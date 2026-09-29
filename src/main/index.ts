/// <reference types="electron-vite/node" />

import { app, BrowserWindow, nativeImage } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerAgentIpc } from "./ipc/agent.ipc";
import { registerGitIpc } from "./ipc/git.ipc";
import { registerProjectIpc } from "./ipc/project.ipc";
import { configureAgentRegistry } from "./services/agent-registry.service";
import { configureProjectRegistry, registerProject, saveProjectWorkspaceSession } from "./services/project-registry.service";
import { generateProject } from "./services/project-generation.service";

const SMOKE_TEST_ARGUMENT = "--flowweave-smoke-test";
const GRAPH_SMOKE_TEST_ARGUMENT = "--flowweave-graph-smoke-test";
const GENERATION_SMOKE_TEST_ARGUMENT = "--flowweave-generation-smoke-test";
const SMOKE_TEST_TIMEOUT_MS = 15_000;
const GRAPH_SMOKE_TEST_TIMEOUT_MS = 45_000;

if (process.argv.includes(GRAPH_SMOKE_TEST_ARGUMENT)) {
  const isolatedUserData = process.env.FLOWWEAVE_GRAPH_SMOKE_USER_DATA;
  if (!isolatedUserData) throw new Error("Graph smoke test requires FLOWWEAVE_GRAPH_SMOKE_USER_DATA.");
  app.setPath("userData", isolatedUserData);
}
if (process.argv.includes(GENERATION_SMOKE_TEST_ARGUMENT)) {
  const isolatedUserData = process.env.FLOWWEAVE_GENERATION_SMOKE_USER_DATA;
  if (!isolatedUserData) throw new Error("Generation smoke test requires FLOWWEAVE_GENERATION_SMOKE_USER_DATA.");
  app.setPath("userData", isolatedUserData);
}

function createWindow(): BrowserWindow {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "flowweave-app-icon.png")
    : join(app.getAppPath(), "logo", "flowweave-app-icon.png");
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    title: "FlowWeave",
    icon: iconPath,
    backgroundColor: "#080a13",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) {
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, "flowweave-app-icon.png")
      : join(app.getAppPath(), "logo", "flowweave-app-icon.png");
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }
  if (process.argv.includes(GENERATION_SMOKE_TEST_ARGUMENT)) {
    await runGenerationSmokeTest();
    return;
  }
  configureAgentRegistry(app.getPath("userData"));
  await configureProjectRegistry(app.getPath("userData"));
  if (process.argv.includes(GRAPH_SMOKE_TEST_ARGUMENT)) {
    const fixturePath = process.env.FLOWWEAVE_GRAPH_SMOKE_PROJECT;
    if (!fixturePath) throw new Error("Graph smoke test requires FLOWWEAVE_GRAPH_SMOKE_PROJECT.");
    const projectId = await registerProject(fixturePath);
    await saveProjectWorkspaceSession({
      openProjectIds: [projectId],
      activeProjectId: projectId,
      lastPageByProject: { [projectId]: "canvas" },
      contextsByProject: {}
    });
  }
  registerProjectIpc();
  registerAgentIpc();
  registerGitIpc();
  const window = createWindow();
  if (process.argv.includes(GRAPH_SMOKE_TEST_ARGUMENT)) {
    runGraphSmokeTest(window);
    return;
  }
  if (process.argv.includes(SMOKE_TEST_ARGUMENT)) {
    runSmokeTest(window);
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

async function runGenerationSmokeTest(): Promise<void> {
  const projectPath = process.env.FLOWWEAVE_GENERATION_SMOKE_PROJECT;
  const role = process.env.FLOWWEAVE_GENERATION_SMOKE_ROLE;
  const barrier = process.env.FLOWWEAVE_GENERATION_SMOKE_BARRIER;
  const reportPath = process.env.FLOWWEAVE_GENERATION_SMOKE_REPORT;
  if (!projectPath || !reportPath || (role !== "older" && role !== "newer") || (role === "older" && !barrier)) {
    throw new Error("Generation smoke test requires project, report, older/newer role, and an older-process barrier.");
  }
  let reachedBarrier = false;
  const result = await generateProject(projectPath, {
    onProgress: (progress) => {
      if (role !== "older" || reachedBarrier || progress.stage !== "persisting" || !barrier) return;
      reachedBarrier = true;
      writeFileSync(`${barrier}.ready`, String(process.pid));
      while (true) {
        try {
          readFileSync(`${barrier}.release`);
          return;
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    }
  });
  await writeFile(reportPath, `${JSON.stringify({ status: result.status, generation: result.status === "committed" ? result.generation : undefined })}\n`);
  console.log(`FlowWeave packaged generation smoke passed: ${role}=${result.status}.`);
  app.exit(0);
  process.exit(0);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function runSmokeTest(window: BrowserWindow): void {
  const timeout = setTimeout(() => {
    console.error("FlowWeave packaged smoke test timed out.");
    exitSmokeTest(window, 1);
  }, SMOKE_TEST_TIMEOUT_MS);
  window.webContents.once("did-finish-load", () => {
    clearTimeout(timeout);
    console.log("FlowWeave packaged smoke test passed.");
    exitSmokeTest(window, 0);
  });
  window.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
    clearTimeout(timeout);
    console.error("FlowWeave packaged smoke test failed.", {
      errorCode,
      errorDescription
    });
    exitSmokeTest(window, 1);
  });
}

function runGraphSmokeTest(window: BrowserWindow): void {
  const expected = process.env.FLOWWEAVE_GRAPH_SMOKE_EXPECT;
  if (expected !== "edges" && expected !== "empty" && expected !== "four-languages" && expected !== "legacy") {
    throw new Error("Graph smoke test requires FLOWWEAVE_GRAPH_SMOKE_EXPECT=edges, empty, four-languages, or legacy.");
  }
  const reportPath = process.env.FLOWWEAVE_GRAPH_SMOKE_REPORT;
  if (!reportPath) throw new Error("Graph smoke test requires FLOWWEAVE_GRAPH_SMOKE_REPORT.");
  type GraphSmokeState = {
    nodes: number;
    nodeIds: string[];
    groups: number;
    edges: Array<{ id: string; label: string; path: string; markerEnd: string }>;
    edgePaths: number;
    layoutPending: boolean;
    emptyText: string;
    viewMode: string;
    projectStatus: string;
    readOnlyActionCount: number;
    readOnlyActionsDisabled: boolean;
  };
  let lastState: GraphSmokeState | undefined;
  let expandingGroups = false;
  const timeout = setTimeout(() => {
    console.error("FlowWeave graph smoke test timed out.", lastState);
    exitSmokeTest(window, 1);
  }, GRAPH_SMOKE_TEST_TIMEOUT_MS);
  window.webContents.once("did-finish-load", () => {
    const interval = setInterval(() => {
      void window.webContents.executeJavaScript(`({
        nodes: document.querySelectorAll('.react-flow__node').length,
        nodeIds: [...document.querySelectorAll('.react-flow__node')].map((node) => node.getAttribute('data-id')),
        groups: document.querySelectorAll('.react-flow__node-groupNode').length,
        edges: [...document.querySelectorAll('.react-flow__edge')].map((edge) => ({
          id: edge.getAttribute('data-id'),
          label: edge.getAttribute('aria-label'),
          path: edge.querySelector('.react-flow__edge-path')?.getAttribute('d') ?? '',
          markerEnd: edge.querySelector('.react-flow__edge-path')?.getAttribute('marker-end') ?? ''
        })),
        edgePaths: [...document.querySelectorAll('.react-flow__edge-path')].filter((path) => Boolean(path.getAttribute('d'))).length,
        layoutPending: Boolean(document.querySelector('.canvas-layout-pending')),
        emptyText: document.querySelector('.canvas-edge-empty')?.textContent ?? '',
        viewMode: [...document.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'architecture'))?.value ?? '',
        projectStatus: document.querySelector('.project-status')?.textContent ?? '',
        readOnlyActionCount: document.querySelectorAll('.workspace-header-primary-actions button').length,
        readOnlyActionsDisabled: [...document.querySelectorAll('.workspace-header-primary-actions button')].every((button) => button.disabled)
      })`).then(async (state: GraphSmokeState) => {
        lastState = state;
        if (state.nodes < 2 || state.layoutPending) return;
        if (state.viewMode !== "architecture") throw new Error(`Graph smoke opened unexpected view: ${state.viewMode}`);
        if (expected !== "empty" && expected !== "legacy" && state.groups > 0) {
          if (expandingGroups) return;
          expandingGroups = true;
          await window.webContents.executeJavaScript(`(() => {
            const button = document.querySelector('button .lucide-chevrons-down-up')?.closest('button');
            if (!button || button.disabled) throw new Error('Graph smoke cannot expand architecture groups.');
            button.click();
          })()`);
          return;
        }
        const passed = expected === "legacy"
          ? /v5/i.test(state.projectStatus) && /(rescan failed|重新扫描失败)/i.test(state.projectStatus) && state.readOnlyActionsDisabled
          : expected !== "empty"
          ? state.edgePaths > 0 && state.edges.every((edge) => edge.path && edge.markerEnd && !/NaN|Infinity/.test(edge.path))
          : state.edgePaths === 0 && state.emptyText.includes("No evidenced cross-module relationships");
        if (!passed) return;
        clearTimeout(timeout);
        clearInterval(interval);
        await writeFile(reportPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        console.log(`FlowWeave graph smoke test passed: ${expected}.`);
        exitSmokeTest(window, 0);
      }).catch((error: unknown) => {
        clearTimeout(timeout);
        clearInterval(interval);
        console.error("FlowWeave graph smoke test failed.", error);
        exitSmokeTest(window, 1);
      });
    }, 250);
  });
  window.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
    clearTimeout(timeout);
    console.error("FlowWeave graph smoke test failed.", { errorCode, errorDescription });
    exitSmokeTest(window, 1);
  });
}

function exitSmokeTest(window: BrowserWindow, exitCode: number): never {
  if (!window.isDestroyed()) {
    window.destroy();
  }
  app.exit(exitCode);
  process.exit(exitCode);
}

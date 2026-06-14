/// <reference types="electron-vite/node" />

import { app, BrowserWindow, nativeImage } from "electron";
import { join } from "node:path";
import { registerAgentIpc } from "./ipc/agent.ipc";
import { registerGitIpc } from "./ipc/git.ipc";
import { registerProjectIpc } from "./ipc/project.ipc";
import { configureAgentRegistry } from "./services/agent-registry.service";

const SMOKE_TEST_ARGUMENT = "--flowweave-smoke-test";
const SMOKE_TEST_TIMEOUT_MS = 15_000;

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

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, "flowweave-app-icon.png")
      : join(app.getAppPath(), "logo", "flowweave-app-icon.png");
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }
  configureAgentRegistry(app.getPath("userData"));
  registerProjectIpc();
  registerAgentIpc();
  registerGitIpc();
  const window = createWindow();
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function runSmokeTest(window: BrowserWindow): void {
  const timeout = setTimeout(() => {
    console.error("FlowWeave packaged smoke test timed out.");
    app.exit(1);
  }, SMOKE_TEST_TIMEOUT_MS);
  window.webContents.once("did-finish-load", () => {
    clearTimeout(timeout);
    console.log("FlowWeave packaged smoke test passed.");
    app.exit(0);
  });
  window.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
    clearTimeout(timeout);
    console.error("FlowWeave packaged smoke test failed.", {
      errorCode,
      errorDescription
    });
    app.exit(1);
  });
}

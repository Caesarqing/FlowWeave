import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_CHANNELS } from "../../src/common/ipc-channels";
import { projectGraphForView } from "../../src/utils/graph-view-projection";

const registeredHandlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>());
const utilityProcessFake = vi.hoisted(() => ({ fork: vi.fn() }));
const workerControl = vi.hoisted(() => ({ paused: false }));

vi.mock("electron", () => ({
  app: { getAppPath: () => process.cwd() },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      registeredHandlers.set(channel, handler);
    }
  },
  dialog: { showOpenDialog: vi.fn() },
  utilityProcess: utilityProcessFake,
  shell: {}
}));

import { dialog } from "electron";
import { registerProjectIpc } from "../../src/main/ipc/project.ipc";
import { configureProjectRegistry, registerProject } from "../../src/main/services/project-registry.service";
import { writeArchitectureReviewStatus } from "../../src/main/services/architecture-review.service";
import { enableProjectAgentConnection, getProjectAgentConnection, getProjectAgentContextPath } from "../../src/main/services/project-agent-connection.service";
import { readModificationDelta } from "../../src/main/services/modification-delta.service";
import { readProjectProtocolCanvas, readProjectProtocolCanvasForDisplay, readProjectProtocolSnapshot } from "../../src/main/storage/flowweave-store";
import type { ArchitectureMap, FlowWeaveProjectOpenResult } from "../../src/types";

utilityProcessFake.fork.mockImplementation(() => {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  let stopped = false;
  const emit = (event: string, value: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };
  return {
    on: (event: string, listener: (value: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return undefined;
    },
    kill: vi.fn(() => { stopped = true; return true; }),
    postMessage: (value: unknown) => {
      if (workerControl.paused) return;
      const request = value as import("../../src/main/services/project-generation.service").ProjectAnalysisWorkerRequest;
      void import("../../src/main/services/project-generation.service").then(({ generateRegisteredProject }) =>
        generateRegisteredProject(request.request, {
          scanOptions: request.scanOptions,
          onProjectScanned: (scanFingerprint) => emit("message", { type: "scanned", requestId: request.request.requestId, scanFingerprint }),
          onProgress: (progress) => emit("message", { type: "progress", requestId: request.request.requestId, progress })
        })
      ).then((generated) => {
        const result = generated.status === "superseded" ? generated : {
          status: generated.status,
          generation: generated.generation,
          scanFingerprint: generated.project.scanFingerprint ?? "",
          written: generated.written,
          localArchitectureInputFingerprint: generated.localArchitecture.metadata?.inputFingerprint ?? ""
        };
        if (!stopped) emit("message", { type: "result", requestId: request.request.requestId, result });
      }).catch((error: unknown) => {
        if (!stopped) emit("message", { type: "failure", requestId: request.request.requestId, message: error instanceof Error ? error.message : String(error) });
      });
    }
  };
});

afterEach(() => {
  registeredHandlers.clear();
  vi.clearAllMocks();
});

describe("first project open static graph", () => {
  it.each([
    PROJECT_CHANNELS.openProject,
    PROJECT_CHANNELS.restoreRegisteredProject,
    PROJECT_CHANNELS.scanProject
  ])("archives invalid markers before cached reads through %s", async (channel) => {
    const root = await projectRoot("preflight-order");
    const storage = join(root, ".flowweave");
    const markerPath = join(storage, "generation.json");
    await mkdir(storage);
    await writeFile(markerPath, "{");
    const userData = await mkdtemp(join(tmpdir(), "flowweave-preflight-registry-"));
    await configureProjectRegistry(userData);
    const projectId = await registerProject(root);
    registerProjectIpc();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [root] });
    const handler = registeredHandlers.get(channel);
    if (!handler) throw new Error(`Missing project handler: ${channel}`);
    const event = { sender: { isDestroyed: () => false, send: () => undefined } };
    await expect(channel === PROJECT_CHANNELS.openProject
      ? handler(event, { concurrency: 2 })
      : handler(event, projectId, { concurrency: 2 })).rejects.toThrow("was preserved");
    const record = JSON.parse(await readFile(join(storage, "migration", "record.json"), "utf8")) as { status: string; backupPath: string };
    expect(record.status).toBe("failed");
    expect(await readFile(join(root, record.backupPath, "artifacts", "generation.json"), "utf8")).toBe("{");
    expect(await readFile(markerPath, "utf8")).toBe("{");
    await expect(readFile(join(storage, "generation-request.json"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("keeps relation identifiers off the initial quality summary", async () => {
    const root = await projectRoot("compact-quality");
    await writeSource(root, "src/features/orders/order.service.ts", "export function loadOrder() { return 1; }\n");
    await writeSource(root, "src/features/accounts/account.service.ts", 'import { loadOrder } from "../orders/order.service";\nexport function loadAccount() { return loadOrder(); }\n');
    await openProject(root);
    const full = await readProjectProtocolCanvas(root);
    const display = await readProjectProtocolCanvasForDisplay(root);
    expect(full?.quality?.factOutcomes?.some((outcome) => outcome.relationIds.length > 0)).toBe(true);
    expect(display?.quality?.factOutcomes?.every((outcome) => outcome.relationIds.length === 0)).toBe(true);
    expect(display?.quality?.factOutcomes?.map((outcome) => outcome.count)).toEqual(full?.quality?.factOutcomes?.map((outcome) => outcome.count));
  });

  it("opens the committed overview without parsing the full static snapshot", async () => {
    const root = await projectRoot("lean-overview");
    await writeSource(root, "src/features/accounts/account.service.ts", "export function loadAccount() { return 1; }\n");
    const opened = await openProject(root);
    if (opened.canceled) throw new Error("Expected project analysis to complete.");
    const overview = JSON.parse(await readFile(join(root, ".flowweave", "graph-overview.json"), "utf8")) as { project?: { projectName: string } };
    expect(overview.project?.projectName).toBe(opened.project.projectName);
    await rm(join(root, ".flowweave", "static-snapshot.json"));
    const readStored = registeredHandlers.get(PROJECT_CHANNELS.readRegisteredProject);
    if (!readStored) throw new Error("Stored project IPC handler was not registered.");
    const stored = await readStored({}, opened.projectId) as { project: { projectName: string } };
    expect(stored.project.projectName).toBe(opened.project.projectName);
  });

  it("generates a task only from the requested current generation and refreshes enabled Agent context", async () => {
    const root = await projectRoot("explicit-task-generation");
    const canonicalRoot = await realpath(root);
    await writeSource(root, "src/features/orders/order.service.ts", "export function loadOrder() { return 1; }\n");
    const opened = await openProject(root);
    if (opened.canceled || opened.status === "superseded" || opened.status === "analyzing") {
      throw new Error("Expected the project scan to commit before task generation.");
    }
    const canvas = await readProjectProtocolCanvas(root);
    const generationId = canvas?.generation?.requestId;
    if (!canvas || !generationId) throw new Error("Expected a committed protocol v7 canvas.");

    await enableProjectAgentConnection(canonicalRoot);
    const handler = registeredHandlers.get(PROJECT_CHANNELS.generateTaskArtifact);
    if (!handler) throw new Error("Task generation IPC handler was not registered.");
    const result = await handler({}, opened.projectId, generationId, canvas.userRevision) as import("../../src/types").TaskArtifactWriteResult;
    const task = JSON.parse(await readFile(result.taskPath, "utf8")) as import("../../src/types").CodeflowTask;
    const originalTaskBytes = await readFile(result.taskPath, "utf8");

    expect(task.generation).toEqual(canvas.generation);
    expect(task.inputFingerprint).toBe(canvas.scanFingerprint);
    expect(task.modules.some((module) => module.files.includes("src/features/orders/order.service.ts"))).toBe(true);
    expect(await readFile(result.markdownPath, "utf8")).toContain("src/features/orders/order.service.ts");
    const connection = await getProjectAgentConnection(canonicalRoot);
    if (connection.state !== "ready") throw new Error(connection.message);
    expect(await readFile(getProjectAgentContextPath(canonicalRoot), "utf8")).toContain(".flowweave/tasks/current.task.json");

    await expect(handler({}, opened.projectId, "superseded-generation", canvas.userRevision)).rejects.toThrow("project generation changed");
    await expect(handler({}, opened.projectId, generationId, canvas.userRevision + 1)).rejects.toThrow("Canvas user state changed");
    await expect(readFile(result.taskPath, "utf8")).resolves.toBe(originalTaskBytes);
  });

  it("uses the committed snapshot for architecture analysis instead of rescanning the project", async () => {
    const root = await projectRoot("downstream-no-rescan");
    await writeSource(root, "src/features/accounts/account.service.ts", "export function loadAccount() { return 1; }\n");
    const opened = await openProject(root);
    if (opened.canceled) throw new Error("Expected project analysis to complete.");
    const generationId = opened.generation?.requestId;
    const forksBeforeReview = utilityProcessFake.fork.mock.calls.length;
    await writeSource(root, "tsconfig.json", '{ "extends":');
    const handler = registeredHandlers.get(PROJECT_CHANNELS.analyzeArchitectureWithAgent);
    if (!handler) throw new Error("Architecture analysis IPC handler was not registered.");

    const review = await handler({ sender: { isDestroyed: () => false, send: () => undefined } }, opened.projectId, "mock", undefined) as {
      outcome: string;
    };

    expect(review.outcome).toBe("generated");
    expect(utilityProcessFake.fork).toHaveBeenCalledTimes(forksBeforeReview);
    expect((await readProjectProtocolSnapshot(root))?.generationId).toBe(generationId);
  });

  it("merges a repeated open while the same project input is being analyzed", async () => {
    const root = await projectRoot("coalesced-open");
    for (let index = 0; index < 40; index += 1) {
      await writeSource(root, `src/features/accounts/account-${index}.ts`, `export function loadAccount${index}() { return ${index}; }\n`);
    }
    const userData = await mkdtemp(join(tmpdir(), "flowweave-first-open-registry-"));
    await configureProjectRegistry(userData);
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [root] } as Awaited<ReturnType<typeof dialog.showOpenDialog>>);
    registerProjectIpc();
    const sender = { isDestroyed: () => false, send: () => undefined };
    const open = registeredHandlers.get(PROJECT_CHANNELS.openProject);
    const cancel = registeredHandlers.get(PROJECT_CHANNELS.cancelProjectAnalysis);
    if (!open || !cancel) throw new Error("Project analysis IPC handlers were not registered.");

    const first = await open({ sender }, { concurrency: 2 }) as { projectId: string; requestId: string };
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const second = await open({ sender }, { concurrency: 2 }) as { projectId: string; requestId: string };

    expect(second.projectId).toBe(first.projectId);
    expect(second.requestId).toBe(first.requestId);
    expect(utilityProcessFake.fork).toHaveBeenCalledTimes(1);
    expect(await cancel({ sender }, first.projectId)).toBe(true);
  });

  it("shares one same-project analysis across windows and cancels only the requesting window", async () => {
    const root = await projectRoot("shared-open");
    const userData = await mkdtemp(join(tmpdir(), "flowweave-first-open-registry-"));
    await configureProjectRegistry(userData);
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [root] } as Awaited<ReturnType<typeof dialog.showOpenDialog>>);
    registerProjectIpc();
    const firstEvents: Array<{ channel: string; payload: unknown }> = [];
    const secondEvents: Array<{ channel: string; payload: unknown }> = [];
    const firstSender = { isDestroyed: () => false, send: (channel: string, payload: unknown) => firstEvents.push({ channel, payload }) };
    const secondSender = { isDestroyed: () => false, send: (channel: string, payload: unknown) => secondEvents.push({ channel, payload }) };
    const open = registeredHandlers.get(PROJECT_CHANNELS.openProject);
    const cancel = registeredHandlers.get(PROJECT_CHANNELS.cancelProjectAnalysis);
    if (!open || !cancel) throw new Error("Project analysis IPC handlers were not registered.");

    workerControl.paused = true;
    try {
      const first = await open({ sender: firstSender }, { concurrency: 2 }) as { projectId: string; requestId: string };
      const second = await open({ sender: secondSender }, { concurrency: 2 }) as { projectId: string; requestId: string };

      expect(second.projectId).toBe(first.projectId);
      expect(second.requestId).toBe(first.requestId);
      expect(utilityProcessFake.fork).toHaveBeenCalledTimes(1);
      expect(await cancel({ sender: secondSender }, first.projectId)).toBe(true);
      expect(secondEvents).toContainEqual(expect.objectContaining({
        channel: PROJECT_CHANNELS.analysisResult,
        payload: expect.objectContaining({ status: "cancelled", requestId: first.requestId })
      }));
      expect(firstEvents).not.toContainEqual(expect.objectContaining({
        channel: PROJECT_CHANNELS.analysisResult,
        payload: expect.objectContaining({ status: "cancelled", requestId: first.requestId })
      }));
      const worker = utilityProcessFake.fork.mock.results[0]?.value as { kill: ReturnType<typeof vi.fn> } | undefined;
      expect(worker?.kill).not.toHaveBeenCalled();
      expect(await cancel({ sender: firstSender }, first.projectId)).toBe(true);
      expect(worker?.kill).toHaveBeenCalledTimes(1);
    } finally {
      workerControl.paused = false;
    }
  });

  it("detaches a window from its previous project analysis when it opens another project", async () => {
    const firstRoot = await projectRoot("switch-first");
    const secondRoot = await projectRoot("switch-second");
    const userData = await mkdtemp(join(tmpdir(), "flowweave-first-open-registry-"));
    await configureProjectRegistry(userData);
    vi.mocked(dialog.showOpenDialog)
      .mockResolvedValueOnce({ canceled: false, filePaths: [firstRoot] } as Awaited<ReturnType<typeof dialog.showOpenDialog>>)
      .mockResolvedValueOnce({ canceled: false, filePaths: [secondRoot] } as Awaited<ReturnType<typeof dialog.showOpenDialog>>);
    registerProjectIpc();
    const events: Array<{ channel: string; payload: unknown }> = [];
    const sender = { isDestroyed: () => false, send: (channel: string, payload: unknown) => events.push({ channel, payload }) };
    const open = registeredHandlers.get(PROJECT_CHANNELS.openProject);
    const cancel = registeredHandlers.get(PROJECT_CHANNELS.cancelProjectAnalysis);
    if (!open || !cancel) throw new Error("Project analysis IPC handlers were not registered.");

    workerControl.paused = true;
    try {
      const first = await open({ sender }, { concurrency: 2 }) as { projectId: string; requestId: string };
      const second = await open({ sender }, { concurrency: 2 }) as { projectId: string; requestId: string };

      expect(second.projectId).not.toBe(first.projectId);
      expect(second.requestId).not.toBe(first.requestId);
      expect(utilityProcessFake.fork).toHaveBeenCalledTimes(2);
      expect(events).toContainEqual(expect.objectContaining({
        channel: PROJECT_CHANNELS.analysisResult,
        payload: expect.objectContaining({ status: "cancelled", projectId: first.projectId, requestId: first.requestId })
      }));
      expect(await cancel({ sender }, first.projectId)).toBe(false);
      expect(await cancel({ sender }, second.projectId)).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({
        channel: PROJECT_CHANNELS.analysisResult,
        payload: expect.objectContaining({ status: "cancelled", projectId: second.projectId, requestId: second.requestId })
      }));
      const firstWorker = utilityProcessFake.fork.mock.results[0]?.value as { kill: ReturnType<typeof vi.fn> } | undefined;
      const secondWorker = utilityProcessFake.fork.mock.results[1]?.value as { kill: ReturnType<typeof vi.fn> } | undefined;
      expect(firstWorker?.kill).toHaveBeenCalledTimes(1);
      expect(secondWorker?.kill).toHaveBeenCalledTimes(1);
    } finally {
      workerControl.paused = false;
    }
  });

  it("kills the background analysis process when the renderer cancels it", async () => {
    const root = await projectRoot("cancel-analysis");
    const userData = await mkdtemp(join(tmpdir(), "flowweave-first-open-registry-"));
    await configureProjectRegistry(userData);
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [root] } as Awaited<ReturnType<typeof dialog.showOpenDialog>>);
    registerProjectIpc();
    const events: Array<{ channel: string; payload: unknown }> = [];
    const sender = { isDestroyed: () => false, send: (channel: string, payload: unknown) => events.push({ channel, payload }) };
    const open = registeredHandlers.get(PROJECT_CHANNELS.openProject);
    const cancel = registeredHandlers.get(PROJECT_CHANNELS.cancelProjectAnalysis);
    if (!open || !cancel) throw new Error("Project analysis IPC handlers were not registered.");

    workerControl.paused = true;
    try {
      const opened = await open({ sender }, { concurrency: 2 }) as { projectId: string; requestId: string };
      expect(await cancel({ sender }, opened.projectId)).toBe(true);
      const worker = utilityProcessFake.fork.mock.results.at(-1)?.value as { kill: ReturnType<typeof vi.fn> } | undefined;
      expect(worker?.kill).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual(expect.objectContaining({
        channel: PROJECT_CHANNELS.analysisResult,
        payload: expect.objectContaining({ status: "cancelled", requestId: opened.requestId })
      }));
    } finally {
      workerControl.paused = false;
    }
  });

  it("enters a new project before background analysis commits its first graph", async () => {
    const root = await projectRoot("async-open");
    await writeSource(root, "src/features/accounts/account.service.ts", "export function loadAccount() { return 1; }\n");
    const userData = await mkdtemp(join(tmpdir(), "flowweave-first-open-registry-"));
    await configureProjectRegistry(userData);
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [root] } as Awaited<ReturnType<typeof dialog.showOpenDialog>>);
    registerProjectIpc();
    const events: Array<{ channel: string; payload: unknown }> = [];
    let resolveAnalysis: (value: unknown) => void = () => undefined;
    const analysis = new Promise<unknown>((resolve) => { resolveAnalysis = resolve; });
    const sender = {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        events.push({ channel, payload });
        if (channel === PROJECT_CHANNELS.analysisResult) resolveAnalysis(payload);
      }
    };
    const handler = registeredHandlers.get(PROJECT_CHANNELS.openProject);
    if (!handler) throw new Error("Project open IPC handler was not registered.");

    const opened = await handler({ sender }, { concurrency: 2 });

    expect(opened).toMatchObject({ status: "analyzing", projectName: root.split("/").at(-1), projectPath: await realpath(root) });
    expect(events).not.toContainEqual(expect.objectContaining({ channel: PROJECT_CHANNELS.analysisResult }));
    const completed = await analysis as { status: string; result: { graph: { nodes: unknown[] } } };
    expect(completed.status).toBe("completed");
    expect(completed.result.canvas.canvas.nodes).toHaveLength(1);
  });

  it("returns the last committed graph immediately while reopening a cached project", async () => {
    const root = await projectRoot("cached-open");
    await writeSource(root, "src/features/accounts/account.service.ts", "export function loadAccount() { return 1; }\n");
    const first = await openProject(root);
    if (!("canvas" in first)) throw new Error("Expected the initial project analysis to complete.");
    const userData = await mkdtemp(join(tmpdir(), "flowweave-first-open-registry-"));
    await configureProjectRegistry(userData);
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [root] } as Awaited<ReturnType<typeof dialog.showOpenDialog>>);
    registerProjectIpc();
    workerControl.paused = true;
    try {
      const handler = registeredHandlers.get(PROJECT_CHANNELS.openProject);
      const cancel = registeredHandlers.get(PROJECT_CHANNELS.cancelProjectAnalysis);
      if (!handler || !cancel) throw new Error("Project analysis IPC handlers were not registered.");
      const sender = { isDestroyed: () => false, send: () => undefined };

      const opened = await handler({ sender }, { concurrency: 2 }) as {
        status: string;
        projectId: string;
        cachedCanvas?: { nodes: Array<{ id: string }> };
      };

      expect(opened.status).toBe("analyzing");
      expect(opened.cachedCanvas?.nodes).toHaveLength(first.canvas.canvas.nodes.length);
      expect(opened.cachedCanvas?.nodes.map(({ id }) => id)).toEqual(first.canvas.canvas.nodes.map(({ id }) => id));
      await cancel({ sender }, opened.projectId);
    } finally {
      workerControl.paused = false;
    }
  });

  it("keeps preserved migration payloads off the initial and cached graph IPC", async () => {
    const root = await projectRoot("compact-migration-graph");
    await writeSource(root, "src/main.py", "def main():\n    return 1\n");
    const canvasDir = join(root, ".flowweave", "canvas");
    await mkdir(canvasDir, { recursive: true });
    await writeFile(join(canvasDir, "main.canvas.json"), JSON.stringify({
      version: 4, nodes: [{ id: "legacy-note", title: "Preserve me" }], edges: []
    }));

    const first = await openProject(root);
    expect(first.canvas.canvas.migrationPendingItems).toBeUndefined();
    expect((first.canvas.canvas as unknown as { preservedCounts?: { pending: number } }).preservedCounts?.pending).toBe(1);
    expect((await readProjectProtocolCanvas(root))?.migrationPendingItems).toHaveLength(1);

    workerControl.paused = true;
    try {
      const restore = registeredHandlers.get(PROJECT_CHANNELS.restoreRegisteredProject);
      const cancel = registeredHandlers.get(PROJECT_CHANNELS.cancelProjectAnalysis);
      if (!restore || !cancel) throw new Error("Project restore or cancellation IPC handler was not registered.");
      const sender = { send: vi.fn(), isDestroyed: () => false };
      const started = await restore({ sender }, first.projectId, { concurrency: 2 }) as {
        status: string; cachedCanvas?: { migrationPendingItems?: unknown[]; preservedCounts?: { pending: number } };
      };
      expect(started.status).toBe("analyzing");
      expect(started.cachedCanvas?.migrationPendingItems).toBeUndefined();
      expect(started.cachedCanvas?.preservedCounts?.pending).toBe(1);
      await cancel({ sender }, first.projectId);
    } finally {
      workerControl.paused = false;
    }
  });

  it("keeps a v5 graph out of normal runtime while a failed migration preserves its backup", async () => {
    const root = await projectRoot("legacy-migration");
    await writeSource(root, "src/features/accounts/account.service.ts", "export function loadAccount() { return 1; }\n");
    const first = await openProject(root);
    await readModificationDelta(root, "");
    const canvasPath = join(root, ".flowweave", "canvas", "main.canvas.json");
    const canvas = first.canvas.canvas;
    const legacy = JSON.stringify({ ...canvas, version: 5 });
    await writeFile(canvasPath, legacy);
    const flowweaveRoot = join(root, ".flowweave");
    await rm(join(flowweaveRoot, "generation.json"));
    await rm(join(flowweaveRoot, "static-snapshot.json"));
    await rm(join(flowweaveRoot, "graph-overview.json"));
    await rm(join(flowweaveRoot, "canvas/user-state.json"));
    const baselinePath = join(root, ".flowweave", "modification-baseline.json");
    const baseline = await readFile(baselinePath, "utf8");
    await writeSource(root, "tsconfig.json", '{ "extends":');
    const read = registeredHandlers.get(PROJECT_CHANNELS.readCanvas);
    if (!read) throw new Error("Canvas read IPC handler was not registered.");
    expect(await read({}, first.projectId)).toBeUndefined();
    const save = registeredHandlers.get(PROJECT_CHANNELS.saveCanvas);
    if (!save) throw new Error("Canvas save IPC handler was not registered.");
    await expect(save({}, first.projectId, canvas, {})).rejects.toThrow(/not been migrated to protocol v7/);
    const readStored = registeredHandlers.get(PROJECT_CHANNELS.readRegisteredProject);
    if (!readStored) throw new Error("Stored project IPC handler was not registered.");
    expect(await readStored({}, first.projectId)).toBeUndefined();
    await expect(rescanProject(first.projectId)).rejects.toThrow(/tsconfig.json/);
    expect(await readFile(canvasPath, "utf8")).toBe(legacy);
    expect(await readFile(baselinePath, "utf8")).toBe(baseline);
    const record = JSON.parse(await readFile(join(flowweaveRoot, "migration/record.json"), "utf8")) as { status: string; backupPath: string };
    expect(record.status).toBe("failed");
    expect(await readFile(join(root, record.backupPath, "artifacts/canvas/main.canvas.json"), "utf8")).toBe(legacy);
  });

  it("rejects malformed committed overview nodes and preserves the artifact", async () => {
    const root = await projectRoot("malformed-canvas");
    await writeSource(root, "src/features/accounts/account.service.ts", "export function loadAccount() { return 1; }\n");
    const project = await openProject(root);
    const canvasPath = join(root, ".flowweave", "graph-overview.json");
    const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
    canvas.nodes[0] = null;
    const malformed = JSON.stringify(canvas);
    await writeFile(canvasPath, malformed);
    const markerPath = join(root, ".flowweave", "generation.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    marker.artifacts.graphOverview = createHash("sha256").update(malformed).digest("hex");
    await writeFile(markerPath, JSON.stringify(marker));
    const read = registeredHandlers.get(PROJECT_CHANNELS.readCanvas);
    if (!read) throw new Error("Canvas read IPC handler was not registered.");

    await expect(read({}, project.projectId)).rejects.toThrow("nodes[0] must be an object");
    expect(await readFile(canvasPath, "utf8")).toBe(malformed);
  });

  it("shows functional modules and evidenced runtime edges without Agent review", async () => {
    const root = await projectRoot("runtime");
    await writeSource(root, "src/features/accounts/account.service.ts", `
      import { loadOrder } from "../orders/order.service";
      export function loadAccountOrders() { return loadOrder(); }
    `);
    await writeSource(root, "src/features/orders/order.service.ts", `
      export function loadOrder() { return { id: "order-1" }; }
    `);
    const result = await openProject(root);
    const graph = result.canvas.canvas;
    const execution = projectGraphForView(graph.nodes, graph.edges, "execution", {});

    expect(result.architectureReview.state).toBe("local");
    expect(result.architectureReview.reviewId).toBeUndefined();
    expect(graph.nodes.map((node) => node.title)).toEqual(expect.arrayContaining(["Accounts", "Orders"]));
    expect(graph.nodes.map((node) => node.title)).not.toContain("features");
    expect(graph.edges).toContainEqual(expect.objectContaining({ relation: "calls", confidence: "confirmed" }));
    expect(execution.edges.length).toBeGreaterThan(0);
    expect(graph.layout?.viewMode).toBe("execution");
    expect(graph.layout?.autoLayouts.execution).toBeDefined();
  });

  it("opens dependency-only projects in the functional view and keeps dependencies selectable", async () => {
    const root = await projectRoot("dependency-only");
    await writeSource(root, "src/features/accounts/account.service.ts", 'import "../orders/order.service";\nexport const account = true;\n');
    await writeSource(root, "src/features/orders/order.service.ts", "export const order = true;\n");
    const result = await openProject(root);

    expect(result.canvas.canvas.edges.map((edge) => edge.relation)).toContain("depends_on");
    expect(result.canvas.canvas.layout?.viewMode).toBe("execution");
    expect(result.canvas.canvas.layout?.autoLayouts.dependency).toBeDefined();
    expect(projectGraphForView(result.canvas.canvas.nodes, result.canvas.canvas.edges, "execution", {}).edges).toEqual([]);
    expect(projectGraphForView(result.canvas.canvas.nodes, result.canvas.canvas.edges, "dependency", {}).edges.map((edge) => edge.relation))
      .toContain("depends_on");
  });

  it("keeps unrelated modules unconnected and exposes skipped same-module evidence", async () => {
    const root = await projectRoot("no-cross-module-edges");
    await writeSource(root, "src/features/accounts/account.service.ts", `
      import { loadAccount } from "./account.repository";
      export function showAccount() { return loadAccount(); }
    `);
    await writeSource(root, "src/features/accounts/account.repository.ts", "export function loadAccount() { return 1; }\n");
    await writeSource(root, "src/features/orders/order.service.ts", "export function loadOrder() { return 2; }\n");
    const result = await openProject(root);

    expect(result.canvas.canvas.nodes).toHaveLength(2);
    expect(result.canvas.canvas.edges).toEqual([]);
    expect(result.canvas.canvas.layout?.viewMode).toBe("execution");
    expect(result.relationDiagnostics).toContainEqual(expect.objectContaining({ reason: "same-module" }));
  });

  it("keeps Agent review separate from static graph facts and preserves manual Canvas content on rescan", async () => {
    const root = await projectRoot("reviewed-rescan");
    await writeSource(root, "src/features/accounts/account.service.ts", 'import { loadOrder } from "../orders/order.service";\nexport function loadAccount() { return loadOrder(); }\n');
    await writeSource(root, "src/features/orders/order.service.ts", "export function loadOrder() { return 1; }\n");
    const first = await openProject(root);
    const architecturePath = join(root, ".flowweave", "architecture-map.json");
    const architecture = (await readProjectProtocolSnapshot(root))?.localArchitecture as ArchitectureMap;
    const reviewed: ArchitectureMap = {
      ...architecture,
      source: "agent",
      generation: architecture.generation,
      architectureStyle: "reviewed architecture",
      modules: architecture.modules.map((module) => ({ ...module, title: `Agent proposal for ${module.title}` })),
      metadata: {
        ...architecture.metadata!,
        source: "agent",
        agentId: "mock",
        runId: "run-reviewed",
        reviewId: "review-reviewed"
      }
    };
    await writeFile(architecturePath, JSON.stringify(reviewed), "utf8");
    await writeArchitectureReviewStatus(root, {
      state: "reviewed",
      projectId: first.projectId,
      artifactTarget: "architecture-map",
      scanFingerprint: first.scanFingerprint,
      inputFingerprint: architecture.metadata?.inputFingerprint,
      agentId: "mock",
      runId: "run-reviewed",
      generation: architecture.generation,
      reviewId: "review-reviewed"
    });
    const canvas = first.canvas.canvas;
    const manualNode = { ...canvas.nodes[0], id: "manual-note", title: "My note", files: [], origin: "manual" as const };
    const editedCanvas = {
      ...canvas,
      nodes: [...canvas.nodes, manualNode],
      edges: [...canvas.edges, { id: "manual-link", source: "manual-note", target: canvas.nodes[0].id, relation: "depends_on" as const, origin: "manual" as const }]
    };
    const save = registeredHandlers.get(PROJECT_CHANNELS.saveCanvas);
    if (!save) throw new Error("Canvas save IPC handler was not registered.");
    await save({}, first.projectId, editedCanvas, {});

    const second = await rescanProject(first.projectId);
    expect(second.architectureReview.state).toBe("reviewed");
    const rescannedModuleIds = second.canvas.canvas.nodes.filter((node) => node.origin !== "manual").map((node) => node.id);
    expect(rescannedModuleIds).toEqual(first.canvas.canvas.nodes.map((node) => node.id));
    expect(second.canvas.canvas.nodes.filter((node) => node.origin !== "manual").map((node) => node.status))
      .toEqual(first.canvas.canvas.nodes.map((node) => node.status));
    expect(second.canvas.canvas.nodes.filter((node) => node.origin !== "manual").map((node) => node.title))
      .toEqual(first.canvas.canvas.nodes.map((node) => node.title));
    expect(second.canvas.canvas.nodes).toContainEqual(expect.objectContaining({ id: "manual-note", title: "My note" }));
    expect(JSON.parse(await readFile(architecturePath, "utf8")).modules[0].title).toContain("Agent proposal");
    expect(second.canvas.canvas.edges).toContainEqual(expect.objectContaining({ id: "manual-link" }));
  });
});

async function openProject(root: string): Promise<Exclude<FlowWeaveProjectOpenResult, { canceled: true }>> {
  const userData = await mkdtemp(join(tmpdir(), "flowweave-first-open-registry-"));
  await configureProjectRegistry(userData);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [root] } as Awaited<ReturnType<typeof dialog.showOpenDialog>>);
  registerProjectIpc();
  const handler = registeredHandlers.get(PROJECT_CHANNELS.openProject);
  if (!handler) throw new Error("Project open IPC handler was not registered.");
  const resultPromise = createProjectAnalysisPromise();
  const sender = resultPromise.sender;
  const opened = await handler({ sender }, { concurrency: 2 }) as FlowWeaveProjectOpenResult;
  if (opened.canceled) return opened;
  expect(opened.status).toBe("analyzing");
  return await resultPromise.wait(opened.requestId, opened.projectId);
}

async function rescanProject(projectId: string): Promise<Exclude<FlowWeaveProjectOpenResult, { canceled: true }>> {
  const handler = registeredHandlers.get(PROJECT_CHANNELS.scanProject);
  if (!handler) throw new Error("Project scan IPC handler was not registered.");
  const resultPromise = createProjectAnalysisPromise();
  const sender = resultPromise.sender;
  const opened = await handler({ sender }, projectId, { concurrency: 2 }) as FlowWeaveProjectOpenResult;
  if (opened.canceled) return opened;
  expect(opened.status).toBe("analyzing");
  return await resultPromise.wait(opened.requestId, opened.projectId);
}

function createProjectAnalysisPromise() {
  let resolveEvent: (event: unknown) => void = () => undefined;
  const eventPromise = new Promise<unknown>((resolve) => { resolveEvent = resolve; });
  return {
    sender: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        if (channel === PROJECT_CHANNELS.analysisResult) resolveEvent(payload);
      }
    },
    async wait(requestId: string, projectId: string): Promise<Exclude<FlowWeaveProjectOpenResult, { canceled: true }>> {
      const event = await eventPromise as { status: string; requestId: string; result?: Exclude<FlowWeaveProjectOpenResult, { canceled: true }>; message?: string };
      if (event.requestId !== requestId) throw new Error(`Project analysis request mismatch: expected ${requestId}, received ${event.requestId}`);
      if (event.status === "failed") throw new Error(event.message);
      if (event.status === "superseded") return { canceled: false, status: "superseded", projectId, requestId };
      if (!event.result) throw new Error(`Project analysis event has no result for request ${requestId}`);
      return event.result;
    }
  };
}

async function projectRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `flowweave-first-open-${prefix}-`));
}

async function writeSource(root: string, path: string, content: string): Promise<void> {
  const absolutePath = join(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

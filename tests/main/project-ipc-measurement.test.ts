import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_CHANNELS } from "../../src/common/ipc-channels";
import { configureProjectRegistry, registerProject, resetProjectRegistryForTests } from "../../src/main/services/project-registry.service";

const registeredHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
const utilityProcessFake = vi.hoisted(() => ({ fork: vi.fn() }));

vi.mock("electron", () => ({
  app: { getAppPath: () => process.cwd() },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => registeredHandlers.set(channel, handler) },
  dialog: { showOpenDialog: vi.fn() },
  utilityProcess: utilityProcessFake,
  shell: {}
}));

import { registerProjectIpc } from "../../src/main/ipc/project.ipc";
import { dialog } from "electron";

const temporaryRoots: string[] = [];

afterEach(async () => {
  registeredHandlers.clear();
  vi.clearAllMocks();
  resetProjectRegistryForTests();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project IPC measurement forwarding", () => {
  it("selects the pinned context project through the normal UI open IPC in measurement mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ipc-selected-measurement-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "main.py"), "def main():\n    return 1\n", "utf8");
    const userData = await mkdtemp(join(tmpdir(), "flowweave-ipc-selected-registry-"));
    temporaryRoots.push(userData);
    await configureProjectRegistry(userData);
    const canonicalRoot = await realpath(root);
    const selections: Array<{ projectId: string; projectPath: string; durationMs: number }> = [];
    const exitedRequests: Array<{ requestId: string; exitedAtEpochMs: number }> = [];
    const cancellationStarts: Array<{ requestId: string; startedAtEpochMs: number }> = [];
    const workerRequests: import("../../src/main/services/project-generation.service").ProjectAnalysisWorkerRequest[] = [];
    const recordCancellationStart = (requestId: string, startedAtEpochMs: number) => {
      cancellationStarts.push({ requestId, startedAtEpochMs });
    };
    utilityProcessFake.fork.mockImplementation(() => {
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      let requestId: string | undefined;
      return {
        on: (event: string, listener: (...args: unknown[]) => void) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        },
        kill: vi.fn(() => {
          for (const listener of listeners.get("exit") ?? []) listener(0);
          return true;
        }),
        postMessage: (value: unknown) => {
          const request = value as import("../../src/main/services/project-generation.service").ProjectAnalysisWorkerRequest;
          requestId = request.request.requestId;
          workerRequests.push(request);
        },
        requestId: () => requestId
      };
    });
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
    const selection = {
      sourcePaths: ["main.py"],
      configurationPaths: [],
      scopeSha256: "a".repeat(64),
      sourceInventorySha256: "b".repeat(64)
    };
    registerProjectIpc({
      autoSelectProjectPath: root,
      autoScanSelection: selection,
      onGenerationMeasurement: () => undefined,
      onProjectSelectionCompleted: (_sender, projectId, projectPath, _requestId, durationMs) => {
        selections.push({ projectId, projectPath, durationMs });
      },
      onProjectAnalysisCancellationRequested: recordCancellationStart,
      onProjectAnalysisWorkerExited: (requestId, exitedAtEpochMs) => exitedRequests.push({ requestId, exitedAtEpochMs }),
      onProjectAnalysisEventSent: () => undefined
    });
    const open = registeredHandlers.get(PROJECT_CHANNELS.openProject);
    if (!open) throw new Error("Open-project IPC handler was not registered.");
    const sender = { isDestroyed: () => false, send: () => undefined };

    const result = await open({ sender }, { concurrency: 2 }) as { status: string; projectId: string; projectPath: string; requestId: string };

    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "analyzing", projectPath: canonicalRoot });
    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({ projectPath: canonicalRoot });
    expect(selections[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(workerRequests).toHaveLength(1);
    expect(workerRequests[0].scanOptions.selection).toEqual(selection);

    const secondSelection = {
      ...selection,
      sourcePaths: ["main.py", "another.py"],
      scopeSha256: "c".repeat(64)
    };
    registerProjectIpc({
      autoSelectProjectPath: root,
      autoScanSelection: secondSelection,
      onGenerationMeasurement: () => undefined,
      onProjectAnalysisCancellationRequested: recordCancellationStart,
      onProjectAnalysisWorkerExited: (requestId, exitedAtEpochMs) => exitedRequests.push({ requestId, exitedAtEpochMs }),
      onProjectAnalysisEventSent: () => undefined
    });
    const openAgain = registeredHandlers.get(PROJECT_CHANNELS.openProject);
    if (!openAgain) throw new Error("Open-project IPC handler was not re-registered.");
    const secondResult = await openAgain({ sender }, { concurrency: 2 }) as { projectId: string; requestId: string };
    expect(secondResult.projectId).toBe(result.projectId);
    expect(secondResult.requestId).not.toBe(result.requestId);
    expect(workerRequests).toHaveLength(2);
    expect(workerRequests[1].scanOptions.selection).toEqual(secondSelection);

    const cancel = registeredHandlers.get(PROJECT_CHANNELS.cancelProjectAnalysis);
    if (!cancel) throw new Error("Cancel-project-analysis IPC handler was not registered.");
    expect(await cancel({ sender }, secondResult.projectId)).toBe(true);
    expect(cancellationStarts).toContainEqual({ requestId: secondResult.requestId, startedAtEpochMs: expect.any(Number) });
    expect(exitedRequests).toContainEqual({ requestId: secondResult.requestId, exitedAtEpochMs: expect.any(Number) });

    registerProjectIpc({
      autoSelectProjectPath: root,
      autoScanSelection: selection,
      onProjectAnalysisEventSent: () => undefined
    });
    const openWithoutTimings = registeredHandlers.get(PROJECT_CHANNELS.openProject);
    if (!openWithoutTimings) throw new Error("Open-project IPC handler was not registered for the uninstrumented driver.");
    await openWithoutTimings({ sender }, { concurrency: 2 });
    expect(workerRequests[2]).toMatchObject({ measurementsEnabled: false, scanOptions: { selection } });
  });

  it("forwards actual worker stage measurements with the committed generation and user revision", async () => {
    const workerRequests: import("../../src/main/services/project-generation.service").ProjectAnalysisWorkerRequest[] = [];
    utilityProcessFake.fork.mockImplementation(() => {
      const listeners = new Map<string, Array<(value: unknown) => void>>();
      let stopped = false;
      return {
        on: (event: string, listener: (value: unknown) => void) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener]);
          return undefined;
        },
        kill: vi.fn(() => { stopped = true; return true; }),
        postMessage: (value: unknown) => {
          const request = value as import("../../src/main/services/project-generation.service").ProjectAnalysisWorkerRequest;
          workerRequests.push(request);
          const emit = (message: unknown) => {
            if (!stopped) for (const listener of listeners.get("message") ?? []) listener(message);
          };
          void import("../../src/main/services/project-generation.service").then(({ generateRegisteredProject }) =>
            generateRegisteredProject(request.request, {
              scanOptions: request.scanOptions,
              onProjectScanned: (scanFingerprint) => emit({ type: "scanned", requestId: request.request.requestId, scanFingerprint }),
              onProgress: (progress) => emit({ type: "progress", requestId: request.request.requestId, progress }),
              onMeasurement: (measurement) => emit({ type: "measurement", requestId: request.request.requestId, measurement })
            })
          ).then((generated) => {
            const result = generated.status === "superseded" ? generated : {
              status: generated.status,
              generation: generated.generation,
              scanFingerprint: generated.project.scanFingerprint ?? "",
              written: generated.written,
              localArchitectureInputFingerprint: generated.localArchitecture.metadata?.inputFingerprint ?? ""
            };
            emit({ type: "result", requestId: request.request.requestId, result });
          }).catch((error: unknown) => emit({
            type: "failure",
            requestId: request.request.requestId,
            message: error instanceof Error ? error.message : String(error)
          }));
        }
      };
    });

    const root = await mkdtemp(join(tmpdir(), "flowweave-ipc-measurement-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/main.py"), "def main():\n    return 1\n", "utf8");
    const userData = await mkdtemp(join(tmpdir(), "flowweave-ipc-measurement-registry-"));
    temporaryRoots.push(userData);
    await configureProjectRegistry(userData);
    const projectId = await registerProject(root);
    const measurements: Array<{ requestId: string; metric: string; durationMs: number; outcome: string }> = [];
    const mainMeasurements: Array<{ metric: string; durationMs: number; outcome: string }> = [];
    const sentEvents: Array<{ status: string; result?: { generation?: { requestId: string }; canvas?: { canvas?: { userRevision?: number } } } }> = [];
    const observer = {
      onGenerationMeasurement: (requestId: string, measurement: { metric: string; durationMs: number; outcome: string }) => {
        measurements.push({ requestId, ...measurement });
      },
      onMainProcessMeasurement: (measurement) => mainMeasurements.push(measurement),
      onProjectAnalysisEventSent: (_sender: unknown, event: typeof sentEvents[number], sentAtEpochMs: number) => {
        expect(Number.isFinite(sentAtEpochMs)).toBe(true);
        sentEvents.push(event);
      }
    };
    registerProjectIpc(observer);
    const handler = registeredHandlers.get(PROJECT_CHANNELS.scanProject);
    if (!handler) throw new Error("Static project scan IPC handler was not registered.");
    const senderEvents: unknown[] = [];
    const sender = { isDestroyed: () => false, send: (_channel: string, event: unknown) => senderEvents.push(event) };

    await handler({ sender }, projectId, { concurrency: 2 });
    await vi.waitFor(() => expect(senderEvents.some((event) => typeof event === "object" && event !== null && "status" in event)).toBe(true), { timeout: 10_000 });

    const completed = sentEvents.find((event) => event.status === "completed");
    expect(completed, JSON.stringify({ measurements, sentEvents, senderEvents })).toBeDefined();
    expect(measurements.map(({ metric }) => metric)).toContain("scanMs");
    expect(measurements.some(({ durationMs, outcome }) => Number.isFinite(durationMs) && durationMs >= 0 && outcome === "completed")).toBe(true);
    expect(workerRequests).toHaveLength(1);
    expect(workerRequests[0].scanOptions.selection).toBeUndefined();
    expect(completed?.result?.generation?.requestId).toMatch(/^[a-f0-9]{64}$/);
    expect(completed?.result?.canvas?.canvas?.generation?.requestId).toBe(completed?.result?.generation?.requestId);
    expect(completed?.result?.canvas?.canvas?.userRevision).toBe(0);
    expect(senderEvents).toContain(completed);

    const readDetail = registeredHandlers.get(PROJECT_CHANNELS.readCanvasNodeDetail);
    if (!readDetail || !completed?.result?.generation?.requestId) throw new Error("Canvas node detail IPC handler or generation identity is missing.");
    await readDetail({ sender }, projectId, completed.result.generation.requestId, 0, "not-present");
    expect(mainMeasurements.map(({ metric }) => metric)).toContain("lockWaitMs");
    expect(mainMeasurements.map(({ metric }) => metric)).toContain("snapshotReadMs");
    expect(mainMeasurements.map(({ metric }) => metric)).toContain("snapshotParseMs");
    expect(mainMeasurements.map(({ metric }) => metric)).toContain("snapshotValidationMs");
    expect(mainMeasurements.map(({ metric }) => metric)).toContain("detailIndexMs");
    expect(mainMeasurements.every(({ durationMs, outcome }) => Number.isFinite(durationMs) && durationMs >= 0 && outcome === "completed")).toBe(true);
    const readEdgeDetail = registeredHandlers.get(PROJECT_CHANNELS.readCanvasEdgeDetail);
    if (!readEdgeDetail) throw new Error("Canvas edge detail IPC handler is missing.");
    mainMeasurements.splice(0);
    await readEdgeDetail({ sender }, projectId, completed.result.generation.requestId, 0, "not-present");
    expect(mainMeasurements).toEqual([{ metric: "lockWaitMs", durationMs: expect.any(Number), outcome: "completed" }]);
  });
});

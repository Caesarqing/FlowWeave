import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as measurementTools from "../../src/main/services/static-graph-measurement";
import {
  isMatchingRenderedGraphWorkspaceReady,
  validateMeasurementSourceInventory,
  measureCancellation,
  serializedIpcPayloadBytes,
  startProcessTreePeakRssSampler,
  summarizeRendererLongTasks,
  sumElectronWorkingSetBytes
} from "../../src/main/services/static-graph-measurement";

describe("static graph measurement tools", () => {
  afterEach(() => vi.useRealTimers());

  it("samples RSS only inside declared action windows and attests retained resident baselines", () => {
    vi.useFakeTimers();
    let workingSetKiB = 80 * 1024;
    let reads = 0;
    const actions = measurementTools.createProcessTreeActionRssMeasurement(() => {
      reads += 1;
      return [{ memory: { workingSetSize: workingSetKiB } }];
    }, 50);
    vi.advanceTimersByTime(100);
    expect(reads).toBe(0);
    workingSetKiB = 12 * 1024;
    actions.startAction("project-open");
    vi.advanceTimersByTime(50);
    actions.finishAction();
    const afterOpenReads = reads;
    workingSetKiB = 120 * 1024;
    vi.advanceTimersByTime(100);
    expect(reads).toBe(afterOpenReads);
    workingSetKiB = 6 * 1024;
    actions.startAction("detail-click");
    workingSetKiB = 8 * 1024;
    vi.advanceTimersByTime(50);
    actions.finishAction();
    const evidence = actions.readEvidence();
    expect(evidence.windows).toEqual([
      expect.objectContaining({ boundary: "project-open", residentBaselineMiB: 12, peakRssMiB: 12 }),
      expect.objectContaining({ boundary: "detail-click", residentBaselineMiB: 6, peakRssMiB: 8 })
    ]);
    expect(evidence.peakRssMiB).toBe(12);
    expect(evidence.cleanLaunchRss).toBe(false);
  });

  it("accepts synthetic overview cards for the measured canvas identity", () => {
    const observation = {
      generationId: "generation-one",
      userRevision: 4,
      shellGenerationId: "generation-one",
      shellUserRevision: "4",
      hasShell: true,
      isLoading: false,
      renderedNodeCount: 4
    };

    expect(isMatchingRenderedGraphWorkspaceReady(observation)).toBe(true);
    expect(isMatchingRenderedGraphWorkspaceReady({ ...observation, shellGenerationId: "generation-old" })).toBe(false);
    expect(isMatchingRenderedGraphWorkspaceReady({ ...observation, shellUserRevision: "3" })).toBe(false);
    expect(isMatchingRenderedGraphWorkspaceReady({ ...observation, renderedNodeCount: 0 })).toBe(false);
    expect(isMatchingRenderedGraphWorkspaceReady({ ...observation, isLoading: true })).toBe(false);
  });

  it("checks frozen selected-file hashes without rejecting unrelated checkout changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-measurement-inventory-"));
    const sourcePath = join(root, "src", "index.ts");
    const sourceBytes = Buffer.from("export const value = 1;\n");
    await mkdir(join(root, "src"));
    await writeFile(sourcePath, sourceBytes);
    const entries = [{
      path: "src/index.ts",
      kind: "source" as const,
      mode: "100644",
      sizeBytes: sourceBytes.byteLength,
      sha256: createHash("sha256").update(sourceBytes).digest("hex")
    }];
    const selection = { sourcePaths: ["src/index.ts"], configurationPaths: [] };

    try {
      await validateMeasurementSourceInventory(root, selection, entries);
      await writeFile(join(root, "README.md"), "out-of-scope change");
      await expect(validateMeasurementSourceInventory(root, selection, entries)).resolves.toBeUndefined();
      await writeFile(sourcePath, "export const value = 2;\n");
      await expect(validateMeasurementSourceInventory(root, selection, entries)).rejects.toThrow(/content changed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores Unix permission bits when validating a Windows source inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-windows-measurement-inventory-"));
    const sourcePath = join(root, "index.ts");
    const sourceBytes = Buffer.from("export const value = 1;\n");
    await writeFile(sourcePath, sourceBytes);
    await chmod(sourcePath, 0o600);
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!originalPlatform) throw new Error("The process platform descriptor is unavailable.");
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    try {
      await expect(validateMeasurementSourceInventory(root, { sourcePaths: ["index.ts"], configurationPaths: [] }, [{
        path: "index.ts",
        kind: "source",
        mode: "100644",
        sizeBytes: sourceBytes.byteLength,
        sha256: createHash("sha256").update(sourceBytes).digest("hex")
      }])).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("counts UTF-8 bytes for a serialized first-screen IPC payload", () => {
    const payload = { nodes: ["支付", "graph"] };

    expect(serializedIpcPayloadBytes(payload)).toBe(Buffer.byteLength(JSON.stringify(payload), "utf8"));
    expect(() => serializedIpcPayloadBytes(undefined)).toThrow(/not JSON-serializable/);
  });

  it("summarizes only renderer tasks at or above the 50 ms threshold", () => {
    expect(summarizeRendererLongTasks([49.9, 50, 75.5, 10])).toEqual({ count: 2, totalMs: 125.5, maxMs: 75.5 });
    expect(() => summarizeRendererLongTasks([Number.NaN])).toThrow(/duration is invalid/);
  });

  it("sums working-set memory for every Electron process metric", () => {
    expect(sumElectronWorkingSetBytes([
      { memory: { workingSetSize: 1024 } },
      { memory: { workingSetSize: 2048 } }
    ])).toBe(3 * 1024 * 1024);
  });

  it("samples and reports the largest aggregate Electron process-tree RSS", () => {
    vi.useFakeTimers();
    const samples = [
      [{ memory: { workingSetSize: 1024 } }],
      [{ memory: { workingSetSize: 2048 } }, { memory: { workingSetSize: 1024 } }],
      [{ memory: { workingSetSize: 512 } }]
    ];
    const sampler = startProcessTreePeakRssSampler(() => samples.shift() ?? [], 50);

    vi.advanceTimersByTime(50);

    expect(sampler.stop()).toEqual({ peakRssMiB: 3, sampleCount: 3, sampleIntervalMs: 50 });
  });

  it("requires matching cancellation, UI receipt, and worker-exit identity", () => {
    expect(measureCancellation({
      requestId: "request-1",
      uiStartedAtEpochMs: 100,
      workerExitStartedAtEpochMs: 1000,
      uiEvent: { requestId: "request-1", status: "cancelled", receivedAtEpochMs: 125 },
      workerExit: { requestId: "request-1", exitedAtEpochMs: 1080 }
    })).toEqual({ cancellationUiResponseMs: 25, backgroundTaskExitMs: 80 });
    expect(() => measureCancellation({
      requestId: "request-1",
      uiStartedAtEpochMs: 100,
      workerExitStartedAtEpochMs: 1000,
      uiEvent: { requestId: "request-2", status: "cancelled", receivedAtEpochMs: 125 },
      workerExit: { requestId: "request-1", exitedAtEpochMs: 1080 }
    })).toThrow(/does not match request/);
  });
});

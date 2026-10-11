import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { StaticGraphDetailUiTiming } from "../../types";

export interface RendererLongTaskSummary {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface ElectronProcessMetricMemory {
  memory: { workingSetSize: number };
}

export interface ProcessTreePeakRssMeasurement {
  peakRssMiB: number;
  sampleCount: number;
  sampleIntervalMs: number;
}
export interface ProcessTreeActionRssWindow extends ProcessTreePeakRssMeasurement {
  boundary: string;
  startedAtEpochMs: number;
  endedAtEpochMs: number;
  residentBaselineMiB: number;
}
export interface ProcessTreeActionRssEvidence {
  peakRssMiB: number;
  cleanLaunchRss: false;
  definition: string;
  windows: ProcessTreeActionRssWindow[];
}
export interface ProcessTreeActionRssMeasurement {
  startAction: (boundary: string) => void;
  finishAction: () => void;
  readEvidence: () => ProcessTreeActionRssEvidence;
}

export interface CancellationMeasurementInput {
  requestId: string;
  uiStartedAtEpochMs: number;
  workerExitStartedAtEpochMs: number;
  uiEvent: { requestId: string; status: string; receivedAtEpochMs: number };
  workerExit: { requestId: string; exitedAtEpochMs: number };
}

export interface RenderedGraphWorkspaceObservation {
  generationId: string;
  userRevision: number;
  shellGenerationId: string | null;
  shellUserRevision: string | null;
  hasShell: boolean;
  isLoading: boolean;
  renderedNodeCount: number;
}

export function staticGraphDetailUiTimingIdentity(
  runtimeProjectId: string | undefined,
  generationId: string,
  userRevision: number,
  nodeId: string
): Pick<StaticGraphDetailUiTiming, "projectId" | "generationId" | "userRevision" | "nodeId"> {
  if (!runtimeProjectId) throw new Error("Static graph detail timing requires a runtime project identity.");
  return { projectId: runtimeProjectId, generationId, userRevision, nodeId };
}

export function measureStaticGraphDetailUiTimings(
  expected: Pick<StaticGraphDetailUiTiming, "projectId" | "generationId" | "userRevision" | "nodeId">,
  observed: StaticGraphDetailUiTiming
): { detailReadyMs: number; detailIpcRoundTripMs: number; detailPanelPresentationMs: number } {
  if (expected.projectId !== observed.projectId || expected.generationId !== observed.generationId ||
    expected.userRevision !== observed.userRevision || expected.nodeId !== observed.nodeId) {
    throw new Error("Static graph detail timing identity does not match the measured project, generation, revision, and node.");
  }
  const timestamps = [observed.clickStartedAtEpochMs, observed.ipcStartedAtEpochMs, observed.ipcResponseAtEpochMs, observed.panelPresentedAtEpochMs];
  if (timestamps.some((timestamp) => !Number.isFinite(timestamp) || timestamp < 0) ||
    observed.ipcStartedAtEpochMs < observed.clickStartedAtEpochMs ||
    observed.ipcResponseAtEpochMs < observed.ipcStartedAtEpochMs ||
    observed.panelPresentedAtEpochMs < observed.ipcResponseAtEpochMs) {
    throw new RangeError("Static graph detail timing timestamps must be finite, non-negative, and ordered.");
  }
  return {
    detailReadyMs: observed.panelPresentedAtEpochMs - observed.clickStartedAtEpochMs,
    detailIpcRoundTripMs: observed.ipcResponseAtEpochMs - observed.ipcStartedAtEpochMs,
    detailPanelPresentationMs: observed.panelPresentedAtEpochMs - observed.ipcResponseAtEpochMs
  };
}

export interface MeasurementSourceInventoryEntry {
  path: string;
  kind: "source" | "configuration" | "license";
  mode: string;
  sizeBytes: number;
  sha256: string;
}

export interface MeasurementSourceSelection {
  sourcePaths: string[];
  configurationPaths: string[];
}

export function isMatchingRenderedGraphWorkspaceReady(input: RenderedGraphWorkspaceObservation): boolean {
  return input.hasShell && !input.isLoading && input.renderedNodeCount > 0 &&
    input.shellGenerationId === input.generationId &&
    input.shellUserRevision === String(input.userRevision);
}

export async function validateMeasurementSourceInventory(
  projectPath: string,
  selection: MeasurementSourceSelection,
  entries: readonly MeasurementSourceInventoryEntry[]
): Promise<void> {
  const root = await realpath(projectPath);
  const expectedSourcePaths = [...selection.sourcePaths].sort();
  const expectedConfigurationPaths = [...selection.configurationPaths].sort();
  const sourceEntries = entries.filter((entry) => entry.kind === "source").map((entry) => entry.path).sort();
  const configurationEntries = entries.filter((entry) => entry.kind === "configuration").map((entry) => entry.path).sort();
  const allPaths = entries.map((entry) => entry.path);
  if (new Set(allPaths).size !== allPaths.length || !samePathList(sourceEntries, expectedSourcePaths) ||
    !samePathList(configurationEntries, expectedConfigurationPaths)) {
    throw new Error(`Measurement source inventory does not match the frozen selection: project ${projectPath}.`);
  }

  for (const entry of entries) {
    if (!isSafeRelativeFilePath(entry.path) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 ||
      !/^(100644|100755)$/.test(entry.mode) || !/^[a-f\d]{64}$/i.test(entry.sha256)) {
      throw new Error(`Measurement source inventory entry is invalid: project ${projectPath}, path ${entry.path}.`);
    }
    const filePath = resolve(root, ...entry.path.split("/"));
    const resolvedPath = await realpath(filePath);
    const relativePath = relative(root, resolvedPath);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === ".." || resolve(root, relativePath) !== filePath) {
      throw new Error(`Measurement source inventory path resolves through a symlink or outside the checkout: project ${projectPath}, path ${entry.path}.`);
    }
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Measurement source inventory entry is not a regular file: project ${projectPath}, path ${entry.path}.`);
    }
    const bytes = await readFile(filePath);
    const actualMode = (stats.mode & 0o777).toString(8).padStart(3, "0");
    const expectedMode = entry.mode.slice(-3);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== entry.sizeBytes || actualMode !== expectedMode || actualSha256 !== entry.sha256.toLowerCase()) {
      throw new Error(`Measurement source inventory content changed: project ${projectPath}, path ${entry.path}; expected size/mode/hash ${entry.sizeBytes}/${expectedMode}/${entry.sha256.toLowerCase()}, found ${bytes.byteLength}/${actualMode}/${actualSha256}.`);
    }
  }
}

export function isMeasurementSourceInventoryEntries(
  value: unknown,
  selection: MeasurementSourceSelection
): value is MeasurementSourceInventoryEntry[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry))) return false;
  const entries = value as MeasurementSourceInventoryEntry[];
  return entries.every((entry) => typeof entry.path === "string" &&
    (entry.kind === "source" || entry.kind === "configuration" || entry.kind === "license") &&
    typeof entry.mode === "string" && Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0 &&
    typeof entry.sha256 === "string" && /^[a-f\d]{64}$/i.test(entry.sha256)) &&
    new Set(entries.map((entry) => entry.path)).size === entries.length &&
    samePathList(entries.filter((entry) => entry.kind === "source").map((entry) => entry.path).sort(), [...selection.sourcePaths].sort()) &&
    samePathList(entries.filter((entry) => entry.kind === "configuration").map((entry) => entry.path).sort(), [...selection.configurationPaths].sort());
}

function samePathList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function isSafeRelativeFilePath(value: string): boolean {
  return value.trim() === value && value.length > 0 && !value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function serializedIpcPayloadBytes(payload: unknown): number {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new TypeError("IPC measurement payload is not JSON-serializable.");
  return Buffer.byteLength(serialized, "utf8");
}

export function summarizeRendererLongTasks(durations: readonly number[]): RendererLongTaskSummary {
  const longTasks = durations.filter((duration) => {
    if (!Number.isFinite(duration) || duration < 0) throw new RangeError(`Renderer long-task duration is invalid: ${duration}`);
    return duration >= 50;
  });
  return {
    count: longTasks.length,
    totalMs: longTasks.reduce((total, duration) => total + duration, 0),
    maxMs: longTasks.reduce((maximum, duration) => Math.max(maximum, duration), 0)
  };
}

export function sumElectronWorkingSetBytes(metrics: readonly ElectronProcessMetricMemory[]): number {
  return metrics.reduce((totalBytes, metric) => {
    const workingSetKb = metric.memory.workingSetSize;
    if (!Number.isFinite(workingSetKb) || workingSetKb < 0) {
      throw new RangeError(`Electron process working-set size is invalid: ${workingSetKb}`);
    }
    return totalBytes + workingSetKb * 1024;
  }, 0);
}

export function measureCancellation(input: CancellationMeasurementInput): {
  cancellationUiResponseMs: number;
  backgroundTaskExitMs: number;
} {
  if (input.uiEvent.requestId !== input.requestId || input.workerExit.requestId !== input.requestId || input.uiEvent.status !== "cancelled") {
    throw new Error(`Cancellation measurement evidence does not match request ${input.requestId}.`);
  }
  if (!Number.isFinite(input.uiStartedAtEpochMs) || !Number.isFinite(input.uiEvent.receivedAtEpochMs) ||
    !Number.isFinite(input.workerExitStartedAtEpochMs) || !Number.isFinite(input.workerExit.exitedAtEpochMs) ||
    input.uiEvent.receivedAtEpochMs < input.uiStartedAtEpochMs ||
    input.workerExit.exitedAtEpochMs < input.workerExitStartedAtEpochMs) {
    throw new RangeError(`Cancellation measurement timestamps are invalid for request ${input.requestId}.`);
  }
  return {
    cancellationUiResponseMs: input.uiEvent.receivedAtEpochMs - input.uiStartedAtEpochMs,
    backgroundTaskExitMs: input.workerExit.exitedAtEpochMs - input.workerExitStartedAtEpochMs
  };
}

export function startProcessTreePeakRssSampler(
  readMetrics: () => readonly ElectronProcessMetricMemory[],
  sampleIntervalMs: number
): { stop: () => ProcessTreePeakRssMeasurement } {
  if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 1) {
    throw new RangeError(`Process-tree RSS sample interval is invalid: ${sampleIntervalMs}`);
  }
  let peakRssBytes = 0;
  let sampleCount = 0;
  let sampleError: unknown;
  let stopped = false;
  const sample = () => {
    try {
      peakRssBytes = Math.max(peakRssBytes, sumElectronWorkingSetBytes(readMetrics()));
      sampleCount += 1;
    } catch (error) {
      sampleError = error;
      clearInterval(interval);
    }
  };
  const interval = setInterval(sample, sampleIntervalMs);
  sample();
  return {
    stop: () => {
      if (!stopped) {
        stopped = true;
        clearInterval(interval);
        sample();
      }
      if (sampleError) throw new Error("Could not sample Electron process-tree RSS.", { cause: sampleError });
      return {
        peakRssMiB: peakRssBytes / (1024 * 1024),
        sampleCount,
        sampleIntervalMs
      };
    }
  };
}

/** Sample only declared action windows; setup allocations still retained at action entry are reported as the resident baseline. */
export function createProcessTreeActionRssMeasurement(
  readMetrics: () => readonly ElectronProcessMetricMemory[],
  sampleIntervalMs: number
): ProcessTreeActionRssMeasurement {
  const windows: ProcessTreeActionRssWindow[] = [];
  let active: {
    boundary: string;
    startedAtEpochMs: number;
    sampler: { stop: () => ProcessTreePeakRssMeasurement };
    readResidentBaseline: () => number | undefined;
  } | undefined;
  return {
    startAction: (boundary) => {
      if (active) throw new Error(`RSS action ${active.boundary} must finish before starting ${boundary}.`);
      if (!boundary.trim()) throw new TypeError("RSS action boundary must be explicit.");
      const startedAtEpochMs = Date.now();
      let residentBaselineMiB: number | undefined;
      const sampler = startProcessTreePeakRssSampler(() => {
        const metrics = readMetrics();
        if (residentBaselineMiB === undefined) residentBaselineMiB = sumElectronWorkingSetBytes(metrics) / (1024 * 1024);
        return metrics;
      }, sampleIntervalMs);
      active = { boundary, startedAtEpochMs, sampler, readResidentBaseline: () => residentBaselineMiB };
    },
    finishAction: () => {
      if (!active) throw new Error("No RSS action window is active.");
      const completed = active;
      active = undefined;
      const measured = completed.sampler.stop();
      const residentBaselineMiB = completed.readResidentBaseline();
      if (residentBaselineMiB === undefined) throw new Error(`RSS action ${completed.boundary} did not establish a resident baseline.`);
      windows.push({ ...measured, boundary: completed.boundary, startedAtEpochMs: completed.startedAtEpochMs,
        endedAtEpochMs: Date.now(), residentBaselineMiB });
    },
    readEvidence: () => {
      if (active) throw new Error(`RSS action ${active.boundary} must finish before its evidence is read.`);
      return {
        peakRssMiB: windows.reduce((maximum, window) => Math.max(maximum, window.peakRssMiB), 0),
        cleanLaunchRss: false,
        definition: "Peak across declared action windows after setup; transient setup sampling is excluded. Allocations retained from seed generation or hot-detail priming remain in the resident baseline and peak. This is not clean-launch process RSS.",
        windows: windows.map((window) => ({ ...window }))
      };
    }
  };
}

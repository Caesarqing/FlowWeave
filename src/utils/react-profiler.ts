export type CanvasProfilerPhase = "mount" | "update" | "nested-update";

export type CanvasProfilerSample = {
  componentId: string;
  phase: CanvasProfilerPhase;
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
  action: string;
};

export type CanvasProfilerCapture = {
  reactVersion: string;
  currentAction: string;
  samples: CanvasProfilerSample[];
};

export type CanvasProfilerGraphSnapshot = {
  nodeIds: string[];
  edgeIds: string[];
};

declare global {
  interface Window {
    __flowweaveReactProfiler?: CanvasProfilerCapture;
  }
}

export function recordCanvasProfilerCommit(
  capture: CanvasProfilerCapture,
  componentId: string,
  phase: CanvasProfilerPhase,
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number
): void {
  capture.samples.push({
    componentId,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
    action: capture.currentAction
  });
}

export function recordCanvasProfilerWindowCommit(
  componentId: string,
  phase: CanvasProfilerPhase,
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number
): void {
  const browserWindow = globalThis as typeof globalThis & { window?: Window };
  const capture = browserWindow.window?.__flowweaveReactProfiler;
  if (!capture) return;
  recordCanvasProfilerCommit(capture, componentId, phase, actualDuration, baseDuration, startTime, commitTime);
}

export function hasCanvasProfilerGraphChange(
  before: CanvasProfilerGraphSnapshot,
  after: CanvasProfilerGraphSnapshot
): boolean {
  const changedIds = (beforeIds: string[], afterIds: string[]) => {
    const afterSet = new Set(afterIds);
    return beforeIds.length !== afterIds.length || beforeIds.some((id) => !afterSet.has(id));
  };

  return changedIds(before.nodeIds, after.nodeIds) || changedIds(before.edgeIds, after.edgeIds);
}

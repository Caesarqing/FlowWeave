export const GRAPH_SMOKE_TRACE_PREFIX = "FLOWWEAVE_GRAPH_SMOKE_TRACE:";

export type GraphSmokeTraceEvent = {
  source: "main" | "renderer";
  stage: string;
  monotonicMs: number;
  projectId?: string;
  requestId?: string;
  localRequestId?: number;
  error?: string;
  observedAtMainMonotonicMs?: number;
};

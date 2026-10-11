import { GRAPH_SMOKE_TRACE_PREFIX, type GraphSmokeTraceEvent } from "../../common/graph-smoke-trace";

export { GRAPH_SMOKE_TRACE_PREFIX };

export function parseGraphSmokeTraceMessage(message: string): GraphSmokeTraceEvent | undefined {
  if (!message.startsWith(GRAPH_SMOKE_TRACE_PREFIX)) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(message.slice(GRAPH_SMOKE_TRACE_PREFIX.length));
  } catch (error) {
    throw new SyntaxError("Invalid graph smoke trace message JSON.", { cause: error });
  }
  if (!isGraphSmokeTraceEvent(value)) throw new TypeError("Invalid graph smoke trace message event.");
  return value;
}

function isGraphSmokeTraceEvent(value: unknown): value is GraphSmokeTraceEvent {
  if (typeof value !== "object" || value === null || !("source" in value) || !("stage" in value) ||
      !("monotonicMs" in value) || (value.source !== "main" && value.source !== "renderer") ||
      typeof value.stage !== "string" || typeof value.monotonicMs !== "number" || !Number.isFinite(value.monotonicMs)) return false;
  return (!("projectId" in value) || typeof value.projectId === "string") &&
    (!("requestId" in value) || typeof value.requestId === "string") &&
    (!("localRequestId" in value) || (typeof value.localRequestId === "number" && Number.isInteger(value.localRequestId))) &&
    (!("error" in value) || typeof value.error === "string") &&
    (!("observedAtMainMonotonicMs" in value) ||
      (typeof value.observedAtMainMonotonicMs === "number" && Number.isFinite(value.observedAtMainMonotonicMs)));
}

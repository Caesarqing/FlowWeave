import { describe, expect, it } from "vitest";
import { GRAPH_SMOKE_TRACE_PREFIX, parseGraphSmokeTraceMessage } from "../../src/main/services/graph-smoke-trace";

describe("graph smoke trace messages", () => {
  it("preserves stage, request id, and error from prefixed console messages", () => {
    const event = {
      source: "renderer",
      stage: "restoreRegisteredProject:failed",
      monotonicMs: 42.5,
      localRequestId: 3,
      projectId: "project-smoke",
      requestId: "scan-smoke",
      error: "synthetic failure"
    };

    expect(parseGraphSmokeTraceMessage(`${GRAPH_SMOKE_TRACE_PREFIX}${JSON.stringify(event)}`)).toEqual(event);
    expect(parseGraphSmokeTraceMessage("unrelated renderer message")).toBeUndefined();
  });

  it("rejects malformed prefixed trace records", () => {
    expect(() => parseGraphSmokeTraceMessage(`${GRAPH_SMOKE_TRACE_PREFIX}{`)).toThrow("Invalid graph smoke trace message");
  });
});

import { describe, expect, it } from "vitest";
import { hasCanvasProfilerGraphChange, recordCanvasProfilerCommit, type CanvasProfilerCapture } from "../../src/utils/react-profiler";

describe("Canvas React Profiler capture", () => {
  it("records component timing and the action active at commit time", () => {
    const capture: CanvasProfilerCapture = { reactVersion: "19.2.6", currentAction: "expand-group", samples: [] };

    recordCanvasProfilerCommit(capture, "CanvasWorkspace", "update", 2.5, 6.5, 10, 13);

    expect(capture.samples).toEqual([{
      componentId: "CanvasWorkspace",
      phase: "update",
      actualDuration: 2.5,
      baseDuration: 6.5,
      startTime: 10,
      commitTime: 13,
      action: "expand-group"
    }]);
  });

  it("detects filter effects from visible node or edge membership, independent of ordering", () => {
    expect(hasCanvasProfilerGraphChange(
      { nodeIds: ["a", "b"], edgeIds: ["a-b"] },
      { nodeIds: ["b", "a"], edgeIds: ["a-b"] }
    )).toBe(false);
    expect(hasCanvasProfilerGraphChange(
      { nodeIds: ["a", "b"], edgeIds: ["a-b"] },
      { nodeIds: ["a"], edgeIds: [] }
    )).toBe(true);
    expect(hasCanvasProfilerGraphChange(
      { nodeIds: ["a"], edgeIds: ["a-b"] },
      { nodeIds: ["a"], edgeIds: [] }
    )).toBe(true);
  });
});

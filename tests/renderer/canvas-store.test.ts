import { afterEach, describe, expect, it } from "vitest";
import { useCanvasStore } from "../../src/stores/canvas.store";
import type { CanvasLayoutState, GraphNode } from "../../src/types";

describe("canvas store layout modes", () => {
  afterEach(() => {
    useCanvasStore.getState().setGraph([], [], [], manualLayout);
  });

  it("uses execution for a newly generated graph", () => {
    useCanvasStore.getState().setGraph([moduleNode], [], []);

    expect(useCanvasStore.getState().canvasLayout.activeMode).toBe("execution");
  });

  it("preserves a previously stored layout mode when restoring a graph", () => {
    useCanvasStore.getState().setGraph([moduleNode], [], [], { ...manualLayout, activeMode: "runtime" });

    expect(useCanvasStore.getState().canvasLayout.activeMode).toBe("runtime");
  });
});

const manualLayout: CanvasLayoutState = {
  activeMode: "manual",
  manualPositions: {},
  autoLayouts: {},
  collapsedGroups: []
};

const moduleNode: GraphNode = {
  id: "module",
  title: "Module",
  subtitle: "Module",
  kind: "module",
  nodeType: "service",
  risk: "unknown",
  description: "Module",
  files: ["src/module.ts"],
  guidanceDraft: "",
  status: "mapped",
  x: 0,
  y: 0
};

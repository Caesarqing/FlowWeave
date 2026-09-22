import { afterEach, describe, expect, it } from "vitest";
import { useCanvasStore } from "../../src/stores/canvas.store";
import type { CanvasLayoutState, GraphEdge, GraphNode } from "../../src/types";

describe("canvas store layout modes", () => {
  afterEach(() => {
    useCanvasStore.getState().setGraph([], [], [], manualLayout);
  });

  it("uses execution for a newly generated graph", () => {
    useCanvasStore.getState().setGraph([moduleNode], [], []);

    expect(useCanvasStore.getState().canvasLayout.activeMode).toBe("execution");
  });

  it("records the topology fingerprint that produced an automatic layout", () => {
    useCanvasStore.getState().setGraph([moduleNode], [], []);

    useCanvasStore.getState().applyAutoLayout("execution", { module: { x: 80, y: 120 } }, "topology-a");

    expect(useCanvasStore.getState().canvasLayout.autoLayoutTopologyFingerprints).toEqual({ execution: "topology-a" });
  });

  it("preserves a previously stored layout mode when restoring a graph", () => {
    useCanvasStore.getState().setGraph([moduleNode], [], [], { ...manualLayout, activeMode: "technology" });

    expect(useCanvasStore.getState().canvasLayout.activeMode).toBe("technology");
  });

  it("retains orphaned manual edges when restoring a v5 Canvas", () => {
    const orphanedEdges: GraphEdge[] = [{
      id: "orphan",
      source: "manual-node",
      target: "removed-node",
      relation: "calls",
      origin: "manual"
    }];

    useCanvasStore.getState().setGraph([moduleNode], [], [], manualLayout, orphanedEdges);

    expect(useCanvasStore.getState().orphanedEdges).toEqual(orphanedEdges);
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

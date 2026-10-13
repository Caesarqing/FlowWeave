import { afterEach, describe, expect, it } from "vitest";
import { useCanvasStore } from "../../src/stores/canvas.store";
import { useProjectStore } from "../../src/stores/project.store";
import type { CanvasLayoutState, GraphEdge, GraphNode } from "../../src/types";

describe("canvas store layout modes", () => {
  afterEach(() => {
    useCanvasStore.getState().setGraph([], [], [], manualLayout);
    useProjectStore.setState({ projectId: "", isProjectLoading: false, isCanvasTransitioning: false, artifactStatuses: undefined });
  });

  it("rejects a module edit while the displayed generation is being analyzed", () => {
    useCanvasStore.getState().setGraph([moduleNode], [], []);
    useProjectStore.setState({ projectId: "project", isProjectLoading: true,
      artifactStatuses: { project: "current", canvas: "current", task: "missing", context: "missing", architecture: "current", sequences: "missing" } });

    expect(() => useCanvasStore.getState().updateModule("module", (node) => ({ ...node, title: "Lost" })))
      .toThrow("not editable");
    expect(useCanvasStore.getState().modules[0].title).toBe("Module");
  });

  it("rejects an edit during an asynchronous project-tab transition", () => {
    useCanvasStore.getState().setGraph([moduleNode], [], []);
    useProjectStore.setState({ projectId: "project", isProjectLoading: false, isCanvasTransitioning: true,
      artifactStatuses: { project: "current", canvas: "current", task: "missing", context: "missing", architecture: "current", sequences: "missing" } });

    expect(() => useCanvasStore.getState().updateModule("module", (node) => ({ ...node, title: "Lost" })))
      .toThrow("not editable");
    expect(useCanvasStore.getState().modules[0].title).toBe("Module");
  });

  it("chooses the initial graph view from the available relationships", () => {
    useCanvasStore.getState().setGraph([moduleNode], [], []);
    expect(useCanvasStore.getState().canvasLayout.viewMode).toBe("execution");
    expect(useCanvasStore.getState().selectedNodeId).toBe("");

    useCanvasStore.getState().setGraph([moduleNode, { ...moduleNode, id: "next" }], [
      { id: "dependency", source: "module", target: "next", relation: "depends_on" }
    ], []);
    expect(useCanvasStore.getState().canvasLayout.viewMode).toBe("execution");

    useCanvasStore.getState().setGraph([moduleNode, { ...moduleNode, id: "next" }], [
      { id: "runtime", source: "module", target: "next", relation: "calls" }
    ], []);

    expect(useCanvasStore.getState().canvasLayout.activeMode).toBe("execution");
    expect(useCanvasStore.getState().canvasLayout.viewMode).toBe("execution");
  });

  it("persists the graph view separately from manual positioning", () => {
    useCanvasStore.getState().setGraph([moduleNode], [], [], { ...manualLayout, viewMode: "dependency" });

    useCanvasStore.getState().setViewMode("dependency");

    expect(useCanvasStore.getState().canvasLayout.viewMode).toBe("dependency");
    expect(useCanvasStore.getState().canvasLayout.activeMode).toBe("manual");
  });

  it("records the topology fingerprint that produced an automatic layout", () => {
    useCanvasStore.getState().setGraph([moduleNode], [], []);
    const handleLayout = {
      positions: { module: { x: 80, y: 120 } },
      handles: {},
      topologyFingerprint: "handle-topology-a"
    };

    useCanvasStore.getState().applyAutoLayout("execution", { module: { x: 80, y: 120 } }, "topology-a", handleLayout);

    expect(useCanvasStore.getState().canvasLayout.autoLayoutTopologyFingerprints).toEqual({ execution: "topology-a" });
    expect(useCanvasStore.getState().canvasLayout.autoConnectionHandles?.execution).toEqual(handleLayout);
  });

  it("captures the displayed graph before recording the first manual drag", () => {
    const secondModule = { ...moduleNode, id: "second", x: 400, y: 200 };
    useCanvasStore.getState().setGraph([moduleNode, secondModule], [], [], {
      ...manualLayout,
      activeMode: "execution",
      autoLayouts: { execution: { module: { x: 100, y: 80 }, second: { x: 500, y: 280 } } }
    });
    useCanvasStore.getState().syncNodePositions(
      [{ id: "module", type: "position", position: { x: 140, y: 120 } }],
      { module: { x: 100, y: 80 }, second: { x: 500, y: 280 }, "group:src": { x: 900, y: 80 } }
    );

    expect(useCanvasStore.getState().canvasLayout.manualPositions).toEqual({
      module: { x: 140, y: 120 },
      second: { x: 500, y: 280 },
      "group:src": { x: 900, y: 80 }
    });
  });

  it("retains ELK handle geometry alongside the positions that produced it", () => {
    const autoConnectionHandles = {
      execution: {
        positions: { module: { x: 20, y: 40 } },
        handles: { module: {
          source: [{ id: "module-source-edge", edgeId: "edge", position: "right" as const, offsetPercent: 25, count: 1 }],
          target: []
        } }
      }
    };
    useCanvasStore.getState().setGraph([moduleNode], [], [], { ...manualLayout, autoConnectionHandles });

    expect(useCanvasStore.getState().canvasLayout.autoConnectionHandles).toEqual(autoConnectionHandles);
  });

  it("keeps the first-view unlinked module group when restoring the generated layout", () => {
    useCanvasStore.getState().setGraph([moduleNode], [], [], {
      ...manualLayout,
      activeMode: "execution",
      viewMode: "execution",
      collapsedGroups: ["view:unlinked"]
    });
    expect(useCanvasStore.getState().canvasLayout.collapsedGroups).toEqual(["view:unlinked"]);
  });

  it("keeps positions for hidden resource nodes when laying out the visible modules", () => {
    useCanvasStore.getState().setGraph([moduleNode, { ...moduleNode, id: "resource" }], [], [], {
      ...manualLayout,
      activeMode: "execution",
      autoLayouts: { execution: { module: { x: 0, y: 0 }, resource: { x: 400, y: 200 } } }
    });
    useCanvasStore.getState().applyAutoLayout("execution", { module: { x: 80, y: 120 } }, "visible-topology");
    expect(useCanvasStore.getState().canvasLayout.autoLayouts.execution).toEqual({
      module: { x: 80, y: 120 }, resource: { x: 400, y: 200 }
    });
  });

  it("maps obsolete layout modes to the functional view when restoring a graph", () => {
    const oldLayout = {
      ...manualLayout,
      activeMode: "technology",
      viewMode: "architecture",
      autoLayouts: {
        execution: { module: { x: 1, y: 2 } },
        dependency: { module: { x: 3, y: 4 } },
        architecture: { module: { x: 5, y: 6 } },
        technology: { module: { x: 7, y: 8 } },
        domain: { module: { x: 9, y: 10 } }
      },
      autoLayoutTopologyFingerprints: {
        architecture: "old-architecture",
        technology: "old-technology",
        domain: "old-domain"
      }
    } as unknown as CanvasLayoutState;
    useCanvasStore.getState().setGraph([moduleNode], [], [], oldLayout);

    expect(useCanvasStore.getState().canvasLayout.activeMode).toBe("execution");
    expect(useCanvasStore.getState().canvasLayout.viewMode).toBe("execution");
    expect(useCanvasStore.getState().canvasLayout.autoLayouts).toEqual({
      execution: { module: { x: 1, y: 2 } },
      dependency: { module: { x: 3, y: 4 } }
    });
    expect(useCanvasStore.getState().canvasLayout.autoLayoutTopologyFingerprints).toBeUndefined();
  });

  it("retains orphaned manual edges when restoring a v6 Canvas", () => {
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

  it("retains the committed generation identity when restoring a Canvas", () => {
    const generation = { requestId: "request-a", inputFingerprint: "fingerprint-a" };
    const generatedAt = "2026-10-05T02:00:00.000Z";
    useCanvasStore.getState().setGraph([moduleNode], [], [], manualLayout, [], { generation, generatedAt });

    expect(useCanvasStore.getState().generation).toEqual(generation);
    expect(useCanvasStore.getState().generatedAt).toBe(generatedAt);
  });

  it("keeps unresolved legacy migration items available after restoring a project", () => {
    const migrationPendingItems = [{
      kind: "node" as const,
      sourceVersion: 4 as const,
      sourceId: "legacy-note",
      raw: { id: "legacy-note", title: "Keep this edit" },
      reason: "Legacy origin cannot be determined."
    }];
    useCanvasStore.getState().setGraph([moduleNode], [], [], manualLayout, [], { migrationPendingItems });

    expect(useCanvasStore.getState().migrationPendingItems).toEqual(migrationPendingItems);
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

import { applyNodeChanges } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import { afterEach, describe, expect, it } from "vitest";
import { useCanvasStore } from "../../src/stores/canvas.store";
import type { GraphNode } from "../../src/types";
import { applyCanvasLayoutResult, canUseLocalCanvasLayout, type CanvasLayoutRequestContext } from "../../src/utils/canvas-layout-request";
import { canvasTopologyFingerprint, layoutCanvasNodesWithPortsWithEngine } from "../../src/utils/canvas-layout";

const moduleNode: GraphNode = {
  id: "orders", title: "Orders", subtitle: "", kind: "module", nodeType: "service", risk: "unknown",
  description: "Orders boundary", files: ["src/orders.ts"], guidanceDraft: "", status: "mapped",
  x: 10, y: 20, origin: "generated"
};
const viewIdentity = { generationId: "generation-1", userRevision: 0, viewRequestId: "project:generation-1:0:0" };

function currentContext(): CanvasLayoutRequestContext {
  const state = useCanvasStore.getState();
  const manualPositionRevision = JSON.stringify(Object.entries(state.canvasLayout.manualPositions)
    .sort(([left], [right]) => left.localeCompare(right)));
  return {
    identity: viewIdentity,
    layoutMode: "dependency",
    activeMode: state.canvasLayout.activeMode,
    manualPositionRevision,
    topologyFingerprint: canvasTopologyFingerprint(state.nodes, state.edges, {
      projectId: "project", generationId: "generation-1", viewport: { width: 960, height: 640 }, manualPositionRevision
    })
  };
}

function requestLayout() {
  const state = useCanvasStore.getState();
  const request = currentContext();
  const engineResult = Promise.withResolvers<ElkNode>();
  const layout = layoutCanvasNodesWithPortsWithEngine(
    state.nodes, state.edges, "dependency", () => engineResult.promise, state.edges
  );
  const controller = new AbortController();
  const applied = applyCanvasLayoutResult(layout, request, currentContext, state.applyAutoLayout, controller.signal);
  return { applied, engineResult, request, controller };
}

describe("Canvas Arrange result and store positions", () => {
  afterEach(() => useCanvasStore.getState().setGraph([], [], []));

  it("rejects a queued local layout after its project, generation, or layout mode changes", () => {
    const request = { projectId: "project-a", generationId: "generation-1", layoutMode: "execution" as const, activeMode: "execution" as const };

    expect(canUseLocalCanvasLayout(request, request)).toBe(true);
    expect(canUseLocalCanvasLayout(request, { ...request, projectId: "project-b" })).toBe(false);
    expect(canUseLocalCanvasLayout(request, { ...request, generationId: "generation-2" })).toBe(false);
    expect(canUseLocalCanvasLayout(request, { ...request, layoutMode: "dependency" })).toBe(false);
    expect(canUseLocalCanvasLayout(request, { ...request, activeMode: "manual" })).toBe(false);
  });

  it("preserves a drag made while an explicit Arrange result is pending", async () => {
    useCanvasStore.getState().setGraph([moduleNode], [], [], {
      activeMode: "dependency", viewMode: "dependency", manualPositions: { orders: { x: 10, y: 20 } },
      autoLayouts: { dependency: { orders: { x: 10, y: 20 } } }, collapsedGroups: []
    });
    const { applied, engineResult } = requestLayout();
    const changes = [{ type: "position" as const, id: "orders", position: { x: 420, y: 360 }, dragging: false }];
    const state = useCanvasStore.getState();
    state.setNodes(applyNodeChanges(changes, state.nodes));
    state.syncNodePositions(changes);

    engineResult.resolve({ id: "flowweave-canvas", children: [{ id: "orders", x: 80, y: 120 }] });
    await applied;

    const current = useCanvasStore.getState();
    expect(current.nodes[0].position).toEqual({ x: 420, y: 360 });
    expect(current.modules[0]).toMatchObject({ x: 420, y: 360 });
    expect(current.canvasLayout.activeMode).toBe("manual");
    expect(current.canvasLayout.manualPositions.orders).toEqual({ x: 420, y: 360 });
    expect(current.canvasLayout.autoLayouts.dependency?.orders).toEqual({ x: 10, y: 20 });
  });

  it("applies an explicit Arrange result when its context remains unchanged", async () => {
    useCanvasStore.getState().setGraph([moduleNode], [], [], {
      activeMode: "manual", viewMode: "dependency", manualPositions: { orders: { x: 10, y: 20 } },
      autoLayouts: {}, collapsedGroups: []
    });
    const { applied, engineResult, request } = requestLayout();

    engineResult.resolve({ id: "flowweave-canvas", children: [{ id: "orders", x: 80, y: 120 }] });
    await applied;

    const current = useCanvasStore.getState();
    expect(current.nodes[0].position).toEqual({ x: 80, y: 120 });
    expect(current.modules[0]).toMatchObject({ x: 80, y: 120 });
    expect(current.canvasLayout.activeMode).toBe("dependency");
    expect(current.canvasLayout.manualPositions.orders).toEqual({ x: 10, y: 20 });
    expect(current.canvasLayout.autoLayoutTopologyFingerprints?.dependency).toBe(request.topologyFingerprint);
  });

  it("leaves the store unchanged when workspace unmount cancels pending Arrange", async () => {
    useCanvasStore.getState().setGraph([moduleNode], [], [], {
      activeMode: "manual", viewMode: "dependency", manualPositions: { orders: { x: 10, y: 20 } },
      autoLayouts: {}, collapsedGroups: []
    });
    const { applied, engineResult, controller } = requestLayout();
    const beforeUnmount = useCanvasStore.getState();

    controller.abort();
    engineResult.resolve({ id: "flowweave-canvas", children: [{ id: "orders", x: 80, y: 120 }] });
    await applied;

    expect(useCanvasStore.getState()).toBe(beforeUnmount);
  });
});

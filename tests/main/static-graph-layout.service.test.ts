import { expect, it } from "vitest";
import ELK from "elkjs/lib/main.js";
import type { ElkNode, ElkPort } from "elkjs/lib/elk-api";
import { layoutStaticGraph } from "../../src/main/services/static-graph-layout.service";
import { createFlowEdge, createFlowNode, decorateFlowGraph, expandedGroupsForGroup, projectCollapsedFlowGraph } from "../../src/utils/graph-converters";
import { CANVAS_NODE_SIZE } from "../../src/common/canvas-geometry";
import { selectOverviewFrontier } from "../../src/utils/graph-view-projection";
import { canvasTopologyFingerprint } from "../../src/utils/canvas-layout";
import { graphEdges, graphNodes } from "./graph.fixture";

it("precomputes stable, non-overlapping overview coordinates matching the renderer topology", async () => {
  const first = await layoutStaticGraph(graphNodes, graphEdges, "execution");
  const second = await layoutStaticGraph(graphNodes, graphEdges, "execution");
  expect(second.positions).toEqual(first.positions);

  const nodeById = new Map(graphNodes.map((node) => [node.id, node]));
  const layoutEdges = graphEdges.filter((edge) => edge.relation === "calls" && edge.confidence === "confirmed" &&
    nodeById.get(edge.source)?.nodeType !== "test" && nodeById.get(edge.target)?.nodeType !== "test");
  expect(first.topologyFingerprint).toBe(canvasTopologyFingerprint(
    graphNodes.map(createFlowNode),
    layoutEdges.map(createFlowEdge)
  ));
  const changedArea = graphNodes.map((node, index) => index === 0 ? { ...node, areaId: "area:changed" } : node);
  const changed = await layoutStaticGraph(changedArea, graphEdges, "execution");
  expect(changed.topologyFingerprint).not.toBe(first.topologyFingerprint);
  expect(changed.topologyFingerprint).toBe(canvasTopologyFingerprint(
    changedArea.map(createFlowNode),
    layoutEdges.map(createFlowEdge)
  ));

  const positioned = Object.entries(first.positions);
  for (let index = 0; index < positioned.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < positioned.length; otherIndex += 1) {
      const left = positioned[index][1];
      const right = positioned[otherIndex][1];
      const separated = left.x + 280 <= right.x || right.x + 280 <= left.x || left.y + 150 <= right.y || right.y + 150 <= left.y;
      expect(separated, `${positioned[index][0]} overlaps ${positioned[otherIndex][0]}`).toBe(true);
    }
  }
});

it("uses stable handle positions from ELK edge-section endpoints and preserves edge direction", async () => {
  const nodeIds = ["source-a", "source-b", "source-c", "hub", "target-a", "target-b", "target-c"];
  const nodes = nodeIds.map((id) => ({ ...graphNodes[0], id, title: id }));
  const edges = [
    { id: "source-a-hub", source: "source-a", target: "hub", relation: "calls" as const, confidence: "confirmed" as const },
    { id: "source-b-hub", source: "source-b", target: "hub", relation: "calls" as const, confidence: "confirmed" as const },
    { id: "source-c-hub", source: "source-c", target: "hub", relation: "calls" as const, confidence: "confirmed" as const },
    { id: "hub-target-a", source: "hub", target: "target-a", relation: "calls" as const, confidence: "confirmed" as const },
    { id: "hub-target-b", source: "hub", target: "target-b", relation: "calls" as const, confidence: "confirmed" as const },
    { id: "hub-target-c", source: "hub", target: "target-c", relation: "calls" as const, confidence: "confirmed" as const }
  ];
  const firstLayout = await layoutStaticGraph(nodes, edges, "execution");
  const secondLayout = await layoutStaticGraph(nodes, edges, "execution");
  const elkInput: ElkNode = {
    id: "flowweave-static-overview",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.layering.strategy": "LONGEST_PATH",
      "elk.spacing.nodeNode": "70",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.padding": "[top=60,left=60,bottom=60,right=60]"
    },
    children: [...nodes].sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => ({ id: node.id, width: CANVAS_NODE_SIZE.width, height: CANVAS_NODE_SIZE.height })),
    edges: [...edges].sort((left, right) => left.id.localeCompare(right.id))
      .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] }))
  };
  const initialGraph = await new ELK().layout(elkInput);
  const initialHandles = expectedConnectionHandles(initialGraph, edges, false);
  const expectedGraph = await layoutExpectedPorts(elkInput, initialHandles, edges);
  const expectedHandles = expectedConnectionHandles(expectedGraph, edges, true);

  expect(firstLayout.connectionHandles).toEqual(expectedHandles);
  expect(secondLayout.connectionHandles).toEqual(expectedHandles);

  const rendered = decorateFlowGraph(
    firstLayout.nodes.map(createFlowNode),
    edges.map(createFlowEdge),
    undefined,
    firstLayout.connectionHandles
  );
  const renderedEdgeById = new Map(rendered.edges.map((edge) => [edge.id, edge]));
  for (const edge of edges) {
    const sourceHandle = expectedHandles[edge.source].source.find((slot) => slot.edgeId === edge.id);
    const targetHandle = expectedHandles[edge.target].target.find((slot) => slot.edgeId === edge.id);
    expect(renderedEdgeById.get(edge.id)?.sourceHandle).toBe(sourceHandle?.id);
    expect(renderedEdgeById.get(edge.id)?.targetHandle).toBe(targetHandle?.id);
  }
  expect(rendered.nodes.find((node) => node.id === "hub")?.data.connectionHandles).toEqual(expectedHandles.hub);
});

function expectedConnectionHandles(
  graph: ElkNode,
  edges: typeof graphEdges,
  hasPorts: boolean
): Record<string, import("../../src/types").ConnectionHandleLayout> {
  const layoutNodes = new Map((graph.children ?? []).map((node) => [node.id, node]));
  const layoutEdges = new Map((graph.edges ?? []).map((edge) => [edge.id, edge]));
  const handles = Object.fromEntries([...layoutNodes.keys()].map((id) => [id, { source: [], target: [] }])) as
    Record<string, import("../../src/types").ConnectionHandleLayout>;
  for (const edge of edges) {
    const layoutEdge = layoutEdges.get(edge.id);
    const source = layoutNodes.get(edge.source);
    const target = layoutNodes.get(edge.target);
    if (!layoutEdge?.sections?.length || !source || !target) throw new Error(`ELK omitted endpoint sections for ${edge.id}`);
    const sourcePort = hasPorts ? `flowweave-port-${edge.id}-source` : edge.source;
    const targetPort = hasPorts ? `flowweave-port-${edge.id}-target` : edge.target;
    const section = layoutEdge.sections.find((item) => item.incomingShape === sourcePort && item.outgoingShape === targetPort);
    if (!section) throw new Error(`ELK edge section does not preserve direction for ${edge.id}`);
    handles[edge.source].source.push(elkHandleSlot(edge.id, edge.relation, section.startPoint, source, "source"));
    handles[edge.target].target.push(elkHandleSlot(edge.id, edge.relation, section.endPoint, target, "target"));
  }
  for (const layout of Object.values(handles)) {
    layout.source.sort((left, right) => left.offsetPercent - right.offsetPercent || left.id.localeCompare(right.id));
    layout.target.sort((left, right) => left.offsetPercent - right.offsetPercent || left.id.localeCompare(right.id));
  }
  return handles;
}

async function layoutExpectedPorts(
  input: ElkNode,
  initialHandles: Record<string, import("../../src/types").ConnectionHandleLayout>,
  edges: typeof graphEdges
): Promise<ElkNode> {
  const portsByEdge = new Map(edges.map((edge) => [edge.id, {
    source: `flowweave-port-${edge.id}-source`,
    target: `flowweave-port-${edge.id}-target`
  }]));
  const portsByNode = new Map<string, Array<{ id: string; side: NonNullable<import("../../src/types").ConnectionHandleSlot["position"]>; offset: number }>>();
  for (const edge of edges) {
    const source = initialHandles[edge.source].source.find((slot) => slot.edgeId === edge.id);
    const target = initialHandles[edge.target].target.find((slot) => slot.edgeId === edge.id);
    if (!source?.position || !target?.position) throw new Error(`ELK omitted planned port side: ${edge.id}`);
    portsByNode.set(edge.source, [...(portsByNode.get(edge.source) ?? []), {
      id: portsByEdge.get(edge.id)!.source, side: source.position, offset: source.offsetPercent
    }]);
    portsByNode.set(edge.target, [...(portsByNode.get(edge.target) ?? []), {
      id: portsByEdge.get(edge.id)!.target, side: target.position, offset: target.offsetPercent
    }]);
  }
  const elkSide = { left: "WEST", right: "EAST", top: "NORTH", bottom: "SOUTH" } as const;
  const children = (input.children ?? []).map((node) => {
    const nodePorts = portsByNode.get(node.id);
    if (!nodePorts?.length) return node;
    const grouped = new Map<typeof nodePorts[number]["side"], typeof nodePorts>();
    for (const port of nodePorts) grouped.set(port.side, [...(grouped.get(port.side) ?? []), port]);
    const ports: ElkPort[] = [...grouped.entries()].flatMap(([side, sidePorts]) => {
      const ordered = [...sidePorts].sort((left, right) => left.offset - right.offset || left.id.localeCompare(right.id));
      return ordered.map((port, index) => ({
        id: port.id,
        width: 0,
        height: 0,
        layoutOptions: {
          "elk.port.side": elkSide[side],
          "elk.port.index": String(side === "left" || side === "bottom" ? ordered.length - index - 1 : index)
        }
      }));
    });
    return { ...node, layoutOptions: { "elk.portConstraints": "FIXED_ORDER" }, ports };
  });
  const constrainedEdges = (input.edges ?? []).map((edge) => ({
    ...edge,
    sources: [portsByEdge.get(edge.id)!.source],
    targets: [portsByEdge.get(edge.id)!.target]
  }));
  return new ELK().layout({ ...input, children, edges: constrainedEdges });
}

function elkHandleSlot(
  edgeId: string,
  relation: string,
  point: { x: number; y: number },
  node: NonNullable<ElkNode["children"]>[number],
  side: "source" | "target"
) {
  const boundaries = [
    { position: "left" as const, coordinate: point.x, boundary: node.x ?? 0, size: node.height ?? CANVAS_NODE_SIZE.height, offset: point.y - (node.y ?? 0) },
    { position: "right" as const, coordinate: point.x, boundary: (node.x ?? 0) + (node.width ?? CANVAS_NODE_SIZE.width), size: node.height ?? CANVAS_NODE_SIZE.height, offset: point.y - (node.y ?? 0) },
    { position: "top" as const, coordinate: point.y, boundary: node.y ?? 0, size: node.width ?? CANVAS_NODE_SIZE.width, offset: point.x - (node.x ?? 0) },
    { position: "bottom" as const, coordinate: point.y, boundary: (node.y ?? 0) + (node.height ?? CANVAS_NODE_SIZE.height), size: node.width ?? CANVAS_NODE_SIZE.width, offset: point.x - (node.x ?? 0) }
  ];
  const boundary = boundaries.find(({ coordinate, boundary }) => Math.abs(coordinate - boundary) < 0.001);
  if (!boundary || boundary.size <= 0) throw new Error(`ELK endpoint is not on a node boundary: edge ${edgeId}, node ${node.id}`);
  return {
    id: `${node.id}-${side}-${edgeId}`,
    edgeId,
    position: boundary.position,
    offsetPercent: boundary.offset / boundary.size * 100,
    count: 1,
    relation
  };
}

it("keeps the initial module layout compact when unrelated resources are discovered", async () => {
  const baseline = await layoutStaticGraph(graphNodes, graphEdges, "execution");
  const resourceNodes = Array.from({ length: 12 }, (_, index) => ({
    ...graphNodes[0], id: `resource:${index}`, files: [],
    resource: { id: `resource:${index}`, kind: "api" as const, scopeId: "app", key: `${index}`, title: `External ${index}`, detail: "", evidence: [] }
  }));
  const expanded = await layoutStaticGraph([...graphNodes, ...resourceNodes], graphEdges, "execution");
  for (const node of graphNodes.filter((item) => item.nodeType !== "test")) {
    expect(expanded.positions[node.id]).toEqual(baseline.positions[node.id]);
  }
  for (const node of resourceNodes) expect(expanded.positions[node.id]).toBeDefined();
});

it("keeps the static layout complete and leaves overview grouping to the viewport projection", async () => {
  const nodes = Array.from({ length: 30 }, (_, index) => ({
    ...graphNodes[0], id: `module:${index}`, areaId: `area:${Math.floor(index / 10)}`
  }));
  const edges = [
    { id: "cross-area", source: "module:0", target: "module:10", relation: "calls" as const, confidence: "confirmed" as const }
  ];
  const layout = await layoutStaticGraph(nodes, edges, "execution");
  expect(layout.collapsedGroups).toEqual([]);
  expect(layout.positions["module:0"]).toBeDefined();
  expect(layout.positions["module:29"]).toBeDefined();
  expect(layout.nodes.filter((node) => node.overviewGroup?.id === "view:unlinked")).toHaveLength(28);
  const overview = selectOverviewFrontier({
    nodes: layout.nodes,
    viewport: { width: 960, height: 640 },
    cardSize: { width: 280, height: 150 },
    collapsedGroupIds: [],
    expandedGroupIds: [],
    identity: { generationId: "generation-layout", userRevision: 0, viewRequestId: "960x640" }
  });
  expect(overview.collapsedGroupIds).toContain("view:unlinked");
  const projected = projectCollapsedFlowGraph(layout.nodes.map(createFlowNode), edges.map(createFlowEdge), "execution", overview.collapsedGroupIds);
  expect(projected.nodes.flatMap((node) => node.data.memberNodeIds ?? [node.id]).sort()).toEqual(nodes.map((node) => node.id).sort());
  expect(projected.nodes.map((node) => node.id).sort()).toEqual(overview.visibleNodeIds);
  expect(projected.edges).toHaveLength(1);
  expect(projected.nodes.find((node) => node.id === "group:view:unlinked")).toMatchObject({ initialWidth: 248, initialHeight: 172 });
  const expandedGroups = expandedGroupsForGroup(layout.nodes, "execution", "view:unlinked", overview.collapsedGroupIds);
  expect(expandedGroups).not.toContain("view:unlinked");
  expect(projectCollapsedFlowGraph(layout.nodes.map(createFlowNode), edges.map(createFlowEdge), "execution", expandedGroups)
    .nodes.flatMap((node) => node.data.memberNodeIds ?? [node.id]).sort()).toEqual(nodes.map((node) => node.id).sort());
});

it("selects a large functional area using available viewport capacity", async () => {
  const nodes = Array.from({ length: 21 }, (_, index) => ({
    ...graphNodes[0], id: `module:${index}`, areaId: index < 11 ? "area:examples" : `area:${index}`
  }));
  const edges = Array.from({ length: 20 }, (_, index) => ({
    id: `call:${index}`,
    source: `module:${index}`,
    target: `module:${index + 1}`,
    relation: "calls" as const,
    confidence: "confirmed" as const
  }));
  const layout = await layoutStaticGraph(nodes, edges, "execution");
  const overview = selectOverviewFrontier({
    nodes: layout.nodes,
    viewport: { width: 1440, height: 900 },
    cardSize: { width: 280, height: 150 },
    collapsedGroupIds: [],
    expandedGroupIds: [],
    identity: { generationId: "generation-medium", userRevision: 0, viewRequestId: "1440x900" }
  });
  const projected = projectCollapsedFlowGraph(layout.nodes.map(createFlowNode), edges.map(createFlowEdge), "execution", overview.collapsedGroupIds);
  expect(layout.collapsedGroups).toEqual([]);
  expect(overview.collapsedGroupIds).toContain("area:examples");
  expect(projected.nodes.length).toBeLessThanOrEqual(overview.readability.maximumReadableNodeCount);
  expect(projected.nodes.flatMap((node) => node.data.memberNodeIds ?? [node.id]).sort()).toEqual(nodes.map((node) => node.id).sort());
  expect(projected.nodes.map((node) => node.id).sort()).toEqual(overview.visibleNodeIds);
  const projectedEdgeIds = [
    ...projected.edges.flatMap((edge) => edge.data?.aggregatedEdgeIds as string[] | undefined ?? [edge.id]),
    ...projected.nodes.flatMap((node) => node.data.internalEdgeIds ?? [])
  ].sort();
  expect(projectedEdgeIds).toEqual(edges.map((edge) => edge.id).sort());
});

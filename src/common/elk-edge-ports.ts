import type { ConnectionHandleLayout, ConnectionHandleSlot, GraphEdgeRelation } from "../types";
import type { ElkExtendedEdge, ElkNode, ElkPoint, ElkPort } from "elkjs/lib/elk-api";
import { CANVAS_NODE_SIZE } from "./canvas-geometry";

export type ElkPortEdge = { id: string; source: string; target: string; relation: GraphEdgeRelation };
export type ElkPortLayout = { graph: ElkNode; connectionHandles: Record<string, ConnectionHandleLayout> };

type HandleSide = NonNullable<ConnectionHandleSlot["position"]>;
type PortSide = "EAST" | "WEST" | "NORTH" | "SOUTH";
type PortEndpoint = { side: HandleSide; offset: number };
type EdgePorts = { source: string; target: string; sourceSide: HandleSide; targetSide: HandleSide };
type PortPlanItem = { edgeId: string; endpoint: "source" | "target"; portId: string; nodeId: string; side: HandleSide; offset: number };

export async function layoutElkGraphWithEdgePorts(
  input: ElkNode,
  initialGraph: ElkNode,
  edges: ElkPortEdge[],
  layout: (graph: ElkNode) => Promise<ElkNode>
): Promise<ElkPortLayout> {
  if (edges.length === 0) return { graph: initialGraph, connectionHandles: emptyHandleLayouts(initialGraph) };
  const plan = portPlan(initialGraph, edges);
  const constrainedGraph = graphWithOrderedPorts(input, edges, plan);
  const graph = await layout(constrainedGraph);
  return { graph, connectionHandles: connectionHandlesFromElkGraph(graph, edges, plan.portsByEdge) };
}

export async function layoutElkGraphWithFixedEdgePorts(
  positionedGraph: ElkNode,
  initialGraph: ElkNode,
  edges: ElkPortEdge[],
  layout: (graph: ElkNode) => Promise<ElkNode>
): Promise<ElkPortLayout> {
  if (edges.length === 0) return { graph: positionedGraph, connectionHandles: emptyHandleLayouts(positionedGraph) };
  const plan = portPlan(initialGraph, edges);
  const graph = await layout(graphWithFixedPorts(positionedGraph, edges, plan));
  return { graph, connectionHandles: connectionHandlesFromElkGraph(graph, edges, plan.portsByEdge) };
}

function portPlan(graph: ElkNode, edges: ElkPortEdge[]): { portsByEdge: Map<string, EdgePorts>; portsByNode: Map<string, PortPlanItem[]> } {
  const nodeById = new Map((graph.children ?? []).map((node) => [node.id, node]));
  const layoutEdges = new Map((graph.edges ?? []).map((edge) => [edge.id, edge]));
  const portsByEdge = new Map<string, EdgePorts>();
  const portsByNode = new Map<string, PortPlanItem[]>();
  for (const edge of edges) {
    const layoutEdge = layoutEdges.get(edge.id);
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    const sourceSection = layoutEdge?.sections?.find((section) => section.incomingShape === edge.source && section.startPoint);
    const targetSection = layoutEdge?.sections?.find((section) => section.outgoingShape === edge.target && section.endPoint);
    if (!sourceSection?.startPoint || !targetSection?.endPoint || !sourceNode || !targetNode) {
      throw new Error(`ELK omitted edge endpoint geometry: edgeId=${edge.id} source=${edge.source} target=${edge.target}`);
    }
    const sourceEndpoint = endpointOnNode(sourceSection.startPoint, sourceNode, edge.id);
    const targetEndpoint = endpointOnNode(targetSection.endPoint, targetNode, edge.id);
    const sourcePort = `flowweave-port-${edge.id}-source`;
    const targetPort = `flowweave-port-${edge.id}-target`;
    portsByEdge.set(edge.id, { source: sourcePort, target: targetPort, sourceSide: sourceEndpoint.side, targetSide: targetEndpoint.side });
    portsByNode.set(edge.source, [...(portsByNode.get(edge.source) ?? []), {
      edgeId: edge.id, endpoint: "source", portId: sourcePort, nodeId: edge.source, ...sourceEndpoint
    }]);
    portsByNode.set(edge.target, [...(portsByNode.get(edge.target) ?? []), {
      edgeId: edge.id, endpoint: "target", portId: targetPort, nodeId: edge.target, ...targetEndpoint
    }]);
  }
  return { portsByEdge, portsByNode };
}

function graphWithOrderedPorts(input: ElkNode, edges: ElkPortEdge[], plan: ReturnType<typeof portPlan>): ElkNode {
  const children = (input.children ?? []).map((node) => {
    const ports = plan.portsByNode.get(node.id);
    if (!ports?.length) return node;
    const elkPorts = orderedPorts(ports).map((port) => ({
      id: port.portId,
      width: 0,
      height: 0,
      layoutOptions: { "elk.port.side": elkSide(port.side), "elk.port.index": String(port.index) }
    }));
    return { ...node, layoutOptions: { ...(node.layoutOptions ?? {}), "elk.portConstraints": "FIXED_ORDER" }, ports: elkPorts };
  });
  const elkEdges = edges.map((edge) => {
    const endpoints = plan.portsByEdge.get(edge.id);
    if (!endpoints) throw new Error(`ELK port mapping is missing edgeId=${edge.id}`);
    return { id: edge.id, sources: [endpoints.source], targets: [endpoints.target] } as ElkExtendedEdge;
  });
  return { ...input, children, edges: elkEdges };
}

function graphWithFixedPorts(positionedGraph: ElkNode, edges: ElkPortEdge[], plan: ReturnType<typeof portPlan>): ElkNode {
  const nodeById = new Map((positionedGraph.children ?? []).map((node) => [node.id, node]));
  const children = (positionedGraph.children ?? []).map((node) => {
    const ports = plan.portsByNode.get(node.id);
    if (!ports?.length) return node;
    const width = nodeSize(node, "width");
    const height = nodeSize(node, "height");
    const elkPorts = orderedPorts(ports).map((port) => {
      const sidePorts = orderedPorts(ports).filter((candidate) => candidate.side === port.side);
      const index = sidePorts.findIndex((candidate) => candidate.portId === port.portId);
      const offsetPercent = (index + 1) * 100 / (sidePorts.length + 1);
      return {
        id: port.portId,
        width: 0,
        height: 0,
        x: port.side === "left" ? 0 : port.side === "right" ? width : width * offsetPercent / 100,
        y: port.side === "top" ? 0 : port.side === "bottom" ? height : height * offsetPercent / 100
      };
    });
    return { ...node, layoutOptions: { ...(node.layoutOptions ?? {}), "elk.portConstraints": "FIXED_POS" }, ports: elkPorts };
  });
  const elkEdges = edges.map((edge) => {
    const endpoints = plan.portsByEdge.get(edge.id);
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!endpoints || !sourceNode || !targetNode) throw new Error(`ELK fixed port endpoint is missing: edgeId=${edge.id}`);
    const sourcePort = portById(children, endpoints.source);
    const targetPort = portById(children, endpoints.target);
    if (!sourcePort || !targetPort) throw new Error(`ELK fixed port coordinates are missing: edgeId=${edge.id}`);
    return {
      id: edge.id,
      sources: [endpoints.source],
      targets: [endpoints.target],
      sections: [{
        id: `${edge.id}_s0`,
        startPoint: { x: (sourceNode.x ?? 0) + (sourcePort.x ?? 0), y: (sourceNode.y ?? 0) + (sourcePort.y ?? 0) },
        endPoint: { x: (targetNode.x ?? 0) + (targetPort.x ?? 0), y: (targetNode.y ?? 0) + (targetPort.y ?? 0) },
        incomingShape: endpoints.source,
        outgoingShape: endpoints.target
      }]
    } as ElkExtendedEdge;
  });
  return {
    ...positionedGraph,
    layoutOptions: { "elk.algorithm": "org.eclipse.elk.fixed" },
    children,
    edges: elkEdges
  };
}

function orderedPorts(ports: PortPlanItem[]): Array<PortPlanItem & { index: number }> {
  const sorted = [...ports].sort((left, right) => left.side.localeCompare(right.side) || left.offset - right.offset ||
    left.edgeId.localeCompare(right.edgeId) || left.endpoint.localeCompare(right.endpoint));
  const sideCounts = new Map<HandleSide, number>();
  const sideIndexes = new Map<HandleSide, number>();
  for (const port of sorted) sideCounts.set(port.side, (sideCounts.get(port.side) ?? 0) + 1);
  return sorted.map((port) => {
    const index = sideIndexes.get(port.side) ?? 0;
    sideIndexes.set(port.side, index + 1);
    const count = sideCounts.get(port.side) ?? 0;
    return { ...port, index: port.side === "left" || port.side === "bottom" ? count - index - 1 : index };
  });
}

function connectionHandlesFromElkGraph(
  graph: ElkNode,
  edges: ElkPortEdge[],
  portsByEdge: ReadonlyMap<string, EdgePorts>
): Record<string, ConnectionHandleLayout> {
  const nodeById = new Map((graph.children ?? []).map((node) => [node.id, node]));
  const edgeById = new Map((graph.edges ?? []).map((edge) => [edge.id, edge]));
  const handlesByNode = new Map<string, ConnectionHandleLayout>((graph.children ?? []).map((node) => [node.id, { source: [], target: [] }]));
  for (const edge of edges) {
    const endpoints = portsByEdge.get(edge.id);
    const layoutEdge = edgeById.get(edge.id);
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    const sourceSection = layoutEdge?.sections?.find((section) => section.incomingShape === endpoints?.source && section.startPoint);
    const targetSection = layoutEdge?.sections?.find((section) => section.outgoingShape === endpoints?.target && section.endPoint);
    if (!endpoints || !sourceSection?.startPoint || !targetSection?.endPoint || !sourceNode || !targetNode) {
      throw new Error(`ELK omitted constrained edge section endpoints: edgeId=${edge.id}`);
    }
    const sourceEndpoint = endpointOnNode(sourceSection.startPoint, sourceNode, edge.id);
    const targetEndpoint = endpointOnNode(targetSection.endPoint, targetNode, edge.id);
    const sourceLayout = handlesByNode.get(edge.source);
    const targetLayout = handlesByNode.get(edge.target);
    if (!sourceLayout || !targetLayout) throw new Error(`ELK handle endpoint node is missing: edgeId=${edge.id}`);
    sourceLayout.source.push(createHandleSlot(edge, edge.source, "source", sourceEndpoint, sourceNode));
    targetLayout.target.push(createHandleSlot(edge, edge.target, "target", targetEndpoint, targetNode));
  }
  for (const handles of handlesByNode.values()) {
    handles.source.sort(compareHandleSlots);
    handles.target.sort(compareHandleSlots);
  }
  return Object.fromEntries(handlesByNode);
}

function endpointOnNode(point: ElkPoint, node: ElkNode, edgeId: string): PortEndpoint {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const width = nodeSize(node, "width");
  const height = nodeSize(node, "height");
  const candidates: Array<{ side: HandleSide; distance: number; offset: number; size: number }> = [
    { side: "left", distance: Math.abs(point.x - x), offset: point.y - y, size: height },
    { side: "right", distance: Math.abs(point.x - (x + width)), offset: point.y - y, size: height },
    { side: "top", distance: Math.abs(point.y - y), offset: point.x - x, size: width },
    { side: "bottom", distance: Math.abs(point.y - (y + height)), offset: point.x - x, size: width }
  ];
  const endpoint = candidates.sort((left, right) => left.distance - right.distance)[0];
  if (!endpoint || endpoint.distance > 0.01 || endpoint.size <= 0 || endpoint.offset < -0.01 || endpoint.offset > endpoint.size + 0.01) {
    throw new Error(`ELK endpoint is not on the node boundary: edgeId=${edgeId} nodeId=${node.id} point=${point.x},${point.y}`);
  }
  return { side: endpoint.side, offset: endpoint.offset };
}

function createHandleSlot(
  edge: ElkPortEdge,
  nodeId: string,
  endpoint: "source" | "target",
  geometry: PortEndpoint,
  node: ElkNode
): ConnectionHandleSlot {
  const size = geometry.side === "left" || geometry.side === "right" ? nodeSize(node, "height") : nodeSize(node, "width");
  return {
    id: `${nodeId}-${endpoint}-${edge.id}`,
    edgeId: edge.id,
    position: geometry.side,
    offsetPercent: geometry.offset / size * 100,
    count: 1,
    relation: edge.relation
  };
}

function nodeSize(node: ElkNode, dimension: "width" | "height"): number {
  return node[dimension] ?? CANVAS_NODE_SIZE[dimension];
}

function portById(nodes: ElkNode["children"], id: string) {
  return nodes?.flatMap((node) => node.ports ?? []).find((port) => port.id === id);
}

function elkSide(side: HandleSide): PortSide {
  const sideByHandle: Record<HandleSide, PortSide> = { left: "WEST", right: "EAST", top: "NORTH", bottom: "SOUTH" };
  return sideByHandle[side];
}

function compareHandleSlots(left: ConnectionHandleSlot, right: ConnectionHandleSlot): number {
  return left.offsetPercent - right.offsetPercent || left.id.localeCompare(right.id);
}

function emptyHandleLayouts(graph: ElkNode): Record<string, ConnectionHandleLayout> {
  return Object.fromEntries((graph.children ?? []).map((node) => [node.id, { source: [], target: [] }]));
}

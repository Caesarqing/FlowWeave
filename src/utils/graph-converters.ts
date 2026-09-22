import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { CanvasLayoutMode, ConnectionHandleLayout, GraphEdge, GraphEdgeRelation, GraphNode } from "../types";
import { cn } from "./classnames";
import { nodeGroupKey } from "./canvas-layout";
import { relationStyle } from "./relation-styles";

export const HANDLE_COLLAPSE_THRESHOLD = 6;

export type FlowNodeData = GraphNode &
  Record<string, unknown> & {
    connectionHandles?: ConnectionHandleLayout;
    edgeConnected?: boolean;
    selectedEdgeId?: string;
    selectedEdgeColor?: string;
    selectedEdgeRole?: "source" | "target";
    cycleGroupId?: string;
    isSupportNode?: boolean;
    isExecutionEntry?: boolean;
    isExecutionSink?: boolean;
  };
export type FlowWeaveNode = Node<FlowNodeData>;

export function createFlowNode(node: GraphNode): FlowWeaveNode {
  return {
    id: node.id,
    type: `${node.kind}Node`,
    position: { x: node.x, y: node.y },
    data: { ...node }
  };
}

export function createFlowEdge(edge: GraphEdge): Edge {
  const color = relationStyle[edge.relation].color;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.relation,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color },
    style: { stroke: color },
    data: { relation: edge.relation, guidanceNote: edge.guidanceNote, evidence: edge.evidence, origin: edge.origin, aggregatedEdgeIds: edge.aggregatedEdgeIds, confidence: edge.confidence, edgeClass: edge.edgeClass },
    className: cn("relation-edge", edge.relation)
  };
}

export function graphEdgeFromFlow(edge: Edge): GraphEdge {
  const relation = (edge.data?.relation as GraphEdgeRelation | undefined) ?? "depends_on";
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    relation,
    guidanceNote: edge.data?.guidanceNote as string | undefined,
    evidence: edge.data?.evidence as GraphEdge["evidence"],
    origin: edge.data?.origin as GraphEdge["origin"],
    aggregatedEdgeIds: edge.data?.aggregatedEdgeIds as string[] | undefined,
    confidence: edge.data?.confidence as GraphEdge["confidence"],
    edgeClass: edge.data?.edgeClass as GraphEdge["edgeClass"]
  };
}

export function projectCollapsedFlowGraph(
  nodes: FlowWeaveNode[],
  edges: Edge[],
  mode: CanvasLayoutMode,
  collapsedGroups: string[]
): { nodes: FlowWeaveNode[]; edges: Edge[] } {
  if (mode === "dependency" || collapsedGroups.length === 0) {
    return { nodes: [...nodes], edges: [...edges] };
  }
  const collapsed = new Set(collapsedGroups);
  const representativeByGroup = new Map<string, string>();
  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    const group = nodeGroupKey(node.data, mode);
    if (collapsed.has(group) && !representativeByGroup.has(group)) representativeByGroup.set(group, node.id);
  }
  const projectedNodeId = (node: FlowWeaveNode): string => {
    const group = nodeGroupKey(node.data, mode);
    return collapsed.has(group) ? representativeByGroup.get(group) ?? node.id : node.id;
  };
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const projectedEdges = new Map<string, Edge>();
  for (const edge of edges) {
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    if (!sourceNode || !targetNode) throw new Error(`Collapsed graph projection found unknown endpoint: edgeId=${edge.id} source=${edge.source} target=${edge.target}`);
    const source = projectedNodeId(sourceNode);
    const target = projectedNodeId(targetNode);
    if (source === target) continue;
    const relation = (edge.data?.relation as GraphEdgeRelation | undefined) ?? "depends_on";
    const key = `${source}\u0000${target}\u0000${relation}`;
    const existing = projectedEdges.get(key);
    const aggregatedEdgeIds = [...new Set([...(existing?.data?.aggregatedEdgeIds as string[] | undefined ?? []), edge.id])].sort();
    const evidence = [...(existing?.data?.evidence as GraphEdge["evidence"] ?? []), ...(edge.data?.evidence as GraphEdge["evidence"] ?? [])];
    const { sourceHandle: _sourceHandle, targetHandle: _targetHandle, ...edgeWithoutHandles } = existing ?? edge;
    projectedEdges.set(key, {
      ...edgeWithoutHandles,
      id: `aggregate:${source}:${target}:${relation}`,
      source,
      target,
      data: { ...(existing?.data ?? edge.data ?? {}), relation, evidence, aggregatedEdgeIds }
    });
  }
  return {
    nodes: nodes.filter((node) => projectedNodeId(node) === node.id),
    edges: [...projectedEdges.values()].sort((left, right) => left.id.localeCompare(right.id))
  };
}

export function decorateFlowGraph(nodes: FlowWeaveNode[], edges: Edge[], selectedEdgeId?: string) {
  const { handlesByEdge, handlesByNode } = buildConnectionHandles(nodes, edges);
  const selectedEdge = selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) : undefined;
  const selectedPair = selectedEdge ? new Set([selectedEdge.source, selectedEdge.target]) : new Set<string>();

  return {
    edges: edges.map((edge) => {
      const relation = (edge.data?.relation as GraphEdgeRelation | undefined) ?? "depends_on";
      const color = relationStyle[relation].color;
      const assignedHandles = handlesByEdge.get(edge.id);
      const isSelected = edge.id === selectedEdgeId;
      return {
        ...edge,
        sourceHandle: assignedHandles?.sourceHandle,
        targetHandle: assignedHandles?.targetHandle,
        label: relation,
        markerEnd: { type: MarkerType.ArrowClosed, color },
        style: { ...(edge.style ?? {}), stroke: color },
        className: cn("relation-edge", relation, isSelected && "selected"),
        data: { ...(edge.data ?? {}), relation }
      };
    }),
    nodes: nodes.map((node) => {
      const selectedEdgeRole: "source" | "target" | undefined =
        selectedEdge?.source === node.id ? "source" : selectedEdge?.target === node.id ? "target" : undefined;
      return {
        ...node,
        data: {
          ...node.data,
          connectionHandles: handlesByNode.get(node.id) ?? createEmptyHandleLayout(node.id),
          edgeConnected: selectedPair.has(node.id),
          selectedEdgeId,
          selectedEdgeColor: selectedEdge ? relationStyle[((selectedEdge.data?.relation as GraphEdgeRelation | undefined) ?? "depends_on")].color : undefined,
          selectedEdgeRole
        }
      };
    })
  };
}

function buildConnectionHandles(nodes: FlowWeaveNode[], edges: Edge[]) {
  const sourceGroups = new Map<string, Edge[]>();
  const targetGroups = new Map<string, Edge[]>();
  for (const node of nodes) {
    sourceGroups.set(node.id, []);
    targetGroups.set(node.id, []);
  }
  for (const edge of edges) {
    sourceGroups.get(edge.source)?.push(edge);
    targetGroups.get(edge.target)?.push(edge);
  }

  const handlesByEdge = new Map<string, { sourceHandle: string; targetHandle: string }>();
  const handlesByNode = new Map<string, ConnectionHandleLayout>();

  for (const node of nodes) {
    const source = createSlots(node.id, "source", sourceGroups.get(node.id) ?? []);
    const target = createSlots(node.id, "target", targetGroups.get(node.id) ?? []);
    handlesByNode.set(node.id, { source, target });
    for (const slot of source) {
      if (slot.edgeId) {
        handlesByEdge.set(slot.edgeId, { ...(handlesByEdge.get(slot.edgeId) ?? { sourceHandle: "", targetHandle: "" }), sourceHandle: slot.id });
      }
    }
    for (const slot of target) {
      if (slot.edgeId) {
        handlesByEdge.set(slot.edgeId, { ...(handlesByEdge.get(slot.edgeId) ?? { sourceHandle: "", targetHandle: "" }), targetHandle: slot.id });
      }
    }
    if (source.length === 1 && source[0].collapsed) {
      for (const edge of sourceGroups.get(node.id) ?? []) {
        handlesByEdge.set(edge.id, { ...(handlesByEdge.get(edge.id) ?? { sourceHandle: "", targetHandle: "" }), sourceHandle: source[0].id });
      }
    }
    if (target.length === 1 && target[0].collapsed) {
      for (const edge of targetGroups.get(node.id) ?? []) {
        handlesByEdge.set(edge.id, { ...(handlesByEdge.get(edge.id) ?? { sourceHandle: "", targetHandle: "" }), targetHandle: target[0].id });
      }
    }
  }

  return { handlesByEdge, handlesByNode };
}

function createSlots(nodeId: string, side: "source" | "target", edges: Edge[]): ConnectionHandleLayout["source"] {
  if (edges.length === 0) {
    return [{ id: `${nodeId}-${side}-idle`, offsetPercent: 50, count: 0 }];
  }
  if (edges.length > HANDLE_COLLAPSE_THRESHOLD) {
    return [{ id: `${nodeId}-${side}-bulk`, offsetPercent: 50, collapsed: true, count: edges.length }];
  }
  const step = 100 / (edges.length + 1);
  return edges.map((edge, index) => ({
    id: `${nodeId}-${side}-${index}-${edge.id}`,
    edgeId: edge.id,
    offsetPercent: Math.round(step * (index + 1)),
    count: 1,
    relation: (edge.data?.relation as GraphEdgeRelation | undefined) ?? "depends_on"
  }));
}

function createEmptyHandleLayout(nodeId: string): ConnectionHandleLayout {
  return {
    source: [{ id: `${nodeId}-source-idle`, offsetPercent: 50, count: 0 }],
    target: [{ id: `${nodeId}-target-idle`, offsetPercent: 50, count: 0 }]
  };
}

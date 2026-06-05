import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { ConnectionHandleLayout, GraphEdge, GraphEdgeRelation, GraphNode } from "../types";
import { cn } from "./classnames";
import { relationStyle } from "./relation-styles";

export const HANDLE_COLLAPSE_THRESHOLD = 6;

export type FlowNodeData = GraphNode &
  Record<string, unknown> & {
    connectionHandles?: ConnectionHandleLayout;
    edgeConnected?: boolean;
    selectedEdgeId?: string;
    selectedEdgeColor?: string;
    selectedEdgeRole?: "source" | "target";
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
    data: { relation: edge.relation, guidanceNote: edge.guidanceNote },
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
    guidanceNote: edge.data?.guidanceNote as string | undefined
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

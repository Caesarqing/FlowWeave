import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { GraphEdge, GraphEdgeRelation, GraphNode } from "../types";
import { relationLabel } from "./labels";

export type FlowNodeData = GraphNode & Record<string, unknown>;
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
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: relationLabel[edge.relation],
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
    data: { relation: edge.relation, guidanceNote: edge.guidanceNote },
    className: `relation-edge ${edge.relation}`
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

import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";
import type { ArchitectureGroupReference, CanvasLayoutMode, ConnectionHandleLayout, GraphEdge, GraphEdgeRelation, GraphNode } from "../types";
import { CANVAS_NODE_SIZE } from "../common/canvas-geometry";
import { cn } from "./classnames";
import { nodeGroupKey, traceNodeIds, type TraceDirection } from "./canvas-layout";
import { relationStyle } from "./relation-styles";

export const HANDLE_COLLAPSE_THRESHOLD = 6;

export type FlowNodeData = GraphNode &
  Record<string, unknown> & {
    syntheticKind?: "group" | "event-boundary" | "unresolved-event-boundary";
    groupId?: string;
    onExpandGroup?: () => void;
    memberNodeIds?: string[];
    memberModuleCount?: number;
    memberResourceCount?: number;
    internalEdgeIds?: string[];
    connectionExplanation?: string;
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
    data: { ...edge },
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
    semanticKinds: edge.data?.semanticKinds as GraphEdge["semanticKinds"],
    operations: edge.data?.operations as GraphEdge["operations"],
    importUsages: edge.data?.importUsages as GraphEdge["importUsages"],
    sourceRelationIds: edge.data?.sourceRelationIds as string[] | undefined,
    guidanceNote: edge.data?.guidanceNote as string | undefined,
    evidence: edge.data?.evidence as GraphEdge["evidence"],
    origin: edge.data?.origin as GraphEdge["origin"],
    aggregatedEdgeIds: edge.data?.aggregatedEdgeIds as string[] | undefined,
    confidence: edge.data?.confidence as GraphEdge["confidence"],
    edgeClass: edge.data?.edgeClass as GraphEdge["edgeClass"]
  };
}

export function nodeDisplayGroups(node: GraphNode, mode: CanvasLayoutMode): ArchitectureGroupReference[] {
  if (mode === "dependency" || node.origin === "manual" || "syntheticKind" in node) return [];
  if (node.resource) return [];
  const id = nodeGroupKey(node);
  const area = node.groupPath?.find((group) => group.id === id);
  const functionalArea = { id, title: area?.title ?? node.title, rootPath: area?.rootPath ?? "" };
  return node.overviewGroup ? [node.overviewGroup, functionalArea] : [functionalArea];
}

export function expandedGroupsForNode(node: GraphNode, mode: CanvasLayoutMode, collapsedGroups: string[]): string[] {
  const ancestors = new Set(nodeDisplayGroups(node, mode).map((group) => group.id));
  return collapsedGroups.filter((id) => !ancestors.has(id));
}

export function expandedGroupsForGroup(nodes: GraphNode[], mode: CanvasLayoutMode, groupId: string, collapsedGroups: string[]): string[] {
  const children = nodes.flatMap((node) => {
    const path = nodeDisplayGroups(node, mode);
    const index = path.findIndex((group) => group.id === groupId);
    return index >= 0 && path[index + 1] ? [path[index + 1].id] : [];
  });
  return [...new Set([...collapsedGroups.filter((id) => id !== groupId), ...children])].sort();
}

export function traceDisplayNodeIds(
  rootId: string,
  sourceNodes: FlowWeaveNode[],
  sourceEdges: Edge[],
  displayNodes: FlowWeaveNode[],
  mode: CanvasLayoutMode,
  direction: TraceDirection
): Set<string> {
  const group = displayNodes.find((node) => node.id === rootId);
  const roots = sourceNodes.some((node) => node.id === rootId) ? [rootId]
    : group?.data.memberNodeIds ?? sourceNodes.filter((node) => nodeDisplayGroups(node.data, mode).some((reference) => `group:${reference.id}` === rootId)).map((node) => node.id);
  const traced = new Set(roots.flatMap((id) => [...traceNodeIds(id, sourceEdges, direction)]));
  return new Set(displayNodes.filter((node) => traced.has(node.id) || node.data.memberNodeIds?.some((id) => traced.has(id))).map((node) => node.id));
}

export function projectCollapsedFlowGraph(
  nodes: FlowWeaveNode[],
  edges: Edge[],
  mode: CanvasLayoutMode,
  collapsedGroups: string[]
): { nodes: FlowWeaveNode[]; edges: Edge[] } {
  if (mode === "dependency" || collapsedGroups.length === 0) return { nodes: [...nodes], edges: [...edges] };
  const collapsed = new Set(collapsedGroups);
  const groupByNodeId = new Map<string, ArchitectureGroupReference>();
  const membersByGroupId = new Map<string, FlowWeaveNode[]>();
  for (const node of nodes) {
    const group = nodeDisplayGroups(node.data, mode).find((candidate) => collapsed.has(candidate.id));
    if (!group) continue;
    groupByNodeId.set(node.id, group);
    membersByGroupId.set(group.id, [...(membersByGroupId.get(group.id) ?? []), node]);
  }
  const projectedNodeId = (id: string): string => {
    const group = groupByNodeId.get(id);
    return group ? `group:${group.id}` : id;
  };
  const nodeIds = new Set(nodes.map((node) => node.id));
  const projectedEdges = new Map<string, Edge>();
  const internalEdgesByGroupId = new Map<string, string[]>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) throw new Error(`Collapsed graph projection found unknown endpoint: edgeId=${edge.id} source=${edge.source} target=${edge.target}`);
    const source = projectedNodeId(edge.source);
    const target = projectedNodeId(edge.target);
    if (source === target) {
      const group = groupByNodeId.get(edge.source);
      if (group) internalEdgesByGroupId.set(group.id, [...(internalEdgesByGroupId.get(group.id) ?? []), edge.id]);
      else projectedEdges.set(edge.id, edge);
      continue;
    }
    if (source === edge.source && target === edge.target) {
      projectedEdges.set(edge.id, edge);
      continue;
    }
    const relation = (edge.data?.relation as GraphEdgeRelation | undefined) ?? "depends_on";
    const key = `${source}\u0000${target}\u0000${relation}`;
    const existing = projectedEdges.get(key);
    const { sourceHandle: _sourceHandle, targetHandle: _targetHandle, ...edgeWithoutHandles } = existing ?? edge;
    const evidence = [...(existing?.data?.evidence as GraphEdge["evidence"] ?? []), ...(edge.data?.evidence as GraphEdge["evidence"] ?? [])];
    const evidenceByKey = new Map(evidence.map((item) => [JSON.stringify(item), item]));
    const union = (field: string): string[] => [...new Set([
      ...(existing?.data?.[field] as string[] | undefined ?? []),
      ...(edge.data?.[field] as string[] | undefined ?? [])
    ])].sort();
    const guidanceNotes = [...new Set([existing?.data?.guidanceNote, edge.data?.guidanceNote].filter((note): note is string => typeof note === "string" && note.length > 0))];
    projectedEdges.set(key, {
      ...edgeWithoutHandles,
      id: `aggregate:${source}:${target}:${relation}`,
      source,
      target,
      data: {
        ...(existing?.data ?? edge.data ?? {}), relation,
        evidence: [...evidenceByKey.values()],
        aggregatedEdgeIds: [...new Set([...union("aggregatedEdgeIds"), edge.id])].sort(),
        sourceEdgeIds: [...new Set([...union("sourceEdgeIds"), edge.id])].sort(),
        sourceRelationIds: union("sourceRelationIds"),
        evidenceIds: union("evidenceIds"),
        semanticKinds: union("semanticKinds"),
        operations: union("operations"),
        importUsages: union("importUsages"),
        guidanceNote: guidanceNotes.join("\n") || undefined,
        confidence: edge.data?.confidence === "confirmed" && (!existing || existing.data?.confidence === "confirmed") ? "confirmed" : "inferred"
      }
    });
  }
  const groupNodes = [...membersByGroupId.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([groupId, groupMembers]): FlowWeaveNode => {
    const members = [...groupMembers].sort((left, right) => left.id.localeCompare(right.id));
    const group = groupByNodeId.get(members[0].id)!;
    const id = `group:${groupId}`;
    return {
      id, type: "groupNode", position: { ...members[0].position }, initialWidth: CANVAS_NODE_SIZE.width, initialHeight: CANVAS_NODE_SIZE.height,
      draggable: false, connectable: false, selected: members.some((node) => node.selected),
      data: {
        id, title: group.title, subtitle: group.rootPath, description: group.rootPath,
        kind: "module", nodeType: "module", risk: "unknown", status: "mapped", guidanceDraft: "",
        files: [...new Set(members.flatMap((node) => node.data.files))].sort(), x: members[0].position.x, y: members[0].position.y,
        syntheticKind: "group", groupId, groupPath: members[0].data.groupPath,
        memberNodeIds: members.map((node) => node.id).sort(),
        memberModuleCount: members.filter((node) => node.data.kind === "module" && !node.data.resource).length,
        memberResourceCount: members.filter((node) => node.data.resource).length,
        internalEdgeIds: (internalEdgesByGroupId.get(groupId) ?? []).sort()
      }
    };
  });
  return {
    nodes: [...nodes.filter((node) => !groupByNodeId.has(node.id)), ...groupNodes],
    edges: [...projectedEdges.values()].sort((left, right) => left.id.localeCompare(right.id))
  };
}

export function decorateFlowGraph(
  nodes: FlowWeaveNode[],
  edges: Edge[],
  selectedEdgeId?: string,
  layoutHandles?: Record<string, ConnectionHandleLayout>
) {
  const { handlesByEdge, handlesByNode } = buildConnectionHandles(nodes, edges, layoutHandles);
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
      const connectionHandles = handlesByNode.get(node.id) ?? createEmptyHandleLayout(node.id);
      const handleSize = {
        width: node.measured?.width ?? node.width ?? CANVAS_NODE_SIZE.width,
        height: node.measured?.height ?? node.height ?? CANVAS_NODE_SIZE.height
      };
      return {
        ...node,
        ...(node.data.syntheticKind === "group" ? { handles: [
          ...connectionHandles.target.map((slot) => groupHandle(slot, "target", handleSize.width, handleSize.height)),
          ...connectionHandles.source.map((slot) => groupHandle(slot, "source", handleSize.width, handleSize.height))
        ] } : {}),
        data: {
          ...node.data,
          connectionHandles,
          edgeConnected: selectedPair.has(node.id),
          selectedEdgeId,
          selectedEdgeColor: selectedEdge ? relationStyle[((selectedEdge.data?.relation as GraphEdgeRelation | undefined) ?? "depends_on")].color : undefined,
          selectedEdgeRole
        }
      };
    })
  };
}

function buildConnectionHandles(nodes: FlowWeaveNode[], edges: Edge[], layoutHandles?: Record<string, ConnectionHandleLayout>) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
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
    const source = createLayoutSlots(node.id, "source", sourceGroups.get(node.id) ?? [], nodeById, layoutHandles?.[node.id]?.source);
    const target = createLayoutSlots(node.id, "target", targetGroups.get(node.id) ?? [], nodeById, layoutHandles?.[node.id]?.target);
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

function createLayoutSlots(
  nodeId: string,
  side: "source" | "target",
  edges: Edge[],
  nodeById: ReadonlyMap<string, FlowWeaveNode>,
  plannedSlots: ConnectionHandleLayout["source"] | undefined
): ConnectionHandleLayout["source"] {
  if (!plannedSlots) return createSlots(nodeId, side, edges, nodeById);
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const slotsByEdgeId = new Map(plannedSlots.flatMap((slot) => slot.edgeId ? [[slot.edgeId, slot] as const] : []));
  const exactSlots = [...slotsByEdgeId.entries()].flatMap(([edgeId, slot]) => edgeIds.has(edgeId) ? [slot] : []);
  const mappedIds = new Set(exactSlots.flatMap((slot) => slot.edgeId ? [slot.edgeId] : []));
  const remainingEdges = edges.filter((edge) => !mappedIds.has(edge.id));
  if (remainingEdges.length === 0 && exactSlots.length > 0) return exactSlots;
  return [...exactSlots, ...createSlots(nodeId, side, remainingEdges, nodeById)]
    .sort((left, right) => left.offsetPercent - right.offsetPercent || left.id.localeCompare(right.id));
}

function groupHandle(slot: ConnectionHandleLayout["source"][number], type: "source" | "target", width: number, height: number) {
  const side = slot.position ?? (type === "source" ? "right" : "left");
  return {
    id: slot.id,
    type,
    position: side === "left" ? Position.Left : side === "right" ? Position.Right : side === "top" ? Position.Top : Position.Bottom,
    x: side === "left" ? 0 : side === "right" ? width : width * slot.offsetPercent / 100,
    y: side === "top" ? 0 : side === "bottom" ? height : height * slot.offsetPercent / 100,
    width: 1,
    height: 1
  };
}

function createSlots(
  nodeId: string,
  side: "source" | "target",
  edges: Edge[],
  nodeById: ReadonlyMap<string, FlowWeaveNode>
): ConnectionHandleLayout["source"] {
  if (edges.length === 0) {
    return [{ id: `${nodeId}-${side}-idle`, offsetPercent: 50, count: 0 }];
  }
  if (edges.length > HANDLE_COLLAPSE_THRESHOLD) {
    return [{ id: `${nodeId}-${side}-bulk`, offsetPercent: 50, collapsed: true, count: edges.length }];
  }
  const orderedEdges = [...edges].sort((left, right) => {
    const leftNeighborId = side === "source" ? left.target : left.source;
    const rightNeighborId = side === "source" ? right.target : right.source;
    const leftNeighbor = nodeById.get(leftNeighborId);
    const rightNeighbor = nodeById.get(rightNeighborId);
    const leftY = leftNeighbor ? leftNeighbor.position.y + (leftNeighbor.measured?.height ?? leftNeighbor.height ?? CANVAS_NODE_SIZE.height) / 2 : 0;
    const rightY = rightNeighbor ? rightNeighbor.position.y + (rightNeighbor.measured?.height ?? rightNeighbor.height ?? CANVAS_NODE_SIZE.height) / 2 : 0;
    return leftY - rightY || left.id.localeCompare(right.id);
  });
  const step = 100 / (orderedEdges.length + 1);
  return orderedEdges.map((edge, index) => ({
    id: `${nodeId}-${side}-${edge.id}`,
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

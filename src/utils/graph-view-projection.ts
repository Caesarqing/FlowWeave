import type {
  ArchitectureEvidence,
  GraphEdge,
  GraphNode,
  GraphViewMode
} from "../types";
import { nodeDisplayGroups } from "./graph-converters";
import { relationEdgeClass } from "./relation-styles";

export type ProjectedGraphEdge = GraphEdge & {
  edgeClass: import("../types").GraphEdgeClass;
  confidence: "confirmed" | "inferred";
  participatesInLayering: boolean;
  sourceEdgeIds: string[];
  evidenceIds: string[];
  aggregatedEdgeIds?: string[];
};

export type ProjectedGraphNode = GraphNode & {
  syntheticKind?: "event-boundary" | "unresolved-event-boundary";
};

export type GraphProjectionDiagnostics = {
  executableModuleCount: number;
  connectedExecutableModuleCount: number;
  isolatedModuleIds: string[];
  unresolvedEventCount: number;
  hiddenDependencyEdgeCount: number;
};

export type ProjectedGraph = {
  nodes: ProjectedGraphNode[];
  edges: ProjectedGraphEdge[];
  diagnostics: GraphProjectionDiagnostics;
};

export type GraphProjectionOptions = {
  additionalRelations?: Array<GraphEdge["relation"] | "manual">;
  showInferredCalls?: boolean;
};

export type OverviewFrontierInput = {
  nodes: GraphNode[];
  viewport: { width: number; height: number };
  cardSize: { width: number; height: number };
  collapsedGroupIds: string[];
  expandedGroupIds: string[];
  identity: { generationId: string; userRevision: number; viewRequestId: string };
};

export type OverviewFrontierResult = {
  identity: OverviewFrontierInput["identity"];
  collapsedGroupIds: string[];
  visibleNodeIds: string[];
  aggregationMap: Record<string, string[]>;
  pendingExpansionCounts: Record<string, number>;
  readability: {
    isReadable: boolean;
    maximumReadableNodeCount: number;
    visibleNodeCount: number;
    reason?: string;
  };
};

export function matchesOverviewIdentity(
  left: OverviewFrontierInput["identity"],
  right: OverviewFrontierInput["identity"]
): boolean {
  return left.generationId === right.generationId && left.userRevision === right.userRevision && left.viewRequestId === right.viewRequestId;
}

export function selectOverviewFrontier(input: OverviewFrontierInput): OverviewFrontierResult {
  const { nodes, viewport, cardSize } = input;
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width < 0 || viewport.height < 0 ||
    !Number.isFinite(cardSize.width) || !Number.isFinite(cardSize.height) || cardSize.width <= 0 || cardSize.height <= 0 ||
    !input.identity.generationId || !Number.isInteger(input.identity.userRevision) || input.identity.userRevision < 0 || !input.identity.viewRequestId) {
    throw new TypeError("Overview frontier requires a valid viewport, card size, generation, revision, and request identity.");
  }
  const nodeIds = nodes.map((node) => node.id);
  if (new Set(nodeIds).size !== nodeIds.length) throw new TypeError("Overview frontier requires unique graph node IDs.");
  const pathsByNodeId = new Map(nodes.map((node) => [node.id, nodeDisplayGroups(node, "execution")]));
  const maximumReadableNodeCount = Math.max(1, Math.floor(
    Math.floor(viewport.width / cardSize.width) * Math.floor(viewport.height / cardSize.height) * 0.5
  ));
  const expanded = new Set(input.expandedGroupIds);
  const collapsed = new Set(input.collapsedGroupIds.filter((groupId) => !expanded.has(groupId)));
  const candidateIds = [...new Set([...pathsByNodeId.values()].flatMap((path) => path.map((group) => group.id)))]
    .filter((groupId) => !expanded.has(groupId) && !collapsed.has(groupId))
    .sort();

  let projection = projectFrontierNodes(nodeIds, pathsByNodeId, collapsed);
  while (projection.visibleNodeIds.length > maximumReadableNodeCount) {
    let selectedGroupId: string | undefined;
    let bestSaving = 0;
    for (const groupId of candidateIds) {
      if (collapsed.has(groupId)) continue;
      const simulated = new Set([...collapsed, groupId]);
      const visibleCount = projectFrontierNodes(nodeIds, pathsByNodeId, simulated).visibleNodeIds.length;
      const saving = projection.visibleNodeIds.length - visibleCount;
      if (saving > bestSaving) {
        selectedGroupId = groupId;
        bestSaving = saving;
      }
    }
    if (!selectedGroupId) break;
    collapsed.add(selectedGroupId);
    projection = projectFrontierNodes(nodeIds, pathsByNodeId, collapsed);
  }

  const isReadable = projection.visibleNodeIds.length <= maximumReadableNodeCount &&
    viewport.width >= cardSize.width && viewport.height >= cardSize.height;
  return {
    identity: { ...input.identity },
    collapsedGroupIds: [...collapsed].sort(),
    visibleNodeIds: projection.visibleNodeIds,
    aggregationMap: projection.aggregationMap,
    pendingExpansionCounts: Object.fromEntries(Object.entries(projection.aggregationMap).map(([groupId, memberIds]) => [groupId, memberIds.length])),
    readability: {
      isReadable,
      maximumReadableNodeCount,
      visibleNodeCount: projection.visibleNodeIds.length,
      ...(!isReadable ? {
        reason: expanded.size > 0
          ? "Available area cannot fit the graph while preserving expanded groups."
          : "Available area cannot fit the full graph at the minimum card size."
      } : {})
    }
  };
}

function projectFrontierNodes(
  nodeIds: string[],
  pathsByNodeId: Map<string, ReturnType<typeof nodeDisplayGroups>>,
  collapsed: Set<string>
): { visibleNodeIds: string[]; aggregationMap: Record<string, string[]> } {
  const visible = new Set<string>();
  const aggregationMap: Record<string, string[]> = {};
  for (const nodeId of nodeIds) {
    const group = (pathsByNodeId.get(nodeId) ?? []).find((candidate) => collapsed.has(candidate.id));
    if (!group) {
      visible.add(nodeId);
      continue;
    }
    const groupNodeId = `group:${group.id}`;
    visible.add(groupNodeId);
    aggregationMap[group.id] = [...(aggregationMap[group.id] ?? []), nodeId];
  }
  return {
    visibleNodeIds: [...visible].sort(),
    aggregationMap: Object.fromEntries(Object.entries(aggregationMap).map(([groupId, members]) => [groupId, members.sort()]))
  };
}

export function chooseInitialGraphView(_edges: GraphEdge[]): GraphViewMode {
  return "execution";
}

export function nodeConnectionExplanation(node: GraphNode, edges: GraphEdge[]): "dependency" | "internal" | "unresolved" | "external" | "none" | undefined {
  const related = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  if (related.length > 0) return related.every((edge) => edge.relation === "depends_on") ? "dependency" : undefined;
  if (node.relationSummary?.internalRelations) return "internal";
  if (node.relationSummary?.unresolvedRelations) return "unresolved";
  if (node.relationSummary?.externalRelations) return "external";
  return "none";
}

export function projectGraphForView(
  nodes: GraphNode[],
  edges: GraphEdge[],
  mode: GraphViewMode,
  options: GraphProjectionOptions
): ProjectedGraph {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const eventBoundaries = new Map<string, ProjectedGraphNode>();
  const projectedEdges: ProjectedGraphEdge[] = [];
  const executableNodes = nodes.filter((node) => node.kind === "module" && !node.resource && node.nodeType !== "test");
  const hasExecutableNodes = executableNodes.length > 0;
  const defaultEdges = mode === "execution"
    ? edges.filter((edge) => edge.relation === "calls" &&
      (edge.confidence === "confirmed" || options.showInferredCalls) && edge.origin !== "manual" &&
      (!hasExecutableNodes || (nodeById.get(edge.source)?.nodeType !== "test" && nodeById.get(edge.target)?.nodeType !== "test")))
    : edges.filter((edge) => edge.relation === "depends_on" && edge.origin !== "manual" &&
      (!hasExecutableNodes || (nodeById.get(edge.source)?.nodeType !== "test" && nodeById.get(edge.target)?.nodeType !== "test")));
  const selectedRelations = new Set(options.additionalRelations ?? []);
  const additionalEdges = edges.filter((edge) => (edge.origin === "manual"
    ? selectedRelations.has("manual")
    : selectedRelations.has(edge.relation)) &&
    !defaultEdges.includes(edge) &&
    (!hasExecutableNodes || edge.relation === "tests" && selectedRelations.has("tests") ||
      (nodeById.get(edge.source)?.nodeType !== "test" && nodeById.get(edge.target)?.nodeType !== "test")));
  const visibleEdgeIds = new Set<string>();
  const visibleEdges = [...defaultEdges, ...additionalEdges].filter((edge) => {
    if (visibleEdgeIds.has(edge.id)) return false;
    visibleEdgeIds.add(edge.id);
    return true;
  });
  const visibleNodeIds = new Set(visibleEdges.flatMap((edge) => [edge.source, edge.target]));
  const projectedNodes: ProjectedGraphNode[] = nodes.filter((node) =>
    !hasExecutableNodes || node.origin === "manual" || visibleNodeIds.has(node.id) ||
    (node.kind === "module" && !node.resource && node.nodeType !== "test"));
  let unresolvedEventCount = 0;

  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      throw new Error(`Graph projection found unknown endpoint: edgeId=${edge.id} source=${edge.source} target=${edge.target}`);
    }
  }

  for (const edge of visibleEdges) {
    if ((edge.relation === "publishes_event" || edge.relation === "subscribes_event") &&
      nodeById.get(edge.source)?.resource?.kind !== "event" && nodeById.get(edge.target)?.resource?.kind !== "event") {
      const eventId = edge.evidence?.map((item) => item.eventId?.trim()).find(Boolean);
      const boundaryKey = eventId ? `event-boundary:${eventId}` : `unresolved-event:${edge.id}`;
      if (!eventId) unresolvedEventCount += 1;
      let boundary = eventBoundaries.get(boundaryKey);
      if (!boundary) {
        boundary = createEventBoundaryNode(boundaryKey, eventId);
        eventBoundaries.set(boundaryKey, boundary);
        projectedNodes.push(boundary);
      }
      projectedEdges.push(projectEdge(
        edge,
        edge.relation === "publishes_event" ? edge.source : boundary.id,
        edge.relation === "publishes_event" ? boundary.id : edge.target
      ));
      continue;
    }
    projectedEdges.push(projectEdge(edge, edge.source, edge.target));
  }

  const connectedIds = new Set(projectedEdges
    .filter((edge) => edge.participatesInLayering &&
      (edge.relation !== "calls" || edge.confidence === "confirmed") &&
      nodeById.get(edge.source)?.nodeType !== "test" && nodeById.get(edge.target)?.nodeType !== "test")
    .flatMap((edge) => [edge.source, edge.target])
    .filter((id) => nodeById.has(id)));
  const isolatedModuleIds = executableNodes
    .filter((node) => !connectedIds.has(node.id))
    .map((node) => node.id)
    .sort();

  return {
    nodes: projectedNodes,
    edges: projectedEdges,
    diagnostics: {
      executableModuleCount: executableNodes.length,
      connectedExecutableModuleCount: executableNodes.filter((node) => connectedIds.has(node.id)).length,
      isolatedModuleIds,
      unresolvedEventCount,
      hiddenDependencyEdgeCount: mode === "execution"
        ? edges.filter((edge) => edge.relation === "depends_on" && !additionalEdges.includes(edge)).length
        : 0
    }
  };
}

function projectEdge(edge: GraphEdge, source: string, target: string): ProjectedGraphEdge {
  const edgeClass = relationEdgeClass[edge.relation];
  return {
    ...edge,
    source,
    target,
    edgeClass,
    confidence: edge.confidence ?? "inferred",
    participatesInLayering: edge.origin !== "manual" && edgeClass !== "dependency" && edgeClass !== "test",
    sourceEdgeIds: [edge.id],
    evidenceIds: (edge.evidence ?? []).map(evidenceId)
  };
}

function evidenceId(evidence: ArchitectureEvidence): string {
  return [evidence.filePath, evidence.symbol, evidence.line, evidence.eventId, evidence.detail]
    .map((part) => part ?? "")
    .join("\u0000");
}

function createEventBoundaryNode(id: string, eventId: string | undefined): ProjectedGraphNode {
  const unresolved = eventId === undefined;
  const label = eventId ?? "Unresolved event";
  return {
    id,
    title: label,
    subtitle: unresolved ? "Unresolved event boundary" : "Event boundary",
    kind: "module",
    nodeType: "utility",
    risk: "unknown",
    description: unresolved
      ? "Static evidence identifies an event relationship but does not identify the event."
      : `Static event boundary for ${eventId}.`,
    files: [],
    guidanceDraft: "",
    status: "mapped",
    x: 0,
    y: 0,
    syntheticKind: unresolved ? "unresolved-event-boundary" : "event-boundary"
  };
}

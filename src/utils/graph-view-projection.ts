import type {
  ArchitectureEvidence,
  GraphEdge,
  GraphNode,
  GraphViewMode
} from "../types";
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
  inferredOverlayEdgeCount: number;
};

export type ProjectedGraph = {
  nodes: ProjectedGraphNode[];
  edges: ProjectedGraphEdge[];
  diagnostics: GraphProjectionDiagnostics;
};

export type GraphProjectionOptions = {
  includeInferredDependencyOverlay: boolean;
};

const EXECUTION_RELATIONS = new Set<GraphEdge["relation"]>([
  "calls",
  "reads_writes",
  "external_api",
  "publishes_event",
  "subscribes_event"
]);

export function projectGraphForView(
  nodes: GraphNode[],
  edges: GraphEdge[],
  mode: GraphViewMode,
  options: GraphProjectionOptions
): ProjectedGraph {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const eventBoundaries = new Map<string, ProjectedGraphNode>();
  const projectedNodes: ProjectedGraphNode[] = [...nodes];
  const projectedEdges: ProjectedGraphEdge[] = [];
  const executionEdges = edges.filter((edge) => EXECUTION_RELATIONS.has(edge.relation));
  const inferredOverlayEdges = mode === "execution" && options.includeInferredDependencyOverlay
    ? edges.filter((edge) => edge.relation === "depends_on")
    : [];
  const visibleEdges = mode === "execution"
    ? [...executionEdges, ...inferredOverlayEdges]
    : edges;
  let unresolvedEventCount = 0;

  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      throw new Error(`Graph projection found unknown endpoint: edgeId=${edge.id} source=${edge.source} target=${edge.target}`);
    }
  }

  for (const edge of visibleEdges) {
    if (edge.relation === "publishes_event" || edge.relation === "subscribes_event") {
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

  const executableNodes = nodes.filter((node) => node.kind === "module" && node.nodeType !== "test");
  const connectedIds = new Set(projectedEdges
    .filter((edge) => edge.participatesInLayering)
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
      hiddenDependencyEdgeCount: mode === "execution" ? edges.filter((edge) => edge.relation === "depends_on").length - inferredOverlayEdges.length : 0,
      inferredOverlayEdgeCount: inferredOverlayEdges.length
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
    confidence: edge.relation === "depends_on" || !edge.evidence?.length ? "inferred" : "confirmed",
    participatesInLayering: edgeClass !== "dependency" && edgeClass !== "test",
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

import type { CodeflowCanvas, GraphEdge, GraphNode } from "../types";
import { invalidateModuleAssessment } from "./module-assessment";

export function updateModuleInCanvasGraph(modules: GraphNode[], nodeId: string, patch: Partial<GraphNode>) {
  return modules.map((module) => {
    if (module.id !== nodeId) return module;
    const updated = { ...module, ...patch, id: module.id, status: "needs-review" as const };
    if (patch.assessment || patch.risk) return updated;
    return changesAssessmentInputs(patch) ? invalidateModuleAssessment(updated, new Date().toISOString()) : updated;
  });
}

export function deleteModuleFromCanvasGraph(modules: GraphNode[], edges: GraphEdge[], nodeId: string) {
  const removedEdges = edges.filter((edge) => edge.source === nodeId || edge.target === nodeId);
  const neighborIds = new Set(removedEdges.flatMap((edge) => [edge.source, edge.target]).filter((id) => id !== nodeId));
  const assessedAt = new Date().toISOString();
  return {
    modules: modules
      .filter((module) => module.id !== nodeId)
      .map((module) => neighborIds.has(module.id) ? invalidateModuleAssessment(module, assessedAt) : module),
    edges: edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
  };
}

export function restoreGeneratedCanvasGraph(canvas: CodeflowCanvas, generated: Pick<CodeflowCanvas, "nodes" | "edges">): CodeflowCanvas {
  const generatedNodeIds = new Set(generated.nodes.map((node) => node.id));
  const generatedEdgeIds = new Set(generated.edges.map((edge) => edge.id));
  const conflictingNode = canvas.nodes.find((node) => node.origin === "manual" && generatedNodeIds.has(node.id));
  if (conflictingNode) throw new Error(`Cannot restore generated Canvas item because manual node ID ${conflictingNode.id} conflicts with it.`);
  const conflictingEdge = canvas.edges.find((edge) => edge.origin === "manual" && generatedEdgeIds.has(edge.id));
  if (conflictingEdge) throw new Error(`Cannot restore generated Canvas item because manual relation ID ${conflictingEdge.id} conflicts with it.`);
  const nodeIds = new Set(canvas.nodes.map((node) => node.id));
  const edgeIds = new Set(canvas.edges.map((edge) => edge.id));
  const restoredNodes = generated.nodes.filter((node) => !nodeIds.has(node.id));
  const restoredEdges = generated.edges.filter((edge) => !edgeIds.has(edge.id));
  return {
    ...canvas,
    nodes: [...canvas.nodes, ...restoredNodes],
    edges: [...canvas.edges, ...restoredEdges],
    hiddenGeneratedNodeIds: [],
    hiddenGeneratedEdgeIds: []
  };
}

export function updateGraphEdge(edges: GraphEdge[], edgeId: string, patch: Partial<GraphEdge>) {
  return edges.map((edge) => {
    if (edge.id !== edgeId) return edge;
    const next = { ...edge, ...patch, id: edge.id };
    if (next.source === next.target) return edge;
    const corrected = edge.origin !== "manual" && (next.source !== edge.source || next.target !== edge.target || next.relation !== edge.relation);
    return corrected ? { ...next, confidence: "inferred" as const, evidence: [], semanticKinds: [], operations: [], importUsages: [], sourceRelationIds: [] } : next;
  });
}

function changesAssessmentInputs(patch: Partial<GraphNode>): boolean {
  return ["title", "description", "files", "symbols", "evidence", "nodeType", "category", "role"]
    .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
}

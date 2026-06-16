import type { GraphEdge, GraphNode } from "../types";
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

export function updateGraphEdge(edges: GraphEdge[], edgeId: string, patch: Partial<GraphEdge>) {
  return edges.map((edge) => {
    if (edge.id !== edgeId) return edge;
    const next = { ...edge, ...patch, id: edge.id };
    return next.source === next.target ? edge : next;
  });
}

function changesAssessmentInputs(patch: Partial<GraphNode>): boolean {
  return ["title", "description", "files", "symbols", "evidence", "nodeType", "category", "role"]
    .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
}

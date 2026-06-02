import type { GraphEdge, GraphNode } from "../types";

export function updateModuleInCanvasGraph(modules: GraphNode[], nodeId: string, patch: Partial<GraphNode>) {
  return modules.map((module) => (module.id === nodeId ? { ...module, ...patch, id: module.id, status: "needs-review" as const } : module));
}

export function deleteModuleFromCanvasGraph(modules: GraphNode[], edges: GraphEdge[], nodeId: string) {
  return {
    modules: modules.filter((module) => module.id !== nodeId),
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

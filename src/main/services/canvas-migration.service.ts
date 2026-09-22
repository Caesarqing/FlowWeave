import type { CodeflowCanvas, GraphEdge, GraphNode } from "../../types";

export function reconcileGeneratedCanvas(generated: CodeflowCanvas, existing: CodeflowCanvas | undefined): CodeflowCanvas {
  if (!existing || existing.version !== 5) return generated;
  const current = existing;
  const generatedNodeIds = new Set(generated.nodes.map((node) => node.id));
  const existingById = new Map(current.nodes.map((node) => [node.id, node]));
  const nodes = generated.nodes.map((node) => {
    const previous = existingById.get(node.id);
    return previous
      ? { ...node, guidanceDraft: previous.guidanceDraft, assessment: previous.assessment }
      : node;
  });
  const manualNodes = current.nodes.filter((node) => node.origin === "manual" && !generatedNodeIds.has(node.id));
  nodes.push(...manualNodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const existingEdgesById = new Map(current.edges.map((edge) => [edge.id, edge]));
  const generatedEdges = generated.edges.map((edge) => {
    const previous = existingEdgesById.get(edge.id);
    return previous ? { ...edge, guidanceNote: previous.guidanceNote ?? edge.guidanceNote } : edge;
  });
  const generatedEdgeIds = new Set(generated.edges.map((edge) => edge.id));
  const manualEdges = current.edges.filter((edge) => edge.origin === "manual" && !generatedEdgeIds.has(edge.id));
  const preservedEdges = manualEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const orphanedEdges = deduplicateEdges([
    ...(current.orphanedEdges ?? []),
    ...manualEdges.filter((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))
  ]);
  return {
    ...generated,
    layout: current.layout ?? generated.layout,
    nodes,
    edges: [...generatedEdges, ...preservedEdges],
    orphanedEdges
  };
}

function deduplicateEdges(edges: GraphEdge[]): GraphEdge[] {
  return [...new Map(edges.map((edge) => [edge.id, edge])).values()];
}

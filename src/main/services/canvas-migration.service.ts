import type { CodeflowCanvas, GraphEdge, GraphNode, ProjectFileNode } from "../../types";

export function migrateCanvasToScan(
  canvas: CodeflowCanvas,
  projectPath: string,
  scanFingerprint: string,
  projectFiles: ProjectFileNode[]
): CodeflowCanvas {
  const knownFiles = new Set(flattenFilePaths(projectFiles));
  const nodes = canvas.nodes.map((node) => sanitizeNodeFiles(node, knownFiles));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = sanitizeEdges(canvas.edges, nodeIds, knownFiles);

  return {
    ...canvas,
    version: 2,
    projectPath,
    generatedAt: new Date().toISOString(),
    scanFingerprint,
    artifactState: "current",
    nodes,
    edges
  };
}

function flattenFilePaths(nodes: ProjectFileNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.type === "file" ? [node.path] : []),
    ...flattenFilePaths(node.children ?? [])
  ]);
}

function sanitizeNodeFiles(node: GraphNode, knownFiles: Set<string>): GraphNode {
  return {
    ...node,
    files: node.files.filter((filePath) => knownFiles.has(filePath)),
    fileRoles: node.fileRoles?.filter((item) => knownFiles.has(item.path)),
    symbols: node.symbols?.filter((symbol) => knownFiles.has(symbol.filePath)),
    evidence: node.evidence?.filter((item) => !item.filePath || knownFiles.has(item.filePath))
  };
}

function sanitizeEdges(edges: GraphEdge[], nodeIds: Set<string>, knownFiles: Set<string>): GraphEdge[] {
  const seen = new Set<string>();
  return edges.flatMap((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) return [];
    const guidanceFilePath = extractGuidanceFilePath(edge.guidanceNote);
    if (guidanceFilePath && !knownFiles.has(guidanceFilePath)) return [];
    const evidence = edge.evidence?.filter((item) => !item.filePath || knownFiles.has(item.filePath));
    if (edge.evidence?.length && evidence?.length === 0) return [];
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.relation}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...edge, evidence }];
  });
}

function extractGuidanceFilePath(guidanceNote: string | undefined): string | undefined {
  if (!guidanceNote) return undefined;
  const separator = guidanceNote.includes(" performs external calls")
    ? " performs external calls"
    : guidanceNote.includes(" imports ")
      ? " imports "
      : undefined;
  if (!separator) return undefined;
  return guidanceNote.slice(0, guidanceNote.indexOf(separator));
}

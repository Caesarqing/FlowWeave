import type { AssessmentLevel, CanvasLayoutState, CodeflowCanvas, GraphEdge, GraphNode, LegacyGraphRisk, ProjectFileNode } from "../../types";
import { unknownAssessment } from "../../utils/module-assessment";

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
    version: 3,
    projectPath,
    generatedAt: new Date().toISOString(),
    scanFingerprint,
    artifactState: "current",
    layout: migrateLayout(canvas, nodes),
    nodes,
    edges
  };
}

function migrateLayout(canvas: CodeflowCanvas, nodes: GraphNode[]): CanvasLayoutState {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const manualPositions = canvas.layout?.manualPositions ?? Object.fromEntries(
    nodes.map((node) => [node.id, { x: node.x, y: node.y }])
  );
  return {
    activeMode: canvas.layout?.activeMode ?? "manual",
    manualPositions: filterPositions(manualPositions, nodeIds),
    autoLayouts: Object.fromEntries(
      Object.entries(canvas.layout?.autoLayouts ?? {}).map(([mode, positions]) => [
        mode,
        filterPositions(positions ?? {}, nodeIds)
      ])
    ),
    collapsedGroups: [...new Set(canvas.layout?.collapsedGroups ?? [])]
  };
}

function filterPositions(
  positions: Record<string, { x: number; y: number }>,
  nodeIds: Set<string>
): Record<string, { x: number; y: number }> {
  return Object.fromEntries(
    Object.entries(positions).filter(([nodeId, position]) =>
      nodeIds.has(nodeId) &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y)
    )
  );
}

function flattenFilePaths(nodes: ProjectFileNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.type === "file" ? [node.path] : []),
    ...flattenFilePaths(node.children ?? [])
  ]);
}

function sanitizeNodeFiles(node: GraphNode, knownFiles: Set<string>): GraphNode {
  const risk = normalizeLegacyRisk(node.risk as GraphNode["risk"] | LegacyGraphRisk);
  const assessment = node.assessment ?? migrateLegacyAssessment(node, risk);
  return {
    ...node,
    risk: assessment.risk.effectiveLevel,
    confidence: undefined,
    assessment,
    files: node.files.filter((filePath) => knownFiles.has(filePath)),
    fileRoles: node.fileRoles?.filter((item) => knownFiles.has(item.path)),
    symbols: node.symbols?.filter((symbol) => knownFiles.has(symbol.filePath)),
    evidence: node.evidence?.filter((item) => !item.filePath || knownFiles.has(item.filePath))
  };
}

function migrateLegacyAssessment(node: GraphNode, risk: AssessmentLevel) {
  const assessment = unknownAssessment("", new Date(0).toISOString());
  const legacyConfidence = typeof node.confidence === "number"
    ? Math.max(0, Math.min(100, Math.round(node.confidence * 100)))
    : undefined;
  return {
    ...assessment,
    confidence: legacyConfidence === undefined
      ? assessment.confidence
      : {
          score: legacyConfidence,
          level: scoreLevel(legacyConfidence),
          factors: [{
            id: "legacy-confidence",
            label: "Legacy confidence",
            score: legacyConfidence,
            maxScore: 100,
            reason: "Migrated from the previous unstructured confidence value. A rescan will replace it.",
            evidence: [{ detail: "Legacy Canvas confidence value" }]
          }]
        },
    risk: {
      systemLevel: risk,
      effectiveLevel: risk,
      factors: [{
        id: "legacy-risk",
        label: "Legacy risk",
        score: risk === "high" ? 70 : risk === "medium" ? 30 : 0,
        maxScore: 100,
        reason: "Migrated from the previous risk label. A rescan will replace it.",
        evidence: [{ detail: "Legacy Canvas risk value" }]
      }]
    }
  };
}

function normalizeLegacyRisk(risk: GraphNode["risk"] | LegacyGraphRisk): AssessmentLevel {
  if (risk === "normal") return "low";
  if (risk === "review") return "medium";
  if (risk === "blocked") return "high";
  return risk;
}

function scoreLevel(score: number): AssessmentLevel {
  if (score >= 80) return "high";
  if (score >= 50) return "medium";
  return "low";
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

import type { GraphEdge, GraphNode } from "../../types";
import type { CodeflowCanvas } from "../storage/schemas";
import { chooseInitialCollapsedGroups, chooseInitialGraphView } from "../../utils/graph-view-projection";

const GENERATOR_VERSION = "1.0.0";

export function createCanvasArtifact(
  projectPath: string,
  modules: GraphNode[],
  edges: GraphEdge[],
  scanFingerprint: string
): CodeflowCanvas {
  const viewMode = chooseInitialGraphView(edges);
  return {
    version: 6,
    generatorVersion: GENERATOR_VERSION,
    inputFingerprint: scanFingerprint,
    id: "main",
    title: "Main Canvas",
    projectPath,
    generatedAt: new Date().toISOString(),
    scanFingerprint,
    artifactState: "current",
    layout: {
      activeMode: viewMode,
      viewMode,
      manualPositions: Object.fromEntries(modules.map((node) => [node.id, { x: node.x, y: node.y }])),
      autoLayouts: {},
      collapsedGroups: chooseInitialCollapsedGroups(modules)
    },
    nodes: modules.map((module) => ({ ...module, origin: "generated" })),
    edges: edges.map((edge) => ({ ...edge, origin: "generated" })),
    orphanedEdges: []
  };
}

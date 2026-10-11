import type { GraphEdge, GraphNode } from "../../types";
import type { CodeflowCanvas } from "../storage/schemas";
import { chooseInitialGraphView } from "../../utils/graph-view-projection";
import { layoutStaticGraph } from "./static-graph-layout.service";

const GENERATOR_VERSION = "1.0.0";

export async function createCanvasArtifact(
  projectPath: string,
  modules: GraphNode[],
  edges: GraphEdge[],
  scanFingerprint: string
): Promise<CodeflowCanvas> {
  const viewMode = chooseInitialGraphView(edges);
  const [executionLayout, dependencyLayout] = await Promise.all([
    layoutStaticGraph(modules, edges, "execution"),
    layoutStaticGraph(modules, edges, "dependency")
  ]);
  const activeLayout = viewMode === "execution" ? executionLayout : dependencyLayout;
  return {
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
      manualPositions: activeLayout.positions,
      autoLayouts: { execution: executionLayout.positions, dependency: dependencyLayout.positions },
      autoConnectionHandles: {
        execution: { positions: executionLayout.positions, handles: executionLayout.connectionHandles, topologyFingerprint: executionLayout.topologyFingerprint },
        dependency: { positions: dependencyLayout.positions, handles: dependencyLayout.connectionHandles, topologyFingerprint: dependencyLayout.topologyFingerprint }
      },
      autoLayoutTopologyFingerprints: {
        execution: executionLayout.topologyFingerprint,
        dependency: dependencyLayout.topologyFingerprint
      },
      collapsedGroups: executionLayout.collapsedGroups
    },
    nodes: activeLayout.nodes.map((module) => ({ ...module, origin: "generated" })),
    edges: edges.map((edge) => ({ ...edge, origin: "generated" })),
    orphanedEdges: []
  };
}

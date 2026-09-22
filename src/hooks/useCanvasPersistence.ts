import { useEffect } from "react";
import type { CanvasLayoutState, GraphEdge, GraphNode } from "../types";
import { useAgentStore } from "../stores/agents.store";
import { useI18n } from "../utils/i18n";

export function useCanvasPersistence(
  projectId: string,
  projectPath: string,
  scanFingerprint: string,
  artifactState: import("../types").ProjectArtifactState | undefined,
  snapshot: string,
  modules: GraphNode[],
  relations: GraphEdge[],
  layout: CanvasLayoutState,
  orphanedEdges: GraphEdge[]
) {
  const { t } = useI18n();
  const setLastRunStatus = useAgentStore((state) => state.setLastRunStatus);

  useEffect(() => {
    if (!window.flowweave || !projectId || modules.length === 0 || artifactState !== "current") return;
    const timeout = window.setTimeout(() => {
      void window.flowweave?.saveCanvas(
        projectId,
        {
          version: 5,
          id: "main",
          title: "Main Canvas",
          projectPath,
          generatedAt: new Date().toISOString(),
          scanFingerprint,
          artifactState: "current",
          layout,
          nodes: modules,
          edges: relations,
          orphanedEdges
        },
        { allowStaleNoop: true }
      ).catch((error) => {
        setLastRunStatus(t("agent.connectionRefreshFailed", { error: formatErrorMessage(error) }));
      });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [projectId, projectPath, scanFingerprint, artifactState, snapshot, layout, orphanedEdges]);
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

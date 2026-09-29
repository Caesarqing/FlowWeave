import { useEffect } from "react";
import type { CanvasLayoutState, CodeflowCanvas, GraphEdge, GraphNode } from "../types";
import { useAgentStore } from "../stores/agents.store";
import { useI18n } from "../utils/i18n";

export function useCanvasPersistence(
  projectId: string,
  projectPath: string,
  scanFingerprint: string,
  legacyCanvasReadOnly: boolean,
  isProjectLoading: boolean,
  artifactState: import("../types").ProjectArtifactState | undefined,
  snapshot: string,
  modules: GraphNode[],
  relations: GraphEdge[],
  layout: CanvasLayoutState,
  orphanedEdges: GraphEdge[],
  metadata: Pick<CodeflowCanvas, "groups" | "quality" | "orphanedNodeEdits">
) {
  const { t } = useI18n();
  const setLastRunStatus = useAgentStore((state) => state.setLastRunStatus);

  useEffect(() => {
    if (!window.flowweave || !projectId || legacyCanvasReadOnly || isProjectLoading || modules.length === 0 || artifactState !== "current") return;
    const timeout = window.setTimeout(() => {
      void window.flowweave?.saveCanvas(
        projectId,
        {
          version: 6,
          id: "main",
          title: "Main Canvas",
          projectPath,
          generatedAt: new Date().toISOString(),
          scanFingerprint,
          artifactState: "current",
          layout,
          nodes: modules,
          edges: relations,
          orphanedEdges,
          ...metadata
        },
        { allowStaleNoop: true }
      ).catch((error) => {
        setLastRunStatus(t("agent.connectionRefreshFailed", { error: formatErrorMessage(error) }));
      });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [projectId, projectPath, scanFingerprint, legacyCanvasReadOnly, isProjectLoading, artifactState, snapshot, layout, orphanedEdges, metadata]);
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

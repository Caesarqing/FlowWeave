import { useEffect } from "react";
import type { GraphEdge, GraphNode } from "../types";
import { useWorkspaceStore } from "../stores/workspace.store";
import { useI18n } from "../utils/i18n";

export function useCanvasPersistence(
  projectId: string,
  projectPath: string,
  scanFingerprint: string,
  artifactState: import("../types").ProjectArtifactState | undefined,
  snapshot: string,
  modules: GraphNode[],
  relations: GraphEdge[]
) {
  const { t } = useI18n();
  const setLastRunStatus = useWorkspaceStore((state) => state.setLastRunStatus);

  useEffect(() => {
    if (!window.flowweave || !projectId || modules.length === 0 || artifactState !== "current") return;
    const timeout = window.setTimeout(() => {
      void window.flowweave?.saveCanvas(projectId, {
        version: 2,
        id: "main",
        title: "Main Canvas",
        projectPath,
        generatedAt: new Date().toISOString(),
        scanFingerprint,
        artifactState: "current",
        nodes: modules,
        edges: relations
      }).catch((error) => {
        setLastRunStatus(t("agent.connectionRefreshFailed", { error: formatErrorMessage(error) }));
      });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [projectId, projectPath, scanFingerprint, artifactState, snapshot]);
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

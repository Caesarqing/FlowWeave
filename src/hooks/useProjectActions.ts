import { useEffect, useRef, useState } from "react";
import type {
  AnalysisOperation,
  FlowWeaveProjectOpenResult,
  GraphEdge,
  GraphNode,
  ProjectArtifactStatuses,
  ProjectFileNode,
  RuntimeAgentId
} from "../types";
import { useI18n } from "../utils/i18n";
import { usePreferencesStore } from "../stores/preferences.store";

export function useProjectActions({
  maxRenderedTreeRows,
  projectId,
  projectPath,
  projectFiles,
  replaceProjectGraph,
  setIsProjectLoading,
  setLastRunStatus,
  setProjectLabel,
  setProjectId,
  setProjectPath,
  setScanFingerprint,
  setArtifactStatuses,
  setProjectStatus
}: {
  maxRenderedTreeRows: number;
  projectId: string;
  projectPath: string;
  projectFiles: ProjectFileNode[];
  replaceProjectGraph: (
    nodes: GraphNode[],
    edges: GraphEdge[],
    files: ProjectFileNode[],
    layout?: import("../types").CanvasLayoutState
  ) => void;
  setIsProjectLoading: (value: boolean) => void;
  setLastRunStatus: (value: string) => void;
  setProjectLabel: (value: string) => void;
  setProjectId: (value: string) => void;
  setProjectPath: (value: string) => void;
  setScanFingerprint: (value: string) => void;
  setArtifactStatuses: (
    value: ProjectArtifactStatuses | ((current?: ProjectArtifactStatuses) => ProjectArtifactStatuses | undefined)
  ) => void;
  setProjectStatus: (value: string) => void;
}) {
  const { t } = useI18n();
  const scanConcurrency = usePreferencesStore((state) => state.scanConcurrency);
  const scanMaxEntries = usePreferencesStore((state) => state.scanMaxEntries);
  const [operation, setOperation] = useState<AnalysisOperation | null>(null);
  const activeOperationId = useRef<string | null>(null);

  useEffect(() => {
    if (!window.flowweave) {
      return undefined;
    }

    return window.flowweave.onOperationProgress((nextOperation) => {
      const isTerminal =
        nextOperation.stage === "completed" ||
        nextOperation.stage === "failed" ||
        nextOperation.stage === "canceled";
      activeOperationId.current = isTerminal ? null : nextOperation.operationId;
      setOperation(nextOperation);
      setProjectStatus(t("operation.progress", {
        stage: t(`operation.stage.${nextOperation.stage}`),
        completed: nextOperation.completed,
        total: nextOperation.total
      }));
    });
  }, [setProjectStatus, t]);

  async function applyProjectOpenResult(result: FlowWeaveProjectOpenResult) {
    if (result.canceled) {
      setProjectStatus(t("status.cancelRead"));
      setLastRunStatus(t("status.cancelRead"));
      return;
    }

    const persistedCanvas = await window.flowweave?.readCanvas(result.projectId);
    const inferredModules = persistedCanvas?.nodes ?? result.graph.nodes;
    const inferredEdges = persistedCanvas?.edges ?? result.graph.edges;
    setProjectLabel(result.project.projectName);
    setProjectId(result.projectId);
    setProjectPath(result.project.rootPath);
    setScanFingerprint(result.scanFingerprint);
    setArtifactStatuses(result.artifacts);
    replaceProjectGraph(inferredModules, inferredEdges, result.project.files, persistedCanvas?.layout);

    const truncateNote = result.project.summary.truncated
      ? t("status.projectTruncated", { count: result.project.summary.displayedEntries ?? maxRenderedTreeRows })
      : "";
    const message = t("status.projectRead", { files: result.project.summary.totalFiles, modules: inferredModules.length, note: truncateNote });
    setProjectStatus(message);
    setLastRunStatus(message);
  }

  async function openProject() {
    if (!window.flowweave) {
      const message = t("status.browserNoOpen");
      setProjectStatus(message);
      setLastRunStatus(message);
      return;
    }

    setIsProjectLoading(true);
    setProjectStatus(t("status.openingPicker"));
    try {
      const result = await window.flowweave.openProject({
        concurrency: scanConcurrency,
        maxEntries: scanMaxEntries
      });
      await applyProjectOpenResult(result);
    } catch (error) {
      const message = t("status.readFailed", { error: formatErrorMessage(error) });
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      setIsProjectLoading(false);
    }
  }

  async function refreshProject() {
    if (!window.flowweave) {
      const message = t("status.browserNoRescan");
      setProjectStatus(message);
      setLastRunStatus(message);
      return;
    }

    if (!projectId) {
      await openProject();
      return;
    }

    setIsProjectLoading(true);
    setProjectStatus(t("status.rescanning"));
    try {
      const result = await window.flowweave.scanProject(projectId, {
        concurrency: scanConcurrency,
        maxEntries: scanMaxEntries
      });
      await applyProjectOpenResult(result);
    } catch (error) {
      const message = t("status.rescanFailed", { error: formatErrorMessage(error) });
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      setIsProjectLoading(false);
    }
  }

  async function cancelProjectOperation() {
    const operationId = activeOperationId.current;
    if (!window.flowweave || !operationId) {
      return;
    }

    await window.flowweave.cancelOperation(operationId);
  }

  async function analyzeProject(agentId: RuntimeAgentId) {
    if (!window.flowweave || !projectId) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }

    setIsProjectLoading(true);
    setProjectStatus(t("status.generatingGraph"));
    try {
      const result = await window.flowweave.analyzeArchitectureWithAgent(projectId, agentId);
      if (result.outcome === "failed") {
        throw new Error(`${result.error.agentId} run ${result.error.runId ?? "unknown"}: ${result.error.message}`);
      }
      replaceProjectGraph(result.graph.nodes, result.graph.edges, projectFiles);
      setArtifactStatuses((current) => current ? {
        ...current,
        architecture: result.architectureMap.source === "agent" || current.architecture === "missing"
          ? "current"
          : current.architecture
      } : current);
      const message = result.warning
        ? t("status.analysisFallbackWarning", {
            count: result.graph.nodes.length,
            agent: result.warning.agentId,
            error: result.warning.message
          })
        : t("status.analysisComplete", { count: result.graph.nodes.length });
      setProjectStatus(message);
      setLastRunStatus(message);
    } catch (error) {
      const message = t("status.analysisFailed", { error: formatErrorMessage(error) });
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      setIsProjectLoading(false);
    }
  }

  return { openProject, refreshProject, analyzeProject, cancelProjectOperation, operation };
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

import type { FlowWeaveProjectOpenResult, GraphEdge, GraphNode, ProjectArtifactStatuses, ProjectFileNode, RuntimeAgentId } from "../types";
import { useI18n } from "../utils/i18n";

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
  replaceProjectGraph: (nodes: GraphNode[], edges: GraphEdge[], files: ProjectFileNode[]) => void;
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
    replaceProjectGraph(inferredModules, inferredEdges, result.project.files);

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
      const result = await window.flowweave.openProject();
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
      const result = await window.flowweave.scanProject(projectId);
      await applyProjectOpenResult(result);
    } catch (error) {
      const message = t("status.rescanFailed", { error: formatErrorMessage(error) });
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      setIsProjectLoading(false);
    }
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
      setArtifactStatuses((current) => current ? { ...current, architecture: "current" } : current);
      const message = t("status.analysisComplete", { count: result.graph.nodes.length });
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

  return { openProject, refreshProject, analyzeProject };
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

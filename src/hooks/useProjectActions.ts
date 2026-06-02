import type { FlowWeaveProjectOpenResult, GraphEdge, GraphNode, ProjectFileNode, RuntimeAgentId } from "../types";
import { useI18n } from "../utils/i18n";

export function useProjectActions({
  maxRenderedTreeRows,
  projectPath,
  projectFiles,
  replaceProjectGraph,
  setIsProjectLoading,
  setLastRunStatus,
  setProjectLabel,
  setProjectPath,
  setProjectStatus
}: {
  maxRenderedTreeRows: number;
  projectPath: string;
  projectFiles: ProjectFileNode[];
  replaceProjectGraph: (nodes: GraphNode[], edges: GraphEdge[], files: ProjectFileNode[]) => void;
  setIsProjectLoading: (value: boolean) => void;
  setLastRunStatus: (value: string) => void;
  setProjectLabel: (value: string) => void;
  setProjectPath: (value: string) => void;
  setProjectStatus: (value: string) => void;
}) {
  const { t } = useI18n();
  async function applyProjectOpenResult(result: FlowWeaveProjectOpenResult) {
    if (result.canceled) {
      setProjectStatus(t("status.cancelRead"));
      setLastRunStatus(t("status.cancelRead"));
      return;
    }

    const persistedCanvas = await window.flowweave?.readCanvas(result.project.rootPath);
    const inferredModules = persistedCanvas?.nodes ?? result.graph.nodes;
    const inferredEdges = persistedCanvas?.edges ?? result.graph.edges;
    setProjectLabel(result.project.projectName);
    setProjectPath(result.project.rootPath);
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

    if (!projectPath) {
      await openProject();
      return;
    }

    setIsProjectLoading(true);
    setProjectStatus(t("status.rescanning"));
    try {
      const result = await window.flowweave.scanProject(projectPath);
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
    if (!window.flowweave || !projectPath) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }

    setIsProjectLoading(true);
    setProjectStatus(t("status.generatingGraph"));
    try {
      const result = await window.flowweave.analyzeArchitectureWithAgent(projectPath, agentId);
      replaceProjectGraph(result.graph.nodes, result.graph.edges, projectFiles);
      const message = result.source === "agent" ? t("status.analysisComplete", { count: result.graph.nodes.length }) : t("status.analysisFallback", { count: result.graph.nodes.length });
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

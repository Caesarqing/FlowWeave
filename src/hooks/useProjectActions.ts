import type { FlowWeaveProjectOpenResult, GraphEdge, GraphNode, ProjectFileNode, RuntimeAgentId } from "../types";

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
  async function applyProjectOpenResult(result: FlowWeaveProjectOpenResult) {
    if (result.canceled) {
      setProjectStatus("已取消项目读取。");
      setLastRunStatus("已取消项目读取。");
      return;
    }

    const persistedCanvas = await window.flowweave?.readCanvas(result.project.rootPath);
    const inferredModules = persistedCanvas?.nodes ?? result.graph.nodes;
    const inferredEdges = persistedCanvas?.edges ?? result.graph.edges;
    setProjectLabel(result.project.projectName);
    setProjectPath(result.project.rootPath);
    replaceProjectGraph(inferredModules, inferredEdges, result.project.files);

    const truncateNote = result.project.summary.truncated
      ? ` 为保持流畅，文件树展示前 ${result.project.summary.displayedEntries ?? maxRenderedTreeRows} 项。`
      : "";
    const message = `已读取 ${result.project.summary.totalFiles} 个文件，生成 ${inferredModules.length} 个模块节点。${truncateNote}`;
    setProjectStatus(message);
    setLastRunStatus(message);
  }

  async function openProject() {
    if (!window.flowweave) {
      const message = "当前是浏览器预览，无法打开本地目录。请使用 npm run dev:electron 启动桌面版。";
      setProjectStatus(message);
      setLastRunStatus(message);
      return;
    }

    setIsProjectLoading(true);
    setProjectStatus("正在打开项目选择器...");
    try {
      const result = await window.flowweave.openProject();
      await applyProjectOpenResult(result);
    } catch (error) {
      const message = `项目读取失败：${formatErrorMessage(error)}`;
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      setIsProjectLoading(false);
    }
  }

  async function refreshProject() {
    if (!window.flowweave) {
      const message = "当前是浏览器预览，无法重新扫描本地目录。请使用 npm run dev:electron 启动桌面版。";
      setProjectStatus(message);
      setLastRunStatus(message);
      return;
    }

    if (!projectPath) {
      await openProject();
      return;
    }

    setIsProjectLoading(true);
    setProjectStatus("正在重新扫描当前项目...");
    try {
      const result = await window.flowweave.scanProject(projectPath);
      await applyProjectOpenResult(result);
    } catch (error) {
      const message = `重新扫描失败：${formatErrorMessage(error)}`;
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      setIsProjectLoading(false);
    }
  }

  async function analyzeProject(agentId: RuntimeAgentId) {
    if (!window.flowweave || !projectPath) {
      setLastRunStatus("请先在桌面版 Canvas 页读取一个本地项目。");
      return;
    }

    setIsProjectLoading(true);
    setProjectStatus("正在生成架构模块图...");
    try {
      const result = await window.flowweave.analyzeArchitectureWithAgent(projectPath, agentId);
      replaceProjectGraph(result.graph.nodes, result.graph.edges, projectFiles);
      const message = result.source === "agent" ? `架构图生成完成，生成 ${result.graph.nodes.length} 个功能模块。` : `基础架构图生成完成，生成 ${result.graph.nodes.length} 个功能模块。`;
      setProjectStatus(message);
      setLastRunStatus(message);
    } catch (error) {
      const message = `架构图生成失败：${formatErrorMessage(error)}`;
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

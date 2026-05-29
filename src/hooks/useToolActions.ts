import { toolMeta, type ToolUiStatus } from "../components/AgentPage";
import type { ExecutionMode, GraphEdge, GraphNode, ToolId } from "../types";

export function useToolActions({
  buildGuidanceMarkdown,
  executionMode,
  graphRelations,
  modules,
  projectLabel,
  projectPath,
  selectedNode,
  setLastRunStatus,
  setSelectedToolId,
  setToolStatuses
}: {
  buildGuidanceMarkdown: (projectLabel: string, nodes: GraphNode[], edges: GraphEdge[]) => string;
  executionMode: ExecutionMode;
  graphRelations: GraphEdge[];
  modules: GraphNode[];
  projectLabel: string;
  projectPath: string;
  selectedNode?: GraphNode;
  setLastRunStatus: (value: string) => void;
  setSelectedToolId: (toolId: ToolId) => void;
  setToolStatuses: (updater: Record<ToolId, ToolUiStatus> | ((current: Record<ToolId, ToolUiStatus>) => Record<ToolId, ToolUiStatus>)) => void;
}) {
  async function detectTool(toolId: ToolId) {
    if (!window.flowweave) {
      setToolStatuses((current) => ({ ...current, [toolId]: { ...current[toolId], available: false, checking: false } }));
      setLastRunStatus("浏览器预览模式无法检测本地 Agent。请使用 npm run dev:electron 打开桌面版。");
      return;
    }

    setToolStatuses((current) => ({ ...current, [toolId]: { ...current[toolId], checking: true } }));
    setLastRunStatus(`正在检测 ${toolMeta[toolId].name}...`);
    try {
      const result = await window.flowweave.detectTool(toolId);
      setToolStatuses((current) => ({ ...current, [toolId]: { ...current[toolId], ...result, checking: false } }));
      setLastRunStatus(
        result.available
          ? `${toolMeta[toolId].name} 已检测 · ${result.commandPath ?? result.appPath ?? result.version ?? "ready"}`
          : `${toolMeta[toolId].name} 未检测到。`
      );
    } catch (error) {
      setToolStatuses((current) => ({ ...current, [toolId]: { ...current[toolId], available: false, checking: false } }));
      setLastRunStatus(`${toolMeta[toolId].name} 检测失败：${formatErrorMessage(error)}`);
    }
  }

  async function openToolProject(toolId: ToolId) {
    if (!window.flowweave || !projectPath) {
      setLastRunStatus("请先在桌面版 Canvas 页读取一个本地项目。");
      return;
    }

    try {
      const result = await window.flowweave.openToolProject(toolId, projectPath);
      setLastRunStatus(`${toolMeta[toolId].name} ${result.opened ? "已打开项目" : "打开失败"} · ${result.message ?? result.method}`);
    } catch (error) {
      setLastRunStatus(`${toolMeta[toolId].name} 打开项目失败：${formatErrorMessage(error)}`);
    }
  }

  async function runToolPlan(toolId: ToolId) {
    if (!window.flowweave || !projectPath || !selectedNode) {
      setLastRunStatus("请先在桌面版 Canvas 页读取一个本地项目。");
      return;
    }

    setLastRunStatus(`正在让 ${toolMeta[toolId].name} 以 ${executionMode} 模式处理...`);
    try {
      const detection = await window.flowweave.detectTool(toolId);
      setToolStatuses((current) => ({ ...current, [toolId]: { ...current[toolId], ...detection, checking: false } }));
      if (!detection.available) {
        setLastRunStatus(`${toolMeta[toolId].name} 未检测到，无法生成计划。`);
        return;
      }

      const result = await window.flowweave.runToolPlan({
        projectPath,
        toolId,
        executionMode,
        prompt: `FlowWeave plan request for module "${selectedNode.title}".

Use this module graph as the modification boundary:
${buildGuidanceMarkdown(projectLabel, modules, graphRelations)}

Return an implementation plan, affected files, risks, and tests. Do not edit files from FlowWeave.`
      });

      setSelectedToolId(toolId);
      setToolStatuses((current) => ({
        ...current,
        [toolId]: {
          ...current[toolId],
          lastRunStatus: result.status,
          lastOutputPath: result.planPath ?? result.logPath ?? result.resultPath
        }
      }));
      setLastRunStatus(`${toolMeta[toolId].name} ${executionMode} ${result.status} · ${result.planPath ?? result.logPath ?? "no output"}`);
    } catch (error) {
      setToolStatuses((current) => ({ ...current, [toolId]: { ...current[toolId], lastRunStatus: "failed" } }));
      setLastRunStatus(`${toolMeta[toolId].name} 生成计划失败：${formatErrorMessage(error)}`);
    }
  }

  return { detectTool, openToolProject, runToolPlan };
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

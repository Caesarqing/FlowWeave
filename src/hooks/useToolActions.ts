import type { AgentDefinition, AgentId, ExecutionMode, GraphEdge, GraphNode, RuntimeAgentId, ToolId, ToolUiStatus } from "../types";
import { useI18n } from "../utils/i18n";

export function useToolActions({
  buildGuidanceMarkdown,
  agents,
  executionMode,
  graphRelations,
  modules,
  projectLabel,
  projectPath,
  selectedNode,
  onRunCompleted,
  setLastRunStatus,
  setSelectedAgentId,
  setToolStatuses
}: {
  buildGuidanceMarkdown: (projectLabel: string, nodes: GraphNode[], edges: GraphEdge[]) => string;
  agents: AgentDefinition[];
  executionMode: ExecutionMode;
  graphRelations: GraphEdge[];
  modules: GraphNode[];
  projectLabel: string;
  projectPath: string;
  selectedNode?: GraphNode;
  onRunCompleted?: (runId: string) => void | Promise<void>;
  setLastRunStatus: (value: string) => void;
  setSelectedAgentId: (agentId: AgentId) => void;
  setToolStatuses: (updater: Record<string, ToolUiStatus> | ((current: Record<string, ToolUiStatus>) => Record<string, ToolUiStatus>)) => void;
}) {
  const { t } = useI18n();
  const agentNames = new Map<string, string>(agents.map((agent) => [agent.id, agent.name]));
  const getAgentName = (agentId: RuntimeAgentId) => agentNames.get(agentId) ?? (agentId === "mock" ? "Mock Agent" : agentId);

  async function detectAgent(agentId: RuntimeAgentId) {
    if (!window.flowweave) {
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], toolId: agentId, available: false, method: "none", checking: false } }));
      setLastRunStatus(t("agent.bridgeWarning"));
      return;
    }

    setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], toolId: agentId, available: false, method: "none", checking: true } }));
    setLastRunStatus(`正在检测 ${getAgentName(agentId)}...`);
    try {
      const result = await window.flowweave.detectAgent(agentId);
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], ...result, checking: false } }));
      setLastRunStatus(
        result.available
          ? `${getAgentName(agentId)} 已检测 · ${result.commandPath ?? result.appPath ?? result.version ?? "ready"}`
          : `${getAgentName(agentId)} 未检测到。`
      );
    } catch (error) {
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], toolId: agentId, available: false, method: "none", checking: false } }));
      setLastRunStatus(`${getAgentName(agentId)} 检测失败：${formatErrorMessage(error)}`);
    }
  }

  async function openToolProject(agentId: RuntimeAgentId) {
    if (!window.flowweave || !projectPath) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }

    if (!isOpenableToolId(agentId)) {
      setLastRunStatus(`${getAgentName(agentId)} 是 CLI 对话型 Agent，不支持从 FlowWeave 打开项目。`);
      return;
    }

    try {
      const result = await window.flowweave.openToolProject(agentId, projectPath);
      setLastRunStatus(`${getAgentName(agentId)} ${result.opened ? "已打开项目" : "打开失败"} · ${result.message ?? result.method}`);
    } catch (error) {
      setLastRunStatus(`${getAgentName(agentId)} 打开项目失败：${formatErrorMessage(error)}`);
    }
  }

  async function runToolPlan(agentId: RuntimeAgentId) {
    if (!window.flowweave || !projectPath || !selectedNode) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }

    setLastRunStatus(`正在让 ${getAgentName(agentId)} 以 ${executionMode} 模式处理...`);
    try {
      const detection = await window.flowweave.detectAgent(agentId);
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], ...detection, checking: false } }));
      if (!detection.available) {
        setLastRunStatus(`${getAgentName(agentId)} 未检测到，无法生成计划。`);
        return;
      }

      const result = await window.flowweave.runToolPlan({
        projectPath,
        toolId: agentId,
        executionMode,
        prompt: `FlowWeave plan request for module "${selectedNode.title}".

Use this module graph as the modification boundary:
${buildGuidanceMarkdown(projectLabel, modules, graphRelations)}

Return an implementation plan, affected files, risks, and tests. Do not edit files from FlowWeave.`
      });

      if (agentId !== "mock") setSelectedAgentId(agentId);
      setToolStatuses((current) => ({
        ...current,
        [agentId]: {
          ...current[agentId],
          lastRunStatus: result.status,
          lastOutputPath: result.planPath ?? result.logPath ?? result.resultPath
        }
      }));
      setLastRunStatus(`${getAgentName(agentId)} ${executionMode} ${result.status} · ${result.planPath ?? result.logPath ?? "no output"}`);
      await onRunCompleted?.(result.id);
    } catch (error) {
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], lastRunStatus: "failed" } }));
      setLastRunStatus(`${getAgentName(agentId)} 生成计划失败：${formatErrorMessage(error)}`);
    }
  }

  return { detectAgent, openToolProject, runToolPlan };
}

function isOpenableToolId(agentId: RuntimeAgentId): agentId is ToolId {
  return agentId === "codex-local" || agentId === "claude-code" || agentId === "cursor" || agentId === "mock";
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

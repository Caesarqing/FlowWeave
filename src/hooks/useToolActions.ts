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
    setLastRunStatus(t("status.detectingAgent", { agent: getAgentName(agentId) }));
    try {
      const result = await window.flowweave.detectAgent(agentId);
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], ...result, checking: false } }));
      setLastRunStatus(
        result.available
          ? t("status.agentDetected", { agent: getAgentName(agentId), detail: result.commandPath ?? result.appPath ?? result.version ?? "ready" })
          : t("status.agentMissing", { agent: getAgentName(agentId) })
      );
    } catch (error) {
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], toolId: agentId, available: false, method: "none", checking: false } }));
      setLastRunStatus(t("status.agentDetectFailed", { agent: getAgentName(agentId), error: formatErrorMessage(error) }));
    }
  }

  async function openToolProject(agentId: RuntimeAgentId) {
    if (!window.flowweave || !projectPath) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }

    if (!isOpenableToolId(agentId)) {
      setLastRunStatus(t("status.agentOpenUnsupported", { agent: getAgentName(agentId) }));
      return;
    }

    try {
      const result = await window.flowweave.openToolProject(agentId, projectPath);
      setLastRunStatus(
        t(result.opened ? "status.agentProjectOpened" : "status.agentProjectOpenFailed", {
          agent: getAgentName(agentId),
          detail: result.message ?? result.method
        })
      );
    } catch (error) {
      setLastRunStatus(t("status.agentProjectOpenError", { agent: getAgentName(agentId), error: formatErrorMessage(error) }));
    }
  }

  async function runToolPlan(agentId: RuntimeAgentId) {
    if (!window.flowweave || !projectPath) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }
    if (!selectedNode) {
      setLastRunStatus(t("status.noProject"));
      return;
    }

    setLastRunStatus(t("status.agentProcessing", { agent: getAgentName(agentId), mode: executionMode }));
    try {
      const detection = await window.flowweave.detectAgent(agentId);
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], ...detection, checking: false } }));
      if (!detection.available) {
        setLastRunStatus(t("status.agentCannotPlan", { agent: getAgentName(agentId) }));
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
      setLastRunStatus(t("status.agentPlanFailed", { agent: getAgentName(agentId), error: formatErrorMessage(error) }));
    }
  }

  return { detectAgent, openToolProject, runToolPlan };
}

function isOpenableToolId(agentId: RuntimeAgentId): agentId is ToolId {
  return (
    agentId === "claude-code" ||
    agentId === "claude-desktop" ||
    agentId === "codex-local" ||
    agentId === "codex-desktop" ||
    agentId === "gemini-cli" ||
    agentId === "cursor" ||
    agentId === "mock"
  );
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

import type { AgentDefinition, AgentId, ExecutionMode, GraphEdge, GraphNode, RuntimeAgentId, ToolId, ToolUiStatus } from "../types";
import { useI18n } from "../utils/i18n";
import { usePreferencesStore } from "../stores/preferences.store";
import { buildExecutionAssessmentSummary, scopeGraphForModule } from "../utils/export-artifacts";

export function useToolActions({
  buildGuidanceMarkdown,
  agents,
  executionMode,
  graphRelations,
  modules,
  projectLabel,
  projectId,
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
  projectId: string;
  projectPath: string;
  selectedNode?: GraphNode;
  onRunCompleted?: (runId: string) => void | Promise<void>;
  setLastRunStatus: (value: string) => void;
  setSelectedAgentId: (agentId: AgentId) => void;
  setToolStatuses: (updater: Record<string, ToolUiStatus> | ((current: Record<string, ToolUiStatus>) => Record<string, ToolUiStatus>)) => void;
}) {
  const { t } = useI18n();
  const planTimeoutMinutes = usePreferencesStore((state) => state.planTimeoutMinutes);
  const executeTimeoutMinutes = usePreferencesStore((state) => state.executeTimeoutMinutes);
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

  async function healthCheckAgent(agentId: RuntimeAgentId) {
    if (!window.flowweave) {
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], toolId: agentId, available: false, method: "none", checking: false } }));
      setLastRunStatus(t("agent.bridgeWarning"));
      return;
    }

    setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], toolId: agentId, checking: true } }));
    setLastRunStatus(t("status.agentHealthChecking", { agent: getAgentName(agentId) }));
    try {
      const health = await window.flowweave.healthCheckAgent(agentId);
      const failedChecks = health.checks.filter((check) => check.status === "failed").length;
      const warningChecks = health.checks.filter((check) => check.status === "warning").length;
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], health, checking: false } }));
      setLastRunStatus(t("status.agentHealthChecked", {
        agent: getAgentName(agentId),
        severity: health.severity,
        failed: String(failedChecks),
        warnings: String(warningChecks)
      }));
    } catch (error) {
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], checking: false } }));
      setLastRunStatus(t("status.agentHealthFailed", { agent: getAgentName(agentId), error: formatErrorMessage(error) }));
    }
  }

  async function openToolProject(agentId: RuntimeAgentId) {
    if (!window.flowweave || !projectId) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }

    if (!isOpenableToolId(agentId)) {
      setLastRunStatus(t("status.agentOpenUnsupported", { agent: getAgentName(agentId) }));
      return;
    }

    try {
      const result = await window.flowweave.openToolProject(agentId, projectId);
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
    if (!window.flowweave || !projectId) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }
    if (!selectedNode) {
      setLastRunStatus(t("status.noProject"));
      return;
    }
    const executionScope = scopeGraphForModule(modules, graphRelations, selectedNode.id);
    if (executionMode === "execute" && !window.confirm(`${t("agent.executeConfirm", {
      agent: getAgentName(agentId),
      project: projectPath
    })}\n\n${buildExecutionAssessmentSummary(executionScope.nodes, executionScope.edges)}`)) {
      setLastRunStatus(t("agent.executeCanceled"));
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
        projectId,
        toolId: agentId,
        executionMode,
        confirmedExecute: executionMode === "execute",
        planTimeoutMs: executionMode === "plan" ? planTimeoutMinutes * 60_000 : undefined,
        executeTimeoutMs: executionMode === "execute" ? executeTimeoutMinutes * 60_000 : undefined,
        purpose: "implementation-plan",
        prompt: `FlowWeave plan request for module "${selectedNode.title}".

Use this module graph as the modification boundary:
${buildGuidanceMarkdown(projectLabel, modules, graphRelations)}

${executionMode === "plan"
  ? "Return an implementation plan, affected files, risks, and tests. Do not edit files."
  : "Implement the requested module changes, report affected files, risks, and tests."}`
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

  return { detectAgent, healthCheckAgent, openToolProject, runToolPlan };
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

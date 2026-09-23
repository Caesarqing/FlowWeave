import type { AgentDefinition, AgentId, AgentPluginHostId, AgentPluginStatus, ExecutionMode, GraphEdge, GraphNode, RuntimeAgentId, ToolUiStatus } from "../types";
import { useI18n } from "../utils/i18n";
import { usePreferencesStore } from "../stores/preferences.store";
import { buildAgentPrompt, buildExecutionAssessmentSummary, buildModificationContext, scopeGraphForModule } from "../utils/export-artifacts";

export function useToolActions({
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
  setPluginStatuses,
  setSelectedAgentId,
  setToolStatuses
}: {
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
  setPluginStatuses: (statuses: AgentPluginStatus[]) => void;
  setSelectedAgentId: (agentId: AgentId) => void;
  setToolStatuses: (updater: Record<string, ToolUiStatus> | ((current: Record<string, ToolUiStatus>) => Record<string, ToolUiStatus>)) => void;
}) {
  const { t } = useI18n();
  const agentPlanTimeoutMinutes = usePreferencesStore((state) => state.agentPlanTimeoutMinutes);
  const agentExecuteTimeoutMinutes = usePreferencesStore((state) => state.agentExecuteTimeoutMinutes);
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
      const result = await window.flowweave.detectAgent(agentId, projectId || undefined);
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
      const health = await window.flowweave.healthCheckAgent(agentId, projectId || undefined);
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

    if (!isOpenableAgent(agentId, agents)) {
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
      const detection = await window.flowweave.detectAgent(agentId, projectId || undefined);
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
        purpose: "implementation-plan",
        timeoutMs: (executionMode === "execute" ? agentExecuteTimeoutMinutes : agentPlanTimeoutMinutes) * 60 * 1000,
        prompt: buildAgentPrompt(
          buildModificationContext({
            projectLabel,
            projectPath,
            nodes: modules,
            edges: graphRelations,
            selectedNodeId: selectedNode.id
          }),
          "canvas-implementation-plan",
          executionMode
        )
      });

      if (agentId !== "mock") setSelectedAgentId(agentId);
      setToolStatuses((current) => ({
        ...current,
        [agentId]: {
          ...current[agentId],
          health: result.agentReadiness ?? current[agentId].health,
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

  async function refreshAgentPlugins() {
    if (!window.flowweave || !projectId) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }
    try {
      const statuses = await window.flowweave.getAgentPluginStatuses(projectId);
      setPluginStatuses(statuses);
      setLastRunStatus(t("agent.pluginStatusRefreshed"));
    } catch (error) {
      setLastRunStatus(t("agent.pluginStatusFailed", { error: formatErrorMessage(error) }));
    }
  }

  async function installAgentPlugins() {
    if (!window.flowweave || !projectId) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }
    try {
      const statuses = await window.flowweave.installAgentPlugin(projectId);
      setPluginStatuses(statuses);
      setLastRunStatus(t("agent.pluginInstalled", { path: statuses[0]?.installTarget ?? "" }));
    } catch (error) {
      setLastRunStatus(t("agent.pluginInstallFailed", { error: formatErrorMessage(error) }));
    }
  }

  async function openAgentPluginFolder() {
    if (!window.flowweave || !projectId) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }
    try {
      await window.flowweave.openAgentPlugin(projectId);
      setLastRunStatus(t("agent.pluginFolderOpened", { path: pluginStatusesPathLabel(projectPath) }));
    } catch (error) {
      setLastRunStatus(t("agent.pluginOpenFailed", { error: formatErrorMessage(error) }));
    }
  }

  async function openAgentPluginInstructions(hostId: AgentPluginHostId) {
    if (!window.flowweave || !projectId) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }
    try {
      await window.flowweave.openAgentPluginInstructions(projectId, hostId);
      setLastRunStatus(t("agent.pluginInstructionsOpened", { host: hostId }));
    } catch (error) {
      setLastRunStatus(t("agent.pluginInstructionsOpenFailed", { error: formatErrorMessage(error) }));
    }
  }

  return { detectAgent, healthCheckAgent, installAgentPlugins, openAgentPluginFolder, openAgentPluginInstructions, openToolProject, refreshAgentPlugins, runToolPlan };
}

function isOpenableAgent(agentId: RuntimeAgentId, agents: AgentDefinition[]): boolean {
  const agent = agents.find((item) => item.id === agentId);
  return (
    agentId === "claude-code" ||
    agentId === "claude-desktop" ||
    agentId === "codex-local" ||
    agentId === "codex-desktop" ||
    agentId === "gemini-cli" ||
    agentId === "cursor" ||
    agentId === "mock" ||
    agent?.kind === "desktop"
  );
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function pluginStatusesPathLabel(projectPath: string): string {
  return projectPath ? `${projectPath}/.flowweave/agent-plugins/flowweave` : "";
}

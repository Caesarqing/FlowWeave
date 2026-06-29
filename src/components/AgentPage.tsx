import { Activity, CheckCircle2, CircleAlert, Clipboard, FileText, Folder, GitPullRequestArrow, Play, Plus, RefreshCw, Settings2, Terminal, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentCapability, AgentDefinition, AgentId, AgentProtocol, ArchitectureReviewStatus, CustomAgentInput, ExecutionMode, ProjectAgentConnectionStatus, RuntimeAgentId, ToolRunArtifact, ToolRunSummary, ToolUiStatus } from "../types";
import type { RunArtifactTab } from "../stores/runs.store";
import { cn } from "../utils/classnames";
import { buildAgentConnectorPrompt } from "../utils/agent-connector-prompts";
import { useI18n } from "../utils/i18n";
import { WorkspaceLayout } from "./WorkspaceLayout";
import { Button } from "./Button";

const fallbackAgents: AgentDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code CLI",
    kind: "cli",
    command: "claude",
    args: ["--print", "--permission-mode", "plan"],
    protocol: "cli-stdin",
    capabilities: ["artifact-analysis", "implementation-plan"],
    description: "Calls Claude Code in plan mode.",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    kind: "desktop",
    command: "/Applications/Claude.app",
    args: [".flowweave/agent-bridge"],
    protocol: "desktop-bridge",
    appPath: "/Applications/Claude.app",
    capabilities: ["artifact-analysis", "implementation-plan"],
    description: "Opens Claude Desktop and waits for file bridge responses.",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "codex-local",
    name: "Codex CLI",
    kind: "cli",
    command: "codex",
    args: ["exec", "--sandbox", "read-only"],
    protocol: "cli-stdin",
    capabilities: ["artifact-analysis", "implementation-plan"],
    description: "Calls the local Codex CLI with FlowWeave context.",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "codex-desktop",
    name: "Codex Desktop",
    kind: "desktop",
    command: "/Applications/Codex.app",
    args: [".flowweave/agent-bridge"],
    protocol: "desktop-bridge",
    appPath: "/Applications/Codex.app",
    capabilities: ["artifact-analysis", "implementation-plan"],
    description: "Opens Codex Desktop and waits for file bridge responses.",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    kind: "cli",
    command: "gemini",
    args: [],
    protocol: "cli-stdin",
    capabilities: ["artifact-analysis", "implementation-plan"],
    description: "Calls the local Gemini CLI through stdin.",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "desktop",
    command: "cursor",
    args: [],
    protocol: "desktop-bridge",
    appPath: "cursor",
    capabilities: ["artifact-analysis", "implementation-plan"],
    description: "Detects Cursor for project review.",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  }
];

const builtInAgentDescriptionKeys: Partial<Record<RuntimeAgentId, string>> = {
  "claude-code": "agent.claudeDescription",
  "claude-desktop": "agent.claudeDesktopDescription",
  "codex-local": "agent.codexDescription",
  "codex-desktop": "agent.codexDesktopDescription",
  "gemini-cli": "agent.geminiDescription",
  cursor: "agent.cursorDescription"
};

export function AgentPage({
  agents,
  architectureReview,
  executionMode,
  isRunsLoading,
  isDesktopBridgeAvailable,
  lastRunStatus,
  onAnalyzeCurrentProject,
  onApplyRunArtifact,
  onDeleteCustomAgent,
  onDetectAgent,
  onExecutionModeChange,
  onGoToGitReview,
  onHealthCheckAgent,
  onOpenRunBridge,
  onOpenToolProject,
  onRefreshRuns,
  onRetryRunArtifact,
  onRunToolPlan,
  onRunArtifactTabChange,
  onSaveCustomAgent,
  onSelectAgent,
  onSelectRun,
  projectPath,
  projectConnection,
  runArtifactTab,
  runs,
  selectedAgentId,
  selectedRunArtifact,
  selectedRunId,
  toolStatuses
}: {
  agents: AgentDefinition[];
  architectureReview: ArchitectureReviewStatus;
  executionMode: ExecutionMode;
  isRunsLoading: boolean;
  isDesktopBridgeAvailable: boolean;
  lastRunStatus: string;
  onAnalyzeCurrentProject: (agentId?: RuntimeAgentId) => void;
  onApplyRunArtifact: () => void;
  onDeleteCustomAgent: (agentId: AgentId) => void;
  onDetectAgent: (agentId: RuntimeAgentId) => void;
  onExecutionModeChange: (mode: ExecutionMode) => void;
  onGoToGitReview: () => void;
  onHealthCheckAgent: (agentId: RuntimeAgentId) => void;
  onOpenRunBridge: () => void;
  onOpenToolProject: (agentId: RuntimeAgentId) => void;
  onRefreshRuns: () => void;
  onRetryRunArtifact: (target: ToolRunSummary["artifactTarget"], agentId: RuntimeAgentId) => void;
  onRunToolPlan: (agentId: RuntimeAgentId) => void;
  onRunArtifactTabChange: (tab: RunArtifactTab) => void;
  onSaveCustomAgent: (input: CustomAgentInput) => void;
  onSelectAgent: (agentId: AgentId) => void;
  onSelectRun: (runId: string) => void;
  projectPath: string;
  projectConnection?: ProjectAgentConnectionStatus;
  runArtifactTab: RunArtifactTab;
  runs: ToolRunSummary[];
  selectedAgentId: AgentId;
  selectedRunArtifact?: ToolRunArtifact;
  selectedRunId: string;
  toolStatuses: Record<string, ToolUiStatus>;
}) {
  const { locale, t } = useI18n();
  const visibleAgents = agents.length > 0 ? agents : fallbackAgents;
  const selectedAgent = visibleAgents.find((agent) => agent.id === selectedAgentId) ?? visibleAgents[0];
  const isArchitectureReviewing = architectureReview.state === "reviewing";
  const agentNames = useMemo(() => new Map<string, string>(visibleAgents.map((agent) => [agent.id, agent.name])), [visibleAgents]);
  const [isAddingAgent, setIsAddingAgent] = useState(false);
  const [copiedAgentId, setCopiedAgentId] = useState<string>("");

  return (
    <main className="agents-page">
      <section className="agents-intro">
        <div>
          <h2>{t("agent.agentWorkspace")}</h2>
          <p>{t("agent.intro")}</p>
        </div>
        <div className="run-status">
          <Terminal size={15} />
          <span>{lastRunStatus}</span>
        </div>
      </section>

      <section className="default-agent-panel">
        <div>
          <small>{t("agent.defaultAgent")}</small>
          <strong>{selectedAgent?.name ?? t("agent.notSelected")}</strong>
          <span>{selectedAgent ? commandLabel(selectedAgent) : t("agent.addOrSelect")}</span>
        </div>
        <button className="send-button" disabled={!projectPath || !selectedAgent || isArchitectureReviewing} type="button" onClick={() => onAnalyzeCurrentProject()}>
          <Play size={14} />
          {isArchitectureReviewing
            ? t("agent.waitingForRun", { runId: architectureReview.runId ?? architectureReview.reviewId ?? "" })
            : t("agent.analyzeProject")}
        </button>
      </section>

      <section className="execution-mode-panel">
        <div>
          <strong>{t("agent.executionMode")}</strong>
          <span>{t("agent.executionModeHelp")}</span>
        </div>
        <div className="segmented-control">
          <button className={cn(executionMode === "plan" && "active")} type="button" onClick={() => onExecutionModeChange("plan")}>
            {t("agent.mode.plan")}
          </button>
          <button
            className={cn("danger", executionMode === "execute" && "active")}
            type="button"
            onClick={() => onExecutionModeChange("execute")}
          >
            {t("agent.mode.execute")}
          </button>
        </div>
      </section>

      {!isDesktopBridgeAvailable ? (
        <section className="bridge-warning">
          {t("agent.bridgeWarning")}
        </section>
      ) : null}

      <section className="agent-grid">
        {visibleAgents.map((agent) => {
          const status = toolStatuses[agent.id] ?? createUnknownStatus(agent.id);
          const available = status.available;
          const isSelected = selectedAgentId === agent.id;
          const connectorPrompt = buildAgentConnectorPrompt({ agentId: agent.id, locale, projectPath: projectPath || "/path/to/project" });
          const runDisabled = isGeneratePlanDisabled(status);
          return (
            <article className={cn("agent-card", isSelected && "selected default-agent-card")} key={agent.id}>
              <div className="agent-card-header">
                <div>
                  <small>{agent.builtIn ? t("agent.builtIn") : agent.id}</small>
                  <h3>{agent.name}</h3>
                </div>
                <div className="agent-card-badges">
                  {isSelected ? <span className="default-badge">{t("agent.default")}</span> : null}
                  <span className={cn("agent-status", available ? "ok" : status.checking ? undefined : "missing")}>
                    {available ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
                    {getToolStatusLabel(status, t)}
                  </span>
                </div>
              </div>
              <p>{agentDescription(agent, t)}</p>
              <code>{commandLabel(agent)}</code>
              <div className="agent-connector-box">
                <div>
                  <small>{t("agent.connectorPrompt")}</small>
                  <span>{connectorPrompt.description}</span>
                </div>
                <code>{connectorPrompt.command}</code>
                <button
                  className="ghost-button"
                  disabled={!projectPath}
                  type="button"
                  onClick={() => {
                    void copyConnectorPrompt(connectorPrompt.command).then(() => setCopiedAgentId(agent.id));
                  }}
                >
                  <Clipboard size={14} />
                  {copiedAgentId === agent.id ? t("agent.copied") : t("agent.copyConnector")}
                </button>
              </div>
              <div className="agent-detail-list">
                <span>{t("agent.kind")}: {agent.kind}</span>
                <span>{t("agent.protocol")}: {agent.protocol ?? (agent.kind === "desktop" ? "desktop-bridge" : "cli-stdin")}</span>
                <span>{t("agent.capabilities")}: {(agent.capabilities ?? []).join(", ") || t("agent.none")}</span>
                <span>{t("agent.commandStatus")}: {commandStatusLabel(status, t)}</span>
                <span>{t("agent.projectContext")}: {connectionStatusLabel(status.health?.connection ?? projectConnection, t)}</span>
                <span>{t("agent.runReadiness")}: {runReadinessLabel(status, t)}</span>
                <span>{t("agent.cli")}: {status.commandPath ?? t("agent.notDetected")}</span>
                <span>{t("agent.app")}: {status.appPath ?? t("agent.notDetected")}</span>
                <span>{t("agent.version")}: {status.version ?? t("agent.notDetected")}</span>
                <span>{t("agent.lastOutput")}: {status.lastOutputPath ?? t("agent.none")}</span>
              </div>
              {status.health ? (
                <div className={cn("agent-health-box", status.health.severity)}>
                  <strong>{t("agent.health")}: {status.health.severity}</strong>
                  {status.health.checks.map((check) => (
                    <span key={check.id}>{check.label}: {check.status} · {check.message}</span>
                  ))}
                  {status.health.suggestedActions.map((action) => (
                    <small key={action}>{action}</small>
                  ))}
                </div>
              ) : null}
              <div className="agent-actions">
                <button className="ghost-button" type="button" onClick={() => onDetectAgent(agent.id)}>
                  <RefreshCw size={14} />
                  {status.checking ? t("agent.checking") : t("agent.detect")}
                </button>
                <button className="ghost-button" type="button" onClick={() => onHealthCheckAgent(agent.id)}>
                  <Activity size={14} />
                  {t("agent.healthCheck")}
                </button>
                <button
                  className={cn(isSelected && "default-button", !isSelected && "ghost-button")}
                  disabled={isSelected}
                  type="button"
                  onClick={() => onSelectAgent(agent.id)}
                >
                  <Settings2 size={14} />
                  {isSelected ? t("agent.currentDefault") : t("agent.setDefault")}
                </button>
                <button className="send-button" disabled={runDisabled} type="button" onClick={() => onRunToolPlan(agent.id)}>
                  <Play size={14} />
                  {t("agent.generatePlan")}
                </button>
                <button className="ghost-button" type="button" onClick={() => onOpenToolProject(agent.id)}>
                  <Folder size={14} />
                  {t("agent.openProject")}
                </button>
                {!agent.builtIn ? (
                  <button className="ghost-button danger-button" type="button" onClick={() => onDeleteCustomAgent(agent.id)}>
                    <Trash2 size={14} />
                    {t("agent.delete")}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
        <AddAgentCard isAdding={isAddingAgent} onCancel={() => setIsAddingAgent(false)} onSave={onSaveCustomAgent} onStart={() => setIsAddingAgent(true)} />
      </section>

      <WorkspaceLayout
        actions={(
          <Button
            disabled={!selectedRunArtifact}
            icon={<GitPullRequestArrow size={14} />}
            variant="secondary"
            onClick={onGoToGitReview}
          >
            {t("agent.goGitReview")}
          </Button>
        )}
        className="run-workspace"
        left={<aside className="run-history">
          <div className="panel-header">
            <span>{t("agent.runHistory")}</span>
            <button className="icon-button" title={t("agent.refreshRuns")} type="button" onClick={onRefreshRuns}>
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="run-list">
            {runs.length > 0 ? (
              runs.map((run) => (
                <button className={cn("run-row", selectedRunId === run.id && "active")} key={run.id} type="button" onClick={() => onSelectRun(run.id)}>
                  <span className={cn("run-dot", run.status)} />
                  <div>
                    <strong>{run.id}</strong>
                    <span>{agentNames.get(run.toolId) ?? run.toolId} · {run.executionMode} · {run.status}</span>
                    {run.artifactAdoption ? (
                      <span className={cn("run-adoption", run.artifactAdoption.status)}>
                        {artifactAdoptionLabel(run.artifactAdoption.status, t)}
                      </span>
                    ) : null}
                    {run.agentReadiness ? (
                      <span className={cn("run-adoption", run.agentReadiness.severity)}>
                        {agentReadinessLabel(run.agentReadiness, t)}
                      </span>
                    ) : null}
                    {run.failure ? <span>{run.failure.code} · {run.failure.message}</span> : null}
                  </div>
                  <small>{formatRunTime(run.startedAt)}</small>
                </button>
              ))
            ) : (
              <p className="empty-state">{isRunsLoading ? t("agent.readingRuns") : t("agent.noRuns")}</p>
            )}
          </div>
        </aside>}
        leftWidth="minmax(260px, 340px)"
        page="tools"
        status={lastRunStatus}
        title={t("agent.artifacts")}
      >
        <section className="run-artifact">
          {selectedRunArtifact ? (
            <>
              <div className="run-summary-strip">
                <div className="run-summary-content">
                  <FileText size={15} />
                  <span className="run-summary-message">
                    {selectedRunArtifact.summary.failure
                      ? `${selectedRunArtifact.summary.toolId} · ${selectedRunArtifact.summary.failure.code} · ${selectedRunArtifact.summary.failure.message}`
                      : selectedRunArtifact.summary.summary ?? selectedRunArtifact.summary.id}
                  </span>
                  <code className="run-summary-path">{selectedRunArtifact.summary.planPath ?? selectedRunArtifact.summary.logPath ?? t("agent.noOutputPath")}</code>
                  {selectedRunArtifact.summary.artifactAdoption ? (
                    <span className={cn("run-adoption", selectedRunArtifact.summary.artifactAdoption.status)}>
                      {artifactAdoptionLabel(selectedRunArtifact.summary.artifactAdoption.status, t)}
                    </span>
                  ) : null}
                  {selectedRunArtifact.summary.agentReadiness ? (
                    <span className={cn("run-adoption", selectedRunArtifact.summary.agentReadiness.severity)}>
                      {agentReadinessLabel(selectedRunArtifact.summary.agentReadiness, t)}
                    </span>
                  ) : null}
                </div>
                <div className="run-summary-actions">
                  {canApplyRunArtifact(selectedRunArtifact.summary) ? (
                    <button className="ghost-button" type="button" onClick={onApplyRunArtifact}>
                      <CheckCircle2 size={14} />
                      {t("agent.applyRunArtifact")}
                    </button>
                  ) : null}
                  {canOpenRunBridge(selectedRunArtifact.summary) ? (
                    <button className="ghost-button" type="button" onClick={onOpenRunBridge}>
                      {t("agent.openRunBridge")}
                    </button>
                  ) : null}
                  {canRetryArtifactRun(selectedRunArtifact.summary) ? (
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => onRetryRunArtifact(selectedRunArtifact.summary.artifactTarget, selectedRunArtifact.summary.toolId)}
                    >
                      {t("agent.retrySameAnalysis")}
                    </button>
                  ) : null}
                  {selectedRunArtifact.summary.failure ? (
                    <>
                      <button className="ghost-button" type="button" onClick={() => onRunArtifactTabChange("log")}>
                        {t("agent.viewRunLog")}
                      </button>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => selectedRunArtifact.summary.purpose === "artifact-analysis"
                          ? onAnalyzeCurrentProject(selectedRunArtifact.summary.toolId)
                          : onRunToolPlan(selectedRunArtifact.summary.toolId)}
                      >
                        {t("agent.retryRun")}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="run-artifact-notices">
                {selectedRunArtifact.summary.failure?.suggestedActions?.length ? (
                  <div className="run-failure-actions">
                    <strong>{t("agent.suggestedActions")}</strong>
                    {selectedRunArtifact.summary.failure.suggestedActions.map((action) => (
                      <span key={action}>{action}</span>
                    ))}
                  </div>
                ) : null}
                {selectedRunArtifact.summary.artifactAdoption?.message ? (
                  <div className="run-failure-actions">
                    <strong>{t("agent.artifactLifecycle")}</strong>
                    <span>{selectedRunArtifact.summary.artifactAdoption.message}</span>
                  </div>
                ) : null}
                {selectedRunArtifact.summary.agentReadiness ? (
                  <div className="run-failure-actions">
                    <strong>{t("agent.preflight")}</strong>
                    {selectedRunArtifact.summary.agentReadiness.checks.map((check) => (
                      <span key={check.id}>{check.label}: {check.status} · {check.message}</span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="artifact-tabs">
                {(["prompt", "plan", "log", "result"] as RunArtifactTab[]).map((tab) => (
                  <button className={cn(runArtifactTab === tab && "active")} key={tab} type="button" onClick={() => onRunArtifactTabChange(tab)}>
                    {artifactTabLabel(tab, t)}
                  </button>
                ))}
              </div>
              <pre className="artifact-preview">{artifactContent(selectedRunArtifact, runArtifactTab) || t("agent.noContent")}</pre>
            </>
          ) : (
            <p className="empty-state">{t("agent.selectRun")}</p>
          )}
        </section>
      </WorkspaceLayout>
    </main>
  );
}

function AddAgentCard({
  isAdding,
  onCancel,
  onSave,
  onStart
}: {
  isAdding: boolean;
  onCancel: () => void;
  onSave: (input: CustomAgentInput) => void;
  onStart: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<AgentProtocol>("cli-stdin");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [planArgs, setPlanArgs] = useState("");
  const [executeArgs, setExecuteArgs] = useState("");
  const [appPath, setAppPath] = useState("");
  const [bridgeInstructions, setBridgeInstructions] = useState("");
  const [artifactAnalysis, setArtifactAnalysis] = useState(true);
  const [implementationPlan, setImplementationPlan] = useState(true);
  const [execute, setExecute] = useState(false);
  const [description, setDescription] = useState("");
  const isCli = protocol === "cli-stdin";
  const canSave = name.trim().length > 0 && (isCli ? command.trim().length > 0 : appPath.trim().length > 0);

  if (!isAdding) {
    return (
      <article className="agent-card add-agent-card">
        <button className="add-agent-button" type="button" onClick={onStart}>
          <Plus size={24} />
          <span>{t("agent.add")}</span>
        </button>
      </article>
    );
  }

  return (
    <article className="agent-card add-agent-card editing">
      <div className="agent-card-header">
        <div>
          <small>{t(isCli ? "agent.customCli" : "agent.customDesktop")}</small>
          <h3>{t("agent.add")}</h3>
        </div>
        <button className="icon-button" title={t("agent.cancel")} type="button" onClick={onCancel}>
          <X size={14} />
        </button>
      </div>
      <label>
        {t("agent.name")}
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Gemini CLI" />
      </label>
      <fieldset className="agent-form-section">
        <legend>{t("agent.protocol")}</legend>
        <div className="segmented-control">
          <button className={cn(isCli && "active")} type="button" onClick={() => setProtocol("cli-stdin")}>
            {t("agent.protocolCli")}
          </button>
          <button className={cn(!isCli && "active")} type="button" onClick={() => setProtocol("desktop-bridge")}>
            {t("agent.protocolDesktop")}
          </button>
        </div>
      </fieldset>
      {isCli ? (
        <>
          <label>
            {t("agent.command")}
            <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="gemini" />
          </label>
          <label>
            {t("agent.args")}
            <input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="--model pro" />
          </label>
          <label>
            {t("agent.planArgs")}
            <input value={planArgs} onChange={(event) => setPlanArgs(event.target.value)} placeholder="--plan --readonly" />
          </label>
          <label>
            {t("agent.executeArgs")}
            <input value={executeArgs} onChange={(event) => setExecuteArgs(event.target.value)} placeholder="--execute" />
          </label>
        </>
      ) : (
        <>
          <label>
            {t("agent.appPath")}
            <input value={appPath} onChange={(event) => setAppPath(event.target.value)} placeholder="/Applications/Custom Agent.app" />
          </label>
          <label>
            {t("agent.bridgeInstructions")}
            <textarea value={bridgeInstructions} onChange={(event) => setBridgeInstructions(event.target.value)} placeholder={t("agent.bridgeInstructionsPlaceholder")} />
          </label>
        </>
      )}
      <fieldset className="agent-form-section">
        <legend>{t("agent.capabilities")}</legend>
        <label className="checkbox-row">
          <input checked={artifactAnalysis} type="checkbox" onChange={(event) => setArtifactAnalysis(event.target.checked)} />
          {t("agent.capabilityArtifactAnalysis")}
        </label>
        <label className="checkbox-row">
          <input checked={implementationPlan} type="checkbox" onChange={(event) => setImplementationPlan(event.target.checked)} />
          {t("agent.capabilityImplementationPlan")}
        </label>
        <label className="checkbox-row">
          <input checked={execute} type="checkbox" onChange={(event) => setExecute(event.target.checked)} />
          {t("agent.capabilityExecute")}
        </label>
      </fieldset>
      <label>
        {t("agent.description")}
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("agent.descriptionPlaceholder")} />
      </label>
      <button
        className="send-button"
        disabled={!canSave}
        type="button"
        onClick={() => {
          const capabilities = buildCapabilities(artifactAnalysis, implementationPlan, execute);
          onSave(isCli
            ? {
              name: name.trim(),
              protocol,
              command: command.trim(),
              args: parseArgs(args),
              planArgs: parseArgs(planArgs),
              executeArgs: parseArgs(executeArgs),
              capabilities,
              description: description.trim()
            }
            : {
              name: name.trim(),
              protocol,
              appPath: appPath.trim(),
              bridgeInstructions: bridgeInstructions.trim(),
              capabilities,
              description: description.trim()
            });
          setName("");
          setProtocol("cli-stdin");
          setCommand("");
          setArgs("");
          setPlanArgs("");
          setExecuteArgs("");
          setAppPath("");
          setBridgeInstructions("");
          setArtifactAnalysis(true);
          setImplementationPlan(true);
          setExecute(false);
          setDescription("");
          onCancel();
        }}
      >
        <Plus size={14} />
        {t("agent.save")}
      </button>
    </article>
  );
}

function getToolStatusLabel(status: ToolUiStatus, t: (key: string) => string) {
  if (status.checking) return t("agent.detecting");
  if (status.lastRunStatus === "completed") return t("agent.recentSuccess");
  if (status.lastRunStatus === "failed") return t("agent.recentFail");
  if (status.available && status.method === "app") return t("agent.methodApp");
  if (status.available && status.method === "cli") return t("agent.methodCli");
  if (status.available && status.method === "mock") return t("agent.methodMock");
  return t("agent.undetected");
}

function agentDescription(agent: AgentDefinition, t: (key: string) => string) {
  const descriptionKey = builtInAgentDescriptionKeys[agent.id];
  return descriptionKey ? t(descriptionKey) : agent.description;
}

function commandLabel(agent: AgentDefinition) {
  return [agent.command, ...agent.args].filter(Boolean).join(" ");
}

function createUnknownStatus(agentId: RuntimeAgentId): ToolUiStatus {
  return {
    toolId: agentId,
    available: false,
    method: "none",
    checking: false
  };
}

function parseArgs(value: string) {
  return Array.from(value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)).map((match) => match[1] ?? match[2] ?? match[3]).filter(Boolean);
}

function buildCapabilities(artifactAnalysis: boolean, implementationPlan: boolean, execute: boolean): AgentCapability[] {
  const capabilities: AgentCapability[] = [];
  if (artifactAnalysis) capabilities.push("artifact-analysis");
  if (implementationPlan) capabilities.push("implementation-plan");
  if (execute) capabilities.push("execute");
  return capabilities;
}

function artifactContent(artifact: ToolRunArtifact, tab: RunArtifactTab) {
  if (tab === "prompt") return artifact.prompt;
  if (tab === "plan") return artifact.plan;
  if (tab === "log") return artifact.log;
  return artifact.result;
}

function canApplyRunArtifact(summary: ToolRunSummary) {
  if (summary.purpose !== "artifact-analysis" || summary.status !== "completed") return false;
  const status = summary.artifactAdoption?.status;
  return status === undefined || status === "pending" || status === "rejected";
}

function canOpenRunBridge(summary: ToolRunSummary) {
  if (summary.purpose !== "artifact-analysis") return false;
  const status = summary.artifactAdoption?.status;
  return summary.status === "pending" || status === "pending" || status === "late";
}

function canRetryArtifactRun(summary: ToolRunSummary) {
  if (summary.purpose !== "artifact-analysis") return false;
  const status = summary.artifactAdoption?.status;
  return status === "rejected" || status === "stale";
}

function artifactAdoptionLabel(status: NonNullable<ToolRunSummary["artifactAdoption"]>["status"], t: (key: string) => string) {
  return t(`agent.artifactAdoption.${status}`);
}

function commandStatusLabel(status: ToolUiStatus, t: (key: string) => string): string {
  if (status.available) return t("agent.commandReady");
  if (status.message || status.health) return t("agent.commandMissing");
  return t("agent.notDetected");
}

function connectionStatusLabel(connection: ProjectAgentConnectionStatus | undefined, t: (key: string) => string): string {
  if (!connection) return t("agent.notDetected");
  return t(`agent.connectionState.${connection.state}`);
}

function runReadinessLabel(status: ToolUiStatus, t: (key: string) => string): string {
  if (!status.health) return t("agent.notDetected");
  if (status.health.severity === "error") return failedReadinessLabel(status.health, t);
  if (status.health.refreshedConnection) return t("agent.contextRefreshed");
  if (status.health.severity === "warning") return warningReadinessLabel(status.health, t);
  if (status.health.severity === "ok") return t("agent.ready");
  return t("agent.notDetected");
}

function isGeneratePlanDisabled(status: ToolUiStatus): boolean {
  if (status.checking) return true;
  if (status.health?.severity === "error") return true;
  return !status.available && Boolean(status.message);
}

function agentReadinessLabel(
  readiness: NonNullable<ToolRunSummary["agentReadiness"]>,
  t: (key: string) => string
): string {
  if (readiness.refreshedConnection) return t("agent.contextRefreshed");
  if (readiness.severity === "error") {
    return failedReadinessLabel(readiness, t);
  }
  if (readiness.severity === "warning") {
    return warningReadinessLabel(readiness, t);
  }
  return t("agent.ready");
}

function failedReadinessLabel(
  readiness: NonNullable<ToolRunSummary["agentReadiness"]>,
  t: (key: string) => string
): string {
  const failed = readiness.checks.find((check) => check.status === "failed");
  if (failed?.id.includes("command")) return t("agent.commandMissing");
  return t("agent.preflightFailed");
}

function warningReadinessLabel(
  readiness: NonNullable<ToolRunSummary["agentReadiness"]>,
  t: (key: string) => string
): string {
  const context = readiness.checks.find((check) => check.id === "project-agent-connection");
  if (context?.status === "warning") {
    return readiness.connection?.state === "disabled"
      ? t("agent.contextDisabled")
      : t("agent.contextStale");
  }
  return t("agent.providerAuthWarning");
}

function artifactTabLabel(tab: RunArtifactTab, t: (key: string) => string) {
  return t(`agent.artifactTab.${tab}`);
}

function formatRunTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

async function copyConnectorPrompt(value: string) {
  await navigator.clipboard.writeText(value);
}

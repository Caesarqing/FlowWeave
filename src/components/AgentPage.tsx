import { CheckCircle2, CircleAlert, Clipboard, FileText, Folder, GitPullRequestArrow, Play, Plus, RefreshCw, Settings2, Terminal, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentDefinition, AgentId, CustomAgentInput, ExecutionMode, RuntimeAgentId, ToolRunArtifact, ToolRunSummary, ToolUiStatus } from "../types";
import type { RunArtifactTab } from "../stores/workspace.store";
import { cn } from "../utils/classnames";
import { buildAgentConnectorPrompt } from "../utils/agent-connector-prompts";
import { useI18n } from "../utils/i18n";

const fallbackAgents: AgentDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code CLI",
    kind: "cli",
    command: "claude",
    args: ["--print", "--permission-mode", "plan"],
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
  executionMode,
  isRunsLoading,
  isDesktopBridgeAvailable,
  lastRunStatus,
  onAnalyzeCurrentProject,
  onDeleteCustomAgent,
  onDetectAgent,
  onExecutionModeChange,
  onGoToGitReview,
  onOpenToolProject,
  onRefreshRuns,
  onRunToolPlan,
  onRunArtifactTabChange,
  onSaveCustomAgent,
  onSelectAgent,
  onSelectRun,
  projectPath,
  runArtifactTab,
  runs,
  selectedAgentId,
  selectedRunArtifact,
  selectedRunId,
  toolStatuses
}: {
  agents: AgentDefinition[];
  executionMode: ExecutionMode;
  isRunsLoading: boolean;
  isDesktopBridgeAvailable: boolean;
  lastRunStatus: string;
  onAnalyzeCurrentProject: () => void;
  onDeleteCustomAgent: (agentId: AgentId) => void;
  onDetectAgent: (agentId: RuntimeAgentId) => void;
  onExecutionModeChange: (mode: ExecutionMode) => void;
  onGoToGitReview: () => void;
  onOpenToolProject: (agentId: RuntimeAgentId) => void;
  onRefreshRuns: () => void;
  onRunToolPlan: (agentId: RuntimeAgentId) => void;
  onRunArtifactTabChange: (tab: RunArtifactTab) => void;
  onSaveCustomAgent: (input: CustomAgentInput) => void;
  onSelectAgent: (agentId: AgentId) => void;
  onSelectRun: (runId: string) => void;
  projectPath: string;
  runArtifactTab: RunArtifactTab;
  runs: ToolRunSummary[];
  selectedAgentId: AgentId;
  selectedRunArtifact?: ToolRunArtifact;
  selectedRunId: string;
  toolStatuses: Record<string, ToolUiStatus>;
}) {
  const { t } = useI18n();
  const visibleAgents = agents.length > 0 ? agents : fallbackAgents;
  const selectedAgent = visibleAgents.find((agent) => agent.id === selectedAgentId) ?? visibleAgents[0];
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
        <button className="send-button" disabled={!projectPath || !selectedAgent} type="button" onClick={onAnalyzeCurrentProject}>
          <Play size={14} />
          {t("agent.analyzeProject")}
        </button>
      </section>

      <section className="execution-mode-panel">
        <div>
          <strong>{t("agent.executionMode")}</strong>
          <span>{t("agent.executionModeHelp")}</span>
        </div>
        <div className="segmented-control">
          <button className={executionMode === "plan" ? "active" : ""} type="button" onClick={() => onExecutionModeChange("plan")}>
            Plan
          </button>
          <button
            className={executionMode === "execute" ? "active danger" : "danger"}
            type="button"
            onClick={() => onExecutionModeChange("execute")}
          >
            Execute
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
          const connectorPrompt = buildAgentConnectorPrompt({ agentId: agent.id, projectPath: projectPath || "/path/to/project" });
          return (
            <article className={cn("agent-card", isSelected && "selected default-agent-card")} key={agent.id}>
              <div className="agent-card-header">
                <div>
                  <small>{agent.builtIn ? "built-in" : agent.id}</small>
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
                <span>{t("agent.cli")}: {status.commandPath ?? t("agent.notDetected")}</span>
                <span>{t("agent.app")}: {status.appPath ?? t("agent.notDetected")}</span>
                <span>{t("agent.version")}: {status.version ?? t("agent.notDetected")}</span>
                <span>{t("agent.lastOutput")}: {status.lastOutputPath ?? t("agent.none")}</span>
              </div>
              <div className="agent-actions">
                <button className="ghost-button" type="button" onClick={() => onDetectAgent(agent.id)}>
                  <RefreshCw size={14} />
                  {status.checking ? t("agent.checking") : t("agent.detect")}
                </button>
                <button className={isSelected ? "default-button" : "ghost-button"} disabled={isSelected} type="button" onClick={() => onSelectAgent(agent.id)}>
                  <Settings2 size={14} />
                  {isSelected ? t("agent.currentDefault") : t("agent.setDefault")}
                </button>
                <button className="send-button" type="button" onClick={() => onRunToolPlan(agent.id)}>
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

      <section className="run-workspace">
        <aside className="run-history">
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
                  </div>
                  <small>{formatRunTime(run.startedAt)}</small>
                </button>
              ))
            ) : (
              <p className="empty-state">{isRunsLoading ? t("agent.readingRuns") : t("agent.noRuns")}</p>
            )}
          </div>
        </aside>
        <section className="run-artifact">
          <div className="panel-header">
            <span>{t("agent.artifacts")}</span>
            <button className="ghost-button" disabled={!selectedRunArtifact} type="button" onClick={onGoToGitReview}>
              <GitPullRequestArrow size={14} />
              {t("agent.goGitReview")}
            </button>
          </div>
          {selectedRunArtifact ? (
            <>
              <div className="run-summary-strip">
                <FileText size={15} />
                <span>{selectedRunArtifact.summary.summary ?? selectedRunArtifact.summary.id}</span>
                <code>{selectedRunArtifact.summary.planPath ?? selectedRunArtifact.summary.logPath ?? "no output path"}</code>
              </div>
              <div className="artifact-tabs">
                {(["prompt", "plan", "log", "result"] as RunArtifactTab[]).map((tab) => (
                  <button className={runArtifactTab === tab ? "active" : ""} key={tab} type="button" onClick={() => onRunArtifactTabChange(tab)}>
                    {tab}
                  </button>
                ))}
              </div>
              <pre className="artifact-preview">{artifactContent(selectedRunArtifact, runArtifactTab) || t("agent.noContent")}</pre>
            </>
          ) : (
            <p className="empty-state">{t("agent.selectRun")}</p>
          )}
        </section>
      </section>
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
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [description, setDescription] = useState("");

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
          <small>{t("agent.customCli")}</small>
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
      <label>
        {t("agent.command")}
        <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="gemini" />
      </label>
      <label>
        {t("agent.args")}
        <input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="--model pro" />
      </label>
      <label>
        {t("agent.description")}
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("agent.descriptionPlaceholder")} />
      </label>
      <button
        className="send-button"
        disabled={!name.trim() || !command.trim()}
        type="button"
        onClick={() => {
          onSave({ name: name.trim(), command: command.trim(), args: parseArgs(args), description: description.trim() });
          setName("");
          setCommand("");
          setArgs("");
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

function artifactContent(artifact: ToolRunArtifact, tab: RunArtifactTab) {
  if (tab === "prompt") return artifact.prompt;
  if (tab === "plan") return artifact.plan;
  if (tab === "log") return artifact.log;
  return artifact.result;
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

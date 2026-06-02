import { CheckCircle2, CircleAlert, FileText, Folder, GitPullRequestArrow, Play, Plus, RefreshCw, Settings2, Terminal, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentDefinition, AgentId, CustomAgentInput, ExecutionMode, RuntimeAgentId, ToolRunArtifact, ToolRunSummary, ToolUiStatus } from "../types";
import type { RunArtifactTab } from "../stores/workspace.store";

const fallbackAgents: AgentDefinition[] = [
  {
    id: "codex-local",
    name: "Codex Local",
    kind: "cli",
    command: "codex",
    args: ["exec", "--sandbox", "read-only"],
    description: "调用本地 Codex CLI 读取 FlowWeave 上下文，并生成可审查的实现计划。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "claude-code",
    name: "Claude Code",
    kind: "cli",
    command: "claude",
    args: ["--print", "--permission-mode", "plan"],
    description: "调用 Claude Code 的 plan 模式输出计划，不直接修改项目文件。",
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
    description: "检测 Cursor CLI 或桌面应用，主要用于打开项目和人工审查。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  }
];

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
  const visibleAgents = agents.length > 0 ? agents : fallbackAgents;
  const selectedAgent = visibleAgents.find((agent) => agent.id === selectedAgentId) ?? visibleAgents[0];
  const agentNames = useMemo(() => new Map<string, string>(visibleAgents.map((agent) => [agent.id, agent.name])), [visibleAgents]);
  const [isAddingAgent, setIsAddingAgent] = useState(false);

  return (
    <main className="agents-page">
      <section className="agents-intro">
        <div>
          <h2>Agent 工作台</h2>
          <p>连接本地 CLI Agent，分析当前项目，并把功能架构模块图写回 Canvas。</p>
        </div>
        <div className="run-status">
          <Terminal size={15} />
          <span>{lastRunStatus}</span>
        </div>
      </section>

      <section className="default-agent-panel">
        <div>
          <small>当前默认 Agent</small>
          <strong>{selectedAgent?.name ?? "未选择"}</strong>
          <span>{selectedAgent ? commandLabel(selectedAgent) : "请先添加或选择一个 Agent"}</span>
        </div>
        <button className="send-button" disabled={!projectPath || !selectedAgent} type="button" onClick={onAnalyzeCurrentProject}>
          <Play size={14} />
          分析当前项目并更新 Canvas
        </button>
      </section>

      <section className="execution-mode-panel">
        <div>
          <strong>执行模式</strong>
          <span>默认使用 plan。execute 需要你显式切换，FlowWeave 只把模式传给外部 Agent。</span>
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
          当前是浏览器预览，无法访问本机编程 Agent。请用 <code>npm run dev:electron</code> 打开桌面版后再检测。
        </section>
      ) : null}

      <section className="agent-grid">
        {visibleAgents.map((agent) => {
          const status = toolStatuses[agent.id] ?? createUnknownStatus(agent.id);
          const available = status.available;
          const isSelected = selectedAgentId === agent.id;
          return (
            <article className={`agent-card ${isSelected ? "selected default-agent-card" : ""}`} key={agent.id}>
              <div className="agent-card-header">
                <div>
                  <small>{agent.builtIn ? "built-in" : agent.id}</small>
                  <h3>{agent.name}</h3>
                </div>
                <div className="agent-card-badges">
                  {isSelected ? <span className="default-badge">Default</span> : null}
                  <span className={`agent-status ${available ? "ok" : status.checking ? "" : "missing"}`}>
                    {available ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
                    {getToolStatusLabel(status)}
                  </span>
                </div>
              </div>
              <p>{agent.description}</p>
              <code>{commandLabel(agent)}</code>
              <div className="agent-detail-list">
                <span>Kind: {agent.kind}</span>
                <span>CLI: {status.commandPath ?? "not detected"}</span>
                <span>App: {status.appPath ?? "not detected"}</span>
                <span>Version: {status.version ?? "not detected"}</span>
                <span>Last output: {status.lastOutputPath ?? "none"}</span>
              </div>
              <div className="agent-actions">
                <button className="ghost-button" type="button" onClick={() => onDetectAgent(agent.id)}>
                  <RefreshCw size={14} />
                  {status.checking ? "检测中..." : "检测"}
                </button>
                <button className={isSelected ? "default-button" : "ghost-button"} disabled={isSelected} type="button" onClick={() => onSelectAgent(agent.id)}>
                  <Settings2 size={14} />
                  {isSelected ? "当前默认" : "设为默认"}
                </button>
                <button className="send-button" type="button" onClick={() => onRunToolPlan(agent.id)}>
                  <Play size={14} />
                  生成计划
                </button>
                <button className="ghost-button" type="button" onClick={() => onOpenToolProject(agent.id)}>
                  <Folder size={14} />
                  打开项目
                </button>
                {!agent.builtIn ? (
                  <button className="ghost-button danger-button" type="button" onClick={() => onDeleteCustomAgent(agent.id)}>
                    <Trash2 size={14} />
                    删除
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
            <span>Run History</span>
            <button className="icon-button" title="刷新运行历史" type="button" onClick={onRefreshRuns}>
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="run-list">
            {runs.length > 0 ? (
              runs.map((run) => (
                <button className={`run-row ${selectedRunId === run.id ? "active" : ""}`} key={run.id} type="button" onClick={() => onSelectRun(run.id)}>
                  <span className={`run-dot ${run.status}`} />
                  <div>
                    <strong>{run.id}</strong>
                    <span>{agentNames.get(run.toolId) ?? run.toolId} · {run.executionMode} · {run.status}</span>
                  </div>
                  <small>{formatRunTime(run.startedAt)}</small>
                </button>
              ))
            ) : (
              <p className="empty-state">{isRunsLoading ? "正在读取运行历史..." : "还没有运行记录。"}</p>
            )}
          </div>
        </aside>
        <section className="run-artifact">
          <div className="panel-header">
            <span>Artifacts</span>
            <button className="ghost-button" disabled={!selectedRunArtifact} type="button" onClick={onGoToGitReview}>
              <GitPullRequestArrow size={14} />
              进入 Git Review
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
              <pre className="artifact-preview">{artifactContent(selectedRunArtifact, runArtifactTab) || "No content."}</pre>
            </>
          ) : (
            <p className="empty-state">选择一次运行查看 prompt、plan、log 和 result。</p>
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
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [description, setDescription] = useState("");

  if (!isAdding) {
    return (
      <article className="agent-card add-agent-card">
        <button className="add-agent-button" type="button" onClick={onStart}>
          <Plus size={24} />
          <span>添加 Agent</span>
        </button>
      </article>
    );
  }

  return (
    <article className="agent-card add-agent-card editing">
      <div className="agent-card-header">
        <div>
          <small>custom cli</small>
          <h3>添加 Agent</h3>
        </div>
        <button className="icon-button" title="取消" type="button" onClick={onCancel}>
          <X size={14} />
        </button>
      </div>
      <label>
        名称
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Gemini CLI" />
      </label>
      <label>
        命令
        <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="gemini" />
      </label>
      <label>
        参数
        <input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="--model pro" />
      </label>
      <label>
        描述
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="通过 stdin 接收 FlowWeave prompt。" />
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
        保存 Agent
      </button>
    </article>
  );
}

export function getToolStatusLabel(status: ToolUiStatus) {
  if (status.checking) return "检测中";
  if (status.lastRunStatus === "completed") return "最近运行成功";
  if (status.lastRunStatus === "failed") return "最近运行失败";
  if (status.available && status.method === "app") return "可打开应用";
  if (status.available && status.method === "cli") return "已检测 CLI";
  if (status.available && status.method === "mock") return "Mock 可用";
  return "未检测";
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

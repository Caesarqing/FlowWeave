import { CheckCircle2, CircleAlert, Folder, Play, RefreshCw, Settings2, Terminal } from "lucide-react";
import type { ExecutionMode, ToolDetectionResult, ToolId, ToolRunResult } from "../types";

export type ToolUiStatus = ToolDetectionResult & {
  checking: boolean;
  lastRunStatus?: ToolRunResult["status"];
  lastOutputPath?: string;
};

export const toolMeta: Record<ToolId, { name: string; command: string; description: string }> = {
  "codex-local": {
    name: "Codex Local",
    command: "codex exec --sandbox read-only",
    description: "调用本地 Codex CLI 读取 FlowWeave 上下文，并生成可审查的实现计划。"
  },
  "claude-code": {
    name: "Claude Code",
    command: "claude --print --permission-mode plan",
    description: "调用 Claude Code 的 plan 模式输出计划，不直接修改项目文件。"
  },
  cursor: {
    name: "Cursor",
    command: "cursor <project> / Cursor.app",
    description: "检测 Cursor CLI 或桌面应用，生成计划文件并打开项目供用户在 Cursor 中审查执行。"
  },
  mock: {
    name: "Mock Agent",
    command: "flowweave mock",
    description: "内置模拟 Agent，用于验证 Agent Bridge 和输出文件链路。"
  }
};

export function AgentPage({
  executionMode,
  isDesktopBridgeAvailable,
  lastRunStatus,
  onDetectTool,
  onExecutionModeChange,
  onOpenToolProject,
  onRunToolPlan,
  onSelectTool,
  selectedToolId,
  toolStatuses
}: {
  executionMode: ExecutionMode;
  isDesktopBridgeAvailable: boolean;
  lastRunStatus: string;
  onDetectTool: (toolId: ToolId) => void;
  onExecutionModeChange: (mode: ExecutionMode) => void;
  onOpenToolProject: (toolId: ToolId) => void;
  onRunToolPlan: (toolId: ToolId) => void;
  onSelectTool: (toolId: ToolId) => void;
  selectedToolId: ToolId;
  toolStatuses: Record<ToolId, ToolUiStatus>;
}) {
  return (
    <main className="agents-page">
      <section className="agents-intro">
        <div>
          <h2>Agent Bridge</h2>
          <p>检测本地 Codex / Claude Code / Cursor，并生成交给这些 Agent 审查执行的计划文件。</p>
        </div>
        <div className="run-status">
          <Terminal size={15} />
          <span>{lastRunStatus}</span>
        </div>
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
        {(Object.keys(toolMeta) as ToolId[]).map((toolId) => {
          const status = toolStatuses[toolId];
          const available = status.available;
          return (
            <article className={`agent-card ${selectedToolId === toolId ? "selected" : ""}`} key={toolId}>
              <div className="agent-card-header">
                <div>
                  <small>{toolId}</small>
                  <h3>{toolMeta[toolId].name}</h3>
                </div>
                <span className={`agent-status ${available ? "ok" : status.checking ? "" : "missing"}`}>
                  {available ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
                  {getToolStatusLabel(status)}
                </span>
              </div>
              <p>{toolMeta[toolId].description}</p>
              <code>{toolMeta[toolId].command}</code>
              <div className="agent-detail-list">
                <span>Method: {status.method}</span>
                <span>CLI: {status.commandPath ?? "not detected"}</span>
                <span>App: {status.appPath ?? "not detected"}</span>
                <span>Version: {status.version ?? "not detected"}</span>
                <span>Default: {selectedToolId === toolId ? "yes" : "no"}</span>
                <span>Last output: {status.lastOutputPath ?? "none"}</span>
              </div>
              <div className="agent-actions">
                <button className="ghost-button" type="button" onClick={() => onDetectTool(toolId)}>
                  <RefreshCw size={14} />
                  {status.checking ? "检测中..." : "检测"}
                </button>
                <button className="ghost-button" type="button" onClick={() => onSelectTool(toolId)}>
                  <Settings2 size={14} />
                  设为默认
                </button>
                <button className="send-button" type="button" onClick={() => onRunToolPlan(toolId)}>
                  <Play size={14} />
                  生成计划
                </button>
                <button className="ghost-button" type="button" onClick={() => onOpenToolProject(toolId)}>
                  <Folder size={14} />
                  打开项目
                </button>
              </div>
            </article>
          );
        })}
      </section>
    </main>
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

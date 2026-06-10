import type { RuntimeAgentId } from "../types";

export type AgentConnectorKind = "codex" | "claude" | "gemini" | "cursor";

export type AgentConnectorPromptInput = {
  agentId: RuntimeAgentId;
  projectPath: string;
};

export type AgentConnectorPrompt = {
  kind: AgentConnectorKind;
  title: string;
  command: string;
  connectorPath: string;
  description: string;
};

export function buildAgentConnectorPrompt(input: AgentConnectorPromptInput): AgentConnectorPrompt {
  const kind = agentConnectorKind(input.agentId);
  const connectorPath = `${input.projectPath}/.flowweave/agent-context.md`;
  const command = input.agentId === "codex-desktop" || input.agentId === "claude-desktop"
    ? "使用 FlowWeave 上下文处理当前待办"
    : buildConnectorCommand(kind, connectorPath);
  return {
    kind,
    title: connectorTitle(kind),
    command,
    connectorPath,
    description: connectorDescription(kind)
  };
}

export function agentConnectorKind(agentId: RuntimeAgentId): AgentConnectorKind {
  if (agentId === "claude-code" || agentId === "claude-desktop") return "claude";
  if (agentId === "codex-local" || agentId === "codex-desktop") return "codex";
  if (agentId === "gemini-cli") return "gemini";
  return "cursor";
}

function buildConnectorCommand(kind: AgentConnectorKind, connectorPath: string) {
  if (kind === "codex") {
    return `Read ${connectorPath} and follow it to connect with FlowWeave. You may modify project files directly.`;
  }
  if (kind === "claude") {
    return `Read ${connectorPath} and follow it to connect with FlowWeave. You may modify project files directly.`;
  }
  if (kind === "gemini") {
    return `Read ${connectorPath} and follow it to connect with FlowWeave. You may modify project files directly.`;
  }
  return `Open this project in Cursor, read ${connectorPath}, and follow it to connect with FlowWeave. You may modify project files directly.`;
}

function connectorTitle(kind: AgentConnectorKind) {
  if (kind === "codex") return "Codex FlowWeave connector";
  if (kind === "claude") return "Claude FlowWeave connector";
  if (kind === "gemini") return "Gemini FlowWeave connector";
  return "Cursor FlowWeave connector";
}

function connectorDescription(kind: AgentConnectorKind) {
  if (kind === "cursor") {
    return "Copy this into Cursor chat after opening the project.";
  }
  return "Copy this into the external Agent chat or CLI prompt.";
}

import type { LocaleId, RuntimeAgentId } from "../types";
import { translate } from "./i18n";

export type AgentConnectorKind = "codex" | "claude" | "gemini" | "cursor" | "custom";

export type AgentConnectorPromptInput = {
  agentId: RuntimeAgentId;
  locale: LocaleId;
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
  const command = input.agentId === "codex-desktop" || input.agentId === "claude-desktop" || kind === "custom"
    ? translate(input.locale, "agent.connectorCommand.pending")
    : buildConnectorCommand(kind, connectorPath, input.locale);
  return {
    kind,
    title: connectorTitle(kind, input.locale),
    command,
    connectorPath,
    description: connectorDescription(kind, input.locale)
  };
}

export function agentConnectorKind(agentId: RuntimeAgentId): AgentConnectorKind {
  if (agentId === "claude-code" || agentId === "claude-desktop") return "claude";
  if (agentId === "codex-local" || agentId === "codex-desktop") return "codex";
  if (agentId === "gemini-cli") return "gemini";
  if (agentId.startsWith("custom:")) return "custom";
  return "cursor";
}

function buildConnectorCommand(kind: AgentConnectorKind, connectorPath: string, locale: LocaleId) {
  if (kind === "codex") {
    return translate(locale, "agent.connectorCommand.readWrite", { connectorPath });
  }
  if (kind === "claude") {
    return translate(locale, "agent.connectorCommand.readWrite", { connectorPath });
  }
  if (kind === "gemini") {
    return translate(locale, "agent.connectorCommand.readWrite", { connectorPath });
  }
  if (kind === "custom") {
    return translate(locale, "agent.connectorCommand.custom", { connectorPath });
  }
  return translate(locale, "agent.connectorCommand.cursor", { connectorPath });
}

function connectorTitle(kind: AgentConnectorKind, locale: LocaleId) {
  return translate(locale, `agent.connectorTitle.${kind}`);
}

function connectorDescription(kind: AgentConnectorKind, locale: LocaleId) {
  if (kind === "cursor") {
    return translate(locale, "agent.connectorDescription.cursor");
  }
  if (kind === "custom") return translate(locale, "agent.connectorDescription.custom");
  return translate(locale, "agent.connectorDescription.default");
}

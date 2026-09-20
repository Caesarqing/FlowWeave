import { access } from "node:fs/promises";
import type { AgentHealthCheck, AgentHealthCheckResult, ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "./agent-adapter";
import { nowIso } from "./time";
import { resolveToolCommand } from "./agent-command";
import { runCliAgentInbox } from "./agent-inbox-runner";

export class ClaudeCodeAdapter implements ToolAdapter {
  id = "claude-code" as const;
  name = "Claude Code";
  kind = "cli" as const;

  async detect() {
    const result = await resolveToolCommand(this.id);
    return {
      toolId: this.id,
      available: result.installed,
      method: result.installed ? ("cli" as const) : ("none" as const),
      commandPath: result.commandPath,
      version: result.version,
      message: result.installed ? "Claude Code CLI detected." : "Claude Code CLI was not found in PATH or known locations."
    };
  }

  async healthCheck(): Promise<AgentHealthCheckResult> {
    const resolvedCommand = await resolveToolCommand(this.id);
    const checks: AgentHealthCheck[] = [
      {
        id: "claude-command",
        label: "Claude CLI command",
        status: resolvedCommand.installed && resolvedCommand.commandPath ? "passed" : "failed",
        message: resolvedCommand.commandPath
          ? `Claude Code CLI resolved at ${resolvedCommand.commandPath}.`
          : "Claude Code CLI was not found in PATH or known locations."
      },
      {
        id: "claude-version",
        label: "Claude CLI version",
        status: resolvedCommand.version ? "passed" : resolvedCommand.installed ? "warning" : "failed",
        message: resolvedCommand.version
          ? `Claude Code version ${resolvedCommand.version}.`
          : "Claude Code version could not be read with --version."
      },
      buildClaudeAuthCheck(process.env),
      buildClaudeProviderCheck(process.env),
      buildClaudeProxyCheck(process.env)
    ];
    return {
      agentId: this.id,
      severity: healthSeverity(checks),
      checks,
      suggestedActions: buildClaudeSuggestedActions(checks),
      environmentHints: buildClaudeEnvironmentHints(process.env),
      checkedAt: nowIso()
    };
  }

  async runPlan(request: ToolRunRequest, onEvent?: (event: ToolRunEvent) => void): Promise<ToolRunResult> {
    const resolvedCommand = await resolveToolCommand(this.id);
    if (!resolvedCommand.installed || !resolvedCommand.commandPath) {
      const timestamp = nowIso();
      return {
        id: request.id,
        toolId: this.id,
        status: "failed",
        projectPath: request.projectPath,
        startedAt: timestamp,
        completedAt: timestamp,
        executionMode: request.executionMode,
        purpose: request.purpose,
        events: [{ type: "error", message: "Claude Code is not installed or not available.", timestamp }]
      };
    }
    const commandPath = resolvedCommand.commandPath;

    if (request.guidancePath) {
      await access(request.guidancePath);
    }

    const args = buildClaudeArgs(request.executionMode, request.model, request.purpose);
    return runCliAgentInbox({
      toolId: this.id,
      commandPath,
      args,
      request
    }, onEvent);
  }
}

export function buildClaudeArgs(
  executionMode: "plan" | "execute",
  model?: string,
  purpose?: import("../../types").ToolRunPurpose
) {
  const args = [
    "--print",
    "--permission-mode",
    executionMode === "plan" ? "plan" : "acceptEdits",
    "--output-format",
    purpose === "artifact-analysis" ? "json" : "text",
    "--no-session-persistence"
  ];
  if (model) {
    args.push("--model", model);
  }
  return args;
}

export function buildClaudePrompt(prompt: string, executionMode: "plan" | "execute", purpose?: import("../../types").ToolRunPurpose) {
  if (executionMode === "execute" || purpose === "artifact-analysis") return prompt;
  return `${prompt}

Dry run only: inspect the request and return the implementation plan, affected files, risks, and tests. Do not edit files.`;
}

export const buildClaudeDryRunArgs = (model?: string) => buildClaudeArgs("plan", model, "implementation-plan");
export const buildClaudeDryRunPrompt = (prompt: string) => buildClaudePrompt(prompt, "plan");

function buildClaudeAuthCheck(environment: NodeJS.ProcessEnv): AgentHealthCheck {
  const authKeys = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX"
  ];
  const configuredKeys = authKeys.filter((key) => Boolean(environment[key]));
  return {
    id: "claude-auth",
    label: "Claude authentication",
    status: configuredKeys.length > 0 ? "passed" : "warning",
    message: configuredKeys.length > 0
      ? `Authentication signal present: ${configuredKeys.join(", ")}.`
      : "No Claude authentication environment variable was visible to FlowWeave. OAuth/keychain auth may still work in Claude Code, but Electron-launched runs can differ from your shell."
  };
}

function buildClaudeProviderCheck(environment: NodeJS.ProcessEnv): AgentHealthCheck {
  const providerKeys = [
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_PROJECT_ID"
  ];
  const configuredKeys = providerKeys.filter((key) => Boolean(environment[key]));
  return {
    id: "claude-provider",
    label: "Claude provider routing",
    status: configuredKeys.length > 0 ? "warning" : "passed",
    message: configuredKeys.length > 0
      ? `Custom provider routing is configured: ${configuredKeys.join(", ")}. Provider gateway errors should be checked there first.`
      : "No custom Claude provider routing environment variable was visible."
  };
}

function buildClaudeProxyCheck(environment: NodeJS.ProcessEnv): AgentHealthCheck {
  const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  const configuredKeys = proxyKeys.filter((key) => Boolean(environment[key]));
  return {
    id: "claude-proxy",
    label: "Network proxy",
    status: configuredKeys.length > 0 ? "warning" : "passed",
    message: configuredKeys.length > 0
      ? `Proxy configuration is visible: ${configuredKeys.join(", ")}.`
      : "No proxy environment variable was visible to FlowWeave."
  };
}

function healthSeverity(checks: AgentHealthCheck[]): AgentHealthCheckResult["severity"] {
  if (checks.some((check) => check.status === "failed")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

function buildClaudeSuggestedActions(checks: AgentHealthCheck[]): string[] {
  const actions: string[] = [];
  if (checks.some((check) => check.id === "claude-command" && check.status === "failed")) {
    actions.push("Install Claude Code CLI or add the claude executable to PATH before running FlowWeave plans.");
  }
  if (checks.some((check) => check.id === "claude-auth" && check.status === "warning")) {
    actions.push("Confirm the same Claude authentication available in your terminal is visible to the Electron app.");
  }
  if (checks.some((check) => check.id === "claude-provider" && check.status === "warning")) {
    actions.push("If runs fail with AppIdNoAuthError, ConnectionRefused, or HTTP 5xx, verify the configured Claude provider gateway credentials and base URL.");
  }
  if (checks.some((check) => check.id === "claude-proxy" && check.status === "warning")) {
    actions.push("If runs fail with connection errors, verify proxy reachability from the FlowWeave process.");
  }
  return actions.length > 0 ? actions : ["Claude Code CLI is locally detectable. Retry the run and inspect the run log if provider errors continue."];
}

function buildClaudeEnvironmentHints(environment: NodeJS.ProcessEnv): string[] {
  return [
    environment.ANTHROPIC_BASE_URL ? "ANTHROPIC_BASE_URL is set." : "ANTHROPIC_BASE_URL is not set.",
    environment.HTTP_PROXY || environment.HTTPS_PROXY ? "HTTP proxy settings are visible." : "HTTP proxy settings are not visible.",
    environment.CLAUDE_CODE_USE_BEDROCK ? "Bedrock mode is enabled." : "Bedrock mode is not enabled.",
    environment.CLAUDE_CODE_USE_VERTEX ? "Vertex mode is enabled." : "Vertex mode is not enabled."
  ];
}

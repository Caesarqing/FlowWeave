import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentPage } from "../../src/components/AgentPage";
import type {
  AgentDefinition,
  AgentPluginStatus,
  AgentReadinessResult,
  ArchitectureReviewStatus,
  ProjectAgentConnectionStatus,
  ToolUiStatus
} from "../../src/types";

describe("AgentPage readiness", () => {
  it("labels disabled project context without blocking a detected CLI run", () => {
    const html = renderAgentPage(cliStatus({
      severity: "warning",
      checks: [{
        id: "project-agent-connection",
        label: "Project Agent context",
        status: "warning",
        message: "External Agent connection is disabled."
      }],
      connection: projectConnection("disabled")
    }));

    expect(html).toContain("Run readiness: context disabled");
    expect(html).not.toContain("provider/auth warning");
    expect(generatePlanButtonOpeningTag(html)).not.toContain("disabled");
  });

  it("labels stale project context separately from provider warnings", () => {
    const html = renderAgentPage(cliStatus({
      severity: "warning",
      checks: [{
        id: "project-agent-connection",
        label: "Project Agent context",
        status: "warning",
        message: "Project Agent context needs refresh."
      }],
      connection: projectConnection("needs-refresh")
    }));

    expect(html).toContain("Run readiness: context stale");
    expect(html).not.toContain("provider/auth warning");
  });

  it("keeps provider warnings visible when readiness has no project context warning", () => {
    const html = renderAgentPage(cliStatus({
      severity: "warning",
      checks: [{
        id: "provider-auth",
        label: "Provider/auth",
        status: "warning",
        message: "OPENAI_API_KEY is not set."
      }]
    }));

    expect(html).toContain("Run readiness: provider/auth warning");
  });

  it("disables Generate plan for command missing and preflight errors", () => {
    const missingCommandHtml = renderAgentPage({
      toolId: "codex-local",
      available: false,
      method: "none",
      checking: false,
      message: "Codex CLI was not found."
    });
    const preflightErrorHtml = renderAgentPage(cliStatus({
      severity: "error",
      checks: [{
        id: "project-agent-connection",
        label: "Project Agent context",
        status: "failed",
        message: "Project Agent context preflight failed."
      }]
    }));

    expect(generatePlanButtonOpeningTag(missingCommandHtml)).toContain("disabled");
    expect(generatePlanButtonOpeningTag(preflightErrorHtml)).toContain("disabled");
  });

  it("renders project plugin host instructions as an action instead of raw paths", () => {
    const html = renderAgentPage(cliStatus({ severity: "ok", checks: [] }), [{
      pluginId: "flowweave",
      hostId: "codex",
      displayName: "Codex",
      status: "installed",
      installedVersion: "0.2.0",
      bundledVersion: "0.2.0",
      installTarget: "/tmp/project/.flowweave/agent-plugins/flowweave",
      hostInstructionPath: "/tmp/project/.flowweave/agent-plugins/flowweave/hosts/codex.md",
      message: "Project FlowWeave plugin copy is installed for Codex."
    }]);

    expect(html).toContain("View instructions");
    expect(html).not.toContain("hosts/codex.md");
  });
});

function renderAgentPage(status: ToolUiStatus, pluginStatuses: AgentPluginStatus[] = []): string {
  return renderToStaticMarkup(createElement(AgentPage, {
    agents: [agent()],
    architectureReview: architectureReview(),
    executionMode: "plan",
    isDesktopBridgeAvailable: true,
    isRunsLoading: false,
    lastRunStatus: "idle",
    onAnalyzeCurrentProject: noop,
    onApplyRunArtifact: noop,
    onDeleteCustomAgent: noop,
    onDetectAgent: noop,
    onExecutionModeChange: noop,
    onGoToGitReview: noop,
    onHealthCheckAgent: noop,
    onInstallAgentPlugins: noop,
    onOpenAgentPluginFolder: noop,
    onOpenAgentPluginInstructions: noop,
    onOpenAgentInbox: noop,
    onOpenToolProject: noop,
    onRefreshAgentPlugins: noop,
    onRefreshRuns: noop,
    onRetryRunArtifact: noop,
    onRunArtifactTabChange: noop,
    onRunToolPlan: noop,
    onSaveCustomAgent: noop,
    onSelectAgent: noop,
    onSelectRun: noop,
    pluginStatuses,
    projectConnection: status.health?.connection,
    projectPath: "/tmp/project",
    runArtifactTab: "prompt",
    runs: [],
    selectedAgentId: "codex-local",
    selectedRunArtifact: undefined,
    selectedRunId: "",
    toolStatuses: { "codex-local": status }
  }));
}

function agent(): AgentDefinition {
  return {
    id: "codex-local",
    name: "Codex CLI",
    kind: "cli",
    command: "codex",
    args: ["exec", "--sandbox", "read-only"],
    protocol: "agent-inbox",
    capabilities: ["artifact-analysis", "implementation-plan"],
    description: "Calls the local Codex CLI with FlowWeave context.",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  };
}

function architectureReview(): ArchitectureReviewStatus {
  return {
    state: "local"
  };
}

function cliStatus(health: Partial<AgentReadinessResult>): ToolUiStatus {
  return {
    toolId: "codex-local",
    available: true,
    method: "cli",
    checking: false,
    commandPath: "/usr/local/bin/codex",
    version: "codex-test 1.0",
    health: {
      agentId: "codex-local",
      severity: "ok",
      checks: [],
      suggestedActions: [],
      environmentHints: [],
      checkedAt: "2026-06-29T00:00:00.000Z",
      ...health
    }
  };
}

function projectConnection(state: ProjectAgentConnectionStatus["state"]): ProjectAgentConnectionStatus {
  return {
    state,
    enabled: state !== "disabled",
    needsConfirmation: false,
    projectPath: "/tmp/project",
    contextPath: "/tmp/project/.flowweave/agent-context.md",
    configPath: "/tmp/project/.flowweave/agent-connection.json",
    generatedFiles: [],
    platforms: ["codex"],
    updatedAt: "2026-06-29T00:00:00.000Z",
    message: state
  };
}

function generatePlanButtonOpeningTag(html: string): string {
  const match = html.match(/<button(?=[^>]*class="send-button")[^>]*>(?:(?!<\/button>)[\s\S])*?Generate plan(?:(?!<\/button>)[\s\S])*?<\/button>/);
  if (!match) throw new Error("Generate plan button was not rendered.");
  const openingTag = match[0].match(/^<button[^>]*>/);
  if (!openingTag) throw new Error("Generate plan button opening tag was not rendered.");
  return openingTag[0];
}

function noop(_value?: unknown): void {
  return undefined;
}

import type {
  ArtifactRunTarget,
  AgentHealthCheck,
  AgentHealthCheckResult,
  AgentPluginHostId,
  AgentPluginSuggestedAction,
  AgentReadinessResult,
  ProjectAgentConnectionStatus,
  RuntimeAgentId,
  ToolKind,
  ToolRunPurpose,
  ToolAdapter
} from "../../types";
import {
  getProjectAgentConnectionForPlatform,
  refreshProjectAgentConnectionForPlatform
} from "./project-agent-connection.service";
import { getBuiltInAgentPluginStatuses } from "./agent-plugin.service";

export type AgentReadinessOptions = {
  agentId: RuntimeAgentId;
  adapterKind: ToolKind;
  projectId?: string;
  projectPath?: string;
  refreshConnection: boolean;
  runModelProbe: boolean;
  purpose?: ToolRunPurpose;
  artifactTarget?: ArtifactRunTarget;
};

export async function checkAgentReadiness(
  adapter: ToolAdapter,
  options: AgentReadinessOptions
): Promise<AgentReadinessResult> {
  if (adapter.kind !== options.adapterKind) {
    throw new Error(`Agent readiness adapter kind mismatch for agentId=${options.agentId}: adapter=${adapter.kind}, readiness=${options.adapterKind}.`);
  }
  const base = await adapterHealth(adapter, options.agentId, options.runModelProbe);
  const connectionResult = options.projectId && options.projectPath
    ? await projectReadinessChecks(options)
    : { checks: [], suggestedActions: [], connection: undefined, refreshedConnection: false };
  const checks = [...base.checks, ...connectionResult.checks];
  return {
    agentId: options.agentId,
    projectId: options.projectId,
    severity: severityForChecks(checks),
    checks,
    suggestedActions: [...base.suggestedActions, ...connectionResult.suggestedActions],
    environmentHints: base.environmentHints,
    connection: connectionResult.connection,
    refreshedConnection: connectionResult.refreshedConnection,
    checkedAt: new Date().toISOString()
  };
}

async function projectReadinessChecks(options: AgentReadinessOptions): Promise<{
  checks: AgentHealthCheck[];
  suggestedActions: string[];
  connection?: ProjectAgentConnectionStatus;
  refreshedConnection: boolean;
}> {
  const { agentId, projectId, projectPath } = options;
  if (!projectId || !projectPath) throw new Error("Project readiness requires projectId and projectPath.");
  const platform = hostIdForAgent(agentId);
  const connection = options.adapterKind === "desktop" && platform
    ? await projectConnectionChecks({
        agentId,
        projectId,
        projectPath,
        platform,
        refreshConnection: options.refreshConnection,
        purpose: options.purpose,
        artifactTarget: options.artifactTarget
      })
    : { checks: [], suggestedActions: [], connection: undefined, refreshedConnection: false };
  const plugin = await projectPluginChecks(projectId, projectPath, agentId, options.adapterKind);
  return {
    checks: [...plugin.checks, ...connection.checks],
    suggestedActions: [...connection.suggestedActions, ...plugin.suggestedActions],
    connection: connection.connection,
    refreshedConnection: connection.refreshedConnection
  };
}

async function adapterHealth(adapter: ToolAdapter, agentId: RuntimeAgentId, runModelProbe: boolean): Promise<AgentHealthCheckResult> {
  if (adapter.healthCheck) {
    return adapter.healthCheck({ runModelProbe });
  }
  const detection = await adapter.detect();
  const unavailableDesktopBridge = adapter.kind === "desktop" && !detection.available;
  const check: AgentHealthCheck = {
    id: "agent-command",
    label: "Agent command",
    status: detection.available ? "passed" : unavailableDesktopBridge ? "warning" : "failed",
    message: detection.message ?? (detection.available ? `${adapter.name} is available.` : `${adapter.name} is not available.`)
  };
  return {
    agentId,
    severity: severityForChecks([check]),
    checks: [check],
    suggestedActions: detection.available
      ? [`${adapter.name} is detectable. Review the run log if executions fail.`]
      : unavailableDesktopBridge
        ? [`Install or open ${adapter.name} to process Agent Inbox requests, or process the generated request file manually.`]
        : [`Install or configure ${adapter.name}, then run detection again.`],
    environmentHints: [],
    checkedAt: new Date().toISOString()
  };
}

async function projectPluginChecks(
  projectId: string,
  projectPath: string,
  agentId: RuntimeAgentId,
  adapterKind: ToolKind
): Promise<{
  checks: AgentHealthCheck[];
  suggestedActions: string[];
}> {
  const hostId = hostIdForAgent(agentId);
  if (!hostId) return { checks: [], suggestedActions: [] };
  let statuses: Awaited<ReturnType<typeof getBuiltInAgentPluginStatuses>>;
  try {
    statuses = await getBuiltInAgentPluginStatuses(projectPath);
  } catch (error) {
    const blocking = adapterKind === "desktop";
    const missingFiles: string[] = [];
    const message = `agentId=${agentId} projectId=${projectId} missingFiles=[] FlowWeave plugin check failed for hostId=${hostId}: ${formatError(error)}`;
    const suggestedActions = [`Repair FlowWeave plugin status for hostId=${hostId}, agentId=${agentId}, projectId=${projectId}.`];
    return {
      checks: [{
        id: `project-agent-plugin-${hostId}`,
        label: "Project Agent plugin",
        status: blocking ? "failed" : "warning",
        blocking,
        message,
        missingFiles,
        suggestedActions
      }],
      suggestedActions
    };
  }
  const status = statuses.find((pluginStatus) => pluginStatus.hostId === hostId);
  if (!status) {
    const blocking = adapterKind === "desktop";
    const missingFiles: string[] = [];
    const message = `agentId=${agentId} projectId=${projectId} missingFiles=[] FlowWeave project plugin status could not be determined for hostId=${hostId}.`;
    const suggestedActions = [`Refresh FlowWeave plugin status for hostId=${hostId}, agentId=${agentId}, projectId=${projectId}.`];
    return {
      checks: [{
        id: `project-agent-plugin-${hostId}`,
        label: "Project Agent plugin",
        status: blocking ? "failed" : "warning",
        blocking,
        message,
        missingFiles,
        suggestedActions
      }],
      suggestedActions
    };
  }
  const ready = status.status === "installed";
  const blocking = adapterKind === "desktop";
  const checkMessage = [
    `agentId=${agentId}`,
    `projectId=${projectId}`,
    status.message,
    status.missingFiles.length > 0 ? `Missing files: ${status.missingFiles.join(", ")}.` : ""
  ].filter(Boolean).join(" ");
  const suggestedActions = status.suggestedActions.map((action) =>
    `${pluginActionMessage(action)} for hostId=${hostId}, agentId=${agentId}, projectId=${projectId}.`
  );
  return {
    checks: [{
      id: `project-agent-plugin-${hostId}`,
      label: "Project Agent plugin",
      status: ready ? "passed" : blocking ? "failed" : "warning",
      message: checkMessage,
      blocking: !ready && blocking,
      missingFiles: status.missingFiles,
      suggestedActions
    }],
    suggestedActions
  };
}

function pluginActionMessage(action: AgentPluginSuggestedAction): string {
  if (action === "install") return "Install the FlowWeave plugin";
  if (action === "refresh") return "Refresh the FlowWeave plugin";
  if (action === "connect") return "Connect project context for the FlowWeave plugin";
  return "Repair the FlowWeave plugin";
}

function hostIdForAgent(agentId: RuntimeAgentId): AgentPluginHostId | undefined {
  if (agentId === "codex-local" || agentId === "codex-desktop") return "codex";
  if (agentId === "claude-code" || agentId === "claude-desktop") return "claude";
  if (agentId === "gemini-cli") return "gemini";
  if (agentId === "cursor") return "cursor";
  return undefined;
}

type ProjectConnectionCheckInput = {
  agentId: RuntimeAgentId;
  projectId: string;
  projectPath: string;
  platform: AgentPluginHostId;
  refreshConnection: boolean;
  purpose: AgentReadinessOptions["purpose"];
  artifactTarget: AgentReadinessOptions["artifactTarget"];
};

async function projectConnectionChecks(input: ProjectConnectionCheckInput): Promise<{
  checks: AgentHealthCheck[];
  suggestedActions: string[];
  connection?: ProjectAgentConnectionStatus;
  refreshedConnection: boolean;
}> {
  const { agentId, projectId, projectPath, platform, refreshConnection, purpose, artifactTarget } = input;
  try {
    const status = await getProjectAgentConnectionForPlatform(projectPath, platform);
    if (status.state === "disabled") {
      const missingFiles = status.missingFiles ?? [];
      const suggestedActions = [`Connect project context for agentId=${agentId}, projectId=${projectId}.`];
      return {
        checks: [{
          id: "project-agent-connection",
          label: "Project Agent context",
          status: "failed",
          blocking: true,
          message: connectionMessage(agentId, projectId, "External Agent connection is disabled.", missingFiles, purpose, artifactTarget),
          missingFiles,
          suggestedActions,
          purpose,
          artifactTarget
        }],
        suggestedActions,
        connection: status,
        refreshedConnection: false
      };
    }
    if (status.state === "ready") {
      return {
        checks: [{
          id: "project-agent-connection",
          label: "Project Agent context",
          status: "passed",
          message: connectionMessage(agentId, projectId, status.message, [], purpose, artifactTarget),
          missingFiles: [],
          suggestedActions: [],
          purpose,
          artifactTarget
        }],
        suggestedActions: [],
        connection: status,
        refreshedConnection: false
      };
    }
    if (status.state === "needs-refresh" && purpose === "artifact-analysis") {
      const missingFiles = status.missingFiles ?? [status.contextPath];
      const suggestedActions = [
        `Refresh project context for agentId=${agentId}, projectId=${projectId} before a general desktop run.`
      ];
      return {
        checks: [{
          id: "project-agent-connection",
          label: "Project Agent context",
          status: "warning",
          blocking: false,
          message: connectionMessage(
            agentId,
            projectId,
            `Artifact analysis will continue with request-scoped context. ${status.message}`,
            missingFiles,
            purpose,
            artifactTarget
          ),
          missingFiles,
          suggestedActions,
          purpose,
          artifactTarget
        }],
        suggestedActions,
        connection: status,
        refreshedConnection: false
      };
    }
    if (status.state === "needs-refresh" && refreshConnection && purpose !== "artifact-analysis") {
      try {
        const refreshed = await refreshProjectAgentConnectionForPlatform(projectPath, platform);
        const message = connectionMessage(
          agentId,
          projectId,
          `Project Agent context was refreshed before run. ${refreshed.message}`,
          [],
          purpose,
          artifactTarget
        );
        return {
          checks: [{
            id: "project-agent-connection",
            label: "Project Agent context",
            status: "passed",
            message,
            missingFiles: [],
            suggestedActions: [],
            purpose,
            artifactTarget
          }],
          suggestedActions: [],
          connection: refreshed,
          refreshedConnection: true
        };
      } catch (error) {
        return failedConnection(input, error, status);
      }
    }
    const missingFiles = status.missingFiles ?? [status.contextPath];
    const suggestedActions = [
      `Refresh project context for agentId=${agentId}, projectId=${projectId}${artifactTarget ? `, artifactTarget=${artifactTarget}` : ""}.`
    ];
    return {
      checks: [{
        id: "project-agent-connection",
        label: "Project Agent context",
        status: "failed",
        blocking: true,
        message: connectionMessage(agentId, projectId, status.message, missingFiles, purpose, artifactTarget),
        missingFiles,
        suggestedActions,
        purpose,
        artifactTarget
      }],
      suggestedActions,
      connection: status,
      refreshedConnection: false
    };
  } catch (error) {
    return failedConnection(input, error, undefined);
  }
}

function failedConnection(
  input: ProjectConnectionCheckInput,
  error: unknown,
  connection: ProjectAgentConnectionStatus | undefined
): {
  checks: AgentHealthCheck[];
  suggestedActions: string[];
  connection?: ProjectAgentConnectionStatus;
  refreshedConnection: boolean;
} {
  const { agentId, projectId, projectPath, purpose, artifactTarget } = input;
  const errorMessage = formatError(error);
  const pathFromError = /(?:in|at) "([^"]+)"/.exec(errorMessage)?.[1];
  const missingFiles = connection?.missingFiles ?? [pathFromError ?? `${projectPath}/.flowweave/agent-connection.json`];
  const suggestedActions = [
    `Repair or refresh project context for agentId=${agentId}, projectId=${projectId}${artifactTarget ? `, artifactTarget=${artifactTarget}` : ""}.`
  ];
  return {
    checks: [{
      id: "project-agent-connection",
      label: "Project Agent context",
      status: "failed",
      blocking: true,
      message: connectionMessage(agentId, projectId, `Project Agent context preflight failed: ${errorMessage}`, missingFiles, purpose, artifactTarget),
      missingFiles,
      suggestedActions,
      purpose,
      artifactTarget
    }],
    suggestedActions,
    connection,
    refreshedConnection: false
  };
}

function connectionMessage(
  agentId: RuntimeAgentId,
  projectId: string,
  message: string,
  missingFiles: string[],
  purpose: AgentReadinessOptions["purpose"],
  artifactTarget: AgentReadinessOptions["artifactTarget"]
): string {
  return `agentId=${agentId} projectId=${projectId} purpose=${purpose ?? "health-check"} artifactTarget=${artifactTarget ?? "none"} missingFiles=${JSON.stringify(missingFiles)} ${message}`;
}

function severityForChecks(checks: AgentHealthCheck[]): AgentReadinessResult["severity"] {
  if (checks.some((check) => check.status === "failed")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

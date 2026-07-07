import type {
  AgentHealthCheck,
  AgentHealthCheckResult,
  AgentReadinessResult,
  ProjectAgentConnectionStatus,
  RuntimeAgentId,
  ToolAdapter
} from "../../types";
import {
  getProjectAgentConnection,
  refreshProjectAgentConnection
} from "./project-agent-connection.service";
import { getBuiltInAgentPluginStatuses } from "./agent-plugin.service";

export type AgentReadinessOptions = {
  agentId: RuntimeAgentId;
  projectId?: string;
  projectPath?: string;
  refreshConnection: boolean;
  runModelProbe: boolean;
};

export async function checkAgentReadiness(
  adapter: ToolAdapter,
  options: AgentReadinessOptions
): Promise<AgentReadinessResult> {
  const base = await adapterHealth(adapter, options.agentId, options.runModelProbe);
  const connectionResult = options.projectId && options.projectPath
    ? await projectReadinessChecks(options.projectId, options.projectPath, options.refreshConnection)
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

async function projectReadinessChecks(
  projectId: string,
  projectPath: string,
  refreshConnection: boolean
): Promise<{
  checks: AgentHealthCheck[];
  suggestedActions: string[];
  connection?: ProjectAgentConnectionStatus;
  refreshedConnection: boolean;
}> {
  const [connection, plugin] = await Promise.all([
    projectConnectionChecks(projectId, projectPath, refreshConnection),
    projectPluginChecks(projectPath)
  ]);
  return {
    checks: [...connection.checks, ...plugin.checks],
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
  const check: AgentHealthCheck = {
    id: "agent-command",
    label: "Agent command",
    status: detection.available ? "passed" : "failed",
    message: detection.message ?? (detection.available ? `${adapter.name} is available.` : `${adapter.name} is not available.`)
  };
  return {
    agentId,
    severity: severityForChecks([check]),
    checks: [check],
    suggestedActions: detection.available
      ? [`${adapter.name} is detectable. Review the run log if executions fail.`]
      : [`Install or configure ${adapter.name}, then run detection again.`],
    environmentHints: [],
    checkedAt: new Date().toISOString()
  };
}

async function projectPluginChecks(projectPath: string): Promise<{
  checks: AgentHealthCheck[];
  suggestedActions: string[];
}> {
  const statuses = await getBuiltInAgentPluginStatuses(projectPath);
  const first = statuses[0];
  if (!first) {
    return {
      checks: [{
        id: "project-agent-plugin",
        label: "Project Agent plugin",
        status: "failed",
        message: "FlowWeave project plugin status could not be determined."
      }],
      suggestedActions: ["Refresh the FlowWeave project plugin status."]
    };
  }
  const failed = statuses.some((status) => status.status === "error" || status.status === "unavailable");
  const warning = statuses.some((status) => status.status === "missing" || status.status === "outdated");
  return {
    checks: [{
      id: "project-agent-plugin",
      label: "Project Agent plugin",
      status: failed ? "failed" : warning ? "warning" : "passed",
      message: first.message
    }],
    suggestedActions: failed
      ? ["Repair the bundled FlowWeave plugin resources, then retry health check."]
      : warning
        ? ["Install or refresh the project FlowWeave plugin copy before desktop/manual bridge review."]
        : []
  };
}

async function projectConnectionChecks(
  projectId: string,
  projectPath: string,
  refreshConnection: boolean
): Promise<{
  checks: AgentHealthCheck[];
  suggestedActions: string[];
  connection?: ProjectAgentConnectionStatus;
  refreshedConnection: boolean;
}> {
  try {
    const status = await getProjectAgentConnection(projectPath);
    if (status.state === "disabled") {
      return {
        checks: [{
          id: "project-agent-connection",
          label: "Project Agent context",
          status: "warning",
          message: "External Agent connection is disabled. CLI runs still receive FlowWeave context through stdin."
        }],
        suggestedActions: ["Enable the project Agent connection only when external manual Agent sessions need FlowWeave context files."],
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
          message: status.message
        }],
        suggestedActions: [],
        connection: status,
        refreshedConnection: false
      };
    }
    if (status.state === "needs-refresh" && refreshConnection) {
      try {
        const refreshed = await refreshProjectAgentConnection(projectPath);
        return {
          checks: [{
            id: "project-agent-connection",
            label: "Project Agent context",
            status: "passed",
            message: `Project Agent context was refreshed before run. ${refreshed.message}`
          }],
          suggestedActions: [],
          connection: refreshed,
          refreshedConnection: true
        };
      } catch (error) {
        return failedConnection(projectId, error, status);
      }
    }
    return {
      checks: [{
        id: "project-agent-connection",
        label: "Project Agent context",
        status: status.state === "needs-refresh" ? "warning" : "failed",
        message: status.message
      }],
      suggestedActions: status.state === "needs-refresh"
        ? ["Refresh the FlowWeave Agent connection before starting external manual Agent sessions."]
        : ["Repair or disable the FlowWeave Agent connection before running this Agent."],
      connection: status,
      refreshedConnection: false
    };
  } catch (error) {
    return failedConnection(projectId, error, undefined);
  }
}

function failedConnection(
  projectId: string,
  error: unknown,
  connection: ProjectAgentConnectionStatus | undefined
): {
  checks: AgentHealthCheck[];
  suggestedActions: string[];
  connection?: ProjectAgentConnectionStatus;
  refreshedConnection: boolean;
} {
  return {
    checks: [{
      id: "project-agent-connection",
      label: "Project Agent context",
      status: "failed",
      message: `Project Agent context preflight failed for ${projectId}: ${formatError(error)}`
    }],
    suggestedActions: ["Fix malformed FlowWeave managed instructions or disable the project Agent connection, then retry."],
    connection,
    refreshedConnection: false
  };
}

function severityForChecks(checks: AgentHealthCheck[]): AgentReadinessResult["severity"] {
  if (checks.some((check) => check.status === "failed")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

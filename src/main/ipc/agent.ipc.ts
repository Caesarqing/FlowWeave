import { shell } from "electron";
import { TOOL_CHANNELS } from "../../common/ipc-channels";
import type { AgentCapability, AgentId, AgentPluginHostId, AgentProtocol, CustomAgentInput, RuntimeAgentId } from "../../types";
import { deleteAgent, detectAgent, detectTool, healthCheckAgent, listAgents, openToolProject, saveAgent, startToolPlan, type StartToolPlanOptions } from "../services/agent-run.service";
import { applyRunArtifact, listRunSummaries, readRunArtifact } from "../services/run-log.service";
import { resolveProjectFile, resolveProjectPath } from "../services/project-registry.service";
import { getDesktopBridgeDir } from "../agents/desktop-bridge.adapter";
import { getBuiltInAgentPluginStatuses, installBuiltInAgentPlugin, resolveAgentPluginInstructionPath } from "../services/agent-plugin.service";
import { requireBoolean, requireBoundedString, requireEnum, requireInteger, requireObject, requireString, requireStringArray } from "./ipc-validation";
import { handleIpc } from "./ipc-handler";

export function registerAgentIpc() {
  handleIpc(TOOL_CHANNELS.listAgents, async () => {
    return listAgents();
  });

  handleIpc(TOOL_CHANNELS.saveCustomAgent, async (_event, input: unknown) => {
    const value = requireObject(TOOL_CHANNELS.saveCustomAgent, input, "input");
    return saveAgent({
      name: requireBoundedString(TOOL_CHANNELS.saveCustomAgent, value.name, "name", 120),
      protocol: value.protocol === undefined
        ? undefined
        : requireEnum(TOOL_CHANNELS.saveCustomAgent, value.protocol, "protocol", ["cli-stdin", "desktop-bridge"]) as AgentProtocol,
      command: value.command === undefined
        ? undefined
        : requireBoundedString(TOOL_CHANNELS.saveCustomAgent, value.command, "command", 2048),
      args: value.args === undefined
        ? undefined
        : requireStringArray(TOOL_CHANNELS.saveCustomAgent, value.args, "args"),
      planArgs: value.planArgs === undefined
        ? undefined
        : requireStringArray(TOOL_CHANNELS.saveCustomAgent, value.planArgs, "planArgs"),
      executeArgs: value.executeArgs === undefined
        ? undefined
        : requireStringArray(TOOL_CHANNELS.saveCustomAgent, value.executeArgs, "executeArgs"),
      appPath: value.appPath === undefined
        ? undefined
        : requireBoundedString(TOOL_CHANNELS.saveCustomAgent, value.appPath, "appPath", 2048),
      bridgeInstructions: value.bridgeInstructions === undefined
        ? undefined
        : requireBoundedString(TOOL_CHANNELS.saveCustomAgent, value.bridgeInstructions, "bridgeInstructions", 4000),
      capabilities: value.capabilities === undefined
        ? undefined
        : requireCapabilityArray(value.capabilities),
      description: value.description === undefined
        ? undefined
        : requireBoundedString(TOOL_CHANNELS.saveCustomAgent, value.description, "description", 2000)
    } satisfies CustomAgentInput);
  });

  handleIpc(TOOL_CHANNELS.deleteCustomAgent, async (_event, agentId: unknown) => {
    return deleteAgent(requireCustomAgentId(TOOL_CHANNELS.deleteCustomAgent, agentId));
  });

  handleIpc(TOOL_CHANNELS.detectAgent, async (_event, agentId: unknown) => {
    return detectAgent(requireAgentId(TOOL_CHANNELS.detectAgent, agentId));
  });

  handleIpc(TOOL_CHANNELS.healthCheckAgent, async (_event, agentId: unknown, projectId: unknown) => {
    return healthCheckAgent(
      requireAgentId(TOOL_CHANNELS.healthCheckAgent, agentId),
      projectId === undefined ? undefined : requireString(TOOL_CHANNELS.healthCheckAgent, projectId, "projectId")
    );
  });

  handleIpc(TOOL_CHANNELS.detect, async (_event, toolId: unknown) => {
    return detectTool(requireEnum(TOOL_CHANNELS.detect, toolId, "toolId", ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"]));
  });

  handleIpc(TOOL_CHANNELS.runPlan, async (_event, value: unknown) => {
    const options = requireObject(TOOL_CHANNELS.runPlan, value, "options") as StartToolPlanOptions;
    const projectId = requireString(TOOL_CHANNELS.runPlan, options.projectId, "projectId");
    return startToolPlan({
      projectId,
      toolId: requireAgentId(TOOL_CHANNELS.runPlan, options.toolId),
      prompt: requireBoundedString(TOOL_CHANNELS.runPlan, options.prompt, "prompt", 1_000_000),
      guidancePath: options.guidancePath
        ? await resolveProjectFile(projectId, requireString(TOOL_CHANNELS.runPlan, options.guidancePath, "guidancePath"))
        : undefined,
      executionMode: requireEnum(TOOL_CHANNELS.runPlan, options.executionMode, "executionMode", ["plan", "execute"]),
      purpose: requireEnum(TOOL_CHANNELS.runPlan, options.purpose, "purpose", ["implementation-plan", "artifact-analysis"]),
      artifactTarget: options.purpose === "artifact-analysis"
        ? requireEnum(TOOL_CHANNELS.runPlan, options.artifactTarget, "artifactTarget", ["architecture-map", "sequence-diagrams", "sequence-revision"]) as StartToolPlanOptions["artifactTarget"]
        : undefined,
      scanFingerprint: options.purpose === "artifact-analysis"
        ? requireBoundedString(TOOL_CHANNELS.runPlan, options.scanFingerprint, "scanFingerprint", 200)
        : undefined,
      reviewId: options.purpose === "artifact-analysis" && options.reviewId !== undefined
        ? requireBoundedString(TOOL_CHANNELS.runPlan, options.reviewId, "reviewId", 200)
        : undefined,
      model: options.model === undefined
        ? undefined
        : requireBoundedString(TOOL_CHANNELS.runPlan, options.model, "model", 200),
      confirmedExecute: options.executionMode === "execute"
        ? requireBoolean(TOOL_CHANNELS.runPlan, options.confirmedExecute, "confirmedExecute")
        : false,
      executeTimeoutMs: options.executionMode === "execute"
        ? requireInteger(TOOL_CHANNELS.runPlan, options.executeTimeoutMs, "executeTimeoutMs", 60_000, 7_200_000)
        : undefined,
      planTimeoutMs: options.executionMode === "plan" && options.planTimeoutMs !== undefined
        ? requireInteger(TOOL_CHANNELS.runPlan, options.planTimeoutMs, "planTimeoutMs", 60_000, 1_800_000)
        : undefined
    });
  });

  handleIpc(TOOL_CHANNELS.listRuns, async (_event, projectId: unknown) => {
    return listRunSummaries(resolveProjectPath(requireString(TOOL_CHANNELS.listRuns, projectId, "projectId")));
  });

  handleIpc(TOOL_CHANNELS.readRun, async (_event, projectId: unknown, runId: unknown) => {
    return readRunArtifact(
      resolveProjectPath(requireString(TOOL_CHANNELS.readRun, projectId, "projectId")),
      requireRunId(TOOL_CHANNELS.readRun, runId)
    );
  });

  handleIpc(TOOL_CHANNELS.applyRunArtifact, async (_event, projectId: unknown, runId: unknown) => {
    return applyRunArtifact(
      resolveProjectPath(requireString(TOOL_CHANNELS.applyRunArtifact, projectId, "projectId")),
      requireRunId(TOOL_CHANNELS.applyRunArtifact, runId)
    );
  });

  handleIpc(TOOL_CHANNELS.openRunBridge, async (_event, projectId: unknown, runId: unknown) => {
    const projectPath = resolveProjectPath(requireString(TOOL_CHANNELS.openRunBridge, projectId, "projectId"));
    const safeRunId = requireRunId(TOOL_CHANNELS.openRunBridge, runId);
    const error = await shell.openPath(getDesktopBridgeDir(projectPath, safeRunId));
    if (error) throw new Error(`Opening FlowWeave bridge folder failed: ${error}`);
  });

  handleIpc(TOOL_CHANNELS.openProject, async (_event, toolId: unknown, projectId: unknown) => {
    return openToolProject(
      requireAgentId(TOOL_CHANNELS.openProject, toolId),
      resolveProjectPath(requireString(TOOL_CHANNELS.openProject, projectId, "projectId"))
    );
  });

  handleIpc(TOOL_CHANNELS.getAgentPluginStatuses, async (_event, projectId: unknown) => {
    return getBuiltInAgentPluginStatuses(resolveProjectPath(requireString(TOOL_CHANNELS.getAgentPluginStatuses, projectId, "projectId")));
  });

  handleIpc(TOOL_CHANNELS.installAgentPlugin, async (_event, projectId: unknown) => {
    return installBuiltInAgentPlugin(resolveProjectPath(requireString(TOOL_CHANNELS.installAgentPlugin, projectId, "projectId")));
  });

  handleIpc(TOOL_CHANNELS.openAgentPlugin, async (_event, projectId: unknown) => {
    const statuses = await getBuiltInAgentPluginStatuses(resolveProjectPath(requireString(TOOL_CHANNELS.openAgentPlugin, projectId, "projectId")));
    const target = statuses[0]?.installTarget;
    if (!target) throw new Error("FlowWeave plugin install target could not be resolved.");
    const error = await shell.openPath(target);
    if (error) throw new Error(`Opening FlowWeave plugin folder failed: ${error}`);
  });

  handleIpc(TOOL_CHANNELS.openAgentPluginInstructions, async (_event, projectId: unknown, hostId: unknown) => {
    const projectPath = resolveProjectPath(requireString(TOOL_CHANNELS.openAgentPluginInstructions, projectId, "projectId"));
    const safeHostId = requireEnum(
      TOOL_CHANNELS.openAgentPluginInstructions,
      hostId,
      "hostId",
      ["codex", "claude", "gemini", "cursor"]
    ) as AgentPluginHostId;
    const instructionPath = await resolveAgentPluginInstructionPath(projectPath, safeHostId);
    const error = await shell.openPath(instructionPath);
    if (error) throw new Error(`Opening FlowWeave plugin instructions failed: ${error}`);
  });
}

function requireAgentId(channel: string, value: unknown): RuntimeAgentId {
  if (typeof value === "string" && value.startsWith("custom:") && value.length > 7) return value as RuntimeAgentId;
  return requireEnum(channel, value, "agentId", ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"]);
}

function requireRunId(channel: string, value: unknown) {
  const runId = requireString(channel, value, "runId");
  if (!/^run-\d+$/.test(runId)) throw new Error(`[${channel}] Invalid "runId".`);
  return runId;
}

function requireCustomAgentId(channel: string, value: unknown): AgentId {
  if (typeof value !== "string" || !value.startsWith("custom:") || value.length <= 7) {
    throw new Error(`[${channel}] Invalid "agentId": expected a custom Agent id.`);
  }
  return value as AgentId;
}

function requireCapabilityArray(value: unknown): AgentCapability[] {
  const capabilities = requireStringArray(TOOL_CHANNELS.saveCustomAgent, value, "capabilities");
  const allowed = new Set<AgentCapability>(["artifact-analysis", "implementation-plan", "execute"]);
  for (const capability of capabilities) {
    if (!allowed.has(capability as AgentCapability)) {
      throw new Error(`[${TOOL_CHANNELS.saveCustomAgent}] Invalid "capabilities": unsupported capability "${capability}".`);
    }
  }
  return capabilities as AgentCapability[];
}

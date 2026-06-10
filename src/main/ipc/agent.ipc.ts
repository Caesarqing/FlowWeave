import { ipcMain } from "electron";
import { TOOL_CHANNELS } from "../../common/ipc-channels";
import type { AgentId, CustomAgentInput, RuntimeAgentId } from "../../types";
import type { ToolId } from "../agents/agent-adapter";
import { deleteAgent, detectAgent, detectTool, listAgents, openToolProject, saveAgent, startToolPlan, type StartToolPlanOptions } from "../services/agent-run.service";
import { listRunSummaries, readRunArtifact } from "../services/run-log.service";
import { resolveProjectFile, resolveProjectPath } from "../services/project-registry.service";
import { requireEnum, requireObject, requireString, requireStringArray } from "./ipc-validation";

export function registerAgentIpc() {
  ipcMain.handle(TOOL_CHANNELS.listAgents, async () => {
    return listAgents();
  });

  ipcMain.handle(TOOL_CHANNELS.saveCustomAgent, async (_event, input: unknown) => {
    const value = requireObject(TOOL_CHANNELS.saveCustomAgent, input, "input");
    return saveAgent({
      name: requireString(TOOL_CHANNELS.saveCustomAgent, value.name, "name"),
      command: requireString(TOOL_CHANNELS.saveCustomAgent, value.command, "command"),
      args: value.args === undefined
        ? undefined
        : requireStringArray(TOOL_CHANNELS.saveCustomAgent, value.args, "args"),
      description: value.description === undefined
        ? undefined
        : requireString(TOOL_CHANNELS.saveCustomAgent, value.description, "description")
    } satisfies CustomAgentInput);
  });

  ipcMain.handle(TOOL_CHANNELS.deleteCustomAgent, async (_event, agentId: unknown) => {
    return deleteAgent(requireCustomAgentId(TOOL_CHANNELS.deleteCustomAgent, agentId));
  });

  ipcMain.handle(TOOL_CHANNELS.detectAgent, async (_event, agentId: unknown) => {
    return detectAgent(requireAgentId(TOOL_CHANNELS.detectAgent, agentId));
  });

  ipcMain.handle(TOOL_CHANNELS.detect, async (_event, toolId: unknown) => {
    return detectTool(requireEnum(TOOL_CHANNELS.detect, toolId, "toolId", ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"]));
  });

  ipcMain.handle(TOOL_CHANNELS.runPlan, async (_event, value: unknown) => {
    const options = requireObject(TOOL_CHANNELS.runPlan, value, "options") as StartToolPlanOptions;
    const projectId = requireString(TOOL_CHANNELS.runPlan, options.projectId, "projectId");
    return startToolPlan({
      projectId,
      toolId: requireAgentId(TOOL_CHANNELS.runPlan, options.toolId),
      prompt: requireString(TOOL_CHANNELS.runPlan, options.prompt, "prompt"),
      guidancePath: options.guidancePath
        ? await resolveProjectFile(projectId, requireString(TOOL_CHANNELS.runPlan, options.guidancePath, "guidancePath"))
        : undefined,
      executionMode: requireEnum(TOOL_CHANNELS.runPlan, options.executionMode, "executionMode", ["plan", "execute"]),
      purpose: requireEnum(TOOL_CHANNELS.runPlan, options.purpose, "purpose", ["implementation-plan", "artifact-analysis"]),
      model: options.model
    });
  });

  ipcMain.handle(TOOL_CHANNELS.listRuns, async (_event, projectId: unknown) => {
    return listRunSummaries(resolveProjectPath(requireString(TOOL_CHANNELS.listRuns, projectId, "projectId")));
  });

  ipcMain.handle(TOOL_CHANNELS.readRun, async (_event, projectId: unknown, runId: unknown) => {
    return readRunArtifact(
      resolveProjectPath(requireString(TOOL_CHANNELS.readRun, projectId, "projectId")),
      requireRunId(TOOL_CHANNELS.readRun, runId)
    );
  });

  ipcMain.handle(TOOL_CHANNELS.openProject, async (_event, toolId: unknown, projectId: unknown) => {
    return openToolProject(
      requireEnum(TOOL_CHANNELS.openProject, toolId, "toolId", ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"]) as ToolId,
      resolveProjectPath(requireString(TOOL_CHANNELS.openProject, projectId, "projectId"))
    );
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

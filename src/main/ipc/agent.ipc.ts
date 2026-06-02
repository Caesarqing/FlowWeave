import { ipcMain } from "electron";
import { TOOL_CHANNELS } from "../../common/ipc-channels";
import type { AgentId, CustomAgentInput, RuntimeAgentId } from "../../types";
import type { ToolId } from "../agents/agent-adapter";
import { deleteAgent, detectAgent, detectTool, listAgents, openToolProject, saveAgent, startToolPlan, type StartToolPlanOptions } from "../services/agent-run.service";
import { listRunSummaries, readRunArtifact } from "../services/run-log.service";

export function registerAgentIpc() {
  ipcMain.handle(TOOL_CHANNELS.listAgents, async () => {
    return listAgents();
  });

  ipcMain.handle(TOOL_CHANNELS.saveCustomAgent, async (_event, input: CustomAgentInput) => {
    return saveAgent(input);
  });

  ipcMain.handle(TOOL_CHANNELS.deleteCustomAgent, async (_event, agentId: AgentId) => {
    return deleteAgent(agentId);
  });

  ipcMain.handle(TOOL_CHANNELS.detectAgent, async (_event, agentId: RuntimeAgentId) => {
    return detectAgent(agentId);
  });

  ipcMain.handle(TOOL_CHANNELS.detect, async (_event, toolId: ToolId) => {
    return detectTool(toolId);
  });

  ipcMain.handle(TOOL_CHANNELS.runPlan, async (_event, options: StartToolPlanOptions) => {
    return startToolPlan({
      ...options,
      executionMode: options.executionMode ?? "plan"
    });
  });

  ipcMain.handle(TOOL_CHANNELS.listRuns, async (_event, projectPath: string) => {
    return listRunSummaries(projectPath);
  });

  ipcMain.handle(TOOL_CHANNELS.readRun, async (_event, projectPath: string, runId: string) => {
    return readRunArtifact(projectPath, runId);
  });

  ipcMain.handle(TOOL_CHANNELS.openProject, async (_event, toolId: ToolId, projectPath: string) => {
    return openToolProject(toolId, projectPath);
  });
}

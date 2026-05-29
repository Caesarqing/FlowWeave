import { ipcMain } from "electron";
import { TOOL_CHANNELS } from "../../common/ipc-channels";
import type { ToolId } from "../agents/agent-adapter";
import { detectTool, openToolProject, startToolPlan, type StartToolPlanOptions } from "../services/agent-run.service";

export function registerAgentIpc() {
  ipcMain.handle(TOOL_CHANNELS.detect, async (_event, toolId: ToolId) => {
    return detectTool(toolId);
  });

  ipcMain.handle(TOOL_CHANNELS.runPlan, async (_event, options: StartToolPlanOptions) => {
    return startToolPlan({
      ...options,
      executionMode: options.executionMode ?? "plan"
    });
  });

  ipcMain.handle(TOOL_CHANNELS.openProject, async (_event, toolId: ToolId, projectPath: string) => {
    return openToolProject(toolId, projectPath);
  });
}

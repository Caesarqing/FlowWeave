import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "./agent-adapter";
import { nowIso } from "./time";
import { resolveAppPath, resolveToolCommand } from "./agent-command";
import { buildAgentInboxInstruction, writeAgentInboxRequest } from "../services/agent-inbox.service";

const execFileAsync = promisify(execFile);
const CURSOR_APP_PATH = "/Applications/Cursor.app";

export class CursorAdapter implements ToolAdapter {
  id = "cursor" as const;
  name = "Cursor";
  kind = "desktop" as const;

  async detect() {
    const command = await resolveToolCommand(this.id);
    if (command.installed) {
      return {
        toolId: this.id,
        available: true,
        method: "cli" as const,
        commandPath: command.commandPath,
        version: command.version,
        message: "Cursor CLI detected."
      };
    }

    const platformSupport = cursorDesktopPlatformSupport(process.platform);
    if (!platformSupport.supported) {
      return {
        toolId: this.id,
        available: false,
        method: "none" as const,
        message: platformSupport.message
      };
    }
    const appPath = await resolveAppPath(CURSOR_APP_PATH);
    return {
      toolId: this.id,
      available: Boolean(appPath),
      method: appPath ? ("app" as const) : ("none" as const),
      appPath,
      message: appPath ? "Cursor.app detected." : "Cursor CLI or Cursor.app was not found."
    };
  }

  async openProject(projectPath: string) {
    const detection = await this.detect();
    if (!detection.available) {
      return {
        toolId: this.id,
        opened: false,
        method: "none" as const,
        message: detection.message
      };
    }

    if (detection.commandPath) {
      await execFileAsync(detection.commandPath, buildCursorCliOpenArgs(projectPath));
      return {
        toolId: this.id,
        opened: true,
        method: "cli" as const,
        message: "Opened project with Cursor CLI."
      };
    }

    if (detection.appPath) {
      await execFileAsync("open", buildCursorAppOpenArgs(detection.appPath, projectPath));
      return {
        toolId: this.id,
        opened: true,
        method: "app" as const,
        message: "Opened project with Cursor.app."
      };
    }

    return {
      toolId: this.id,
      opened: false,
      method: "none" as const,
      message: "Cursor is not available."
    };
  }

  async runPlan(request: ToolRunRequest, onEvent?: (event: ToolRunEvent) => void): Promise<ToolRunResult> {
    const startedAt = nowIso();
    const detection = await this.detect();
    const events: ToolRunEvent[] = [];
    const pushEvent = (event: ToolRunEvent) => {
      events.push(event);
      onEvent?.(event);
    };

    pushEvent({ type: "status", status: "running", timestamp: startedAt });
    await writeAgentInboxRequest(request, this.id);
    if (detection.available) {
      await this.openProject(request.projectPath);
    }
    pushEvent({
      type: "stdout",
      content: detection.available
        ? `Cursor opened. ${buildAgentInboxInstruction(request.projectPath)}`
        : `Agent Inbox request written, but Cursor was not detected. ${detection.message ?? ""}`,
      timestamp: nowIso()
    });
    pushEvent({ type: "status", status: "pending", timestamp: nowIso() });

    return {
      id: request.id,
      toolId: this.id,
      status: "pending",
      projectPath: request.projectPath,
      startedAt,
      completedAt: nowIso(),
      exitCode: undefined,
      executionMode: request.executionMode,
      purpose: request.purpose,
      summary: detection.available ? `Pending Cursor Agent Inbox response for ${request.id}.` : detection.message,
      events
    };
  }
}

export function buildCursorCliOpenArgs(projectPath: string) {
  return [projectPath];
}

export function buildCursorAppOpenArgs(appPath: string, projectPath: string) {
  return ["-a", appPath, projectPath];
}

export function cursorDesktopPlatformSupport(platform: NodeJS.Platform): {
  supported: boolean;
  message?: string;
} {
  if (platform === "darwin") return { supported: true };
  return {
    supported: false,
    message: "Cursor CLI was not found. Install the Cursor CLI to use Cursor on Windows."
  };
}

import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "./agent-adapter";
import { nowIso } from "./time";
import { resolveAppPath, resolveToolCommand } from "./agent-command";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

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
    const planPath = join(request.projectPath, FLOWWEAVE_DIR, "runs", request.id, "plan.md");
    const detection = await this.detect();
    const events: ToolRunEvent[] = [];
    const pushEvent = (event: ToolRunEvent) => {
      events.push(event);
      onEvent?.(event);
    };

    pushEvent({ type: "status", status: "running", timestamp: startedAt });

    const plan = `# Cursor ${request.executionMode === "execute" ? "Execute" : "Plan"} Context

Cursor v1 integration writes this plan for manual review in Cursor.

## How to use

1. Open the project in Cursor.
2. Attach or paste this plan and the generated FlowWeave guidance.
3. Review Cursor's proposed edits before applying them.

## FlowWeave Prompt

${request.prompt}
`;

    await access(join(request.projectPath, FLOWWEAVE_DIR, "runs", request.id));
    await writeFile(planPath, plan, "utf8");
    if (request.executionMode === "execute" && detection.available) {
      await this.openProject(request.projectPath);
    }
    pushEvent({
      type: "stdout",
      content: detection.available
        ? `Cursor context plan written. ${detection.message ?? ""}`
        : `Cursor context plan written, but Cursor was not detected. ${detection.message ?? ""}`,
      timestamp: nowIso()
    });
    pushEvent({ type: "status", status: detection.available ? "completed" : "failed", timestamp: nowIso() });

    return {
      id: request.id,
      toolId: this.id,
      status: detection.available ? "completed" : "failed",
      projectPath: request.projectPath,
      startedAt,
      completedAt: nowIso(),
      exitCode: detection.available ? 0 : 1,
      planPath,
      executionMode: request.executionMode,
      summary: detection.available ? "Cursor plan generated. Open the project in Cursor to review." : detection.message,
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

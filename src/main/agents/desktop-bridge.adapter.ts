import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionMode, RuntimeAgentId } from "../../types";
import type { ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "./agent-adapter";
import { resolveAppPathFromCandidates } from "./agent-command";
import { nowIso } from "./time";
import {
  buildAgentInboxInstruction,
  getAgentInboxRunDir,
  writeAgentInboxRequest
} from "../services/agent-inbox.service";

const execFileAsync = promisify(execFile);
export type DesktopBridgeConfig = {
  id: RuntimeAgentId;
  name: string;
  appPath: string;
  appPathCandidates?: string[];
};

export class DesktopBridgeAdapter implements ToolAdapter {
  id: DesktopBridgeConfig["id"];
  name: string;
  kind = "desktop" as const;
  private appPathCandidates: string[];

  constructor(config: DesktopBridgeConfig) {
    this.id = config.id;
    this.name = config.name;
    this.appPathCandidates = config.appPathCandidates ?? [config.appPath];
  }

  async detect() {
    const platformSupport = desktopBridgePlatformSupport(process.platform);
    if (!platformSupport.supported) {
      return {
        toolId: this.id,
        available: false,
        method: "none" as const,
        message: platformSupport.message
      };
    }
    const appPath = await resolveAppPathFromCandidates(this.appPathCandidates);
    return {
      toolId: this.id,
      available: Boolean(appPath),
      method: appPath ? ("app" as const) : ("none" as const),
      appPath,
      message: appPath ? `${this.name} app detected.` : `${this.name} app was not found at ${this.appPathCandidates.join(", ")}.`
    };
  }

  async openProject(projectPath: string) {
    const detection = await this.detect();
    if (!detection.available || !detection.appPath) {
      return {
        toolId: this.id,
        opened: false,
        method: "none" as const,
        message: detection.message
      };
    }

    await execFileAsync("open", buildDesktopAppOpenArgs(detection.appPath, projectPath));
    return {
      toolId: this.id,
      opened: true,
      method: "app" as const,
      message: `Opened ${this.name}. Agent Inbox requests are stored in their FlowWeave run directories.`
    };
  }

  async runPlan(request: ToolRunRequest, onEvent?: (event: ToolRunEvent) => void): Promise<ToolRunResult> {
    const startedAt = nowIso();
    const events: ToolRunEvent[] = [];

    const pushEvent = (event: ToolRunEvent) => {
      events.push(event);
      onEvent?.(event);
    };

    pushEvent({ type: "status", status: "running", timestamp: startedAt });
    await writeAgentInboxRequest(request, this.id);

    const detection = await this.detect();
    if (detection.available) {
      await this.openProject(request.projectPath)
        .then(() => {
          pushEvent({
            type: "stdout",
            content: `${this.name} opened. ${buildAgentInboxInstruction(request.projectPath, request.id)}`,
            timestamp: nowIso()
          });
        })
        .catch((error: Error) => {
          pushEvent({ type: "stderr", content: `Failed to open ${this.name}: ${error.message}`, timestamp: nowIso() });
        });
    } else {
      pushEvent({ type: "stderr", content: detection.message ?? `${this.name} app is not available.`, timestamp: nowIso() });
    }

    const completedAt = nowIso();
    pushEvent({ type: "status", status: "pending", timestamp: completedAt });
    return {
      id: request.id,
      toolId: this.id,
      status: "pending",
      projectPath: request.projectPath,
      startedAt,
      completedAt,
      exitCode: undefined,
      executionMode: request.executionMode,
      purpose: request.purpose,
      summary: detection.available
        ? `Pending ${this.name} Agent Inbox response for ${request.id}.`
        : `${this.name} is not installed. The Agent Inbox request remains available for manual processing.`,
      events
    };
  }
}

export class ClaudeDesktopAdapter extends DesktopBridgeAdapter {
  constructor() {
    super({
      id: "claude-desktop",
      name: "Claude Desktop",
      appPath: "/Applications/Claude.app"
    });
  }
}

export class CodexDesktopAdapter extends DesktopBridgeAdapter {
  constructor() {
    super({
      id: "codex-desktop",
      name: "Codex Desktop",
      appPath: "/Applications/ChatGPT.app",
      appPathCandidates: [
        "/Applications/ChatGPT.app",
        "/Applications/Codex.app"
      ]
    });
  }
}

export function getCodexDesktopAppPathCandidates(): string[] {
  return [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app"
  ];
}

export function buildDesktopAppOpenArgs(appPath: string, projectPath: string) {
  return ["-a", appPath, projectPath];
}

export function desktopBridgePlatformSupport(platform: NodeJS.Platform): {
  supported: boolean;
  message?: string;
} {
  if (platform === "darwin") return { supported: true };
  return {
    supported: false,
    message: "Desktop Agent Inbox is only supported on macOS. Use the CLI integration on Windows."
  };
}

export function getDesktopBridgeDir(projectPath: string, runId: string) {
  return getAgentInboxRunDir(projectPath, runId);
}

export function buildDesktopBridgeInstructions(
  agentName: string,
  executionMode: ExecutionMode,
  purpose: ToolRunRequest["purpose"]
) {
  const baseInstructions = `# FlowWeave Agent Inbox Instructions

Agent: ${agentName}
Execution mode: ${executionMode}
Purpose: ${purpose}

Read the run-specific .flowweave/runs/<run-id>/agent-request.json path provided by FlowWeave.
Write exactly one response to the request responsePath.
Use Agent Inbox protocol v2. Copy runId and projectId exactly from request.json.
In plan mode, do not modify project source files.`;
  return baseInstructions;
}

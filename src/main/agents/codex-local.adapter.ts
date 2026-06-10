import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "./agent-adapter";
import { nowIso } from "./time";
import { resolveToolCommand } from "./agent-command";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

export class CodexLocalAdapter implements ToolAdapter {
  id = "codex-local" as const;
  name = "Codex Local";
  kind = "cli" as const;

  async detect() {
    const result = await resolveToolCommand(this.id);
    return {
      toolId: this.id,
      available: result.installed,
      method: result.installed ? ("cli" as const) : ("none" as const),
      commandPath: result.commandPath,
      version: result.version,
      message: result.installed ? "Codex CLI detected." : "Codex CLI was not found in PATH or known app locations."
    };
  }

  async runPlan(request: ToolRunRequest, onEvent?: (event: ToolRunEvent) => void): Promise<ToolRunResult> {
    const resolvedCommand = await resolveToolCommand(this.id);
    if (!resolvedCommand.installed || !resolvedCommand.commandPath) {
      const timestamp = nowIso();
      return {
        id: request.id,
        toolId: this.id,
        status: "failed",
        projectPath: request.projectPath,
        startedAt: timestamp,
        completedAt: timestamp,
        executionMode: request.executionMode,
        purpose: request.purpose,
        events: [{ type: "error", message: "Codex CLI is not installed or not available.", timestamp }]
      };
    }
    const commandPath = resolvedCommand.commandPath;

    if (request.guidancePath) {
      await access(request.guidancePath);
    }

    const startedAt = nowIso();
    const events: ToolRunEvent[] = [];
    const lastMessagePath = join(request.projectPath, FLOWWEAVE_DIR, "runs", request.id, "last-message.md");
    const prompt = request.prompt;

    const args = buildCodexPlanArgs({
      executionMode: request.executionMode,
      lastMessagePath,
      model: request.model,
      projectPath: request.projectPath
    });

    return new Promise<ToolRunResult>((resolve) => {
      const pushEvent = (event: ToolRunEvent) => {
        events.push(event);
        onEvent?.(event);
      };

      pushEvent({ type: "status", status: "running", timestamp: startedAt });

      const child = spawn(commandPath, args, {
        cwd: request.projectPath,
        stdio: ["pipe", "pipe", "pipe"]
      });

      child.stdin.write(prompt);
      child.stdin.end();

      child.stdout.on("data", (chunk: Buffer) => {
        pushEvent({ type: "stdout", content: chunk.toString(), timestamp: nowIso() });
      });

      child.stderr.on("data", (chunk: Buffer) => {
        pushEvent({ type: "stderr", content: chunk.toString(), timestamp: nowIso() });
      });

      child.on("error", (error: Error) => {
        const timestamp = nowIso();
        pushEvent({ type: "error", message: error.message, timestamp });
        pushEvent({ type: "status", status: "failed", timestamp });
        resolve({
          id: request.id,
          toolId: this.id,
          status: "failed",
          projectPath: request.projectPath,
          startedAt,
          completedAt: timestamp,
          executionMode: request.executionMode,
          purpose: request.purpose,
          events
        });
      });

      child.on("close", (code: number | null) => {
        const completedAt = nowIso();
        const status = code === 0 ? "completed" : "failed";
        pushEvent({ type: "status", status, timestamp: completedAt });
        resolve({
          id: request.id,
          toolId: this.id,
          status,
          projectPath: request.projectPath,
          startedAt,
          completedAt,
          exitCode: code,
          lastMessagePath,
          executionMode: request.executionMode,
          purpose: request.purpose,
          events
        });
      });
    });
  }
}

export function buildCodexPlanArgs({
  executionMode,
  lastMessagePath,
  model,
  projectPath
}: {
  executionMode: "plan" | "execute";
  lastMessagePath: string;
  model?: string;
  projectPath: string;
}) {
  const args = [
    "exec",
    "--cd",
    projectPath,
    "--sandbox",
    executionMode === "plan" ? "read-only" : "workspace-write",
    "--output-last-message",
    lastMessagePath,
    "-"
  ];

  if (model) {
    args.splice(1, 0, "--model", model);
  }

  return args;
}

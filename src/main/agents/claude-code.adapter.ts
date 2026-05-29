import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "./agent-adapter";
import { nowIso } from "./time";
import { resolveToolCommand } from "./agent-command";

export class ClaudeCodeAdapter implements ToolAdapter {
  id = "claude-code" as const;
  name = "Claude Code";
  kind = "cli" as const;

  async detect() {
    const result = await resolveToolCommand(this.id);
    return {
      toolId: this.id,
      available: result.installed,
      method: result.installed ? ("cli" as const) : ("none" as const),
      commandPath: result.commandPath,
      version: result.version,
      message: result.installed ? "Claude Code CLI detected." : "Claude Code CLI was not found in PATH or known locations."
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
        events: [{ type: "error", message: "Claude Code is not installed or not available.", timestamp }]
      };
    }
    const commandPath = resolvedCommand.commandPath;

    if (request.guidancePath) {
      await access(request.guidancePath);
    }

    const startedAt = nowIso();
    const events: ToolRunEvent[] = [];
    const prompt = buildClaudePrompt(request.prompt, request.executionMode);
    const args = buildClaudeArgs(request.executionMode, request.model);

    return new Promise<ToolRunResult>((resolve) => {
      const pushEvent = (event: ToolRunEvent) => {
        events.push(event);
        onEvent?.(event);
      };

      pushEvent({ type: "status", status: "running", timestamp: startedAt });

      const child = spawn(commandPath, [...args, prompt], {
        cwd: request.projectPath,
        stdio: ["ignore", "pipe", "pipe"]
      });

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
          executionMode: request.executionMode,
          events
        });
      });
    });
  }
}

export function buildClaudeArgs(executionMode: "plan" | "execute", model?: string) {
  const args = [
    "--print",
    "--permission-mode",
    executionMode === "plan" ? "plan" : "acceptEdits",
    "--output-format",
    "text",
    "--no-session-persistence"
  ];
  if (model) {
    args.push("--model", model);
  }
  return args;
}

export function buildClaudePrompt(prompt: string, executionMode: "plan" | "execute") {
  if (executionMode === "execute") return prompt;
  return `${prompt}

Dry run only: inspect the request and return the implementation plan, affected files, risks, and tests. Do not edit files.`;
}

export const buildClaudeDryRunArgs = (model?: string) => buildClaudeArgs("plan", model);
export const buildClaudeDryRunPrompt = (prompt: string) => buildClaudePrompt(prompt, "plan");

import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "./agent-adapter";
import { resolveToolCommand } from "./agent-command";
import { nowIso } from "./time";

export class GeminiCliAdapter implements ToolAdapter {
  id = "gemini-cli" as const;
  name = "Gemini CLI";
  kind = "cli" as const;

  async detect() {
    const result = await resolveToolCommand(this.id);
    return {
      toolId: this.id,
      available: result.installed,
      method: result.installed ? ("cli" as const) : ("none" as const),
      commandPath: result.commandPath,
      version: result.version,
      message: result.installed ? "Gemini CLI detected." : "Gemini CLI was not found in PATH or known locations."
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
        events: [{ type: "error", message: "Gemini CLI is not installed or not available.", timestamp }]
      };
    }

    if (request.guidancePath) {
      await access(request.guidancePath);
    }

    const startedAt = nowIso();
    const events: ToolRunEvent[] = [];
    const commandPath = resolvedCommand.commandPath;
    const prompt = request.prompt;

    return new Promise<ToolRunResult>((resolve) => {
      const pushEvent = (event: ToolRunEvent) => {
        events.push(event);
        onEvent?.(event);
      };

      pushEvent({ type: "status", status: "running", timestamp: startedAt });

      const child = spawn(commandPath, buildGeminiArgs(request.executionMode, request.model), {
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
          executionMode: request.executionMode,
          purpose: request.purpose,
          events
        });
      });
    });
  }
}

export function buildGeminiArgs(executionMode: "plan" | "execute", model?: string) {
  const args: string[] = ["--approval-mode", executionMode === "plan" ? "plan" : "auto_edit"];
  if (model) {
    args.push("--model", model);
  }
  return args;
}

export function buildGeminiPrompt(prompt: string, executionMode: "plan" | "execute", purpose?: import("../../types").ToolRunPurpose) {
  if (executionMode === "execute" || purpose === "artifact-analysis") return prompt;
  return `${prompt}

Dry run only: inspect the request and return the implementation plan, affected files, risks, and tests. Do not edit files.`;
}

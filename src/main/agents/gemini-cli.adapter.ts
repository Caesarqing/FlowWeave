import { access } from "node:fs/promises";
import type { ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "./agent-adapter";
import { resolveToolCommand } from "./agent-command";
import { nowIso } from "./time";
import { runSpawnedAgent } from "./spawn-agent-process";

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

    const commandPath = resolvedCommand.commandPath;
    const prompt = request.prompt;
    return runSpawnedAgent({
      toolId: this.id,
      commandPath,
      args: buildGeminiArgs(request.executionMode, request.model),
      request,
      stdin: prompt
    }, onEvent);
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

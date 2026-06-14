import { access } from "node:fs/promises";
import type { ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "./agent-adapter";
import { nowIso } from "./time";
import { resolveToolCommand } from "./agent-command";
import { runSpawnedAgent } from "./spawn-agent-process";

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
        purpose: request.purpose,
        events: [{ type: "error", message: "Claude Code is not installed or not available.", timestamp }]
      };
    }
    const commandPath = resolvedCommand.commandPath;

    if (request.guidancePath) {
      await access(request.guidancePath);
    }

    const prompt = request.prompt;
    const args = buildClaudeArgs(request.executionMode, request.model, request.purpose);
    return runSpawnedAgent({
      toolId: this.id,
      commandPath,
      args,
      request,
      stdin: prompt
    }, onEvent);
  }
}

export function buildClaudeArgs(
  executionMode: "plan" | "execute",
  model?: string,
  purpose?: import("../../types").ToolRunPurpose
) {
  const args = [
    "--print",
    "--permission-mode",
    executionMode === "plan" ? "plan" : "acceptEdits",
    "--output-format",
    purpose === "artifact-analysis" ? "json" : "text",
    "--no-session-persistence"
  ];
  if (model) {
    args.push("--model", model);
  }
  return args;
}

export function buildClaudePrompt(prompt: string, executionMode: "plan" | "execute", purpose?: import("../../types").ToolRunPurpose) {
  if (executionMode === "execute" || purpose === "artifact-analysis") return prompt;
  return `${prompt}

Dry run only: inspect the request and return the implementation plan, affected files, risks, and tests. Do not edit files.`;
}

export const buildClaudeDryRunArgs = (model?: string) => buildClaudeArgs("plan", model, "implementation-plan");
export const buildClaudeDryRunPrompt = (prompt: string) => buildClaudePrompt(prompt, "plan");

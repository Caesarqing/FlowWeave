import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "./agent-adapter";
import { nowIso } from "./time";
import { resolveToolCommand } from "./agent-command";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { runSpawnedAgent } from "./spawn-agent-process";

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

    const lastMessagePath = join(request.projectPath, FLOWWEAVE_DIR, "runs", request.id, "last-message.md");
    const prompt = request.prompt;

    const args = buildCodexPlanArgs({
      executionMode: request.executionMode,
      lastMessagePath,
      model: request.model,
      projectPath: request.projectPath,
      isolated: process.env.FLOWWEAVE_AGENT_SMOKE_ISOLATED === "1"
    });

    return runSpawnedAgent({
      toolId: this.id,
      commandPath,
      args,
      request,
      stdin: prompt,
      lastMessagePath
    }, onEvent);
  }
}

export function buildCodexPlanArgs({
  executionMode,
  lastMessagePath,
  model,
  projectPath,
  isolated
}: {
  executionMode: "plan" | "execute";
  lastMessagePath: string;
  model?: string;
  projectPath: string;
  isolated?: boolean;
}) {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--cd",
    projectPath,
    "--sandbox",
    executionMode === "plan" ? "read-only" : "workspace-write",
    "--output-last-message",
    lastMessagePath,
    "-"
  ];
  if (isolated) {
    args.splice(1, 0, "--ephemeral", "--ignore-user-config", "--ignore-rules");
  }

  if (model) {
    args.splice(1, 0, "--model", model);
  }

  return args;
}

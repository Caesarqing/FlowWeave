import { spawn } from "node:child_process";
import type { AgentDefinition, ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "../../types";
import { resolveCandidate } from "./agent-command";
import { nowIso } from "./time";
import { runSpawnedAgent } from "./spawn-agent-process";

export class CustomCliAdapter implements ToolAdapter {
  id: AgentDefinition["id"];
  name: string;
  kind = "cli" as const;

  constructor(private readonly definition: AgentDefinition) {
    this.id = definition.id;
    this.name = definition.name;
  }

  async detect() {
    const commandPath = await resolveCandidate(this.definition.command);
    const version = commandPath ? await readVersion(commandPath, this.definition.args) : undefined;
    return {
      toolId: this.definition.id,
      available: Boolean(commandPath),
      method: commandPath ? ("cli" as const) : ("none" as const),
      commandPath,
      version,
      message: commandPath ? `${this.definition.name} CLI detected.` : `${this.definition.name} command was not found.`
    };
  }

  async runPlan(request: ToolRunRequest, onEvent?: (event: ToolRunEvent) => void): Promise<ToolRunResult> {
    if (request.executionMode === "plan") {
      throw new Error(`Custom CLI "${this.definition.name}" does not declare a verifiable read-only Plan mode.`);
    }
    const detection = await this.detect();
    if (!detection.available || !detection.commandPath) {
      const startedAt = nowIso();
      const events: ToolRunEvent[] = [];
      const pushEvent = (event: ToolRunEvent) => {
        events.push(event);
        onEvent?.(event);
      };
      pushEvent({ type: "error", message: detection.message ?? "Custom CLI agent is not available.", timestamp: startedAt });
      pushEvent({ type: "status", status: "failed", timestamp: startedAt });
      return {
        id: request.id,
        toolId: this.definition.id,
        status: "failed",
        projectPath: request.projectPath,
        startedAt,
        completedAt: startedAt,
        executionMode: request.executionMode,
        purpose: request.purpose,
        events
      };
    }

    const commandPath = detection.commandPath;
    return runSpawnedAgent({
      toolId: this.definition.id,
      commandPath,
      args: this.definition.args,
      request,
      stdin: request.prompt
    }, onEvent);
  }
}

async function readVersion(commandPath: string, args: string[]) {
  return new Promise<string | undefined>((resolve) => {
    const child = spawn(commandPath, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, 1200);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("close", () => {
      clearTimeout(timeout);
      resolve(output.trim() || args.join(" ") || undefined);
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
  });
}

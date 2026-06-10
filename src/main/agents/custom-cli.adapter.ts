import { spawn } from "node:child_process";
import type { AgentDefinition, ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "../../types";
import { resolveCandidate } from "./agent-command";
import { nowIso } from "./time";

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
    const startedAt = nowIso();
    const events: ToolRunEvent[] = [];
    const pushEvent = (event: ToolRunEvent) => {
      events.push(event);
      onEvent?.(event);
    };

    if (!detection.available || !detection.commandPath) {
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
    return new Promise<ToolRunResult>((resolve) => {
      pushEvent({ type: "status", status: "running", timestamp: startedAt });
      const child = spawn(commandPath, this.definition.args, {
        cwd: request.projectPath,
        stdio: ["pipe", "pipe", "pipe"]
      });

      child.stdin.write(request.prompt);
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
          toolId: this.definition.id,
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
          toolId: this.definition.id,
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

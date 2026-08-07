import { spawn } from "node:child_process";
import type { AgentDefinition, AgentHealthCheck, AgentHealthCheckResult, ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "../../types";
import { resolveCandidate } from "./agent-command";
import { prepareCommandInvocation } from "./command-invocation";
import { nowIso } from "./time";
import { runCliAgentInbox } from "./agent-inbox-runner";

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

  async healthCheck(): Promise<AgentHealthCheckResult> {
    const detection = await this.detect();
    const checks: AgentHealthCheck[] = [{
      id: "custom-command",
      label: `${this.definition.name} command`,
      status: detection.available ? "passed" : "failed",
      message: detection.commandPath ? `${this.definition.name} resolved at ${detection.commandPath}.` : `${this.definition.name} command was not found.`
    }, {
      id: "custom-stdin-plan",
      label: "Custom CLI stdin plan mode",
      status: supportsReadOnlyPurpose(this.definition, "implementation-plan") ? "passed" : "warning",
      message: supportsReadOnlyPurpose(this.definition, "implementation-plan")
        ? `Plan args: ${argsForRequest(this.definition, { executionMode: "plan", purpose: "implementation-plan" } as ToolRunRequest).join(" ") || "(none)"}`
        : "This custom CLI does not declare implementation-plan capability."
    }, {
      id: "custom-execute-args",
      label: "Custom CLI execute args",
      status: (this.definition.executeArgs?.length ?? 0) > 0 || (this.definition.args?.length ?? 0) > 0 ? "passed" : "warning",
      message: `Execute args: ${(this.definition.executeArgs?.length ? this.definition.executeArgs : this.definition.args).join(" ") || "(none)"}`
    }];
    return {
      agentId: this.definition.id,
      severity: healthSeverity(checks),
      checks,
      suggestedActions: detection.available
        ? ["Custom CLI is detectable. Confirm its plan and execute arguments are non-interactive."]
        : [`Install or configure ${this.definition.name}, then run detection again.`],
      environmentHints: [],
      checkedAt: nowIso()
    };
  }

  async runPlan(request: ToolRunRequest, onEvent?: (event: ToolRunEvent) => void): Promise<ToolRunResult> {
    if (request.executionMode === "plan" && !supportsReadOnlyPurpose(this.definition, request.purpose)) {
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
    return runCliAgentInbox({
      toolId: this.definition.id,
      commandPath,
      args: argsForRequest(this.definition, request),
      request
    }, onEvent);
  }
}

function healthSeverity(checks: AgentHealthCheck[]): AgentHealthCheckResult["severity"] {
  if (checks.some((check) => check.status === "failed")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

function supportsReadOnlyPurpose(definition: AgentDefinition, purpose: ToolRunRequest["purpose"]): boolean {
  const capabilities = new Set(definition.capabilities ?? []);
  if (purpose === "artifact-analysis") return capabilities.has("artifact-analysis");
  return capabilities.has("implementation-plan");
}

function argsForRequest(definition: AgentDefinition, request: ToolRunRequest): string[] {
  if (request.executionMode === "plan") {
    return definition.planArgs && definition.planArgs.length > 0 ? definition.planArgs : definition.args;
  }
  return definition.executeArgs && definition.executeArgs.length > 0 ? definition.executeArgs : definition.args;
}

async function readVersion(commandPath: string, args: string[]) {
  const invocation = await prepareCommandInvocation(commandPath, ["--version"], process.platform);
  return new Promise<string | undefined>((resolve) => {
    const child = spawn(invocation.commandPath, invocation.args, { stdio: ["ignore", "pipe", "ignore"] });
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

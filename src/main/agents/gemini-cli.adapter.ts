import { access } from "node:fs/promises";
import type { AgentHealthCheck, AgentHealthCheckResult, ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "./agent-adapter";
import { resolveToolCommand } from "./agent-command";
import { nowIso } from "./time";
import { runAgentModelProbe } from "./agent-probe";
import { runCliAgentInbox } from "./agent-inbox-runner";

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

  async healthCheck(options?: { runModelProbe: boolean }): Promise<AgentHealthCheckResult> {
    const result = await resolveToolCommand(this.id);
    const checks: AgentHealthCheck[] = [{
      id: "gemini-command",
      label: "Gemini CLI command",
      status: result.installed && result.commandPath ? "passed" : "failed",
      message: result.commandPath ? `Gemini CLI resolved at ${result.commandPath}.` : "Gemini CLI command was not found in PATH or known locations."
    }, {
      id: "gemini-version",
      label: "Gemini CLI version",
      status: result.version ? "passed" : result.installed ? "warning" : "failed",
      message: result.version ? `Gemini CLI version ${result.version}.` : "Gemini CLI version could not be read with --version."
    }, {
      id: "gemini-stdin",
      label: "Gemini stdin mode",
      status: result.installed ? "passed" : "failed",
      message: result.installed
        ? "FlowWeave will pass prompts through stdin with approval-mode arguments."
        : "Gemini CLI cannot run FlowWeave stdin prompts until the command is installed."
    }];
    if (options?.runModelProbe === true && result.commandPath && !checks.some((check) => check.status === "failed")) {
      checks.push(await runAgentModelProbe({
        toolId: this.id,
        commandPath: result.commandPath,
        args: buildGeminiArgs("plan"),
        stdin: "FlowWeave health check. Reply with OK only. Do not edit files.",
        checkId: "gemini-model-probe",
        label: "Gemini model probe"
      }));
    }
    return {
      agentId: this.id,
      severity: healthSeverity(checks),
      checks,
      suggestedActions: result.installed
        ? ["Gemini CLI is detectable. Review run logs if provider errors continue."]
        : ["Install Gemini CLI or add the gemini executable to PATH."],
      environmentHints: [
        process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? "Gemini API key signal is visible." : "Gemini API key signal is not visible.",
        process.env.GOOGLE_GENAI_USE_VERTEXAI ? "Vertex AI mode is enabled." : "Vertex AI mode is not enabled."
      ],
      checkedAt: nowIso()
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
    return runCliAgentInbox({
      toolId: this.id,
      commandPath,
      args: buildGeminiArgs(request.executionMode, request.model),
      request
    }, onEvent);
  }
}

function healthSeverity(checks: AgentHealthCheck[]): AgentHealthCheckResult["severity"] {
  if (checks.some((check) => check.status === "failed")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
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

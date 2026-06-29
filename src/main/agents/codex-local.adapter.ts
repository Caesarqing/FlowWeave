import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentHealthCheck, AgentHealthCheckResult, ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "./agent-adapter";
import { nowIso } from "./time";
import { resolveToolCommand } from "./agent-command";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { runSpawnedAgent } from "./spawn-agent-process";
import { prepareCommandInvocation } from "./command-invocation";

const execFileAsync = promisify(execFile);
const CODEX_HEALTH_TIMEOUT_MS = 3_000;

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

  async healthCheck(): Promise<AgentHealthCheckResult> {
    const resolved = await resolveToolCommand(this.id);
    const checks: AgentHealthCheck[] = [{
      id: "codex-command",
      label: "Codex CLI command",
      status: resolved.installed && resolved.commandPath ? "passed" : "failed",
      message: resolved.commandPath ? `Codex CLI resolved at ${resolved.commandPath}.` : "Codex CLI was not found in PATH or known app locations."
    }, {
      id: "codex-version",
      label: "Codex CLI version",
      status: resolved.version ? "passed" : resolved.installed ? "warning" : "failed",
      message: resolved.version ? `Codex CLI version ${resolved.version}.` : "Codex CLI version could not be read with --version."
    }];
    if (resolved.commandPath) {
      const versionWarning = await codexVersionWarning(resolved.commandPath);
      if (versionWarning) {
        checks.push({
          id: "codex-cli-warning",
          label: "Codex CLI warning",
          status: "warning",
          message: versionWarning
        });
      }
      checks.push(...await codexExecChecks(resolved.commandPath));
    }
    return {
      agentId: this.id,
      severity: healthSeverity(checks),
      checks,
      suggestedActions: buildCodexSuggestedActions(checks),
      environmentHints: [
        process.env.OPENAI_API_KEY ? "OPENAI_API_KEY is set." : "OPENAI_API_KEY is not set.",
        process.env.OPENAI_BASE_URL ? "OPENAI_BASE_URL is set." : "OPENAI_BASE_URL is not set."
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

async function codexVersionWarning(commandPath: string): Promise<string | undefined> {
  try {
    const result = await execCodexHealthCommand(commandPath, ["--version"]);
    return result.stderr.trim() || undefined;
  } catch (error) {
    return isTimeoutError(error)
      ? `Codex --version timed out after ${CODEX_HEALTH_TIMEOUT_MS}ms.`
      : undefined;
  }
}

async function codexExecChecks(commandPath: string): Promise<AgentHealthCheck[]> {
  try {
    const result = await execCodexHealthCommand(commandPath, ["exec", "--help"]);
    const help = `${result.stdout}\n${result.stderr}`;
    const requiredFlags = ["--cd", "--sandbox", "--output-last-message"];
    const missing = requiredFlags.filter((flag) => !help.includes(flag));
    const checks: AgentHealthCheck[] = [{
      id: "codex-exec-flags",
      label: "Codex exec flags",
      status: missing.length === 0 && /stdin/i.test(help) ? "passed" : "failed",
      message: missing.length === 0
        ? "Codex exec supports FlowWeave non-interactive flags and stdin prompts."
        : `Codex exec is missing required flags: ${missing.join(", ")}.`
    }];
    if (result.stderr.trim()) {
      checks.push({
        id: "codex-cli-warning",
        label: "Codex CLI warning",
        status: "warning",
        message: result.stderr.trim()
      });
    }
    return checks;
  } catch (error) {
    return [{
      id: "codex-exec-flags",
      label: "Codex exec flags",
      status: "failed",
      message: isTimeoutError(error)
        ? `Codex exec --help timed out after ${CODEX_HEALTH_TIMEOUT_MS}ms.`
        : `Codex exec --help failed: ${formatError(error)}`
    }];
  }
}

async function execCodexHealthCommand(commandPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const invocation = await prepareCommandInvocation(commandPath, args, process.platform);
  const result = await execFileAsync(invocation.commandPath, invocation.args, { timeout: CODEX_HEALTH_TIMEOUT_MS });
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "")
  };
}

function healthSeverity(checks: AgentHealthCheck[]): AgentHealthCheckResult["severity"] {
  if (checks.some((check) => check.status === "failed")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

function buildCodexSuggestedActions(checks: AgentHealthCheck[]): string[] {
  if (checks.some((check) => check.status === "failed")) {
    return ["Install or update Codex CLI, then run health check again."];
  }
  if (checks.some((check) => check.status === "warning")) {
    return ["Codex CLI is available, but warnings may affect Electron-launched runs. Inspect the warning before retrying if runs fail."];
  }
  return ["Codex CLI is ready for FlowWeave non-interactive runs."];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const processError = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null };
  return processError.killed === true || processError.signal === "SIGTERM" || /timed out/i.test(error.message);
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

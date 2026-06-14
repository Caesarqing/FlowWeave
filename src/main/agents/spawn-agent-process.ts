import { execFile, spawn } from "node:child_process";
import type { RuntimeAgentId, ToolRunEvent, ToolRunRequest, ToolRunResult, ToolRunTerminationReason } from "../../types";
import { prepareCommandInvocation } from "./command-invocation";
import { nowIso } from "./time";

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const FORCE_KILL_DELAY_MS = 2_000;
const BASE_ENVIRONMENT_KEYS = [
  "PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "PATHEXT", "SystemRoot", "ComSpec"
] as const;

export type SpawnAgentProcessOptions = {
  toolId: RuntimeAgentId;
  commandPath: string;
  args: string[];
  request: ToolRunRequest;
  stdin?: string;
  lastMessagePath?: string;
};

export async function runSpawnedAgent(
  options: SpawnAgentProcessOptions,
  onEvent?: (event: ToolRunEvent) => void
): Promise<ToolRunResult> {
  const invocation = await prepareCommandInvocation(options.commandPath, options.args, process.platform);
  const startedAt = nowIso();
  const startedMs = Date.now();
  const events: ToolRunEvent[] = [];
  let outputBytes = 0;
  let outputTruncated = false;
  let forcedReason: ToolRunTerminationReason | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;

  return new Promise<ToolRunResult>((resolve) => {
    let settled = false;
    const pushEvent = (event: ToolRunEvent) => {
      events.push(event);
      onEvent?.(event);
    };
    const finish = (exitCode: number | null, reason: ToolRunTerminationReason) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.request.signal?.removeEventListener("abort", abortProcessTree);
      const completedAt = nowIso();
      const status = reason === "completed" ? "completed" : "failed";
      pushEvent({ type: "status", status, timestamp: completedAt });
      resolve({
        id: options.request.id,
        toolId: options.toolId,
        status,
        projectPath: options.request.projectPath,
        startedAt,
        completedAt,
        exitCode,
        lastMessagePath: options.lastMessagePath,
        executionMode: options.request.executionMode,
        purpose: options.request.purpose,
        events,
        durationMs: Date.now() - startedMs,
        outputTruncated,
        terminationReason: reason
      });
    };
    const maxOutputBytes = options.request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    pushEvent({ type: "status", status: "running", timestamp: startedAt });
    const child = spawn(invocation.commandPath, invocation.args, {
      cwd: options.request.projectPath,
      detached: process.platform !== "win32",
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: safeAgentEnvironment(process.env, options.toolId)
    });

    const abortProcessTree = () => {
      forcedReason = abortReason(options.request.signal);
      terminateProcessTree(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => terminateProcessTree(child.pid, "SIGKILL"), FORCE_KILL_DELAY_MS);
    };
    if (options.request.signal?.aborted) abortProcessTree();
    else options.request.signal?.addEventListener("abort", abortProcessTree, { once: true });

    const readOutput = (type: "stdout" | "stderr", chunk: Buffer) => {
      if (outputTruncated) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes || events.length >= MAX_EVENTS) {
        outputTruncated = true;
        forcedReason = "output-limit";
        pushEvent({
          type: "error",
          message: outputBytes > maxOutputBytes
            ? `Agent output exceeded the ${maxOutputBytes} byte limit.`
            : `Agent output exceeded the ${MAX_EVENTS} event limit.`,
          timestamp: nowIso()
        });
        terminateProcessTree(child.pid, "SIGTERM");
        forceKillTimer = setTimeout(() => terminateProcessTree(child.pid, "SIGKILL"), FORCE_KILL_DELAY_MS);
        return;
      }
      pushEvent({ type, content: chunk.toString(), timestamp: nowIso() });
    };

    if (!child.stdout || !child.stderr) {
      terminateProcessTree(child.pid, "SIGTERM");
      finish(null, "failed");
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => readOutput("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => readOutput("stderr", chunk));
    child.on("error", (error: Error) => {
      const aborted = error.name === "AbortError" || options.request.signal?.aborted;
      const reason = forcedReason ?? (aborted ? abortReason(options.request.signal) : "failed");
      pushEvent({ type: "error", message: aborted ? `Agent run ${reason}.` : error.message, timestamp: nowIso() });
      finish(null, reason);
    });
    child.on("close", (code: number | null) => {
      const reason = forcedReason ??
        (options.request.signal?.aborted ? abortReason(options.request.signal) : code === 0 ? "completed" : "failed");
      finish(code, reason);
    });

    if (options.stdin !== undefined) {
      if (!child.stdin) {
        terminateProcessTree(child.pid, "SIGTERM");
        finish(null, "failed");
        return;
      }
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

export function safeAgentEnvironment(source: NodeJS.ProcessEnv, toolId: RuntimeAgentId): NodeJS.ProcessEnv {
  const credentialKeys = toolId === "claude-code"
    ? [
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
        "ANTHROPIC_BEDROCK_BASE_URL", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE",
        "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
        "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION",
        "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"
      ]
    : toolId === "codex-local"
      ? ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "CODEX_HOME"]
      : toolId === "gemini-cli"
        ? [
            "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI",
            "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"
          ]
        : [];
  return Object.fromEntries(
    [...BASE_ENVIRONMENT_KEYS, ...credentialKeys]
      .flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])
  );
}

function abortReason(signal: AbortSignal | undefined): ToolRunTerminationReason {
  return signal?.reason === "timeout" ? "timeout" : "canceled";
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    execFile("taskkill.exe", buildWindowsTaskkillArgs(pid), (error) => {
      if (error && !isMissingProcess(error)) {
        console.error("Failed to terminate Windows Agent process tree.", {
          pid,
          code: "code" in error ? error.code : undefined
        });
      }
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

export function buildWindowsTaskkillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

function isMissingProcess(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH";
}

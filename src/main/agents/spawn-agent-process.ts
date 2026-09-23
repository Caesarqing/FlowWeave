import { execFile, spawn } from "node:child_process";
import type { RuntimeAgentId, ToolRunEvent, ToolRunRequest, ToolRunResult } from "../../types";
import { prepareCommandInvocation } from "./command-invocation";
import { nowIso } from "./time";
import { promisify } from "node:util";

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const TERMINATION_GRACE_MS = 5_000;
const PROCESS_TREE_CONFIRMATION_MS = 2_000;
const PROCESS_TREE_CONFIRMATION_POLL_MS = 25;
const execFileAsync = promisify(execFile);
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

  return new Promise<ToolRunResult>((resolve) => {
    let settled = false;
    const pushEvent = (event: ToolRunEvent) => {
      events.push(event);
      onEvent?.(event);
    };
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let terminationCheckTimer: NodeJS.Timeout | undefined;
    let terminationCheckDeadline: number | undefined;
    let childClosed = false;
    let childExitCode: number | null = null;
    let forceKillCompleted = false;
    let terminationFailure: string | undefined;
    const recordTerminationFailure = (signal: NodeJS.Signals, error: unknown) => {
      const message = `Could not terminate the Agent process tree with ${signal}: ${formatError(error)}`;
      terminationFailure = terminationFailure ? `${terminationFailure} ${message}` : message;
      pushEvent({ type: "error", message: terminationFailure, timestamp: nowIso() });
    };
    const finish = (exitCode: number | null, reason: "completed" | "failed" | "timed-out") => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (terminationCheckTimer) clearTimeout(terminationCheckTimer);
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
        summary: reason === "timed-out"
          ? terminationFailure ?? `Agent process exceeded its ${options.request.timeoutMs} ms timeout.`
          : undefined,
        failure: reason === "timed-out" ? {
          code: terminationFailure ? "process" : "timeout",
          message: terminationFailure ?? `Agent process exceeded its ${options.request.timeoutMs} ms timeout.`,
          transient: false,
          source: "error",
          exitCode,
          suggestedActions: ["Increase the timeout in Settings or review the Agent output before retrying."]
        } : undefined,
        lastMessagePath: options.lastMessagePath,
        executionMode: options.request.executionMode,
        purpose: options.request.purpose,
        events,
        durationMs: Date.now() - startedMs,
        outputTruncated,
        terminationReason: reason
      });
    };
    const finishWithUnconfirmedTermination = () => {
      const detail = process.platform === "win32"
        ? `Could not confirm the Agent process tree stopped within ${PROCESS_TREE_CONFIRMATION_MS} ms.`
        : `Could not confirm process group ${child.pid} and its output streams stopped within ${PROCESS_TREE_CONFIRMATION_MS} ms.`;
      recordTerminationFailure("SIGKILL", new Error(detail));
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(childExitCode, "timed-out");
    };
    const finishTimedOutRunWhenCleaned = () => {
      if (!timedOut) return;
      if (process.platform === "win32") {
        if (!forceKillCompleted) return;
        if (childClosed) {
          finish(childExitCode, "timed-out");
          return;
        }
        scheduleTerminationCheck();
        return;
      }
      let groupAlive = false;
      try {
        groupAlive = child.pid ? isProcessGroupAlive(child.pid) : false;
      } catch (error) {
        if (!terminationFailure) recordTerminationFailure("SIGKILL", error);
        groupAlive = true;
      }
      if (!groupAlive && childClosed) {
        finish(childExitCode, "timed-out");
        return;
      }
      if (forceKillCompleted) scheduleTerminationCheck();
    };
    const scheduleTerminationCheck = () => {
      terminationCheckDeadline ??= Date.now() + PROCESS_TREE_CONFIRMATION_MS;
      if (Date.now() >= terminationCheckDeadline) {
        finishWithUnconfirmedTermination();
        return;
      }
      if (terminationCheckTimer) return;
      terminationCheckTimer = setTimeout(() => {
        terminationCheckTimer = undefined;
        finishTimedOutRunWhenCleaned();
      }, PROCESS_TREE_CONFIRMATION_POLL_MS);
    };
    const forceKillProcessTree = () => {
      void signalProcessTree(child, "SIGKILL").then(() => {
        forceKillCompleted = true;
        finishTimedOutRunWhenCleaned();
      }).catch((error: unknown) => {
        recordTerminationFailure("SIGKILL", error);
        child.kill("SIGKILL");
        forceKillCompleted = true;
        finishTimedOutRunWhenCleaned();
      });
    };
    const maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
    pushEvent({ type: "status", status: "running", timestamp: startedAt });
    const child = spawn(invocation.commandPath, invocation.args, {
      cwd: options.request.projectPath,
      detached: process.platform !== "win32",
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: safeAgentEnvironment(process.env, options.toolId)
    });

    const readOutput = (type: "stdout" | "stderr", chunk: Buffer) => {
      if (outputTruncated) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes || events.length >= MAX_EVENTS) {
        outputTruncated = true;
        pushEvent({
          type: "error",
          message: outputBytes > maxOutputBytes
            ? `Agent output exceeded the ${maxOutputBytes} byte capture limit; remaining output was discarded.`
            : `Agent output exceeded the ${MAX_EVENTS} event capture limit; remaining output was discarded.`,
          timestamp: nowIso()
        });
        return;
      }
      pushEvent({ type, content: chunk.toString(), timestamp: nowIso() });
    };

    if (!child.stdout || !child.stderr) {
      finish(null, "failed");
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => readOutput("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => readOutput("stderr", chunk));
    child.on("error", (error: Error) => {
      pushEvent({ type: "error", message: error.message, timestamp: nowIso() });
      finish(null, "failed");
    });
    child.on("close", (code: number | null) => {
      childClosed = true;
      childExitCode = code;
      if (!timedOut) {
        finish(code, code === 0 ? "completed" : "failed");
        return;
      }
      finishTimedOutRunWhenCleaned();
    });

    if (options.request.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        const message = `Agent process timed out after ${options.request.timeoutMs} ms; terminating its process tree.`;
        pushEvent({ type: "error", message, timestamp: nowIso() });
        if (process.platform === "win32") {
          forceKillProcessTree();
          return;
        }
        void signalProcessTree(child, "SIGTERM").catch((error: unknown) => {
          recordTerminationFailure("SIGTERM", error);
          child.kill("SIGTERM");
        });
        forceTimer = setTimeout(forceKillProcessTree, TERMINATION_GRACE_MS);
        finishTimedOutRunWhenCleaned();
      }, options.request.timeoutMs);
    }

    if (options.stdin !== undefined) {
      if (!child.stdin) {
        finish(null, "failed");
        return;
      }
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

async function signalProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
    try {
      await execFileAsync("taskkill", args, {
        windowsHide: true,
        timeout: PROCESS_TREE_CONFIRMATION_MS
      });
    } catch (error) {
      throw new Error(`taskkill failed for Agent process ${child.pid}: ${formatError(error)}`, { cause: error });
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (isErrnoCode(error, "ESRCH")) return;
    throw new Error(`Could not signal Agent process group ${child.pid} with ${signal}: ${formatError(error)}`, { cause: error });
  }
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ESRCH")) return false;
    if (isErrnoCode(error, "EPERM")) return true;
    throw error;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

import type { AgentRunPolicy, ToolAdapter, ToolRunFailure, ToolRunOutputSource, ToolRunRequest, ToolRunResult } from "../../types";
import { extractProviderOutputText } from "./structured-output.service";

const DEFAULT_PLAN_POLICY: AgentRunPolicy = {
  retryCount: 2,
  retryDelayMs: 1_000,
  timeoutMs: 20 * 60 * 1000
};
const DEFAULT_EXECUTE_POLICY: AgentRunPolicy = {
  retryCount: 0,
  retryDelayMs: 0,
  timeoutMs: 60 * 60 * 1000
};

export async function executeAgentWithPolicy(
  adapter: ToolAdapter,
  request: ToolRunRequest,
  policy?: Partial<AgentRunPolicy>
): Promise<ToolRunResult> {
  const effectivePolicy = resolvePolicy(request, policy);
  return executeAttempts(adapter, request, effectivePolicy);
}

async function executeAttempts(
  adapter: ToolAdapter,
  request: ToolRunRequest,
  policy: AgentRunPolicy
): Promise<ToolRunResult> {
  let lastResult: ToolRunResult | undefined;
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + policy.timeoutMs;
  const retryEvents: ToolRunResult["events"] = [];
  for (let attempt = 1; attempt <= policy.retryCount + 1; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return timeoutResult(adapter.id, request, startedAt, policy.timeoutMs, attempt - 1, retryEvents);
    const adapterResult = await adapter.runPlan({ ...request, timeoutMs: remainingMs });
    const result = normalizeAgentResult(adapterResult);
    lastResult = { ...result, timeoutMs: policy.timeoutMs, attempts: attempt, events: [...retryEvents, ...result.events] };
    if (result.terminationReason === "timed-out" || result.status === "completed" || !isTransientFailure(result) || attempt > policy.retryCount) {
      return lastResult;
    }
    retryEvents.push({
      type: "status",
      status: "pending",
      timestamp: new Date().toISOString(),
      message: `Retrying transient Agent failure after attempt ${attempt}.`
    });
    const nextDelayMs = retryDelay(policy.retryDelayMs, attempt);
    const timeRemaining = deadline - Date.now();
    if (nextDelayMs >= timeRemaining) {
      await delay(Math.max(0, timeRemaining));
      return timeoutResult(adapter.id, request, startedAt, policy.timeoutMs, attempt, retryEvents);
    }
    await delay(nextDelayMs);
  }
  if (!lastResult) throw new Error(`Agent execution did not produce a result: ${adapter.id}`);
  return lastResult;
}

function resolvePolicy(request: ToolRunRequest, policy: Partial<AgentRunPolicy> | undefined): AgentRunPolicy {
  const defaults = request.executionMode === "execute" ? DEFAULT_EXECUTE_POLICY : DEFAULT_PLAN_POLICY;
  const resolved = { ...defaults, ...policy };
  if (!Number.isInteger(resolved.retryCount) || resolved.retryCount < 0 || resolved.retryCount > 3) {
    throw new Error(`Agent retry count must be between 0 and 3: ${resolved.retryCount}`);
  }
  if (!Number.isInteger(resolved.timeoutMs) || resolved.timeoutMs < 1 || resolved.timeoutMs > 120 * 60 * 1000) {
    throw new Error(`Agent timeout must be between 1 and 120 minutes: ${resolved.timeoutMs} ms`);
  }
  return resolved;
}

function timeoutResult(
  toolId: ToolAdapter["id"],
  request: ToolRunRequest,
  startedAt: string,
  timeoutMs: number,
  attempts: number,
  retryEvents: ToolRunResult["events"]
): ToolRunResult {
  const completedAt = new Date().toISOString();
  const message = "Agent run exceeded its total timeout, including retry delays.";
  return {
    id: request.id,
    toolId,
    status: "failed",
    projectPath: request.projectPath,
    startedAt,
    completedAt,
    executionMode: request.executionMode,
    purpose: request.purpose,
    attempts,
    durationMs: Date.now() - Date.parse(startedAt),
    timeoutMs,
    terminationReason: "timed-out",
    summary: message,
    failure: {
      code: "timeout",
      message,
      transient: false,
      source: "error",
      suggestedActions: ["Increase the timeout in Settings or review the Agent output before retrying."]
    },
    events: [
      ...retryEvents,
      { type: "error", message, timestamp: completedAt },
      { type: "status", status: "failed", timestamp: completedAt }
    ]
  };
}

function isTransientFailure(result: ToolRunResult): boolean {
  return result.failure?.transient === true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(baseDelayMs: number, attempt: number): number {
  const exponentialDelay = baseDelayMs * (2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseDelayMs / 2)));
  return exponentialDelay + jitter;
}

export function normalizeAgentResult(result: ToolRunResult): ToolRunResult {
  const outputs = collectOutputs(result);
  const preferred = outputs.find((output) => output.source === "stdout" && output.text.trim()) ??
    outputs.find((output) => output.text.trim());
  const outputText = result.outputText?.trim()
    ? result.outputText
    : preferred ? extractProviderOutputText(preferred.text) : "";
  const failure = result.terminationReason === "timed-out"
    ? result.failure ?? {
        code: "timeout" as const,
        message: result.summary ?? "Agent process timed out.",
        transient: false,
        source: "error" as const,
        exitCode: result.exitCode,
        suggestedActions: ["Increase the timeout in Settings or review the Agent output before retrying."]
      }
    : result.status === "failed"
      ? classifyFailure(result, outputs)
    : undefined;
  return {
    ...result,
    outputText,
    failure,
    summary: result.status === "failed"
      ? failure?.message ?? result.summary
      : result.summary
  };
}

function collectOutputs(result: ToolRunResult): Array<{ source: ToolRunOutputSource; text: string }> {
  const outputs: Array<{ source: ToolRunOutputSource; text: string }> = [];
  for (const event of result.events) {
    if (event.type === "stdout" || event.type === "stderr") {
      outputs.push({ source: event.type, text: event.content });
    } else if (event.type === "error") {
      outputs.push({ source: "error", text: event.message });
    }
  }
  return outputs;
}

function classifyFailure(
  result: ToolRunResult,
  outputs: Array<{ source: ToolRunOutputSource; text: string }>
): ToolRunFailure {
  const selected = selectFailureOutput(outputs);
  const message = selected
    ? extractProviderOutputText(selected.text)
    : fallbackFailureMessage(result);
  const lower = message.toLowerCase();
  const code = classifyFailureCode(message);
  return {
    code,
    message,
    transient: code === "connection" ||
      code === "provider" ||
      (code === "rate-limit" && !/(usage limit|quota|credits|billing)/i.test(message)),
    source: selected?.source ?? "error",
    exitCode: result.exitCode,
    providerDetails: lower.includes("request id") || lower.includes("sid:") ? message : undefined,
    suggestedActions: suggestedActionsForFailure(code)
  };
}

function fallbackFailureMessage(result: ToolRunResult): string {
  return `Agent process failed with exit code ${result.exitCode ?? "unknown"}.`;
}

function classifyFailureCode(message: string): ToolRunFailure["code"] {
  return classifyFailureCodeForMessage(message);
}

export function classifyFailureCodeForMessage(
  message: string
): ToolRunFailure["code"] {
  if (/(appidnoautherror|noauth|unauthori[sz]ed|authentication|invalid api key|permission denied|forbidden|oauth|credential)/i.test(message)) {
    return "authentication";
  }
  if (/(model[_ -]?not[_ -]?found|unknown model|model is not available|no available channel for model)/i.test(message)) {
    return "model-not-found";
  }
  if (/(429|rate.?limit|too many requests)/i.test(message)) return "rate-limit";
  if (/(usage limit|quota|credits|billing)/i.test(message)) return "rate-limit";
  if (/(connectionrefused|econnrefused|econnreset|etimedout|unable to connect|network unavailable|dns|socket hang up|reconnecting)/i.test(message)) {
    return "connection";
  }
  if (/(http\s*5\d\d|\b5\d\d\b|server-side issue|service unavailable|provider|temporar(?:y|ily))/i.test(message)) return "provider";
  return "process";
}

function suggestedActionsForFailure(code: ToolRunFailure["code"]): string[] {
  if (code === "authentication") {
    return [
      "Verify Claude authentication and provider gateway credentials visible to FlowWeave.",
      "If ANTHROPIC_BASE_URL points to a third-party gateway, validate that gateway app id and token."
    ];
  }
  if (code === "connection") {
    return [
      "Check network and proxy reachability from the FlowWeave desktop process.",
      "Retry after the connection recovers."
    ];
  }
  if (code === "rate-limit") {
    return [
      "Wait for rate limits to reset or switch to a model/provider with available quota.",
      "Check billing or quota when the message mentions usage limit, quota, credits, or billing."
    ];
  }
  if (code === "provider") {
    return [
      "Retry after the provider recovers.",
      "Check the configured Claude provider status and gateway logs."
    ];
  }
  if (code === "model-not-found") {
    return [
      "Choose a model available to the configured provider.",
      "Check provider routing and model alias configuration."
    ];
  }
  if (code === "invalid-output") return ["Reduce Agent output size or inspect the run log for runaway output."];
  return ["Open the run log and verify the Agent command, arguments, and environment."];
}

function selectFailureOutput(
  outputs: Array<{ source: ToolRunOutputSource; text: string }>
): { source: ToolRunOutputSource; text: string } | undefined {
  const meaningful = outputs.filter((output) => output.text.trim());
  return meaningful.find((output) => /(error|failed|refused|unauthor|noauth|429|limit|timeout|quota|forbidden)/i.test(output.text)) ??
    meaningful.find((output) => output.source === "stderr") ??
    meaningful[0];
}

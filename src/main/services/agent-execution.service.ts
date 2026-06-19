import type { AgentRunPolicy, ToolAdapter, ToolRunFailure, ToolRunOutputSource, ToolRunRequest, ToolRunResult } from "../../types";
import { extractProviderOutputText } from "./structured-output.service";

const DEFAULT_PLAN_POLICY: AgentRunPolicy = {
  timeoutMs: 300_000,
  maxOutputBytes: 4 * 1024 * 1024,
  retryCount: 2,
  retryDelayMs: 1_000
};
const DEFAULT_EXECUTE_POLICY: AgentRunPolicy = {
  timeoutMs: 600_000,
  maxOutputBytes: 8 * 1024 * 1024,
  retryCount: 0,
  retryDelayMs: 0
};
const MAX_CONCURRENT_READS_PER_PROJECT = 2;
const MAX_QUEUED_READS_PER_PROJECT = 8;
const activeWrites = new Set<string>();
const activeReads = new Map<string, number>();
const queuedReads = new Map<string, Array<() => void>>();

export async function executeAgentWithPolicy(
  adapter: ToolAdapter,
  request: ToolRunRequest,
  policy?: Partial<AgentRunPolicy>
): Promise<ToolRunResult> {
  const effectivePolicy = resolvePolicy(request, policy);
  if (request.executionMode === "execute" && activeWrites.has(request.projectPath)) {
    throw new Error(`Another Agent write execution is already running for project: ${request.projectPath}`);
  }
  if (request.executionMode === "execute") {
    activeWrites.add(request.projectPath);
  } else {
    await acquireReadExecutionSlot(request);
  }
  try {
    return await executeAttempts(adapter, request, effectivePolicy);
  } finally {
    if (request.executionMode === "execute") {
      activeWrites.delete(request.projectPath);
    } else {
      releaseReadExecutionSlot(request.projectPath);
    }
  }
}

export function resetAgentExecutionStateForTests(): void {
  activeWrites.clear();
  activeReads.clear();
  queuedReads.clear();
}

async function acquireReadExecutionSlot(request: ToolRunRequest): Promise<void> {
  if (tryAcquireReadExecutionSlot(request.projectPath)) return;
  const queue = queuedReads.get(request.projectPath) ?? [];
  if (queue.length >= MAX_QUEUED_READS_PER_PROJECT) {
    throw new Error(`Agent read execution queue is full for project: ${request.projectPath}`);
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const releaseListener = () => {
      if (settled) return;
      settled = true;
      request.signal?.removeEventListener("abort", abortListener);
      resolve();
    };
    const abortListener = () => {
      if (settled) return;
      settled = true;
      removeQueuedRead(request.projectPath, releaseListener);
      reject(new Error(`Agent read execution was canceled while waiting for project: ${request.projectPath}`));
    };
    queue.push(releaseListener);
    queuedReads.set(request.projectPath, queue);
    if (request.signal?.aborted) abortListener();
    else request.signal?.addEventListener("abort", abortListener, { once: true });
  });
}

function tryAcquireReadExecutionSlot(projectPath: string): boolean {
  const readCount = activeReads.get(projectPath) ?? 0;
  if (readCount >= MAX_CONCURRENT_READS_PER_PROJECT) return false;
  activeReads.set(projectPath, readCount + 1);
  return true;
}

function releaseReadExecutionSlot(projectPath: string): void {
  const remaining = (activeReads.get(projectPath) ?? 1) - 1;
  if (remaining === 0) activeReads.delete(projectPath);
  else activeReads.set(projectPath, remaining);
  drainQueuedReads(projectPath);
}

function drainQueuedReads(projectPath: string): void {
  const queue = queuedReads.get(projectPath);
  if (!queue) return;
  while (queue.length > 0 && tryAcquireReadExecutionSlot(projectPath)) {
    const next = queue.shift();
    next?.();
  }
  if (queue.length === 0) queuedReads.delete(projectPath);
}

function removeQueuedRead(projectPath: string, listener: () => void): void {
  const queue = queuedReads.get(projectPath);
  if (!queue) return;
  const index = queue.indexOf(listener);
  if (index >= 0) queue.splice(index, 1);
  if (queue.length === 0) queuedReads.delete(projectPath);
}

async function executeAttempts(
  adapter: ToolAdapter,
  request: ToolRunRequest,
  policy: AgentRunPolicy
): Promise<ToolRunResult> {
  let lastResult: ToolRunResult | undefined;
  const retryEvents: ToolRunResult["events"] = [];
  for (let attempt = 1; attempt <= policy.retryCount + 1; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), policy.timeoutMs);
    const relayAbort = () => controller.abort(request.signal?.reason ?? "canceled");
    if (request.signal?.aborted) relayAbort();
    request.signal?.addEventListener("abort", relayAbort, { once: true });
    try {
      const adapterResult = await adapter.runPlan({
        ...request,
        signal: controller.signal,
        maxOutputBytes: policy.maxOutputBytes
      });
      const result = normalizeAgentResult(adapterResult);
      lastResult = { ...result, attempts: attempt, events: [...retryEvents, ...result.events] };
      if (result.status === "completed" || !isTransientFailure(result) || attempt > policy.retryCount) {
        return lastResult;
      }
      retryEvents.push({
        type: "status",
        status: "pending",
        timestamp: new Date().toISOString(),
        message: `Retrying transient Agent failure after attempt ${attempt}.`
      });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", relayAbort);
    }
    await delay(retryDelay(policy.retryDelayMs, attempt));
  }
  if (!lastResult) throw new Error(`Agent execution did not produce a result: ${adapter.id}`);
  return lastResult;
}

function resolvePolicy(request: ToolRunRequest, policy: Partial<AgentRunPolicy> | undefined): AgentRunPolicy {
  const defaults = request.executionMode === "execute" ? DEFAULT_EXECUTE_POLICY : DEFAULT_PLAN_POLICY;
  const resolved = { ...defaults, ...policy };
  if (!Number.isInteger(resolved.timeoutMs) || resolved.timeoutMs < 100) {
    throw new Error(`Agent timeout must be an integer of at least 100ms: ${resolved.timeoutMs}`);
  }
  if (!Number.isInteger(resolved.maxOutputBytes) || resolved.maxOutputBytes < 1024) {
    throw new Error(`Agent output limit must be an integer of at least 1024 bytes: ${resolved.maxOutputBytes}`);
  }
  if (!Number.isInteger(resolved.retryCount) || resolved.retryCount < 0 || resolved.retryCount > 3) {
    throw new Error(`Agent retry count must be between 0 and 3: ${resolved.retryCount}`);
  }
  return resolved;
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
  const outputText = preferred ? extractProviderOutputText(preferred.text) : "";
  const failure = result.status === "failed"
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
  const code = classifyFailureCode(message, result.terminationReason);
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
  if (result.terminationReason === "timeout") {
    return `Agent run timed out after ${formatDuration(result.durationMs)}.`;
  }
  if (result.terminationReason === "canceled") {
    return "Agent run was canceled.";
  }
  if (result.exitCode === 143) {
    return "Agent process was terminated with SIGTERM (exit code 143). Check the plan timeout setting and any external process manager.";
  }
  return `Agent process failed with exit code ${result.exitCode ?? "unknown"}.`;
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "the configured timeout";
  if (durationMs >= 60_000) return `${Math.round(durationMs / 60_000)} minutes`;
  return `${durationMs}ms`;
}

function classifyFailureCode(
  message: string,
  terminationReason: ToolRunResult["terminationReason"]
): ToolRunFailure["code"] {
  if (terminationReason === "timeout") return "timeout";
  if (/exit code 143|sigterm/i.test(message)) return "timeout";
  if (/(appidnoautherror|noauth|unauthori[sz]ed|authentication|invalid api key|permission denied|forbidden|oauth|credential)/i.test(message)) {
    return "authentication";
  }
  if (/(429|rate.?limit|too many requests)/i.test(message)) return "rate-limit";
  if (/(usage limit|quota|credits|billing)/i.test(message)) return "rate-limit";
  if (/(connectionrefused|econnrefused|econnreset|etimedout|unable to connect|network unavailable|dns|socket hang up)/i.test(message)) {
    return "connection";
  }
  if (/(http\s*5\d\d|\b5\d\d\b|server-side issue|service unavailable|provider|temporar(?:y|ily))/i.test(message)) return "provider";
  if (terminationReason === "output-limit") return "invalid-output";
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
  if (code === "timeout") return ["Increase the plan timeout or retry with a smaller prompt."];
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

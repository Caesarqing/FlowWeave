import type { AgentRunPolicy, ToolAdapter, ToolRunFailure, ToolRunOutputSource, ToolRunRequest, ToolRunResult } from "../../types";
import { extractProviderOutputText } from "./structured-output.service";

const DEFAULT_PLAN_POLICY: AgentRunPolicy = {
  timeoutMs: 120_000,
  maxOutputBytes: 4 * 1024 * 1024,
  retryCount: 1,
  retryDelayMs: 800
};
const DEFAULT_EXECUTE_POLICY: AgentRunPolicy = {
  timeoutMs: 600_000,
  maxOutputBytes: 8 * 1024 * 1024,
  retryCount: 0,
  retryDelayMs: 0
};
const MAX_CONCURRENT_READS_PER_PROJECT = 2;
const activeWrites = new Set<string>();
const activeReads = new Map<string, number>();

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
    const readCount = activeReads.get(request.projectPath) ?? 0;
    if (readCount >= MAX_CONCURRENT_READS_PER_PROJECT) {
      throw new Error(`Agent read execution limit reached for project: ${request.projectPath}`);
    }
    activeReads.set(request.projectPath, readCount + 1);
  }
  try {
    return await executeAttempts(adapter, request, effectivePolicy);
  } finally {
    if (request.executionMode === "execute") {
      activeWrites.delete(request.projectPath);
    } else {
      const remaining = (activeReads.get(request.projectPath) ?? 1) - 1;
      if (remaining === 0) activeReads.delete(request.projectPath);
      else activeReads.set(request.projectPath, remaining);
    }
  }
}

export function resetAgentExecutionStateForTests(): void {
  activeWrites.clear();
  activeReads.clear();
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
    await delay(policy.retryDelayMs * attempt);
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
    : `Agent process failed with exit code ${result.exitCode ?? "unknown"}.`;
  const lower = message.toLowerCase();
  const code = result.terminationReason === "timeout"
    ? "timeout"
    : /(noauth|unauthori[sz]ed|authentication|invalid api key|permission denied|forbidden|oauth|credential)/i.test(message)
      ? "authentication"
      : /(429|rate.?limit|usage limit|quota|too many requests)/i.test(message)
        ? "rate-limit"
        : /(connectionrefused|econnrefused|econnreset|etimedout|unable to connect|network unavailable|dns|socket hang up)/i.test(message)
          ? "connection"
          : /(http\s*5\d\d|server-side issue|service unavailable|provider|temporar(?:y|ily))/i.test(message)
            ? "provider"
            : result.terminationReason === "output-limit"
              ? "invalid-output"
              : "process";
  return {
    code,
    message,
    transient: code === "connection" ||
      code === "provider" ||
      (code === "rate-limit" && !/(usage limit|quota|credits|billing)/i.test(message)),
    source: selected?.source ?? "error",
    exitCode: result.exitCode,
    providerDetails: lower.includes("request id") || lower.includes("sid:") ? message : undefined
  };
}

function selectFailureOutput(
  outputs: Array<{ source: ToolRunOutputSource; text: string }>
): { source: ToolRunOutputSource; text: string } | undefined {
  const meaningful = outputs.filter((output) => output.text.trim());
  return meaningful.find((output) => /(error|failed|refused|unauthor|noauth|429|limit|timeout|quota|forbidden)/i.test(output.text)) ??
    meaningful.find((output) => output.source === "stderr") ??
    meaningful[0];
}

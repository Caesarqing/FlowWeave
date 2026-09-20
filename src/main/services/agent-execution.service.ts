import type { AgentRunPolicy, ToolAdapter, ToolRunFailure, ToolRunOutputSource, ToolRunRequest, ToolRunResult } from "../../types";
import { extractProviderOutputText } from "./structured-output.service";

const DEFAULT_PLAN_POLICY: AgentRunPolicy = {
  retryCount: 2,
  retryDelayMs: 1_000
};
const DEFAULT_EXECUTE_POLICY: AgentRunPolicy = {
  retryCount: 0,
  retryDelayMs: 0
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
  const retryEvents: ToolRunResult["events"] = [];
  for (let attempt = 1; attempt <= policy.retryCount + 1; attempt += 1) {
    const adapterResult = await adapter.runPlan(request);
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
    await delay(retryDelay(policy.retryDelayMs, attempt));
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
  const outputText = result.outputText?.trim()
    ? result.outputText
    : preferred ? extractProviderOutputText(preferred.text) : "";
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

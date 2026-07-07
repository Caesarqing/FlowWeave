import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentDefinition, AgentReadinessResult, AgentId, ArtifactRunTarget, CustomAgentInput, ExecutionMode, RuntimeAgentId, ToolAdapter, ToolDetectionResult, ToolId, ToolOpenResult, ToolRunPurpose, ToolRunResult } from "../../types";
import { ClaudeCodeAdapter } from "../agents/claude-code.adapter";
import { CodexLocalAdapter } from "../agents/codex-local.adapter";
import { CursorAdapter } from "../agents/cursor.adapter";
import { ClaudeDesktopAdapter, CodexDesktopAdapter } from "../agents/desktop-bridge.adapter";
import { GeminiCliAdapter } from "../agents/gemini-cli.adapter";
import { MockAgentAdapter } from "../agents/mock.adapter";
import { deleteCustomAgent, getAgentAdapter as getRegistryAgentAdapter, isBuiltInAgentId, listAgentDefinitions, saveCustomAgent } from "./agent-registry.service";
import { createCheckpoint } from "./git.service";
import { prepareRunPaths, serializeAgentEvents, writeRunResult } from "./run-log.service";
import { resolveProjectPath } from "./project-registry.service";
import { executeAgentWithPolicy } from "./agent-execution.service";
import { redactSensitiveText } from "./sensitive-data.service";
import { writeTextAtomic } from "../storage/artifact-store";
import { recordDiagnostic } from "./diagnostic.service";
import { checkAgentReadiness } from "./agent-readiness.service";

export type StartToolPlanOptions = {
  projectId: string;
  toolId: RuntimeAgentId;
  prompt: string;
  guidancePath?: string;
  executionMode: ExecutionMode;
  purpose: ToolRunPurpose;
  artifactTarget?: ArtifactRunTarget;
  scanFingerprint?: string;
  reviewId?: string;
  model?: string;
  confirmedExecute?: boolean;
  executeTimeoutMs?: number;
  planTimeoutMs?: number;
  signal?: AbortSignal;
};

export type StartToolPlanResult = ToolRunResult & {
  executionMode: ExecutionMode;
};

const adapters: Record<ToolId, ToolAdapter> = {
  "claude-code": new ClaudeCodeAdapter(),
  "claude-desktop": new ClaudeDesktopAdapter(),
  "codex-local": new CodexLocalAdapter(),
  "codex-desktop": new CodexDesktopAdapter(),
  "gemini-cli": new GeminiCliAdapter(),
  cursor: new CursorAdapter(),
  mock: new MockAgentAdapter()
};

export async function startToolPlan(options: StartToolPlanOptions): Promise<StartToolPlanResult> {
  const projectPath = resolveProjectPath(options.projectId);
  const runId = `run-${Date.now()}`;
  const paths = await prepareRunPaths(projectPath, runId);
  const prompt = redactSensitiveText(buildRunPrompt(await resolvePrompt(options), options.executionMode, options.purpose));

  await writeTextAtomic(paths.promptPath, prompt);

  const adapter = await getAgentAdapter(options.toolId);
  const executionMode = options.executionMode;
  if (executionMode === "execute" && options.confirmedExecute !== true) {
    throw new Error("Execute mode requires explicit user confirmation.");
  }
  const agentReadiness = await checkAgentReadiness(adapter, {
    agentId: options.toolId,
    projectId: options.projectId,
    projectPath,
    refreshConnection: true,
    runModelProbe: false
  });
  if (agentReadiness.severity === "error") {
    const failed = await writePreflightFailureRun({
      adapter,
      agentReadiness,
      executionMode,
      options,
      paths,
      projectPath
    });
    await recordAgentRunFailure(projectPath, failed);
    return failed;
  }
  const checkpointId = executionMode === "execute" ? await createCheckpoint(projectPath) : undefined;
  const result = await executeAgentWithPolicy(adapter, {
    id: runId,
    projectId: options.projectId,
    projectPath,
    prompt,
    guidancePath: options.guidancePath,
    executionMode,
    purpose: options.purpose,
    artifactTarget: options.artifactTarget,
    scanFingerprint: options.scanFingerprint,
    reviewId: options.reviewId,
    model: options.model,
    signal: options.signal
  }, resolveRunPolicyOverride(executionMode, options));

  const logText = redactSensitiveText(serializeAgentEvents(result.events));
  const planText = await resolvePlanText(result, logText);
  await Promise.all([
    writeTextAtomic(paths.logPath, logText),
    writeTextAtomic(paths.planPath, planText)
  ]);

  const finalResult: StartToolPlanResult = {
    ...result,
    projectId: options.projectId,
    promptPath: paths.promptPath,
    planPath: result.planPath ?? paths.planPath,
    logPath: paths.logPath,
    resultPath: paths.resultPath,
    executionMode,
    purpose: options.purpose,
    artifactTarget: options.artifactTarget,
    scanFingerprint: options.scanFingerprint,
    reviewId: options.reviewId,
    artifactAdoption: options.purpose === "artifact-analysis"
      ? {
          status: "pending",
          message: result.status === "pending"
            ? `Waiting for ${adapter.name} response for ${runId}.`
            : "Artifact response has not been applied yet."
        }
      : { status: "not-applicable", message: "Run is not an artifact-analysis run." },
    agentReadiness,
    checkpointId,
    summary: result.failure?.message ?? result.summary ?? firstUsefulLine(planText),
    stderr: result.failure?.message ?? collectStderr(result.events)
  };

  await writeRunResult(paths.resultPath, finalResult, {});
  if (finalResult.status === "failed") {
    await recordAgentRunFailure(projectPath, finalResult);
  }
  return finalResult;
}

export async function recordAgentRunFailure(projectPath: string, result: ToolRunResult): Promise<void> {
  const errorMessage = result.events
    .filter((event) => event.type === "stderr" || event.type === "error")
    .map((event) => event.type === "error" ? event.message : event.content)
    .filter(Boolean)
    .join("\n");
  await recordDiagnostic(projectPath, {
    category: "agent",
    code: `agent-${result.terminationReason ?? "failed"}`,
    message: errorMessage || result.summary || "Agent run failed without an error message.",
    context: {
      runId: result.id,
      agentId: result.toolId,
      executionMode: result.executionMode,
      purpose: result.purpose,
      terminationReason: result.terminationReason,
      attempts: result.attempts ?? 1,
      outputTruncated: result.outputTruncated ?? false
    }
  });
}

async function writePreflightFailureRun({
  adapter,
  agentReadiness,
  executionMode,
  options,
  paths,
  projectPath
}: {
  adapter: ToolAdapter;
  agentReadiness: AgentReadinessResult;
  executionMode: ExecutionMode;
  options: StartToolPlanOptions;
  paths: Awaited<ReturnType<typeof prepareRunPaths>>;
  projectPath: string;
}): Promise<StartToolPlanResult> {
  const timestamp = new Date().toISOString();
  const failedMessages = agentReadiness.checks
    .filter((check) => check.status === "failed")
    .map((check) => `${check.label}: ${check.message}`);
  const message = failedMessages[0] ?? "Agent preflight failed.";
  const events: ToolRunResult["events"] = [
    { type: "error", message, timestamp },
    { type: "status", status: "failed", timestamp }
  ];
  const result: StartToolPlanResult = {
    id: basename(paths.runDir),
    projectId: options.projectId,
    toolId: options.toolId,
    status: "failed",
    projectPath,
    startedAt: timestamp,
    completedAt: timestamp,
    exitCode: 1,
    promptPath: paths.promptPath,
    planPath: paths.planPath,
    logPath: paths.logPath,
    resultPath: paths.resultPath,
    summary: message,
    stderr: message,
    failure: {
      code: "process",
      message,
      transient: false,
      source: "error",
      exitCode: 1,
      suggestedActions: agentReadiness.suggestedActions
    },
    events,
    executionMode,
    purpose: options.purpose,
    artifactTarget: options.artifactTarget,
    scanFingerprint: options.scanFingerprint,
    reviewId: options.reviewId,
    artifactAdoption: options.purpose === "artifact-analysis"
      ? { status: "rejected", message }
      : { status: "not-applicable", message: "Run is not an artifact-analysis run." },
    agentReadiness,
    terminationReason: "failed"
  };
  const logText = redactSensitiveText(serializeAgentEvents(events));
  const planText = fallbackPlan({ ...result, toolId: adapter.id }, logText);
  await Promise.all([
    writeTextAtomic(paths.logPath, logText),
    writeTextAtomic(paths.planPath, planText),
    writeRunResult(paths.resultPath, result, {})
  ]);
  return result;
}

export function buildRunPrompt(prompt: string, executionMode: ExecutionMode, purpose: ToolRunPurpose) {
  if (executionMode === "execute" || purpose === "artifact-analysis") return prompt;
  return `${prompt}

Dry run only: inspect the request and return an implementation plan, affected files, risks, and tests. Do not edit files.`;
}

export async function detectTool(toolId: ToolId): Promise<ToolDetectionResult> {
  return adapters[toolId].detect();
}

export async function detectAgent(agentId: RuntimeAgentId): Promise<ToolDetectionResult> {
  return (await getAgentAdapter(agentId)).detect();
}

export async function healthCheckAgent(agentId: RuntimeAgentId, projectId?: string): Promise<AgentReadinessResult> {
  const adapter = await getAgentAdapter(agentId);
  const projectPath = projectId ? resolveProjectPath(projectId) : undefined;
  return checkAgentReadiness(adapter, {
    agentId,
    projectId,
    projectPath,
    refreshConnection: false,
    runModelProbe: true
  });
}

export function getToolAdapter(toolId: ToolId): ToolAdapter {
  return adapters[toolId];
}

export function getAgentAdapter(agentId: RuntimeAgentId): Promise<ToolAdapter> {
  if (agentId === "mock" || isBuiltInAgentId(agentId)) {
    return Promise.resolve(adapters[agentId]);
  }
  return getRegistryAgentAdapter(agentId);
}

export async function openToolProject(agentId: RuntimeAgentId, projectPath: string): Promise<ToolOpenResult> {
  const adapter = await getAgentAdapter(agentId);
  if (!adapter.openProject) {
    return {
      toolId: agentId,
      opened: false,
      method: "none",
      message: `${adapter.name} does not support opening projects from FlowWeave.`
    };
  }

  return adapter.openProject(projectPath);
}

export function listAgents(): Promise<AgentDefinition[]> {
  return listAgentDefinitions();
}

export function saveAgent(input: CustomAgentInput): Promise<AgentDefinition> {
  return saveCustomAgent(input);
}

export function deleteAgent(agentId: AgentId): Promise<void> {
  return deleteCustomAgent(agentId);
}

async function resolvePrompt(options: StartToolPlanOptions) {
  if (options.prompt.trim()) {
    return options.prompt;
  }

  if (options.guidancePath) {
    const guidance = await readFile(options.guidancePath, "utf8");
    return `Use this FlowWeave guidance file (${basename(options.guidancePath)}) to produce an implementation plan.\n\n${guidance}`;
  }

  throw new Error("FlowWeave run prompt is required.");
}

async function resolvePlanText(result: ToolRunResult, logText: string) {
  if (result.planPath) {
    return readFile(result.planPath, "utf8").catch(() => fallbackPlan(result, logText));
  }

  if (result.lastMessagePath) {
    const lastMessage = await readFile(result.lastMessagePath, "utf8").catch(() => "");
    if (lastMessage.trim()) {
      return lastMessage;
    }
  }

  if (result.outputText?.trim()) {
    return result.outputText;
  }

  return fallbackPlan(result, logText);
}

function fallbackPlan(result: ToolRunResult, logText: string) {
  return `# Tool Plan

Tool: ${result.toolId}
Status: ${result.status}

${result.summary ?? "Review the tool log for details."}

## Tool Output

${logText}
`;
}

function collectStderr(events: ToolRunResult["events"]) {
  const stderr = events
    .filter((event) => event.type === "stderr")
    .map((event) => event.content.trim())
    .filter(Boolean)
    .join("\n");
  return stderr || undefined;
}

function resolveRunPolicyOverride(
  executionMode: ExecutionMode,
  options: StartToolPlanOptions
) {
  if (executionMode === "execute" && options.executeTimeoutMs !== undefined) {
    return { timeoutMs: options.executeTimeoutMs };
  }
  if (executionMode === "plan" && options.planTimeoutMs !== undefined) {
    return { timeoutMs: options.planTimeoutMs };
  }
  return undefined;
}

function firstUsefulLine(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
}

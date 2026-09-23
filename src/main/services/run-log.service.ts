import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExecutionMode, RuntimeAgentId, ToolRunArtifact, ToolRunEvent, ToolRunPurpose, ToolRunResult, ToolRunStatus, ToolRunSummary } from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { writeJsonAtomic, writeTextAtomic } from "../storage/artifact-store";
import { adoptArtifactRun } from "./artifact-run-adoption.service";
import { markArchitectureReviewFailedIfCurrent } from "./architecture-review.service";
import { writeSequenceReviewStatus } from "./sequence-review.service";
import { readAgentInboxResponseForRun } from "./agent-inbox.service";

const runLocks = new Map<string, Promise<void>>();

export type RunPaths = {
  runDir: string;
  promptPath: string;
  planPath: string;
  logPath: string;
  resultPath: string;
};

export async function prepareRunPaths(projectPath: string, runId: string): Promise<RunPaths> {
  const runDir = join(projectPath, FLOWWEAVE_DIR, "runs", runId);
  await mkdir(runDir, { recursive: true });

  return {
    runDir,
    promptPath: join(runDir, "prompt.md"),
    planPath: join(runDir, "plan.md"),
    logPath: join(runDir, "agent.log"),
    resultPath: join(runDir, "result.json")
  };
}

export function serializeAgentEvents(events: ToolRunEvent[]) {
  return events
    .map((event) => {
      if (event.type === "status") {
        return `[${event.timestamp}] status ${event.status}${event.message ? ` ${event.message}` : ""}`;
      }

      if (event.type === "error") {
        return `[${event.timestamp}] error ${event.message}`;
      }

      return `[${event.timestamp}] ${event.type}\n${event.content.trimEnd()}`;
    })
    .join("\n\n");
}

export async function writeRunResult(resultPath: string, result: ToolRunResult, extra: Record<string, unknown>) {
  await writeJsonAtomic(resultPath, { ...result, ...extra });
}

export async function listRunSummaries(projectPath: string): Promise<ToolRunSummary[]> {
  const runsDir = join(projectPath, FLOWWEAVE_DIR, "runs");
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isSafeRunId(entry.name))
      .map((entry) => readRunSummary(projectPath, entry.name))
  );

  return summaries
    .filter((summary): summary is ToolRunSummary => Boolean(summary))
    .sort((a, b) => sortableTime(b.startedAt) - sortableTime(a.startedAt));
}

export async function readRunArtifact(projectPath: string, runId: string): Promise<ToolRunArtifact> {
  assertSafeRunId(runId);
  return withRunLock(projectPath, runId, async () => {
    const summary = await readRunSummaryUnlocked(projectPath, runId);
    if (!summary) {
      throw new Error(`FlowWeave run not found: ${runId}`);
    }

    const runDir = getRunDir(projectPath, runId);
    const [prompt, plan, log, result] = await Promise.all([
      readFixedRunFile(runDir, "prompt.md"),
      readFixedRunFile(runDir, "plan.md"),
      readFixedRunFile(runDir, "agent.log"),
      readFixedRunFile(runDir, "result.json")
    ]);

    return { summary, prompt, plan, log, result };
  });
}

export async function applyRunArtifact(projectPath: string, runId: string): Promise<ToolRunSummary> {
  assertSafeRunId(runId);
  await withRunLock(projectPath, runId, async () => {
    const runDir = getRunDir(projectPath, runId);
    const resultText = await readFixedRunFile(runDir, "result.json");
    if (!resultText.trim()) throw new Error(`FlowWeave run not found: ${runId}`);
    const result = JSON.parse(resultText) as Partial<ToolRunResult>;
    const output = await readFixedRunFile(runDir, "plan.md");
    const adoption = await adoptArtifactRun(projectPath, result, output, "manual");
    await writeJsonAtomic(join(runDir, "result.json"), { ...result, artifactAdoption: adoption });
  });
  const summary = await readRunSummary(projectPath, runId);
  if (!summary) throw new Error(`FlowWeave run not found after applying artifact: ${runId}`);
  return summary;
}

export async function updateRunArtifactAdoption(
  projectPath: string,
  runId: string,
  artifactAdoption: NonNullable<ToolRunResult["artifactAdoption"]>
): Promise<void> {
  assertSafeRunId(runId);
  await withRunLock(projectPath, runId, async () => {
    const runDir = getRunDir(projectPath, runId);
    const resultText = await readFixedRunFile(runDir, "result.json");
    if (!resultText.trim()) return;
    const result = JSON.parse(resultText) as Partial<ToolRunResult>;
    await writeJsonAtomic(join(runDir, "result.json"), { ...result, artifactAdoption });
  });
}

async function readRunSummary(projectPath: string, runId: string): Promise<ToolRunSummary | undefined> {
  assertSafeRunId(runId);
  return withRunLock(projectPath, runId, () => readRunSummaryUnlocked(projectPath, runId));
}

async function readRunSummaryUnlocked(projectPath: string, runId: string): Promise<ToolRunSummary | undefined> {
  try {
    const result = await refreshPendingAgentInboxRunUnlocked(projectPath, runId);
    return result ? toRunSummary(runId, result) : undefined;
  } catch {
    return undefined;
  }
}

export async function expirePendingAgentInboxRun(projectPath: string, runId: string): Promise<void> {
  assertSafeRunId(runId);
  await withRunLock(projectPath, runId, async () => {
    await refreshPendingAgentInboxRunUnlocked(projectPath, runId);
  });
}

export async function importPendingAgentInboxRun(
  projectPath: string,
  runId: string,
  result: Partial<ToolRunResult>
): Promise<Partial<ToolRunResult>> {
  assertSafeRunId(runId);
  return withRunLock(projectPath, runId, async () => {
    const updated = await refreshPendingAgentInboxRunUnlocked(projectPath, runId);
    return updated ?? result;
  });
}

async function refreshPendingAgentInboxRunUnlocked(
  projectPath: string,
  runId: string
): Promise<Partial<ToolRunResult> | undefined> {
  const runDir = getRunDir(projectPath, runId);
  const resultText = await readFixedRunFile(runDir, "result.json");
  if (!resultText.trim()) return undefined;
  const result = JSON.parse(resultText) as Partial<ToolRunResult>;
  if (result.status !== "pending") return result;

  let response;
  try {
    response = await readAgentInboxResponseForRun(projectPath, runId, result);
  } catch (error) {
    return rejectPendingAgentInboxRun(projectPath, runId, result, error);
  }
  const deadline = pendingRunDeadline(result);
  const responseIsLate = Boolean(response && deadline !== undefined && Date.parse(response.completedAt) > deadline);
  if (response && !responseIsLate) {
    return importAgentInboxResponse(projectPath, runId, result, response);
  }
  if (!responseIsLate && (deadline === undefined || Date.now() <= deadline)) return result;

  const timeoutResult = createTimedOutRunResult(runId, result);
  const artifactAdoption = rejectedAdoptionForFailedImport(timeoutResult, timeoutResult.summary ?? "Agent Inbox run timed out.");
  const timedOut = { ...timeoutResult, artifactAdoption };
  await reconcileImportedArtifactReview(projectPath, runId, timedOut, artifactAdoption);

  const latestResultText = await readFixedRunFile(runDir, "result.json");
  const latestResult = latestResultText.trim()
    ? JSON.parse(latestResultText) as Partial<ToolRunResult>
    : undefined;
  if (latestResult && latestResult.status !== "pending") return latestResult;

  // A response can be published while review state is being reconciled. Recheck
  // it immediately before committing timeout so a valid on-time response wins arbitration.
  let latestResponse;
  try {
    latestResponse = await readAgentInboxResponseForRun(projectPath, runId, result);
  } catch (error) {
    return rejectPendingAgentInboxRun(projectPath, runId, result, error);
  }
  if (latestResponse && deadline !== undefined && Date.parse(latestResponse.completedAt) <= deadline) {
    return importAgentInboxResponse(projectPath, runId, result, latestResponse);
  }
  await writeJsonAtomic(join(runDir, "result.json"), timedOut);
  return timedOut;
}

async function importAgentInboxResponse(
  projectPath: string,
  runId: string,
  result: Partial<ToolRunResult>,
  response: Awaited<ReturnType<typeof readAgentInboxResponseForRun>> & {}
): Promise<Partial<ToolRunResult>> {
  const completedAt = response.completedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(completedAt))) {
    throw new Error(`Agent Inbox response completedAt is invalid for run ${runId}.`);
  }
  const runDir = getRunDir(projectPath, runId);
  const updated: Partial<ToolRunResult> = {
    ...result,
    status: response.status,
    completedAt,
    exitCode: response.status === "completed" ? 0 : 1,
    summary: response.status === "failed" ? response.error?.message ?? response.summary : response.summary
  };
  const adoption = response.status === "completed"
    ? await adoptArtifactRun(projectPath, updated, response.content, "auto").catch((error) => ({
        status: "rejected" as const,
        message: formatError(error)
      }))
    : rejectedAdoptionForFailedImport(updated, response.error?.message ?? response.summary);
  await reconcileImportedArtifactReview(projectPath, runId, updated, adoption);
  await Promise.all([
    writeTextAtomic(join(runDir, "plan.md"), response.content),
    writeJsonAtomic(join(runDir, "result.json"), { ...updated, artifactAdoption: adoption })
  ]);
  return { ...updated, artifactAdoption: adoption };
}

async function rejectPendingAgentInboxRun(
  projectPath: string,
  runId: string,
  result: Partial<ToolRunResult>,
  error: unknown
): Promise<Partial<ToolRunResult>> {
  const completedAt = new Date().toISOString();
  const message = formatError(error);
  const artifactAdoption = rejectedAdoptionForFailedImport(result, message);
  const rejected: Partial<ToolRunResult> = {
    ...result,
    status: "failed",
    completedAt,
    exitCode: 1,
    summary: `Agent Inbox response rejected: ${message}`,
    artifactAdoption
  };
  await reconcileImportedArtifactReview(projectPath, runId, rejected, artifactAdoption);
  await writeJsonAtomic(join(getRunDir(projectPath, runId), "result.json"), rejected);
  return rejected;
}

function createTimedOutRunResult(runId: string, result: Partial<ToolRunResult>): Partial<ToolRunResult> {
  const message = `Agent Inbox run ${runId} exceeded its ${result.timeoutMs} ms timeout.`;
  return {
    ...result,
    status: "failed",
    completedAt: new Date().toISOString(),
    exitCode: 1,
    summary: message,
    failure: {
      code: "timeout",
      message,
      transient: false,
      source: "error",
      suggestedActions: ["Increase the timeout in Settings or review the Agent output before retrying."]
    },
    terminationReason: "timed-out"
  };
}

function pendingRunDeadline(result: Partial<ToolRunResult>): number | undefined {
  if (!Number.isFinite(result.timeoutMs) || !result.startedAt) return undefined;
  const startedAt = Date.parse(result.startedAt);
  if (Number.isNaN(startedAt)) return undefined;
  return startedAt + Number(result.timeoutMs);
}

function toRunSummary(runId: string, result: Partial<ToolRunResult>): ToolRunSummary {
  return {
    id: result.id ?? runId,
    toolId: isRuntimeAgentId(result.toolId) ? result.toolId : "mock",
    status: isToolRunStatus(result.status) ? result.status : "failed",
    executionMode: isExecutionMode(result.executionMode) ? result.executionMode : "plan",
    purpose: isPurpose(result.purpose) ? result.purpose : "implementation-plan",
    startedAt: result.startedAt ?? "",
    completedAt: result.completedAt ?? result.startedAt ?? "",
    summary: result.summary,
    promptPath: result.promptPath,
    planPath: result.planPath,
    logPath: result.logPath,
    resultPath: result.resultPath,
    checkpointId: result.checkpointId,
    artifactTarget: result.artifactTarget,
    scanFingerprint: result.scanFingerprint,
    inputFingerprint: result.inputFingerprint,
    reviewId: result.reviewId,
    artifactAdoption: result.artifactAdoption,
    agentReadiness: result.agentReadiness,
    failure: result.failure
  };
}

async function withRunLock<T>(projectPath: string, runId: string, action: () => Promise<T>): Promise<T> {
  const key = `${resolve(projectPath)}\0${runId}`;
  const previous = runLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  runLocks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (runLocks.get(key) === current) runLocks.delete(key);
  }
}

function rejectedAdoptionForFailedImport(
  result: Partial<ToolRunResult>,
  message: string
): ToolRunResult["artifactAdoption"] {
  if (result.purpose !== "artifact-analysis") {
    return result.artifactAdoption ?? { status: "not-applicable", message: "Run is not an artifact-analysis run." };
  }
  return { status: "rejected", message };
}

async function reconcileImportedArtifactReview(
  projectPath: string,
  runId: string,
  result: Partial<ToolRunResult>,
  adoption: ToolRunResult["artifactAdoption"]
): Promise<void> {
  if (result.purpose !== "artifact-analysis") return;
  if (adoption?.status !== "rejected") return;
  if (result.artifactTarget === "architecture-map") {
    if (!result.projectId || !result.reviewId || !result.scanFingerprint || !result.inputFingerprint || !result.toolId) return;
    await markArchitectureReviewFailedIfCurrent(projectPath, {
      projectId: result.projectId,
      artifactTarget: "architecture-map",
      reviewId: result.reviewId,
      scanFingerprint: result.scanFingerprint,
      inputFingerprint: result.inputFingerprint,
      agentId: result.toolId,
      runId
    }, {
      code: "invalid-output",
      message: adoption.message
    });
    return;
  }
  if (result.artifactTarget !== "sequence-diagrams" && result.artifactTarget !== "sequence-revision") return;
  const status = {
    state: "review-failed" as const,
    reviewId: result.reviewId,
    scanFingerprint: result.scanFingerprint,
    agentId: result.toolId,
    runId,
    completedAt: new Date().toISOString(),
    error: {
      code: adoption.status === "rejected" ? "invalid-output" as const : "agent-failed" as const,
      message: adoption.message
    }
  };
  if (result.artifactTarget === "sequence-diagrams" || result.artifactTarget === "sequence-revision") {
    await writeSequenceReviewStatus(projectPath, status);
  }
}

function getRunDir(projectPath: string, runId: string) {
  return join(projectPath, FLOWWEAVE_DIR, "runs", runId);
}

function readFixedRunFile(runDir: string, filename: "prompt.md" | "plan.md" | "agent.log" | "result.json") {
  return readFile(join(runDir, filename), "utf8").catch(() => "");
}

function assertSafeRunId(runId: string) {
  if (!isSafeRunId(runId)) {
    throw new Error("Invalid FlowWeave run id.");
  }
}

function isSafeRunId(runId: string) {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(runId) && !runId.includes("..");
}

function isRuntimeAgentId(value: unknown): value is RuntimeAgentId {
  return (
    value === "claude-code" ||
    value === "claude-desktop" ||
    value === "codex-local" ||
    value === "codex-desktop" ||
    value === "gemini-cli" ||
    value === "cursor" ||
    value === "mock" ||
    (typeof value === "string" && value.startsWith("custom:"))
  );
}

function isToolRunStatus(value: unknown): value is ToolRunStatus {
  return value === "pending" || value === "running" || value === "completed" || value === "failed";
}

function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === "plan" || value === "execute";
}

function isPurpose(value: unknown): value is ToolRunPurpose {
  return value === "implementation-plan" || value === "artifact-analysis";
}

function sortableTime(value: string) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

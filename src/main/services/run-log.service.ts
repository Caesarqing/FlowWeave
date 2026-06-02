import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionMode, RuntimeAgentId, ToolRunArtifact, ToolRunEvent, ToolRunResult, ToolRunStatus, ToolRunSummary } from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

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
        return `[${event.timestamp}] status ${event.status}`;
      }

      if (event.type === "error") {
        return `[${event.timestamp}] error ${event.message}`;
      }

      return `[${event.timestamp}] ${event.type}\n${event.content.trimEnd()}`;
    })
    .join("\n\n");
}

export async function writeRunResult(resultPath: string, result: ToolRunResult, extra: Record<string, unknown>) {
  await writeFile(resultPath, `${JSON.stringify({ ...result, ...extra }, null, 2)}\n`, "utf8");
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
  const summary = await readRunSummary(projectPath, runId);
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
}

async function readRunSummary(projectPath: string, runId: string): Promise<ToolRunSummary | undefined> {
  assertSafeRunId(runId);
  const resultText = await readFixedRunFile(getRunDir(projectPath, runId), "result.json").catch(() => "");
  if (!resultText.trim()) return undefined;

  try {
    const result = JSON.parse(resultText) as Partial<ToolRunResult>;
    return {
      id: result.id ?? runId,
      toolId: isRuntimeAgentId(result.toolId) ? result.toolId : "mock",
      status: isToolRunStatus(result.status) ? result.status : "failed",
      executionMode: isExecutionMode(result.executionMode) ? result.executionMode : "plan",
      startedAt: result.startedAt ?? "",
      completedAt: result.completedAt ?? result.startedAt ?? "",
      summary: result.summary,
      promptPath: result.promptPath,
      planPath: result.planPath,
      logPath: result.logPath,
      resultPath: result.resultPath,
      checkpointId: result.checkpointId
    };
  } catch {
    return undefined;
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
  return value === "codex-local" || value === "claude-code" || value === "cursor" || value === "mock" || (typeof value === "string" && value.startsWith("custom:"));
}

function isToolRunStatus(value: unknown): value is ToolRunStatus {
  return value === "pending" || value === "running" || value === "completed" || value === "failed";
}

function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === "plan" || value === "execute";
}

function sortableTime(value: string) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

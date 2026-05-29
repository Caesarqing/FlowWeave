import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ExecutionMode, ToolAdapter, ToolDetectionResult, ToolId, ToolOpenResult, ToolRunResult } from "../../types";
import { ClaudeCodeAdapter } from "../agents/claude-code.adapter";
import { CodexLocalAdapter } from "../agents/codex-local.adapter";
import { CursorAdapter } from "../agents/cursor.adapter";
import { MockAgentAdapter } from "../agents/mock.adapter";
import { createCheckpoint } from "./git.service";
import { prepareRunPaths, serializeAgentEvents, writeRunResult } from "./run-log.service";

export type StartToolPlanOptions = {
  projectPath: string;
  toolId: ToolId;
  prompt?: string;
  guidancePath?: string;
  executionMode?: ExecutionMode;
  model?: string;
};

export type StartToolPlanResult = ToolRunResult & {
  executionMode: ExecutionMode;
};

const adapters: Record<ToolId, ToolAdapter> = {
  "codex-local": new CodexLocalAdapter(),
  "claude-code": new ClaudeCodeAdapter(),
  cursor: new CursorAdapter(),
  mock: new MockAgentAdapter()
};

export async function startToolPlan(options: StartToolPlanOptions): Promise<StartToolPlanResult> {
  const runId = `run-${Date.now()}`;
  const paths = await prepareRunPaths(options.projectPath, runId);
  const prompt = await resolvePrompt(options);

  await writeFile(paths.promptPath, prompt, "utf8");

  const adapter = adapters[options.toolId];
  const executionMode = options.executionMode ?? "plan";
  const checkpointId = executionMode === "execute" ? await createCheckpoint(options.projectPath) : undefined;
  const result = await adapter.runPlan({
    id: runId,
    projectPath: options.projectPath,
    prompt,
    guidancePath: options.guidancePath,
    executionMode,
    model: options.model
  });

  const logText = serializeAgentEvents(result.events);
  const planText = await resolvePlanText(result, logText);
  await Promise.all([writeFile(paths.logPath, logText, "utf8"), writeFile(paths.planPath, planText, "utf8")]);

  const finalResult: StartToolPlanResult = {
    ...result,
    promptPath: paths.promptPath,
    planPath: result.planPath ?? paths.planPath,
    logPath: paths.logPath,
    resultPath: paths.resultPath,
    executionMode,
    checkpointId,
    summary: result.summary ?? firstUsefulLine(planText),
    stderr: collectStderr(result.events)
  };

  await writeRunResult(paths.resultPath, finalResult, {});
  return finalResult;
}

export async function detectTool(toolId: ToolId): Promise<ToolDetectionResult> {
  return adapters[toolId].detect();
}

export function getToolAdapter(toolId: ToolId): ToolAdapter {
  return adapters[toolId];
}

export async function openToolProject(toolId: ToolId, projectPath: string): Promise<ToolOpenResult> {
  const adapter = adapters[toolId];
  if (!adapter.openProject) {
    return {
      toolId,
      opened: false,
      method: "none",
      message: `${adapter.name} does not support opening projects from FlowWeave.`
    };
  }

  return adapter.openProject(projectPath);
}

async function resolvePrompt(options: StartToolPlanOptions) {
  if (options.prompt?.trim()) {
    return options.prompt;
  }

  if (options.guidancePath) {
    const guidance = await readFile(options.guidancePath, "utf8");
    return `Use this FlowWeave guidance file (${basename(options.guidancePath)}) to produce an implementation plan.\n\n${guidance}`;
  }

  return "Inspect the FlowWeave task context and produce an implementation plan.";
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

function firstUsefulLine(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
}

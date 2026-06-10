import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentDefinition, AgentId, CustomAgentInput, ExecutionMode, RuntimeAgentId, ToolAdapter, ToolDetectionResult, ToolId, ToolOpenResult, ToolRunPurpose, ToolRunResult } from "../../types";
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

export type StartToolPlanOptions = {
  projectId: string;
  toolId: RuntimeAgentId;
  prompt: string;
  guidancePath?: string;
  executionMode: ExecutionMode;
  purpose: ToolRunPurpose;
  model?: string;
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
  const prompt = buildRunPrompt(await resolvePrompt(options), options.executionMode, options.purpose);

  await writeFile(paths.promptPath, prompt, "utf8");

  const adapter = await getAgentAdapter(options.toolId);
  const executionMode = options.executionMode;
  const checkpointId = executionMode === "execute" ? await createCheckpoint(projectPath) : undefined;
  const result = await adapter.runPlan({
    id: runId,
    projectId: options.projectId,
    projectPath,
    prompt,
    guidancePath: options.guidancePath,
    executionMode,
    purpose: options.purpose,
    model: options.model
  });

  const logText = serializeAgentEvents(result.events);
  const planText = await resolvePlanText(result, logText);
  await Promise.all([writeFile(paths.logPath, logText, "utf8"), writeFile(paths.planPath, planText, "utf8")]);

  const finalResult: StartToolPlanResult = {
    ...result,
    projectId: options.projectId,
    promptPath: paths.promptPath,
    planPath: result.planPath ?? paths.planPath,
    logPath: paths.logPath,
    resultPath: paths.resultPath,
    executionMode,
    purpose: options.purpose,
    checkpointId,
    summary: result.summary ?? firstUsefulLine(planText),
    stderr: collectStderr(result.events)
  };

  await writeRunResult(paths.resultPath, finalResult, {});
  return finalResult;
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

export function getToolAdapter(toolId: ToolId): ToolAdapter {
  return adapters[toolId];
}

export function getAgentAdapter(agentId: RuntimeAgentId): Promise<ToolAdapter> {
  if (agentId === "mock" || isBuiltInAgentId(agentId)) {
    return Promise.resolve(adapters[agentId]);
  }
  return getRegistryAgentAdapter(agentId);
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

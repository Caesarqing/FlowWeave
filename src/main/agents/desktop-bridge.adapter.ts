import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BuiltInAgentId, ExecutionMode } from "../../types";
import type { ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult, ToolRunStatus } from "./agent-adapter";
import { resolveAppPath } from "./agent-command";
import { nowIso } from "./time";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

const execFileAsync = promisify(execFile);
const BRIDGE_TIMEOUT_MS = 120_000;
const BRIDGE_POLL_INTERVAL_MS = 250;

export type DesktopBridgeConfig = {
  id: Extract<BuiltInAgentId, "claude-desktop" | "codex-desktop">;
  name: string;
  appPath: string;
  responseTimeoutMs: number;
  pollIntervalMs: number;
};

type DesktopBridgeSkillReference = {
  name: string;
  kind: "project" | "prompt" | "instructions" | "skill-root" | "plugin-root";
  path: string;
  description: string;
};

type DesktopBridgeRequest = {
  runId: string;
  agentId: DesktopBridgeConfig["id"];
  projectPath: string;
  executionMode: ExecutionMode;
  promptPath: string;
  instructionsPath: string;
  skills: DesktopBridgeSkillReference[];
  createdAt: string;
};

type DesktopBridgeResponse = {
  status: Extract<ToolRunStatus, "completed" | "failed">;
  summary: string;
  plan: string;
  sourcePath: string;
};

export class DesktopBridgeAdapter implements ToolAdapter {
  id: DesktopBridgeConfig["id"];
  name: string;
  kind = "desktop" as const;
  private appPath: string;
  private responseTimeoutMs: number;
  private pollIntervalMs: number;

  constructor(config: DesktopBridgeConfig) {
    this.id = config.id;
    this.name = config.name;
    this.appPath = config.appPath;
    this.responseTimeoutMs = config.responseTimeoutMs;
    this.pollIntervalMs = config.pollIntervalMs;
  }

  async detect() {
    const appPath = await resolveAppPath(this.appPath);
    return {
      toolId: this.id,
      available: Boolean(appPath),
      method: appPath ? ("app" as const) : ("none" as const),
      appPath,
      message: appPath ? `${this.name} app detected.` : `${this.name} app was not found at ${this.appPath}.`
    };
  }

  async openProject(projectPath: string) {
    const detection = await this.detect();
    if (!detection.available || !detection.appPath) {
      return {
        toolId: this.id,
        opened: false,
        method: "none" as const,
        message: detection.message
      };
    }

    await execFileAsync("open", buildDesktopAppOpenArgs(detection.appPath, projectPath));
    return {
      toolId: this.id,
      opened: true,
      method: "app" as const,
      message: `Opened ${this.name}. Desktop bridge requests are written under ${FLOWWEAVE_DIR}/agent-bridge.`
    };
  }

  async runPlan(request: ToolRunRequest, onEvent?: (event: ToolRunEvent) => void): Promise<ToolRunResult> {
    const startedAt = nowIso();
    const events: ToolRunEvent[] = [];
    const bridgeDir = getDesktopBridgeDir(request.projectPath, request.id);
    const runPlanPath = join(request.projectPath, FLOWWEAVE_DIR, "runs", request.id, "plan.md");
    const promptPath = join(bridgeDir, "prompt.md");
    const instructionsPath = join(bridgeDir, "instructions.md");
    const requestPath = join(bridgeDir, "request.json");

    const pushEvent = (event: ToolRunEvent) => {
      events.push(event);
      onEvent?.(event);
    };

    pushEvent({ type: "status", status: "running", timestamp: startedAt });
    await access(join(request.projectPath, FLOWWEAVE_DIR, "runs", request.id));
    await mkdir(bridgeDir, { recursive: true });
    await writeFile(promptPath, request.prompt, "utf8");
    await writeFile(instructionsPath, buildDesktopBridgeInstructions(this.name, request.executionMode), "utf8");
    await writeFile(
      requestPath,
      `${JSON.stringify(buildDesktopBridgeRequest({ request, agentId: this.id, promptPath, instructionsPath }), null, 2)}\n`,
      "utf8"
    );

    const detection = await this.detect();
    if (detection.available) {
      await this.openProject(request.projectPath)
        .then(() => {
          pushEvent({ type: "stdout", content: `${this.name} opened. Waiting for bridge response in ${bridgeDir}.`, timestamp: nowIso() });
        })
        .catch((error: Error) => {
          pushEvent({ type: "stderr", content: `Failed to open ${this.name}: ${error.message}`, timestamp: nowIso() });
        });
    } else {
      pushEvent({ type: "stderr", content: detection.message ?? `${this.name} app is not available.`, timestamp: nowIso() });
    }

    const response = await waitForDesktopBridgeResponse(bridgeDir, this.responseTimeoutMs, this.pollIntervalMs);
    if (response) {
      await writeFile(runPlanPath, response.plan, "utf8");
      const completedAt = nowIso();
      pushEvent({ type: "stdout", content: `Bridge response loaded from ${response.sourcePath}.`, timestamp: completedAt });
      pushEvent({ type: "status", status: response.status, timestamp: completedAt });
      return {
        id: request.id,
        toolId: this.id,
        status: response.status,
        projectPath: request.projectPath,
        startedAt,
        completedAt,
        exitCode: response.status === "completed" ? 0 : 1,
        planPath: runPlanPath,
        executionMode: request.executionMode,
        summary: response.summary,
        events
      };
    }

    const completedAt = nowIso();
    const timeoutPlan = buildDesktopBridgeTimeoutPlan({
      agentName: this.name,
      bridgeDir,
      requestPath,
      promptPath,
      instructionsPath,
      detectionMessage: detection.message ?? ""
    });
    await writeFile(runPlanPath, timeoutPlan, "utf8");
    pushEvent({ type: "error", message: `${this.name} bridge timed out after ${this.responseTimeoutMs}ms.`, timestamp: completedAt });
    pushEvent({ type: "status", status: "failed", timestamp: completedAt });
    return {
      id: request.id,
      toolId: this.id,
      status: "failed",
      projectPath: request.projectPath,
      startedAt,
      completedAt,
      exitCode: 1,
      planPath: runPlanPath,
      executionMode: request.executionMode,
      summary: `${this.name} bridge timed out. Request files remain in ${bridgeDir}.`,
      events
    };
  }
}

export class ClaudeDesktopAdapter extends DesktopBridgeAdapter {
  constructor() {
    super({
      id: "claude-desktop",
      name: "Claude Desktop",
      appPath: "/Applications/Claude.app",
      responseTimeoutMs: resolveDesktopBridgeTimeoutMs(),
      pollIntervalMs: resolveDesktopBridgePollIntervalMs()
    });
  }
}

export class CodexDesktopAdapter extends DesktopBridgeAdapter {
  constructor() {
    super({
      id: "codex-desktop",
      name: "Codex Desktop",
      appPath: "/Applications/Codex.app",
      responseTimeoutMs: resolveDesktopBridgeTimeoutMs(),
      pollIntervalMs: resolveDesktopBridgePollIntervalMs()
    });
  }
}

export function buildDesktopAppOpenArgs(appPath: string, projectPath: string) {
  return ["-a", appPath, projectPath];
}

export function getDesktopBridgeDir(projectPath: string, runId: string) {
  return join(projectPath, FLOWWEAVE_DIR, "agent-bridge", runId);
}

export function buildDesktopBridgeInstructions(agentName: string, executionMode: ExecutionMode) {
  return `# FlowWeave Desktop Bridge Instructions

Agent: ${agentName}
Execution mode: ${executionMode}

Read request.json and prompt.md from this directory.
Inspect the project at the request projectPath.
Write one response file in the same directory:

- response.json with { "status": "completed" | "failed", "summary": string, "plan": string }
- or response.md with the plan markdown

Prefer response.json when possible. In plan mode, do not modify project files.`;
}

export function buildDesktopBridgeRequest({
  request,
  agentId,
  promptPath,
  instructionsPath
}: {
  request: ToolRunRequest;
  agentId: DesktopBridgeConfig["id"];
  promptPath: string;
  instructionsPath: string;
}): DesktopBridgeRequest {
  return {
    runId: request.id,
    agentId,
    projectPath: request.projectPath,
    executionMode: request.executionMode,
    promptPath,
    instructionsPath,
    skills: buildDesktopBridgeSkillReferences(request.projectPath, promptPath, instructionsPath),
    createdAt: nowIso()
  };
}

export async function waitForDesktopBridgeResponse(bridgeDir: string, timeoutMs: number, pollIntervalMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const response = await readDesktopBridgeResponse(bridgeDir);
    if (response) return response;
    await delay(pollIntervalMs);
  }
  return undefined;
}

export async function readDesktopBridgeResponse(bridgeDir: string): Promise<DesktopBridgeResponse | undefined> {
  const jsonPath = join(bridgeDir, "response.json");
  const jsonContent = await readFile(jsonPath, "utf8").catch(() => "");
  if (jsonContent.trim()) {
    const parsed = JSON.parse(jsonContent) as Partial<DesktopBridgeResponse>;
    if (parsed.status !== "completed" && parsed.status !== "failed") {
      throw new Error(`Invalid desktop bridge response status in ${jsonPath}.`);
    }
    if (!parsed.plan?.trim()) {
      throw new Error(`Desktop bridge response plan is required in ${jsonPath}.`);
    }
    return {
      status: parsed.status,
      summary: parsed.summary?.trim() || `${parsed.status} desktop bridge response.`,
      plan: parsed.plan,
      sourcePath: jsonPath
    };
  }

  const markdownPath = join(bridgeDir, "response.md");
  const markdown = await readFile(markdownPath, "utf8").catch(() => "");
  if (markdown.trim()) {
    return {
      status: "completed",
      summary: "Desktop bridge response loaded from response.md.",
      plan: markdown,
      sourcePath: markdownPath
    };
  }

  return undefined;
}

function buildDesktopBridgeSkillReferences(projectPath: string, promptPath: string, instructionsPath: string): DesktopBridgeSkillReference[] {
  return [
    {
      name: "FlowWeave project context",
      kind: "project",
      path: projectPath,
      description: "Local project root that the desktop agent should inspect."
    },
    {
      name: "Current FlowWeave prompt",
      kind: "prompt",
      path: promptPath,
      description: "Prompt generated by FlowWeave for this run."
    },
    {
      name: "Desktop bridge instructions",
      kind: "instructions",
      path: instructionsPath,
      description: "Response protocol and execution mode rules."
    },
    {
      name: "Codex skills root",
      kind: "skill-root",
      path: join(process.env.HOME ?? "", ".codex", "skills"),
      description: "Optional local Codex skill directory reference. Content is not copied by FlowWeave."
    },
    {
      name: "Codex plugin cache",
      kind: "plugin-root",
      path: join(process.env.HOME ?? "", ".codex", "plugins"),
      description: "Optional local Codex plugin directory reference. Content is not copied by FlowWeave."
    }
  ];
}

function buildDesktopBridgeTimeoutPlan({
  agentName,
  bridgeDir,
  requestPath,
  promptPath,
  instructionsPath,
  detectionMessage
}: {
  agentName: string;
  bridgeDir: string;
  requestPath: string;
  promptPath: string;
  instructionsPath: string;
  detectionMessage: string;
}) {
  return `# ${agentName} Desktop Bridge Pending

FlowWeave wrote a desktop bridge request but did not receive response.json or response.md before the timeout.

## Bridge Files

- Bridge directory: ${bridgeDir}
- Request: ${requestPath}
- Prompt: ${promptPath}
- Instructions: ${instructionsPath}

## Detection

${detectionMessage}

To complete this run manually, have the desktop agent read request.json and prompt.md, then write response.json or response.md in the bridge directory.`;
}

function resolveDesktopBridgeTimeoutMs() {
  return readPositiveIntegerEnv("FLOWWEAVE_AGENT_BRIDGE_TIMEOUT_MS", BRIDGE_TIMEOUT_MS);
}

function resolveDesktopBridgePollIntervalMs() {
  return readPositiveIntegerEnv("FLOWWEAVE_AGENT_BRIDGE_POLL_INTERVAL_MS", BRIDGE_POLL_INTERVAL_MS);
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

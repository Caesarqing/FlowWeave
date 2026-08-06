import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentExpectedContentKind, AgentProtocolVersion, ArtifactRunTarget, ExecutionMode, RuntimeAgentId } from "../../types";
import type { ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult, ToolRunStatus } from "./agent-adapter";
import { resolveAppPathFromCandidates } from "./agent-command";
import { nowIso } from "./time";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { addDesktopBridgePendingRequest } from "../services/desktop-bridge-manifest.service";
import {
  AGENT_PROTOCOL_VERSION,
  buildDesktopBridgeResponseInstructions,
  expectedContentKindForPurpose,
  FLOWWEAVE_PLUGIN_ID,
  parseBridgeResponse
} from "../services/agent-protocol.service";

const execFileAsync = promisify(execFile);
export type DesktopBridgeConfig = {
  id: RuntimeAgentId;
  name: string;
  appPath: string;
  appPathCandidates?: string[];
  bridgeInstructions?: string;
};

type DesktopBridgeSkillReference = {
  name: string;
  kind: "project" | "prompt" | "instructions" | "skill-root" | "plugin-root";
  path: string;
  description: string;
};

type DesktopBridgeRequest = {
  protocolVersion: AgentProtocolVersion;
  runId: string;
  projectId: string;
  agentId: RuntimeAgentId;
  projectPath: string;
  executionMode: ExecutionMode;
  purpose: ToolRunRequest["purpose"];
  expectedContentKind: AgentExpectedContentKind;
  artifactTarget?: ArtifactRunTarget;
  scanFingerprint?: string;
  reviewId?: string;
  runDirectory: string;
  promptPath: string;
  instructionsPath: string;
  responsePath: string;
  pluginHint: string;
  skills: DesktopBridgeSkillReference[];
  createdAt: string;
};

type DesktopBridgeResponse = {
  status: Extract<ToolRunStatus, "completed" | "failed">;
  summary: string;
  content: string;
  protocolVersion?: AgentProtocolVersion;
  runId?: string;
  projectId?: string;
  artifactTarget?: ArtifactRunTarget;
  scanFingerprint?: string;
  reviewId?: string;
  completedAt?: string;
  sourcePath: string;
  warnings: string[];
};

export class DesktopBridgeAdapter implements ToolAdapter {
  id: DesktopBridgeConfig["id"];
  name: string;
  kind = "desktop" as const;
  private appPathCandidates: string[];
  private bridgeInstructions?: string;

  constructor(config: DesktopBridgeConfig) {
    this.id = config.id;
    this.name = config.name;
    this.appPathCandidates = config.appPathCandidates ?? [config.appPath];
    this.bridgeInstructions = config.bridgeInstructions;
  }

  async detect() {
    const platformSupport = desktopBridgePlatformSupport(process.platform);
    if (!platformSupport.supported) {
      return {
        toolId: this.id,
        available: false,
        method: "none" as const,
        message: platformSupport.message
      };
    }
    const appPath = await resolveAppPathFromCandidates(this.appPathCandidates);
    return {
      toolId: this.id,
      available: Boolean(appPath),
      method: appPath ? ("app" as const) : ("none" as const),
      appPath,
      message: appPath ? `${this.name} app detected.` : `${this.name} app was not found at ${this.appPathCandidates.join(", ")}.`
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
    const promptPath = join(bridgeDir, "prompt.md");
    const instructionsPath = join(bridgeDir, "instructions.md");
    const requestPath = join(bridgeDir, "request.json");
    const responsePath = join(bridgeDir, "response.json");

    const pushEvent = (event: ToolRunEvent) => {
      events.push(event);
      onEvent?.(event);
    };

    pushEvent({ type: "status", status: "running", timestamp: startedAt });
    await access(join(request.projectPath, FLOWWEAVE_DIR, "runs", request.id));
    await mkdir(bridgeDir, { recursive: true });
    await writeFile(promptPath, request.prompt, "utf8");
    await writeFile(
      instructionsPath,
      buildDesktopBridgeInstructions(this.name, request.executionMode, request.purpose, this.bridgeInstructions),
      "utf8"
    );
    const createdAt = nowIso();
    const bridgeRequest = buildDesktopBridgeRequest({
      request,
      agentId: this.id,
      bridgeDir,
      promptPath,
      instructionsPath,
      responsePath,
      createdAt
    });
    await writeFile(
      requestPath,
      `${JSON.stringify(bridgeRequest, null, 2)}\n`,
      "utf8"
    );
    await addDesktopBridgePendingRequest(request.projectPath, {
      runId: request.id,
      projectId: request.projectId,
      agentId: this.id,
      purpose: request.purpose,
      executionMode: request.executionMode,
      artifactTarget: request.artifactTarget,
      scanFingerprint: request.scanFingerprint,
      reviewId: request.reviewId,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      expectedContentKind: expectedContentKindForPurpose(request.purpose),
      pluginHint: FLOWWEAVE_PLUGIN_ID,
      createdAt,
      requestPath,
      responsePath,
      status: "pending"
    });

    const detection = await this.detect();
    if (detection.available) {
      await this.openProject(request.projectPath)
        .then(() => {
          pushEvent({
            type: "stdout",
            content: `${this.name} opened. Use FlowWeave context to process pending requests.`,
            timestamp: nowIso()
          });
        })
        .catch((error: Error) => {
          pushEvent({ type: "stderr", content: `Failed to open ${this.name}: ${error.message}`, timestamp: nowIso() });
        });
    } else {
      pushEvent({ type: "stderr", content: detection.message ?? `${this.name} app is not available.`, timestamp: nowIso() });
    }

    const completedAt = nowIso();
    pushEvent({ type: "status", status: "pending", timestamp: completedAt });
    return {
      id: request.id,
      toolId: this.id,
      status: "pending",
      projectPath: request.projectPath,
      startedAt,
      completedAt,
      exitCode: undefined,
      executionMode: request.executionMode,
      purpose: request.purpose,
      summary: detection.available
        ? `Pending ${this.name} response. Use FlowWeave context to process pending requests.`
        : `${this.name} is not installed. The pending bridge request remains available for manual processing.`,
      events
    };
  }
}

export class ClaudeDesktopAdapter extends DesktopBridgeAdapter {
  constructor() {
    super({
      id: "claude-desktop",
      name: "Claude Desktop",
      appPath: "/Applications/Claude.app"
    });
  }
}

export class CodexDesktopAdapter extends DesktopBridgeAdapter {
  constructor() {
    super({
      id: "codex-desktop",
      name: "Codex Desktop",
      appPath: "/Applications/ChatGPT.app",
      appPathCandidates: [
        "/Applications/ChatGPT.app",
        "/Applications/Codex.app"
      ]
    });
  }
}

export function getCodexDesktopAppPathCandidates(): string[] {
  return [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app"
  ];
}

export function buildDesktopAppOpenArgs(appPath: string, projectPath: string) {
  return ["-a", appPath, projectPath];
}

export function desktopBridgePlatformSupport(platform: NodeJS.Platform): {
  supported: boolean;
  message?: string;
} {
  if (platform === "darwin") return { supported: true };
  return {
    supported: false,
    message: "Desktop Agent bridge is only supported on macOS. Use the CLI integration on Windows."
  };
}

export function getDesktopBridgeDir(projectPath: string, runId: string) {
  return join(projectPath, FLOWWEAVE_DIR, "agent-bridge", runId);
}

export function buildDesktopBridgeInstructions(
  agentName: string,
  executionMode: ExecutionMode,
  purpose: ToolRunRequest["purpose"],
  extraInstructions?: string
) {
  const responseInstructions = buildDesktopBridgeResponseInstructions(purpose);
  const baseInstructions = `# FlowWeave Desktop Bridge Instructions

Agent: ${agentName}
Execution mode: ${executionMode}
Purpose: ${purpose}

Read request.json and prompt.md from this directory.
Inspect the project at the request projectPath.
Also read ../pending-requests.json. When multiple requests are pending, process them from oldest createdAt to newest createdAt.
For each request, write only to that request's responsePath in its own run directory. Do not write one request's result into another run directory.
Process only the request directory whose prompt you are answering while writing a response.
Use Agent Protocol v${AGENT_PROTOCOL_VERSION}. Copy runId and projectId exactly from request.json.

${responseInstructions}

In plan mode, do not modify project files.`;
  return extraInstructions?.trim()
    ? `${baseInstructions}\n\n## Agent-specific instructions\n\n${extraInstructions.trim()}\n`
    : baseInstructions;
}

export function buildDesktopBridgeRequest({
  request,
  agentId,
  bridgeDir,
  promptPath,
  instructionsPath,
  responsePath,
  createdAt
}: {
  request: ToolRunRequest;
  agentId: RuntimeAgentId;
  bridgeDir: string;
  promptPath: string;
  instructionsPath: string;
  responsePath: string;
  createdAt: string;
}): DesktopBridgeRequest {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    runId: request.id,
    projectId: request.projectId,
    agentId,
    projectPath: request.projectPath,
    executionMode: request.executionMode,
    purpose: request.purpose,
    expectedContentKind: expectedContentKindForPurpose(request.purpose),
    artifactTarget: request.artifactTarget,
    scanFingerprint: request.scanFingerprint,
    reviewId: request.reviewId,
    runDirectory: bridgeDir,
    promptPath,
    instructionsPath,
    responsePath,
    pluginHint: FLOWWEAVE_PLUGIN_ID,
    skills: buildDesktopBridgeSkillReferences(request.projectPath, promptPath, instructionsPath),
    createdAt
  };
}

export async function readDesktopBridgeResponse(bridgeDir: string): Promise<DesktopBridgeResponse | undefined> {
  const jsonPath = join(bridgeDir, "response.json");
  const jsonContent = await readFile(jsonPath, "utf8").catch(() => "");
  if (jsonContent.trim()) {
    const parsed = parseBridgeResponse(jsonContent, jsonPath);
    return {
      status: parsed.status,
      summary: parsed.summary,
      content: parsed.content,
      protocolVersion: parsed.protocolVersion,
      runId: parsed.runId,
      projectId: parsed.projectId,
      artifactTarget: parsed.artifactTarget,
      scanFingerprint: parsed.scanFingerprint,
      reviewId: parsed.reviewId,
      completedAt: parsed.completedAt,
      sourcePath: jsonPath,
      warnings: parsed.warnings
    };
  }

  const markdownPath = join(bridgeDir, "response.md");
  const markdown = await readFile(markdownPath, "utf8").catch(() => "");
  if (markdown.trim()) {
    return {
      status: "completed",
      summary: "Desktop bridge response loaded from response.md.",
      content: markdown,
      sourcePath: markdownPath,
      warnings: []
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
      path: join(homedir(), ".codex", "skills"),
      description: "Optional local Codex skill directory reference. Content is not copied by FlowWeave."
    },
    {
      name: "Codex plugin cache",
      kind: "plugin-root",
      path: join(homedir(), ".codex", "plugins"),
      description: "Optional local Codex plugin directory reference. Content is not copied by FlowWeave."
    }
  ];
}

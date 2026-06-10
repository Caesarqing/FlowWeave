import { ipcMain, dialog, shell, app, nativeImage, BrowserWindow } from "electron";
import { join, resolve, isAbsolute, normalize, relative, sep, basename, posix, dirname, extname } from "node:path";
import { access, writeFile, mkdir, readFile, readdir, realpath, lstat, rm, stat, rename } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import fg from "fast-glob";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const PROJECT_CHANNELS = {
  openProject: "project:open",
  scanProject: "project:scan",
  analyzeProject: "project:analyze",
  analyzeArchitecture: "project:analyze-architecture",
  analyzeArchitectureWithAgent: "project:analyze-architecture-with-agent",
  readArchitectureMap: "project:read-architecture-map",
  generateSequenceDiagrams: "project:generate-sequence-diagrams",
  reviseSequenceDiagram: "project:revise-sequence-diagram",
  readSequenceDiagrams: "project:read-sequence-diagrams",
  readFile: "project:read-file",
  saveDoc: "project:save-doc",
  readCanvas: "project:read-canvas",
  saveCanvas: "project:save-canvas",
  getAgentConnection: "project:get-agent-connection",
  enableAgentConnection: "project:enable-agent-connection",
  refreshAgentConnection: "project:refresh-agent-connection",
  disableAgentConnection: "project:disable-agent-connection",
  openAgentConnection: "project:open-agent-connection"
};
const TOOL_CHANNELS = {
  listAgents: "tool:list-agents",
  saveCustomAgent: "tool:save-custom-agent",
  deleteCustomAgent: "tool:delete-custom-agent",
  detectAgent: "tool:detect-agent",
  detect: "tool:detect",
  runPlan: "tool:run-plan",
  listRuns: "tool:list-runs",
  readRun: "tool:read-run",
  openProject: "tool:open-project"
};
const GIT_CHANNELS = {
  status: "git:status",
  diff: "git:diff",
  checkpoint: "git:checkpoint",
  rollback: "git:rollback"
};
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
const execFileAsync$4 = promisify(execFile);
const commandCandidates = {
  "claude-code": ["claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
  "claude-desktop": [],
  "codex-local": [
    "codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex"
  ],
  "codex-desktop": [],
  "gemini-cli": ["gemini", "/opt/homebrew/bin/gemini", "/usr/local/bin/gemini"],
  cursor: [
    "cursor",
    "code",
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    "/Applications/Cursor.app/Contents/Resources/app/bin/code",
    "/usr/local/bin/cursor",
    "/usr/local/bin/code",
    "/opt/homebrew/bin/cursor",
    "/opt/homebrew/bin/code"
  ],
  mock: []
};
async function resolveToolCommand(toolId) {
  if (toolId === "mock") {
    return { commandPath: "built-in", installed: true, version: "mock" };
  }
  for (const candidate of commandCandidates[toolId]) {
    const commandPath = await resolveCandidate(candidate);
    if (!commandPath) {
      continue;
    }
    const version = await execFileAsync$4(commandPath, ["--version"]).then(({ stdout }) => stdout.trim()).catch(() => void 0);
    return { commandPath, installed: true, version };
  }
  return { installed: false };
}
async function resolveAppPath(appPath) {
  return access(appPath).then(() => appPath).catch(() => void 0);
}
function buildCommandSearchPaths(homePath = homedir()) {
  return [
    join(homePath, ".local", "bin"),
    join(homePath, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/Applications/Codex.app/Contents/Resources",
    "/Applications/Claude.app/Contents/Resources",
    "/Applications/Cursor.app/Contents/Resources/app/bin"
  ];
}
async function resolveCandidate(candidate) {
  if (candidate.includes("/")) {
    return access(candidate).then(() => candidate).catch(() => void 0);
  }
  const pathMatch = await execFileAsync$4("which", [candidate]).then(({ stdout }) => stdout.trim() || void 0).catch(() => void 0);
  if (pathMatch) return pathMatch;
  const knownPathMatch = await resolveCandidateFromSearchPaths(candidate);
  if (knownPathMatch) return knownPathMatch;
  return execFileAsync$4("/bin/zsh", ["-lc", 'command -v -- "$1"', "flowweave-command-lookup", candidate]).then(({ stdout }) => stdout.trim() || void 0).catch(() => void 0);
}
async function resolveCandidateFromSearchPaths(candidate, searchPaths = buildCommandSearchPaths()) {
  for (const searchPath of searchPaths) {
    const resolved = await access(join(searchPath, candidate)).then(() => join(searchPath, candidate)).catch(() => void 0);
    if (resolved) return resolved;
  }
  return void 0;
}
class ClaudeCodeAdapter {
  id = "claude-code";
  name = "Claude Code";
  kind = "cli";
  async detect() {
    const result = await resolveToolCommand(this.id);
    return {
      toolId: this.id,
      available: result.installed,
      method: result.installed ? "cli" : "none",
      commandPath: result.commandPath,
      version: result.version,
      message: result.installed ? "Claude Code CLI detected." : "Claude Code CLI was not found in PATH or known locations."
    };
  }
  async runPlan(request, onEvent) {
    const resolvedCommand = await resolveToolCommand(this.id);
    if (!resolvedCommand.installed || !resolvedCommand.commandPath) {
      const timestamp = nowIso();
      return {
        id: request.id,
        toolId: this.id,
        status: "failed",
        projectPath: request.projectPath,
        startedAt: timestamp,
        completedAt: timestamp,
        executionMode: request.executionMode,
        purpose: request.purpose,
        events: [{ type: "error", message: "Claude Code is not installed or not available.", timestamp }]
      };
    }
    const commandPath = resolvedCommand.commandPath;
    if (request.guidancePath) {
      await access(request.guidancePath);
    }
    const startedAt = nowIso();
    const events = [];
    const prompt = request.prompt;
    const args = buildClaudeArgs(request.executionMode, request.model);
    return new Promise((resolve2) => {
      const pushEvent = (event) => {
        events.push(event);
        onEvent?.(event);
      };
      pushEvent({ type: "status", status: "running", timestamp: startedAt });
      const child = spawn(commandPath, [...args, prompt], {
        cwd: request.projectPath,
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.on("data", (chunk) => {
        pushEvent({ type: "stdout", content: chunk.toString(), timestamp: nowIso() });
      });
      child.stderr.on("data", (chunk) => {
        pushEvent({ type: "stderr", content: chunk.toString(), timestamp: nowIso() });
      });
      child.on("error", (error) => {
        const timestamp = nowIso();
        pushEvent({ type: "error", message: error.message, timestamp });
        pushEvent({ type: "status", status: "failed", timestamp });
        resolve2({
          id: request.id,
          toolId: this.id,
          status: "failed",
          projectPath: request.projectPath,
          startedAt,
          completedAt: timestamp,
          executionMode: request.executionMode,
          purpose: request.purpose,
          events
        });
      });
      child.on("close", (code) => {
        const completedAt = nowIso();
        const status = code === 0 ? "completed" : "failed";
        pushEvent({ type: "status", status, timestamp: completedAt });
        resolve2({
          id: request.id,
          toolId: this.id,
          status,
          projectPath: request.projectPath,
          startedAt,
          completedAt,
          exitCode: code,
          executionMode: request.executionMode,
          purpose: request.purpose,
          events
        });
      });
    });
  }
}
function buildClaudeArgs(executionMode, model) {
  const args = [
    "--print",
    "--permission-mode",
    executionMode === "plan" ? "plan" : "acceptEdits",
    "--output-format",
    "text",
    "--no-session-persistence"
  ];
  if (model) {
    args.push("--model", model);
  }
  return args;
}
const FLOWWEAVE_DIR = ".flowweave";
class CodexLocalAdapter {
  id = "codex-local";
  name = "Codex Local";
  kind = "cli";
  async detect() {
    const result = await resolveToolCommand(this.id);
    return {
      toolId: this.id,
      available: result.installed,
      method: result.installed ? "cli" : "none",
      commandPath: result.commandPath,
      version: result.version,
      message: result.installed ? "Codex CLI detected." : "Codex CLI was not found in PATH or known app locations."
    };
  }
  async runPlan(request, onEvent) {
    const resolvedCommand = await resolveToolCommand(this.id);
    if (!resolvedCommand.installed || !resolvedCommand.commandPath) {
      const timestamp = nowIso();
      return {
        id: request.id,
        toolId: this.id,
        status: "failed",
        projectPath: request.projectPath,
        startedAt: timestamp,
        completedAt: timestamp,
        executionMode: request.executionMode,
        purpose: request.purpose,
        events: [{ type: "error", message: "Codex CLI is not installed or not available.", timestamp }]
      };
    }
    const commandPath = resolvedCommand.commandPath;
    if (request.guidancePath) {
      await access(request.guidancePath);
    }
    const startedAt = nowIso();
    const events = [];
    const lastMessagePath = join(request.projectPath, FLOWWEAVE_DIR, "runs", request.id, "last-message.md");
    const prompt = request.prompt;
    const args = buildCodexPlanArgs({
      executionMode: request.executionMode,
      lastMessagePath,
      model: request.model,
      projectPath: request.projectPath
    });
    return new Promise((resolve2) => {
      const pushEvent = (event) => {
        events.push(event);
        onEvent?.(event);
      };
      pushEvent({ type: "status", status: "running", timestamp: startedAt });
      const child = spawn(commandPath, args, {
        cwd: request.projectPath,
        stdio: ["pipe", "pipe", "pipe"]
      });
      child.stdin.write(prompt);
      child.stdin.end();
      child.stdout.on("data", (chunk) => {
        pushEvent({ type: "stdout", content: chunk.toString(), timestamp: nowIso() });
      });
      child.stderr.on("data", (chunk) => {
        pushEvent({ type: "stderr", content: chunk.toString(), timestamp: nowIso() });
      });
      child.on("error", (error) => {
        const timestamp = nowIso();
        pushEvent({ type: "error", message: error.message, timestamp });
        pushEvent({ type: "status", status: "failed", timestamp });
        resolve2({
          id: request.id,
          toolId: this.id,
          status: "failed",
          projectPath: request.projectPath,
          startedAt,
          completedAt: timestamp,
          executionMode: request.executionMode,
          purpose: request.purpose,
          events
        });
      });
      child.on("close", (code) => {
        const completedAt = nowIso();
        const status = code === 0 ? "completed" : "failed";
        pushEvent({ type: "status", status, timestamp: completedAt });
        resolve2({
          id: request.id,
          toolId: this.id,
          status,
          projectPath: request.projectPath,
          startedAt,
          completedAt,
          exitCode: code,
          lastMessagePath,
          executionMode: request.executionMode,
          purpose: request.purpose,
          events
        });
      });
    });
  }
}
function buildCodexPlanArgs({
  executionMode,
  lastMessagePath,
  model,
  projectPath
}) {
  const args = [
    "exec",
    "--cd",
    projectPath,
    "--sandbox",
    executionMode === "plan" ? "read-only" : "workspace-write",
    "--output-last-message",
    lastMessagePath,
    "-"
  ];
  if (model) {
    args.splice(1, 0, "--model", model);
  }
  return args;
}
const execFileAsync$3 = promisify(execFile);
const CURSOR_APP_PATH = "/Applications/Cursor.app";
class CursorAdapter {
  id = "cursor";
  name = "Cursor";
  kind = "desktop";
  async detect() {
    const command = await resolveToolCommand(this.id);
    if (command.installed) {
      return {
        toolId: this.id,
        available: true,
        method: "cli",
        commandPath: command.commandPath,
        version: command.version,
        message: "Cursor CLI detected."
      };
    }
    const appPath = await resolveAppPath(CURSOR_APP_PATH);
    return {
      toolId: this.id,
      available: Boolean(appPath),
      method: appPath ? "app" : "none",
      appPath,
      message: appPath ? "Cursor.app detected." : "Cursor CLI or Cursor.app was not found."
    };
  }
  async openProject(projectPath) {
    const detection = await this.detect();
    if (!detection.available) {
      return {
        toolId: this.id,
        opened: false,
        method: "none",
        message: detection.message
      };
    }
    if (detection.commandPath) {
      await execFileAsync$3(detection.commandPath, buildCursorCliOpenArgs(projectPath));
      return {
        toolId: this.id,
        opened: true,
        method: "cli",
        message: "Opened project with Cursor CLI."
      };
    }
    if (detection.appPath) {
      await execFileAsync$3("open", buildCursorAppOpenArgs(detection.appPath, projectPath));
      return {
        toolId: this.id,
        opened: true,
        method: "app",
        message: "Opened project with Cursor.app."
      };
    }
    return {
      toolId: this.id,
      opened: false,
      method: "none",
      message: "Cursor is not available."
    };
  }
  async runPlan(request, onEvent) {
    const startedAt = nowIso();
    const planPath = join(request.projectPath, FLOWWEAVE_DIR, "runs", request.id, "plan.md");
    const detection = await this.detect();
    const events = [];
    const pushEvent = (event) => {
      events.push(event);
      onEvent?.(event);
    };
    pushEvent({ type: "status", status: "running", timestamp: startedAt });
    const plan = `# Cursor ${request.executionMode === "execute" ? "Execute" : "Plan"} Context

Cursor v1 integration writes this plan for manual review in Cursor.

## How to use

1. Open the project in Cursor.
2. Attach or paste this plan and the generated FlowWeave guidance.
3. Review Cursor's proposed edits before applying them.

## FlowWeave Prompt

${request.prompt}
`;
    await access(join(request.projectPath, FLOWWEAVE_DIR, "runs", request.id));
    await writeFile(planPath, plan, "utf8");
    if (request.executionMode === "execute" && detection.available) {
      await this.openProject(request.projectPath);
    }
    pushEvent({
      type: "stdout",
      content: detection.available ? `Cursor context plan written. ${detection.message ?? ""}` : `Cursor context plan written, but Cursor was not detected. ${detection.message ?? ""}`,
      timestamp: nowIso()
    });
    pushEvent({ type: "status", status: detection.available ? "completed" : "failed", timestamp: nowIso() });
    return {
      id: request.id,
      toolId: this.id,
      status: detection.available ? "completed" : "failed",
      projectPath: request.projectPath,
      startedAt,
      completedAt: nowIso(),
      exitCode: detection.available ? 0 : 1,
      planPath,
      executionMode: request.executionMode,
      purpose: request.purpose,
      summary: detection.available ? "Cursor plan generated. Open the project in Cursor to review." : detection.message,
      events
    };
  }
}
function buildCursorCliOpenArgs(projectPath) {
  return [projectPath];
}
function buildCursorAppOpenArgs(appPath, projectPath) {
  return ["-a", appPath, projectPath];
}
const execFileAsync$2 = promisify(execFile);
class DesktopBridgeAdapter {
  id;
  name;
  kind = "desktop";
  appPath;
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.appPath = config.appPath;
  }
  async detect() {
    const appPath = await resolveAppPath(this.appPath);
    return {
      toolId: this.id,
      available: Boolean(appPath),
      method: appPath ? "app" : "none",
      appPath,
      message: appPath ? `${this.name} app detected.` : `${this.name} app was not found at ${this.appPath}.`
    };
  }
  async openProject(projectPath) {
    const detection = await this.detect();
    if (!detection.available || !detection.appPath) {
      return {
        toolId: this.id,
        opened: false,
        method: "none",
        message: detection.message
      };
    }
    await execFileAsync$2("open", buildDesktopAppOpenArgs(detection.appPath, projectPath));
    return {
      toolId: this.id,
      opened: true,
      method: "app",
      message: `Opened ${this.name}. Desktop bridge requests are written under ${FLOWWEAVE_DIR}/agent-bridge.`
    };
  }
  async runPlan(request, onEvent) {
    const startedAt = nowIso();
    const events = [];
    const bridgeDir = getDesktopBridgeDir(request.projectPath, request.id);
    const promptPath = join(bridgeDir, "prompt.md");
    const instructionsPath = join(bridgeDir, "instructions.md");
    const requestPath = join(bridgeDir, "request.json");
    const pushEvent = (event) => {
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
      `${JSON.stringify(buildDesktopBridgeRequest({ request, agentId: this.id, promptPath, instructionsPath }), null, 2)}
`,
      "utf8"
    );
    const detection = await this.detect();
    if (detection.available) {
      await this.openProject(request.projectPath).then(() => {
        pushEvent({
          type: "stdout",
          content: `${this.name} opened. Use FlowWeave context to process the current pending request.`,
          timestamp: nowIso()
        });
      }).catch((error) => {
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
      exitCode: void 0,
      executionMode: request.executionMode,
      purpose: request.purpose,
      summary: detection.available ? `Pending ${this.name} response. Use FlowWeave context to process the current pending request.` : `${this.name} is not installed. The pending bridge request remains available for manual processing.`,
      events
    };
  }
}
class ClaudeDesktopAdapter extends DesktopBridgeAdapter {
  constructor() {
    super({
      id: "claude-desktop",
      name: "Claude Desktop",
      appPath: "/Applications/Claude.app"
    });
  }
}
class CodexDesktopAdapter extends DesktopBridgeAdapter {
  constructor() {
    super({
      id: "codex-desktop",
      name: "Codex Desktop",
      appPath: "/Applications/Codex.app"
    });
  }
}
function buildDesktopAppOpenArgs(appPath, projectPath) {
  return ["-a", appPath, projectPath];
}
function getDesktopBridgeDir(projectPath, runId) {
  return join(projectPath, FLOWWEAVE_DIR, "agent-bridge", runId);
}
function buildDesktopBridgeInstructions(agentName, executionMode) {
  return `# FlowWeave Desktop Bridge Instructions

Agent: ${agentName}
Execution mode: ${executionMode}

Read request.json and prompt.md from this directory.
Inspect the project at the request projectPath.
Write one response file in the same directory:

- response.json with { "runId": string, "projectId": string, "status": "completed" | "failed", "summary": string, "content": string, "completedAt": ISO timestamp }
- or response.md with the plan markdown

Prefer response.json when possible. In plan mode, do not modify project files.`;
}
function buildDesktopBridgeRequest({
  request,
  agentId,
  promptPath,
  instructionsPath
}) {
  return {
    runId: request.id,
    projectId: request.projectId,
    agentId,
    projectPath: request.projectPath,
    executionMode: request.executionMode,
    promptPath,
    instructionsPath,
    skills: buildDesktopBridgeSkillReferences(request.projectPath, promptPath, instructionsPath),
    createdAt: nowIso()
  };
}
async function readDesktopBridgeResponse(bridgeDir) {
  const jsonPath = join(bridgeDir, "response.json");
  const jsonContent = await readFile(jsonPath, "utf8").catch(() => "");
  if (jsonContent.trim()) {
    const parsed = JSON.parse(jsonContent);
    if (parsed.status !== "completed" && parsed.status !== "failed") {
      throw new Error(`Invalid desktop bridge response status in ${jsonPath}.`);
    }
    if (!parsed.content?.trim()) {
      throw new Error(`Desktop bridge response content is required in ${jsonPath}.`);
    }
    return {
      status: parsed.status,
      summary: parsed.summary?.trim() || `${parsed.status} desktop bridge response.`,
      content: parsed.content,
      runId: parsed.runId,
      projectId: parsed.projectId,
      completedAt: parsed.completedAt,
      sourcePath: jsonPath
    };
  }
  const markdownPath = join(bridgeDir, "response.md");
  const markdown = await readFile(markdownPath, "utf8").catch(() => "");
  if (markdown.trim()) {
    return {
      status: "completed",
      summary: "Desktop bridge response loaded from response.md.",
      content: markdown,
      sourcePath: markdownPath
    };
  }
  return void 0;
}
function buildDesktopBridgeSkillReferences(projectPath, promptPath, instructionsPath) {
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
class GeminiCliAdapter {
  id = "gemini-cli";
  name = "Gemini CLI";
  kind = "cli";
  async detect() {
    const result = await resolveToolCommand(this.id);
    return {
      toolId: this.id,
      available: result.installed,
      method: result.installed ? "cli" : "none",
      commandPath: result.commandPath,
      version: result.version,
      message: result.installed ? "Gemini CLI detected." : "Gemini CLI was not found in PATH or known locations."
    };
  }
  async runPlan(request, onEvent) {
    const resolvedCommand = await resolveToolCommand(this.id);
    if (!resolvedCommand.installed || !resolvedCommand.commandPath) {
      const timestamp = nowIso();
      return {
        id: request.id,
        toolId: this.id,
        status: "failed",
        projectPath: request.projectPath,
        startedAt: timestamp,
        completedAt: timestamp,
        executionMode: request.executionMode,
        purpose: request.purpose,
        events: [{ type: "error", message: "Gemini CLI is not installed or not available.", timestamp }]
      };
    }
    if (request.guidancePath) {
      await access(request.guidancePath);
    }
    const startedAt = nowIso();
    const events = [];
    const commandPath = resolvedCommand.commandPath;
    const prompt = request.prompt;
    return new Promise((resolve2) => {
      const pushEvent = (event) => {
        events.push(event);
        onEvent?.(event);
      };
      pushEvent({ type: "status", status: "running", timestamp: startedAt });
      const child = spawn(commandPath, buildGeminiArgs(request.executionMode, request.model), {
        cwd: request.projectPath,
        stdio: ["pipe", "pipe", "pipe"]
      });
      child.stdin.write(prompt);
      child.stdin.end();
      child.stdout.on("data", (chunk) => {
        pushEvent({ type: "stdout", content: chunk.toString(), timestamp: nowIso() });
      });
      child.stderr.on("data", (chunk) => {
        pushEvent({ type: "stderr", content: chunk.toString(), timestamp: nowIso() });
      });
      child.on("error", (error) => {
        const timestamp = nowIso();
        pushEvent({ type: "error", message: error.message, timestamp });
        pushEvent({ type: "status", status: "failed", timestamp });
        resolve2({
          id: request.id,
          toolId: this.id,
          status: "failed",
          projectPath: request.projectPath,
          startedAt,
          completedAt: timestamp,
          executionMode: request.executionMode,
          purpose: request.purpose,
          events
        });
      });
      child.on("close", (code) => {
        const completedAt = nowIso();
        const status = code === 0 ? "completed" : "failed";
        pushEvent({ type: "status", status, timestamp: completedAt });
        resolve2({
          id: request.id,
          toolId: this.id,
          status,
          projectPath: request.projectPath,
          startedAt,
          completedAt,
          exitCode: code,
          executionMode: request.executionMode,
          purpose: request.purpose,
          events
        });
      });
    });
  }
}
function buildGeminiArgs(executionMode, model) {
  const args = ["--approval-mode", executionMode === "plan" ? "plan" : "auto_edit"];
  if (model) {
    args.push("--model", model);
  }
  return args;
}
class MockAgentAdapter {
  id = "mock";
  name = "Mock Tool";
  kind = "mock";
  async detect() {
    return {
      toolId: this.id,
      available: true,
      method: "mock",
      commandPath: "built-in",
      version: "mock",
      message: "Built-in mock tool is available."
    };
  }
  async runPlan(request, onEvent) {
    const startedAt = nowIso();
    const events = [
      { type: "status", status: "running", timestamp: startedAt },
      { type: "stdout", content: `Mock plan for ${request.projectPath}`, timestamp: nowIso() },
      { type: "stdout", content: "Plan generated without file changes.", timestamp: nowIso() },
      { type: "status", status: "completed", timestamp: nowIso() }
    ];
    events.forEach((event) => onEvent?.(event));
    return {
      id: request.id,
      toolId: this.id,
      status: "completed",
      projectPath: request.projectPath,
      startedAt,
      completedAt: nowIso(),
      exitCode: 0,
      executionMode: request.executionMode,
      purpose: request.purpose,
      summary: "Mock plan generated.",
      events
    };
  }
}
class CustomCliAdapter {
  constructor(definition) {
    this.definition = definition;
    this.id = definition.id;
    this.name = definition.name;
  }
  definition;
  id;
  name;
  kind = "cli";
  async detect() {
    const commandPath = await resolveCandidate(this.definition.command);
    const version = commandPath ? await readVersion(commandPath, this.definition.args) : void 0;
    return {
      toolId: this.definition.id,
      available: Boolean(commandPath),
      method: commandPath ? "cli" : "none",
      commandPath,
      version,
      message: commandPath ? `${this.definition.name} CLI detected.` : `${this.definition.name} command was not found.`
    };
  }
  async runPlan(request, onEvent) {
    if (request.executionMode === "plan") {
      throw new Error(`Custom CLI "${this.definition.name}" does not declare a verifiable read-only Plan mode.`);
    }
    const detection = await this.detect();
    const startedAt = nowIso();
    const events = [];
    const pushEvent = (event) => {
      events.push(event);
      onEvent?.(event);
    };
    if (!detection.available || !detection.commandPath) {
      pushEvent({ type: "error", message: detection.message ?? "Custom CLI agent is not available.", timestamp: startedAt });
      pushEvent({ type: "status", status: "failed", timestamp: startedAt });
      return {
        id: request.id,
        toolId: this.definition.id,
        status: "failed",
        projectPath: request.projectPath,
        startedAt,
        completedAt: startedAt,
        executionMode: request.executionMode,
        purpose: request.purpose,
        events
      };
    }
    const commandPath = detection.commandPath;
    return new Promise((resolve2) => {
      pushEvent({ type: "status", status: "running", timestamp: startedAt });
      const child = spawn(commandPath, this.definition.args, {
        cwd: request.projectPath,
        stdio: ["pipe", "pipe", "pipe"]
      });
      child.stdin.write(request.prompt);
      child.stdin.end();
      child.stdout.on("data", (chunk) => {
        pushEvent({ type: "stdout", content: chunk.toString(), timestamp: nowIso() });
      });
      child.stderr.on("data", (chunk) => {
        pushEvent({ type: "stderr", content: chunk.toString(), timestamp: nowIso() });
      });
      child.on("error", (error) => {
        const timestamp = nowIso();
        pushEvent({ type: "error", message: error.message, timestamp });
        pushEvent({ type: "status", status: "failed", timestamp });
        resolve2({
          id: request.id,
          toolId: this.definition.id,
          status: "failed",
          projectPath: request.projectPath,
          startedAt,
          completedAt: timestamp,
          executionMode: request.executionMode,
          purpose: request.purpose,
          events
        });
      });
      child.on("close", (code) => {
        const completedAt = nowIso();
        const status = code === 0 ? "completed" : "failed";
        pushEvent({ type: "status", status, timestamp: completedAt });
        resolve2({
          id: request.id,
          toolId: this.definition.id,
          status,
          projectPath: request.projectPath,
          startedAt,
          completedAt,
          exitCode: code,
          executionMode: request.executionMode,
          purpose: request.purpose,
          events
        });
      });
    });
  }
}
async function readVersion(commandPath, args) {
  return new Promise((resolve2) => {
    const child = spawn(commandPath, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve2(void 0);
    }, 1200);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", () => {
      clearTimeout(timeout);
      resolve2(output.trim() || args.join(" ") || void 0);
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve2(void 0);
    });
  });
}
const BUILT_IN_AGENTS = [
  {
    id: "claude-code",
    name: "Claude Code CLI",
    kind: "cli",
    command: "claude",
    args: ["--print", "--permission-mode", "plan"],
    description: "调用 Claude Code 的 plan 模式输出计划，不直接修改项目文件。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    kind: "desktop",
    command: "/Applications/Claude.app",
    args: [".flowweave/agent-bridge"],
    description: "检测并打开 Claude 桌面端，通过项目内文件系统桥接请求等待桌面端回写计划。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "codex-local",
    name: "Codex CLI",
    kind: "cli",
    command: "codex",
    args: ["exec", "--sandbox", "read-only"],
    description: "调用本地 Codex CLI 读取 FlowWeave 上下文，并生成可审查的实现计划。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "codex-desktop",
    name: "Codex Desktop",
    kind: "desktop",
    command: "/Applications/Codex.app",
    args: [".flowweave/agent-bridge"],
    description: "检测并打开 Codex 桌面端，通过项目内文件系统桥接请求等待桌面端回写计划。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    kind: "cli",
    command: "gemini",
    args: [],
    description: "调用本地 Gemini CLI，通过 stdin 传入 FlowWeave prompt 并记录 stdout/stderr。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "desktop",
    command: "cursor/code <project> / Cursor.app",
    args: [],
    description: "检测 Cursor CLI 或桌面应用，生成计划文件并打开项目供用户在 Cursor 中审查执行。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  }
];
let configuredRoot;
function configureAgentRegistry(rootPath) {
  configuredRoot = rootPath;
}
async function listAgentDefinitions() {
  return [...BUILT_IN_AGENTS, ...await readCustomAgents()];
}
async function saveCustomAgent(input) {
  const name = input.name.trim();
  const command = input.command.trim();
  if (!name) throw new Error("Agent name is required.");
  if (!command) throw new Error("Agent command is required.");
  const agents = await readCustomAgents();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const id = createCustomAgentId(name, agents);
  const agent = {
    id,
    name,
    kind: "cli",
    command,
    args: input.args ?? [],
    description: input.description?.trim() || "Custom CLI Agent",
    builtIn: false,
    createdAt: now,
    updatedAt: now
  };
  await writeCustomAgents([...agents, agent]);
  return agent;
}
async function deleteCustomAgent(agentId) {
  if (!isCustomAgentId(agentId)) return;
  const agents = await readCustomAgents();
  await writeCustomAgents(agents.filter((agent) => agent.id !== agentId));
}
async function getAgentDefinition(agentId) {
  if (agentId === "mock") {
    return {
      id: "custom:mock",
      name: "Mock Agent",
      kind: "cli",
      command: "built-in",
      args: [],
      description: "Built-in mock tool for development tests.",
      builtIn: true,
      createdAt: "builtin",
      updatedAt: "builtin"
    };
  }
  return (await listAgentDefinitions()).find((agent) => agent.id === agentId);
}
async function getAgentAdapter$1(agentId) {
  if (agentId === "mock") return new MockAgentAdapter();
  if (agentId === "claude-code") return new ClaudeCodeAdapter();
  if (agentId === "claude-desktop") return new ClaudeDesktopAdapter();
  if (agentId === "codex-local") return new CodexLocalAdapter();
  if (agentId === "codex-desktop") return new CodexDesktopAdapter();
  if (agentId === "gemini-cli") return new GeminiCliAdapter();
  if (agentId === "cursor") return new CursorAdapter();
  const definition = await getAgentDefinition(agentId);
  if (!definition || definition.builtIn) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return new CustomCliAdapter(definition);
}
function isBuiltInAgentId(agentId) {
  return agentId === "claude-code" || agentId === "claude-desktop" || agentId === "codex-local" || agentId === "codex-desktop" || agentId === "gemini-cli" || agentId === "cursor";
}
function isCustomAgentId(agentId) {
  return agentId.startsWith("custom:");
}
async function readCustomAgents() {
  const content = await readFile(agentConfigPath(), "utf8").catch(() => "[]");
  try {
    const parsed = JSON.parse(content);
    return parsed.filter((agent) => isCustomAgentId(agent.id) && !agent.builtIn);
  } catch {
    return [];
  }
}
async function writeCustomAgents(agents) {
  const path = agentConfigPath();
  await mkdir(agentConfigRoot(), { recursive: true });
  await writeFile(path, `${JSON.stringify(agents, null, 2)}
`, "utf8");
}
function agentConfigPath() {
  return join(agentConfigRoot(), "agents.json");
}
function agentConfigRoot() {
  return configuredRoot ?? process.env.FLOWWEAVE_AGENT_CONFIG_DIR ?? join(homedir(), ".flowweave");
}
function createCustomAgentId(name, existing) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  const existingIds = new Set(existing.map((agent) => agent.id));
  let index = 1;
  let id = `custom:${base}`;
  while (existingIds.has(id)) {
    index += 1;
    id = `custom:${base}-${index}`;
  }
  return id;
}
const execFileAsync$1 = promisify(execFile);
async function getGitStatus(projectPath) {
  const isRepo = await isGitRepo(projectPath);
  if (!isRepo) return { isRepo: false, changedFiles: [] };
  const [{ stdout: branch }, aheadBehind, changedFiles] = await Promise.all([
    git(projectPath, ["branch", "--show-current"]),
    readAheadBehind(projectPath),
    getChangedFiles(projectPath)
  ]);
  return {
    isRepo: true,
    branch: branch.trim() || "detached",
    changedFiles,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind
  };
}
async function createCheckpoint(projectPath) {
  await assertGitRepo(projectPath);
  const checkpointId = `flowweave-${Date.now()}`;
  const { stdout, stderr } = await git(projectPath, ["stash", "push", "-u", "-m", checkpointId]);
  const output = `${stdout}
${stderr}`;
  if (/No local changes to save/i.test(output)) {
    await writeCheckpointMarker(projectPath, checkpointId, false);
    return checkpointId;
  }
  if (!await findStashRef(projectPath, checkpointId)) {
    throw new Error(`Failed to create git checkpoint: ${output.trim() || checkpointId}`);
  }
  await writeCheckpointMarker(projectPath, checkpointId, true);
  return checkpointId;
}
async function getDiff(projectPath, checkpointId) {
  const isRepo = await isGitRepo(projectPath);
  if (!isRepo) return "";
  if (checkpointId) {
    const stashRef = await findStashRef(projectPath, checkpointId);
    if (stashRef) {
      const diff = await git(projectPath, ["diff", "--unified=3", stashRef]).catch(() => ({ stdout: "", stderr: "" }));
      if (diff.stdout.trim()) return diff.stdout;
    }
  }
  const { stdout } = await git(projectPath, ["diff", "--unified=3"]);
  const { stdout: staged } = await git(projectPath, ["diff", "--cached", "--unified=3"]);
  return [stdout, staged].filter(Boolean).join("\n");
}
async function restoreCheckpoint(projectPath, checkpointId) {
  if (!/^flowweave-\d+$/.test(checkpointId)) throw new Error(`Invalid FlowWeave checkpoint id: ${checkpointId}`);
  await assertGitRepo(projectPath);
  const [stashRef, marker] = await Promise.all([findStashRef(projectPath, checkpointId), readCheckpointMarker(projectPath, checkpointId)]);
  if (!marker) {
    throw new Error(`FlowWeave checkpoint not found: ${checkpointId}`);
  }
  if (marker.checkpointId !== checkpointId || marker.projectPath !== resolve(projectPath)) {
    throw new Error(`FlowWeave checkpoint does not belong to this project: ${checkpointId}`);
  }
  if (marker.hasStash !== Boolean(stashRef)) {
    throw new Error(`FlowWeave checkpoint state is invalid: ${checkpointId}`);
  }
  await git(projectPath, ["reset", "--hard"]);
  await git(projectPath, ["clean", "-fd"]);
  if (stashRef) {
    await git(projectPath, ["stash", "pop", stashRef]);
  }
}
async function getChangedFiles(projectPath) {
  const isRepo = await isGitRepo(projectPath);
  if (!isRepo) return [];
  const [{ stdout: porcelain }, { stdout: numstat }] = await Promise.all([
    git(projectPath, ["status", "--porcelain"]),
    git(projectPath, ["diff", "--numstat", "HEAD"]).catch(() => ({ stdout: "", stderr: "" }))
  ]);
  const stats = parseNumstat(numstat);
  return porcelain.split("\n").map((line) => line.trimEnd()).filter(Boolean).map((line) => parsePorcelainLine(line, stats));
}
async function isGitRepo(projectPath) {
  return git(projectPath, ["rev-parse", "--is-inside-work-tree"]).then(({ stdout }) => stdout.trim() === "true").catch(() => false);
}
async function assertGitRepo(projectPath) {
  if (!await isGitRepo(projectPath)) {
    throw new Error("Project is not a git repository.");
  }
}
async function readAheadBehind(projectPath) {
  const upstream = await git(projectPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => void 0);
  if (!upstream?.stdout.trim()) return {};
  const { stdout } = await git(projectPath, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]).catch(() => ({ stdout: "" }));
  const [aheadText, behindText] = stdout.trim().split(/\s+/);
  return {
    ahead: Number(aheadText) || 0,
    behind: Number(behindText) || 0
  };
}
async function findStashRef(projectPath, checkpointId) {
  const { stdout } = await git(projectPath, ["stash", "list"]).catch(() => ({ stdout: "" }));
  const line = stdout.split("\n").find((item) => item.includes(checkpointId));
  return line?.match(/^stash@\{\d+\}/)?.[0];
}
async function writeCheckpointMarker(projectPath, checkpointId, hasStash) {
  const checkpointDir = join(projectPath, FLOWWEAVE_DIR, "checkpoints");
  await mkdir(checkpointDir, { recursive: true });
  await writeFile(
    join(checkpointDir, `${checkpointId}.json`),
    `${JSON.stringify({ checkpointId, projectPath: resolve(projectPath), hasStash, createdAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)}
`,
    "utf8"
  );
}
async function readCheckpointMarker(projectPath, checkpointId) {
  const checkpointPath = join(projectPath, FLOWWEAVE_DIR, "checkpoints", `${checkpointId}.json`);
  return readFile(checkpointPath, "utf8").then((content) => JSON.parse(content)).catch(() => void 0);
}
function parseNumstat(output) {
  const stats = /* @__PURE__ */ new Map();
  for (const line of output.split("\n")) {
    const [additionsText, deletionsText, path] = line.split("	");
    if (!path) continue;
    stats.set(path, {
      additions: additionsText === "-" ? 0 : Number(additionsText) || 0,
      deletions: deletionsText === "-" ? 0 : Number(deletionsText) || 0
    });
  }
  return stats;
}
function parsePorcelainLine(line, stats) {
  const code = line.slice(0, 2);
  const rawPath = line.slice(3);
  const [previousPath, currentPath] = rawPath.includes(" -> ") ? rawPath.split(" -> ") : [void 0, rawPath];
  const path = currentPath ?? rawPath;
  const stat2 = stats.get(path) ?? { additions: 0, deletions: 0 };
  return {
    path,
    previousPath,
    status: statusFromPorcelain(code),
    additions: stat2.additions,
    deletions: stat2.deletions
  };
}
function statusFromPorcelain(code) {
  if (code.includes("?")) return "untracked";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("M")) return "modified";
  return "unknown";
}
function git(projectPath, args) {
  return execFileAsync$1("git", args, {
    cwd: projectPath,
    maxBuffer: 20 * 1024 * 1024
  });
}
async function prepareRunPaths(projectPath, runId) {
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
function serializeAgentEvents(events) {
  return events.map((event) => {
    if (event.type === "status") {
      return `[${event.timestamp}] status ${event.status}`;
    }
    if (event.type === "error") {
      return `[${event.timestamp}] error ${event.message}`;
    }
    return `[${event.timestamp}] ${event.type}
${event.content.trimEnd()}`;
  }).join("\n\n");
}
async function writeRunResult(resultPath, result, extra) {
  await writeFile(resultPath, `${JSON.stringify({ ...result, ...extra }, null, 2)}
`, "utf8");
}
async function listRunSummaries(projectPath) {
  const runsDir = join(projectPath, FLOWWEAVE_DIR, "runs");
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const summaries = await Promise.all(
    entries.filter((entry) => entry.isDirectory() && isSafeRunId(entry.name)).map((entry) => readRunSummary(projectPath, entry.name))
  );
  return summaries.filter((summary) => Boolean(summary)).sort((a, b) => sortableTime(b.startedAt) - sortableTime(a.startedAt));
}
async function readRunArtifact(projectPath, runId) {
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
async function readRunSummary(projectPath, runId) {
  assertSafeRunId(runId);
  const resultText = await readFixedRunFile(getRunDir(projectPath, runId), "result.json").catch(() => "");
  if (!resultText.trim()) return void 0;
  try {
    let result = JSON.parse(resultText);
    if (result.status === "pending") {
      try {
        result = await importDesktopBridgeResponse(projectPath, runId, result);
      } catch (error) {
        const completedAt = (/* @__PURE__ */ new Date()).toISOString();
        result = {
          ...result,
          status: "failed",
          completedAt,
          exitCode: 1,
          summary: `Desktop bridge response rejected: ${formatError$2(error)}`
        };
        await writeFile(join(getRunDir(projectPath, runId), "result.json"), `${JSON.stringify(result, null, 2)}
`, "utf8");
      }
    }
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
      checkpointId: result.checkpointId
    };
  } catch {
    return void 0;
  }
}
async function importDesktopBridgeResponse(projectPath, runId, result) {
  const response = await readDesktopBridgeResponse(getDesktopBridgeDir(projectPath, runId));
  if (!response) return result;
  if (!response.sourcePath.endsWith("response.json")) {
    throw new Error(`Desktop bridge response.json is required for pending run ${runId}.`);
  }
  if (response.runId !== runId) {
    throw new Error(`Desktop bridge response runId does not match pending run ${runId}.`);
  }
  if (!result.projectId || response.projectId !== result.projectId) {
    throw new Error(`Desktop bridge response projectId does not match pending run ${runId}.`);
  }
  const completedAt = response.completedAt ?? (/* @__PURE__ */ new Date()).toISOString();
  if (Number.isNaN(Date.parse(completedAt))) {
    throw new Error(`Desktop bridge response completedAt is invalid for run ${runId}.`);
  }
  const runDir = getRunDir(projectPath, runId);
  const updated = {
    ...result,
    status: response.status,
    completedAt,
    exitCode: response.status === "completed" ? 0 : 1,
    summary: response.summary
  };
  await Promise.all([
    writeFile(join(runDir, "plan.md"), response.content, "utf8"),
    writeFile(join(runDir, "result.json"), `${JSON.stringify(updated, null, 2)}
`, "utf8")
  ]);
  return updated;
}
function getRunDir(projectPath, runId) {
  return join(projectPath, FLOWWEAVE_DIR, "runs", runId);
}
function readFixedRunFile(runDir, filename) {
  return readFile(join(runDir, filename), "utf8").catch(() => "");
}
function assertSafeRunId(runId) {
  if (!isSafeRunId(runId)) {
    throw new Error("Invalid FlowWeave run id.");
  }
}
function isSafeRunId(runId) {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(runId) && !runId.includes("..");
}
function isRuntimeAgentId(value) {
  return value === "claude-code" || value === "claude-desktop" || value === "codex-local" || value === "codex-desktop" || value === "gemini-cli" || value === "cursor" || value === "mock" || typeof value === "string" && value.startsWith("custom:");
}
function isToolRunStatus(value) {
  return value === "pending" || value === "running" || value === "completed" || value === "failed";
}
function isExecutionMode(value) {
  return value === "plan" || value === "execute";
}
function isPurpose(value) {
  return value === "implementation-plan" || value === "artifact-analysis";
}
function sortableTime(value) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}
function formatError$2(error) {
  return error instanceof Error ? error.message : String(error);
}
const PROJECT_ID_PATTERN = /^project-[a-f0-9-]{36}$/;
const projects = /* @__PURE__ */ new Map();
async function registerProject(projectPath) {
  if (!isAbsolute(projectPath)) {
    throw new Error(`Project path must be absolute: "${projectPath}".`);
  }
  const canonicalPath = await realpath(projectPath);
  const existing = [...projects.entries()].find(([, path]) => path === canonicalPath);
  if (existing) return existing[0];
  const projectId = `project-${randomUUID()}`;
  projects.set(projectId, canonicalPath);
  return projectId;
}
function resolveProjectPath(projectId) {
  assertProjectId(projectId);
  const projectPath = projects.get(projectId);
  if (!projectPath) {
    throw new Error(`Project is not authorized in this FlowWeave session: "${projectId}".`);
  }
  return projectPath;
}
async function resolveProjectFile(projectId, filePath) {
  const projectPath = resolveProjectPath(projectId);
  if (!filePath || isAbsolute(filePath) || filePath.split(/[\\/]/).includes("..")) {
    throw new Error(`Project file path must be a relative path inside the project: "${filePath}".`);
  }
  const absolutePath = resolve(projectPath, filePath);
  assertInsideProject(projectPath, absolutePath);
  const parentPath = resolve(absolutePath, "..");
  const canonicalParent = await realpath(parentPath);
  assertInsideProject(projectPath, canonicalParent);
  try {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      const target = await realpath(absolutePath);
      assertInsideProject(projectPath, target);
    }
  } catch (error) {
    if (!isMissingFileError$1(error)) throw error;
  }
  return absolutePath;
}
function assertProjectId(projectId) {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(`Invalid FlowWeave project id: "${projectId}".`);
  }
}
function createScanFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function createStructureFingerprint(projectName, languages, files) {
  return createScanFingerprint({
    projectName,
    languages,
    files: files.map((file) => ({ path: file.path, language: file.language })).sort((left, right) => left.path.localeCompare(right.path))
  });
}
function assertInsideProject(projectPath, candidatePath) {
  const normalizedProject = normalize(projectPath);
  const normalizedCandidate = normalize(candidatePath);
  const pathFromProject = relative(normalizedProject, normalizedCandidate);
  if (pathFromProject === ".." || pathFromProject.startsWith(`..${sep}`) || isAbsolute(pathFromProject)) {
    throw new Error(`Path escapes the authorized project: "${candidatePath}".`);
  }
}
function isMissingFileError$1(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
const adapters = {
  "claude-code": new ClaudeCodeAdapter(),
  "claude-desktop": new ClaudeDesktopAdapter(),
  "codex-local": new CodexLocalAdapter(),
  "codex-desktop": new CodexDesktopAdapter(),
  "gemini-cli": new GeminiCliAdapter(),
  cursor: new CursorAdapter(),
  mock: new MockAgentAdapter()
};
async function startToolPlan(options) {
  const projectPath = resolveProjectPath(options.projectId);
  const runId = `run-${Date.now()}`;
  const paths = await prepareRunPaths(projectPath, runId);
  const prompt = buildRunPrompt(await resolvePrompt(options), options.executionMode, options.purpose);
  await writeFile(paths.promptPath, prompt, "utf8");
  const adapter = await getAgentAdapter(options.toolId);
  const executionMode = options.executionMode;
  const checkpointId = executionMode === "execute" ? await createCheckpoint(projectPath) : void 0;
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
  const finalResult = {
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
function buildRunPrompt(prompt, executionMode, purpose) {
  if (executionMode === "execute" || purpose === "artifact-analysis") return prompt;
  return `${prompt}

Dry run only: inspect the request and return an implementation plan, affected files, risks, and tests. Do not edit files.`;
}
async function detectTool(toolId) {
  return adapters[toolId].detect();
}
async function detectAgent(agentId) {
  return (await getAgentAdapter(agentId)).detect();
}
function getAgentAdapter(agentId) {
  if (agentId === "mock" || isBuiltInAgentId(agentId)) {
    return Promise.resolve(adapters[agentId]);
  }
  return getAgentAdapter$1(agentId);
}
async function openToolProject(toolId, projectPath) {
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
function listAgents() {
  return listAgentDefinitions();
}
function saveAgent(input) {
  return saveCustomAgent(input);
}
function deleteAgent(agentId) {
  return deleteCustomAgent(agentId);
}
async function resolvePrompt(options) {
  if (options.prompt.trim()) {
    return options.prompt;
  }
  if (options.guidancePath) {
    const guidance = await readFile(options.guidancePath, "utf8");
    return `Use this FlowWeave guidance file (${basename(options.guidancePath)}) to produce an implementation plan.

${guidance}`;
  }
  throw new Error("FlowWeave run prompt is required.");
}
async function resolvePlanText(result, logText) {
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
function fallbackPlan(result, logText) {
  return `# Tool Plan

Tool: ${result.toolId}
Status: ${result.status}

${result.summary ?? "Review the tool log for details."}

## Tool Output

${logText}
`;
}
function collectStderr(events) {
  const stderr = events.filter((event) => event.type === "stderr").map((event) => event.content.trim()).filter(Boolean).join("\n");
  return stderr || void 0;
}
function firstUsefulLine(text) {
  return text.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
}
function requireString(channel, value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[${channel}] Invalid "${name}": expected a non-empty string.`);
  }
  return value;
}
function requireObject(channel, value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[${channel}] Invalid "${name}": expected an object.`);
  }
  return value;
}
function requireEnum(channel, value, name, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`[${channel}] Invalid "${name}": expected one of ${allowed.join(", ")}.`);
  }
  return value;
}
function requireStringArray(channel, value, name) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`[${channel}] Invalid "${name}": expected an array of strings.`);
  }
  return value;
}
function requireSafeId(channel, value, name) {
  const id = requireString(channel, value, name);
  if (id.includes("..") || id.includes("/") || id.includes("\\") || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new Error(`[${channel}] Invalid "${name}": expected a safe identifier.`);
  }
  return id;
}
function registerAgentIpc() {
  ipcMain.handle(TOOL_CHANNELS.listAgents, async () => {
    return listAgents();
  });
  ipcMain.handle(TOOL_CHANNELS.saveCustomAgent, async (_event, input) => {
    const value = requireObject(TOOL_CHANNELS.saveCustomAgent, input, "input");
    return saveAgent({
      name: requireString(TOOL_CHANNELS.saveCustomAgent, value.name, "name"),
      command: requireString(TOOL_CHANNELS.saveCustomAgent, value.command, "command"),
      args: value.args === void 0 ? void 0 : requireStringArray(TOOL_CHANNELS.saveCustomAgent, value.args, "args"),
      description: value.description === void 0 ? void 0 : requireString(TOOL_CHANNELS.saveCustomAgent, value.description, "description")
    });
  });
  ipcMain.handle(TOOL_CHANNELS.deleteCustomAgent, async (_event, agentId) => {
    return deleteAgent(requireCustomAgentId(TOOL_CHANNELS.deleteCustomAgent, agentId));
  });
  ipcMain.handle(TOOL_CHANNELS.detectAgent, async (_event, agentId) => {
    return detectAgent(requireAgentId(TOOL_CHANNELS.detectAgent, agentId));
  });
  ipcMain.handle(TOOL_CHANNELS.detect, async (_event, toolId) => {
    return detectTool(requireEnum(TOOL_CHANNELS.detect, toolId, "toolId", ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"]));
  });
  ipcMain.handle(TOOL_CHANNELS.runPlan, async (_event, value) => {
    const options = requireObject(TOOL_CHANNELS.runPlan, value, "options");
    const projectId = requireString(TOOL_CHANNELS.runPlan, options.projectId, "projectId");
    return startToolPlan({
      projectId,
      toolId: requireAgentId(TOOL_CHANNELS.runPlan, options.toolId),
      prompt: requireString(TOOL_CHANNELS.runPlan, options.prompt, "prompt"),
      guidancePath: options.guidancePath ? await resolveProjectFile(projectId, requireString(TOOL_CHANNELS.runPlan, options.guidancePath, "guidancePath")) : void 0,
      executionMode: requireEnum(TOOL_CHANNELS.runPlan, options.executionMode, "executionMode", ["plan", "execute"]),
      purpose: requireEnum(TOOL_CHANNELS.runPlan, options.purpose, "purpose", ["implementation-plan", "artifact-analysis"]),
      model: options.model
    });
  });
  ipcMain.handle(TOOL_CHANNELS.listRuns, async (_event, projectId) => {
    return listRunSummaries(resolveProjectPath(requireString(TOOL_CHANNELS.listRuns, projectId, "projectId")));
  });
  ipcMain.handle(TOOL_CHANNELS.readRun, async (_event, projectId, runId) => {
    return readRunArtifact(
      resolveProjectPath(requireString(TOOL_CHANNELS.readRun, projectId, "projectId")),
      requireRunId(TOOL_CHANNELS.readRun, runId)
    );
  });
  ipcMain.handle(TOOL_CHANNELS.openProject, async (_event, toolId, projectId) => {
    return openToolProject(
      requireEnum(TOOL_CHANNELS.openProject, toolId, "toolId", ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"]),
      resolveProjectPath(requireString(TOOL_CHANNELS.openProject, projectId, "projectId"))
    );
  });
}
function requireAgentId(channel, value) {
  if (typeof value === "string" && value.startsWith("custom:") && value.length > 7) return value;
  return requireEnum(channel, value, "agentId", ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"]);
}
function requireRunId(channel, value) {
  const runId = requireString(channel, value, "runId");
  if (!/^run-\d+$/.test(runId)) throw new Error(`[${channel}] Invalid "runId".`);
  return runId;
}
function requireCustomAgentId(channel, value) {
  if (typeof value !== "string" || !value.startsWith("custom:") || value.length <= 7) {
    throw new Error(`[${channel}] Invalid "agentId": expected a custom Agent id.`);
  }
  return value;
}
const BLOCKED_PATH_PATTERN = /(^|\/)(\.env($|\.)|credentials\.[^/]+$)|\.(key|pem|p12|pfx|crt|cer)$/i;
function checkSafety(files) {
  const warnings = [];
  for (const file of files) {
    if (BLOCKED_PATH_PATTERN.test(file.path)) {
      warnings.push({
        level: "blocked",
        code: "sensitive-file",
        filePath: file.path,
        message: `Sensitive file change requires manual review: ${file.path}`
      });
    }
    if (file.additions + file.deletions > 500) {
      warnings.push({
        level: "review",
        code: "large-file-change",
        filePath: file.path,
        message: `Large file change over 500 lines: ${file.path}`
      });
    }
  }
  const deletedCount = files.filter((file) => file.status === "deleted").length;
  if (deletedCount > 5) {
    warnings.push({
      level: "review",
      code: "many-deletions",
      message: `More than 5 deleted files detected: ${deletedCount}`
    });
  }
  return {
    level: warnings.some((warning) => warning.level === "blocked") ? "blocked" : warnings.some((warning) => warning.level === "review") ? "review" : "ok",
    warnings
  };
}
function registerGitIpc() {
  ipcMain.handle(GIT_CHANNELS.status, async (_event, projectId) => {
    return getGitStatus(resolveProjectPath(requireString(GIT_CHANNELS.status, projectId, "projectId")));
  });
  ipcMain.handle(GIT_CHANNELS.diff, async (_event, projectId, checkpointId) => {
    const projectPath = resolveProjectPath(requireString(GIT_CHANNELS.diff, projectId, "projectId"));
    const safeCheckpointId = checkpointId === void 0 ? void 0 : requireString(GIT_CHANNELS.diff, checkpointId, "checkpointId");
    const [patch, changedFiles] = await Promise.all([getDiff(projectPath, safeCheckpointId), getChangedFiles(projectPath)]);
    return {
      isRepo: (await getGitStatus(projectPath)).isRepo,
      patch,
      changedFiles,
      safety: checkSafety(changedFiles)
    };
  });
  ipcMain.handle(GIT_CHANNELS.checkpoint, async (_event, projectId) => {
    return createCheckpoint(resolveProjectPath(requireString(GIT_CHANNELS.checkpoint, projectId, "projectId")));
  });
  ipcMain.handle(GIT_CHANNELS.rollback, async (_event, projectId, checkpointId) => {
    await restoreCheckpoint(
      resolveProjectPath(requireString(GIT_CHANNELS.rollback, projectId, "projectId")),
      requireString(GIT_CHANNELS.rollback, checkpointId, "checkpointId")
    );
  });
}
const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
];
const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".prisma", ".sql"];
function parseImportSpecifiers(source) {
  const withoutComments = stripComments(source);
  const specifiers = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while (match = pattern.exec(withoutComments)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}
function resolveProjectImport(importerPath, specifier, projectFiles) {
  if (!specifier.startsWith(".")) return void 0;
  const basePath = posix.normalize(posix.join(dirname(importerPath), specifier));
  const candidates = [
    basePath,
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...RESOLVABLE_EXTENSIONS.map((extension) => posix.join(basePath, `index${extension}`))
  ];
  return candidates.find((candidate) => projectFiles.has(candidate));
}
function collectImportReferences(fileContents, projectFiles) {
  const fileSet = new Set(flattenProjectFilePaths(projectFiles));
  const references = [];
  for (const file of fileContents) {
    for (const specifier of parseImportSpecifiers(file.content)) {
      const imported = resolveProjectImport(file.path, specifier, fileSet);
      if (imported) {
        references.push({ importer: file.path, imported });
      }
    }
  }
  return references;
}
function flattenProjectFilePaths(nodes) {
  const paths = [];
  function visit(node) {
    if (node.type === "file") paths.push(node.path);
    node.children?.forEach(visit);
  }
  nodes.forEach(visit);
  return paths;
}
function stripComments(source) {
  let output = "";
  let index = 0;
  let mode = "code";
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === "line") {
      if (char === "\n") {
        mode = "code";
        output += char;
      }
      index += 1;
      continue;
    }
    if (mode === "block") {
      if (char === "*" && next === "/") {
        mode = "code";
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (mode === "single" || mode === "double" || mode === "template") {
      output += char;
      const quote = mode === "single" ? "'" : mode === "double" ? '"' : "`";
      if (char === "\\") {
        output += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) mode = "code";
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      mode = "line";
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      mode = "block";
      index += 2;
      continue;
    }
    if (char === "'") mode = "single";
    if (char === '"') mode = "double";
    if (char === "`") mode = "template";
    output += char;
    index += 1;
  }
  return output;
}
const MAX_INSIGHT_FILES = 800;
const MAX_FILE_BYTES = 22e4;
const CODE_EXTENSIONS = /* @__PURE__ */ new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java", ".rs", ".php", ".cs"]);
const require$1 = createRequire(import.meta.url);
async function buildProjectStructureFacts(project) {
  const paths = flattenProjectFilePaths(project.files).filter((path) => CODE_EXTENSIONS.has(extname(path).toLowerCase())).sort((left, right) => representativePathScore(right) - representativePathScore(left) || left.localeCompare(right)).slice(0, MAX_INSIGHT_FILES);
  const files = await Promise.all(paths.map((path) => readFileInsight(project.rootPath, project.files, path)));
  return {
    projectName: project.projectName,
    rootPath: project.rootPath,
    languages: project.summary.languages,
    files: files.filter((file) => Boolean(file))
  };
}
async function readFileInsight(rootPath, projectFiles, filePath) {
  const absolutePath = join(rootPath, ...filePath.split("/"));
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(rootPath), realpath(absolutePath).catch(() => void 0)]);
  if (!canonicalFile) return void 0;
  const pathFromRoot = relative(canonicalRoot, canonicalFile);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) return void 0;
  const content = await readFile(absolutePath, "utf8").catch(() => "");
  if (!content || Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    return void 0;
  }
  const language = detectLanguage$1(filePath);
  if (isTypeScriptLike(filePath)) {
    return extractTypeScriptInsight(filePath, content, language);
  }
  return extractLightweightInsight(filePath, content, language, projectFiles);
}
function selectRepresentativeStructureFacts(facts, maxFiles) {
  return [...facts.files].sort((left, right) => representativeScore(right) - representativeScore(left) || left.path.localeCompare(right.path)).slice(0, maxFiles);
}
function representativeScore(file) {
  const path = file.path.toLowerCase();
  let score = file.symbols.length * 3 + file.calls.length * 2 + file.externalCalls.length * 5 + file.imports.length;
  if (/(^|\/)(main|index|app|server|bootstrap)\.[^.]+$/.test(path)) score += 40;
  if (/(ipc|controller|service|worker|gateway|adapter|repository|store|dispatcher|scheduler)/.test(path)) score += 25;
  if (/(test|spec|fixture|example|generated)/.test(path)) score -= 20;
  return score;
}
function representativePathScore(filePath) {
  const path = filePath.toLowerCase();
  let score = 0;
  if (/(^|\/)(main|index|app|server|bootstrap)\.[^.]+$/.test(path)) score += 40;
  if (/(ipc|controller|service|worker|gateway|adapter|repository|store|dispatcher|scheduler)/.test(path)) score += 25;
  if (/(test|spec|fixture|example|generated)/.test(path)) score -= 20;
  return score;
}
function extractTypeScriptInsight(filePath, content, language = detectLanguage$1(filePath)) {
  const loadedTypeScript = loadTypeScript();
  if (!loadedTypeScript) {
    return extractLightweightInsight(filePath, content, language);
  }
  const ts = loadedTypeScript;
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = /* @__PURE__ */ new Set();
  const exports = /* @__PURE__ */ new Set();
  const symbols = [];
  const calls = /* @__PURE__ */ new Set();
  const externalCalls = [];
  function visit(node) {
    collectImportsAndExports(ts, node, imports, exports);
    collectSymbols(ts, filePath, sourceFile, node, symbols, exports);
    if (ts.isCallExpression(node)) {
      const callName = callExpressionName(ts, node.expression);
      if (callName) {
        calls.add(callName);
        const external = externalCallFromExpression(ts, filePath, callName, node);
        if (external) externalCalls.push(external);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return {
    path: filePath,
    language,
    imports: [...imports],
    exports: [...exports],
    symbols: dedupeSymbols(symbols),
    calls: [...calls].slice(0, 80),
    externalCalls: dedupeExternalCalls(externalCalls)
  };
}
function loadTypeScript() {
  try {
    return require$1("typescript");
  } catch {
    return void 0;
  }
}
function extractLightweightInsight(filePath, content, language = detectLanguage$1(filePath), _projectFiles = []) {
  const imports = /* @__PURE__ */ new Set();
  const symbols = [];
  const externalCalls = [];
  const patterns = lightweightPatterns(filePath);
  for (const pattern of patterns.imports) {
    collectMatches(content, pattern, imports);
  }
  for (const pattern of patterns.functions) {
    collectSymbolMatches(filePath, content, pattern, "function", symbols);
  }
  for (const pattern of patterns.classes) {
    collectSymbolMatches(filePath, content, pattern, "class", symbols);
  }
  collectLightweightExternalCalls(filePath, content, externalCalls);
  return {
    path: filePath,
    language,
    imports: [...imports].slice(0, 80),
    exports: [],
    symbols: dedupeSymbols(symbols),
    calls: [],
    externalCalls: dedupeExternalCalls(externalCalls)
  };
}
function collectImportsAndExports(ts, node, imports, exports) {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    imports.add(node.moduleSpecifier.text);
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    imports.add(node.moduleSpecifier.text);
  }
  if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
    const expression = node.expression.getText();
    if (expression === "require" || expression === "import") {
      imports.add(node.arguments[0].text);
    }
  }
  if (hasExportModifier(ts, node)) {
    const name = declarationName(ts, node);
    if (name) exports.add(name);
  }
  if (ts.isVariableStatement(node) && hasExportModifier(ts, node)) {
    for (const declaration of node.declarationList.declarations) {
      const name = declarationName(ts, declaration);
      if (name) exports.add(name);
    }
  }
  if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
    for (const element of node.exportClause.elements) {
      exports.add(element.name.text);
    }
  }
}
function collectSymbols(ts, filePath, sourceFile, node, symbols, exports) {
  const kind = symbolKind(ts, node);
  if (!kind) return;
  const name = declarationName(ts, node);
  if (!name) return;
  const exported = hasExportModifier(ts, node) || hasExportedParent(ts, node) || exports.has(name);
  symbols.push({
    name,
    kind,
    filePath,
    exported,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  });
}
function symbolKind(ts, node) {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isVariableDeclaration(node) && initializerLooksCallable(ts, node.initializer)) return "function";
  return void 0;
}
function declarationName(ts, node) {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) {
    if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  }
  return void 0;
}
function hasExportModifier(ts, node) {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}
function hasExportedParent(ts, node) {
  return Boolean(node.parent && hasExportModifier(ts, node.parent));
}
function initializerLooksCallable(ts, initializer) {
  return Boolean(initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)));
}
function callExpressionName(ts, expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.getText();
  return void 0;
}
function externalCallFromExpression(ts, filePath, callName, node) {
  const firstArg = node.arguments[0];
  const target = firstArg && ts.isStringLiteralLike(firstArg) ? firstArg.text : callName;
  if (/^(fetch|axios(\.|$)|request|got\.|http\.|https\.)/.test(callName) || /^https?:\/\//.test(target)) {
    return { kind: "http", target, filePath, symbol: callName };
  }
  if (/(prisma|sequelize|mongoose|knex|repository|db|database)\./i.test(callName)) {
    return { kind: "database", target: callName, filePath, symbol: callName };
  }
  if (/^(fs\.|readFile|writeFile)/.test(callName)) {
    return { kind: "filesystem", target: callName, filePath, symbol: callName };
  }
  if (/^(spawn|exec|execFile|fork)$/.test(callName)) {
    return { kind: "process", target: callName, filePath, symbol: callName };
  }
  if (/(publish|subscribe|enqueue|queue|emit)\b/i.test(callName)) {
    return { kind: "queue", target: callName, filePath, symbol: callName };
  }
  return void 0;
}
function lightweightPatterns(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".py") {
    return {
      imports: [/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm],
      functions: [/^\s*def\s+([A-Za-z_]\w*)\s*\(/gm],
      classes: [/^\s*class\s+([A-Za-z_]\w*)\s*[:(]/gm]
    };
  }
  if (extension === ".go") {
    return {
      imports: [/\bimport\s+(?:"([^"]+)"|\(([\s\S]*?)\))/gm],
      functions: [/\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/gm],
      classes: [/\btype\s+([A-Za-z_]\w*)\s+struct\b/gm]
    };
  }
  return {
    imports: [/\b(?:import|using|use)\s+["']?([A-Za-z0-9_./:@-]+)/gm],
    functions: [/\b(?:function|fn|def|public\s+\w+|private\s+\w+|protected\s+\w+)\s+([A-Za-z_]\w*)\s*\(/gm],
    classes: [/\b(?:class|interface|trait|struct)\s+([A-Za-z_]\w*)\b/gm]
  };
}
function collectMatches(content, pattern, values) {
  pattern.lastIndex = 0;
  let match;
  while (match = pattern.exec(content)) {
    for (const group of match.slice(1)) {
      if (!group) continue;
      if (group.includes("\n")) {
        for (const item of group.matchAll(/"([^"]+)"/g)) {
          if (item[1]) values.add(item[1]);
        }
      } else {
        values.add(group);
      }
    }
  }
}
function collectSymbolMatches(filePath, content, pattern, kind, symbols) {
  pattern.lastIndex = 0;
  let match;
  while (match = pattern.exec(content)) {
    if (!match[1]) continue;
    symbols.push({
      name: match[1],
      kind,
      filePath,
      line: lineNumberAt(content, match.index)
    });
  }
}
function collectLightweightExternalCalls(filePath, content, externalCalls) {
  const checks = [
    [/\b(fetch|axios|requests\.|http\.|https\.|curl_exec)\b/g, "http"],
    [/\b(sql|query|execute|prisma|sequelize|mongoose|database|repository)\b/gi, "database"],
    [/\b(readFile|writeFile|open\(|File\(|fs\.)\b/g, "filesystem"],
    [/\b(publish|subscribe|enqueue|queue|emit)\b/gi, "queue"]
  ];
  for (const [pattern, kind] of checks) {
    pattern.lastIndex = 0;
    let match;
    while (match = pattern.exec(content)) {
      externalCalls.push({ kind, target: match[1] ?? match[0], filePath });
    }
  }
}
function dedupeSymbols(symbols) {
  const seen = /* @__PURE__ */ new Set();
  return symbols.filter((symbol) => {
    const key = `${symbol.filePath}:${symbol.kind}:${symbol.name}:${symbol.line ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 120);
}
function dedupeExternalCalls(calls) {
  const seen = /* @__PURE__ */ new Set();
  return calls.filter((call) => {
    const key = `${call.filePath}:${call.kind}:${call.target}:${call.symbol ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 80);
}
function lineNumberAt(content, index) {
  return content.slice(0, index).split("\n").length;
}
function isTypeScriptLike(filePath) {
  return /\.(tsx?|jsx?|mjs|cjs)$/.test(filePath);
}
function detectLanguage$1(filePath) {
  const extension = extname(filePath).toLowerCase();
  const labels = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript React",
    ".js": "JavaScript",
    ".jsx": "JavaScript React",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".py": "Python",
    ".go": "Go",
    ".java": "Java",
    ".rs": "Rust",
    ".php": "PHP",
    ".cs": "C#"
  };
  return labels[extension];
}
const MAX_PROMPT_FILES$1 = 260;
const MAX_PROMPT_SYMBOLS_PER_FILE = 18;
const REPRESENTATIVE_FILE_LIMIT$1 = 60;
const architectureFlights = /* @__PURE__ */ new Map();
async function analyzeArchitecture(project, toolId) {
  const flightKey = `${project.rootPath}:${toolId}`;
  const existing = architectureFlights.get(flightKey);
  if (existing) return existing;
  const flight = analyzeArchitectureOnce(project, toolId).then(async (result) => {
    if (result.outcome === "generated") return result;
    const previous = await readArchitectureMap(project.rootPath);
    return {
      ...result,
      previous: previous?.source === "agent" ? previous.metadata : void 0
    };
  }).finally(() => architectureFlights.delete(flightKey));
  architectureFlights.set(flightKey, flight);
  return flight;
}
async function analyzeArchitectureOnce(project, toolId) {
  const facts = await buildProjectStructureFacts(project);
  const representativeFacts = { ...facts, files: selectRepresentativeStructureFacts(facts, REPRESENTATIVE_FILE_LIMIT$1) };
  const inputFingerprint = project.scanFingerprint ?? createScanFingerprint(representativeFacts);
  const prompt = buildArchitecturePrompt(representativeFacts);
  if (toolId === "mock") {
    const agentOutput = mockArchitectureJson(createFallbackArchitectureMap(project, representativeFacts, "agent"));
    const parsed = parseArchitectureJson(agentOutput, project, facts);
    if (!parsed) return failedArchitectureResult(toolId, "invalid-output", "Mock agent returned invalid architecture JSON.", []);
    const quality = validateArchitectureMap(parsed, representativeFacts);
    if (!quality.valid) return failedArchitectureResult(toolId, "quality-rejected", quality.reasons.join("; "), []);
    const architectureMap = withArchitectureMetadata(parsed, toolId, "mock", inputFingerprint, quality);
    await writeArchitectureArtifacts(project.rootPath, architectureMap);
    return architectureMapToResult(architectureMap, "mock");
  }
  const projectId = await registerProject(project.rootPath);
  const runIds = [];
  try {
    const firstRun = await startToolPlan({
      projectId,
      toolId,
      prompt,
      executionMode: "plan",
      purpose: "artifact-analysis"
    });
    runIds.push(firstRun.id);
    if (firstRun.status !== "completed") {
      return failedArchitectureResult(toolId, "agent-failed", firstRun.stderr ?? firstRun.summary ?? "Agent architecture analysis failed.", runIds);
    }
    const firstOutput = collectStdout$1(firstRun.events);
    const firstParsed = parseArchitectureJson(firstOutput, project, facts);
    const firstQuality = firstParsed ? validateArchitectureMap(firstParsed, representativeFacts) : void 0;
    if (firstParsed && firstQuality?.valid) {
      const architectureMap2 = withArchitectureMetadata(firstParsed, toolId, firstRun.id, inputFingerprint, firstQuality);
      await writeArchitectureArtifacts(project.rootPath, architectureMap2);
      return architectureMapToResult(architectureMap2, firstRun.id);
    }
    const firstFailure = firstParsed ? firstQuality?.reasons.join("; ") ?? "Architecture quality validation failed." : "Agent returned invalid architecture JSON.";
    const retry = await startToolPlan({
      projectId,
      toolId,
      prompt: buildArchitectureRepairPrompt(prompt, firstOutput, firstFailure),
      executionMode: "plan",
      purpose: "artifact-analysis"
    });
    runIds.push(retry.id);
    if (retry.status !== "completed") {
      return failedArchitectureResult(toolId, "agent-failed", retry.stderr ?? retry.summary ?? "Architecture repair run failed.", runIds, firstFailure);
    }
    const retryOutput = collectStdout$1(retry.events);
    const retryParsed = parseArchitectureJson(retryOutput, project, facts);
    const retryQuality = retryParsed ? validateArchitectureMap(retryParsed, representativeFacts) : void 0;
    if (!retryParsed || !retryQuality?.valid) {
      const retryFailure = retryParsed ? retryQuality?.reasons.join("; ") ?? "Architecture quality validation failed." : "Repair run returned invalid architecture JSON.";
      return failedArchitectureResult(toolId, retryParsed ? "quality-rejected" : "invalid-output", retryFailure, runIds, firstFailure, retryFailure);
    }
    const architectureMap = withArchitectureMetadata(retryParsed, toolId, retry.id, inputFingerprint, retryQuality);
    await writeArchitectureArtifacts(project.rootPath, architectureMap);
    return architectureMapToResult(architectureMap, retry.id);
  } catch (error) {
    return failedArchitectureResult(toolId, "agent-failed", formatError$1(error), runIds);
  }
}
async function readArchitectureMap(projectPath) {
  const architecturePath = join(projectPath, FLOWWEAVE_DIR, "architecture-map.json");
  return readFile(architecturePath, "utf8").then((content) => JSON.parse(content)).catch(() => void 0);
}
function buildArchitecturePrompt(facts) {
  return `You are FlowWeave's architecture analyst. Return only JSON.

Goal:
Create a functional architecture module map for a visual Canvas that helps a user understand the real code structure and workflow of this project. Nodes must represent feature/architecture modules, not individual files or folders.

Project: ${facts.projectName}
Languages: ${JSON.stringify(facts.languages)}

ProjectStructureFacts:
${JSON.stringify(compactFactsForPrompt$1(facts), null, 2)}

Analysis priorities:
- Use only the supplied ProjectStructureFacts. Do not invent files, symbols, calls, endpoints, databases, queues, or third-party systems.
- Explain the project as a human-readable explanation for someone trying to understand how the code works.
- Identify real entry points, core business/domain modules, data access, external integrations, background workers, shared utilities, and test surfaces from paths, imports, exports, symbols, calls, and externalCalls.
- Describe the practical workflow: how a request, job, event, or command enters the system, which modules process it, where state is read or written, and where external systems are touched.
- Prefer concrete code evidence over broad guesses. When evidence is partial, say that the detail is inferred from imports, calls, externalCalls, symbols, or file roles.

Return this exact JSON shape:
{
  "architectureStyle": "short architecture style, e.g. layered service, desktop app, MVC, event-driven",
  "modules": [{
    "id": "stable-kebab-id",
    "title": "Human module title",
    "category": "api-boundary|domain-service|data-access|external-integration|job-worker|shared-utility|test-surface",
    "role": "one sentence role",
    "description": "one concise paragraph",
    "files": ["path"],
    "fileRoles": [{"path": "path", "role": "why this file belongs here"}],
    "symbols": [{"name": "symbol", "kind": "function|class|method|export|variable", "filePath": "path", "role": "why it matters"}],
    "evidence": [{"filePath": "path", "symbol": "optional", "detail": "import/function/call evidence"}],
    "risk": "normal|review|blocked",
    "confidence": 0.0
  }],
  "relationships": [{
    "source": "module-id",
    "target": "module-id",
    "relation": "depends_on|calls|reads_writes|external_api|publishes_event|subscribes_event|tests",
    "description": "how these modules connect",
    "evidence": [{"filePath": "path", "symbol": "optional", "detail": "specific connection evidence"}]
  }]
}

Rules:
- Prefer 5-12 functional architecture modules for medium projects.
- Merge files by responsibility: API boundaries, domain services, data access, external integrations, workers, utilities, tests.
- Do not create one node per file.
- Every module must include concrete files and at least one evidence item when possible.
- For fileRoles, describe what each file does inside the module, such as request handling, orchestration, validation, persistence, integration, configuration, or tests.
- For symbols, choose key functions, classes, methods, or exports that explain how the module works; include a role that tells the user why the symbol matters.
- Every relationship must explain how modules connect using imports, calls, symbols, or external call hints.
- Relationship descriptions should describe real workflow collaboration, e.g. API boundary calls domain service, service reads/writes data access, service calls external integration, worker consumes queue work, or tests cover a target module.
- Use only relation and category enum values shown above.`;
}
function parseArchitectureJson(output, project, facts) {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) return void 0;
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.modules) || parsed.modules.length === 0) return void 0;
    const fileSet = new Set(facts.files.map((file) => file.path));
    const modules = parsed.modules.map((module, index) => normalizeModule(module, facts, fileSet, index)).filter((module) => Boolean(module));
    if (modules.length === 0) return void 0;
    const moduleIds = new Set(modules.map((module) => module.id));
    const relationships = (parsed.relationships ?? []).map((relationship, index) => normalizeRelationship(relationship, moduleIds, index)).filter((relationship) => Boolean(relationship));
    return {
      version: 1,
      projectName: project.projectName,
      rootPath: project.rootPath,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      source: "agent",
      architectureStyle: stringOrUndefined$1(parsed.architectureStyle),
      modules,
      relationships,
      files: applyModuleIds(facts.files, modules),
      symbols: modules.flatMap((module) => module.symbols)
    };
  } catch {
    return void 0;
  }
}
function architectureMapToResult(architectureMap, runId) {
  return {
    outcome: "generated",
    architectureMap,
    graph: architectureMapToGraph(architectureMap),
    runId
  };
}
function architectureMapToGraph(architectureMap) {
  const nodes = architectureMap.modules.map((module, index) => ({
    id: module.id,
    title: module.title,
    subtitle: categoryLabel(module.category),
    kind: "module",
    nodeType: nodeTypeFromCategory(module.category),
    risk: module.risk,
    description: module.description,
    files: module.files,
    guidanceDraft: `请围绕 ${module.title} 的功能架构职责修改代码，优先参考右侧 Files、Functions 和 Connections 证据。`,
    status: architectureMap.source === "agent" ? "mapped" : "needs-review",
    x: xForCategory(module.category) + index % 2 * 34,
    y: yForCategory(module.category, index),
    category: module.category,
    role: module.role,
    fileRoles: module.fileRoles,
    symbols: module.symbols,
    evidence: module.evidence,
    confidence: module.confidence
  }));
  const edges = architectureMap.relationships.map((relationship) => ({
    id: relationship.id,
    source: relationship.source,
    target: relationship.target,
    relation: relationship.relation,
    guidanceNote: relationship.description,
    evidence: relationship.evidence
  }));
  return { nodes, edges };
}
function architectureMapToProjectMap(map) {
  return {
    language: Object.entries(languageCounts(map.files)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown",
    framework: map.architectureStyle,
    entryFiles: map.modules.filter((module) => module.category === "api-boundary").flatMap((module) => module.files).slice(0, 8),
    directories: map.modules.map((module) => ({
      path: module.files[0] ?? module.id,
      purpose: module.role
    }))
  };
}
function architectureMapToModuleMap(map) {
  return {
    modules: map.modules.map((module) => ({
      id: module.id,
      title: module.title,
      description: module.description,
      files: module.files,
      dependencies: map.relationships.filter((relationship) => relationship.source === module.id).map((relationship) => ({ target: relationship.target, relation: relationship.relation })),
      risk: module.risk
    }))
  };
}
async function writeArchitectureArtifacts(projectPath, architectureMap) {
  const root = join(projectPath, FLOWWEAVE_DIR);
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "architecture-map.json"), `${JSON.stringify(architectureMap, null, 2)}
`, "utf8"),
    writeFile(join(root, "file-insights.json"), `${JSON.stringify(architectureMap.files, null, 2)}
`, "utf8"),
    writeFile(join(root, "module-map.json"), `${JSON.stringify(architectureMapToModuleMap(architectureMap), null, 2)}
`, "utf8")
  ]);
}
function validateArchitectureMap(architectureMap, representativeFacts) {
  const factByFile = new Map(representativeFacts.files.map((file) => [file.path, file]));
  const coveredFiles = new Set(architectureMap.modules.flatMap((module) => module.files).filter((file) => factByFile.has(file)));
  const evidence = [
    ...architectureMap.modules.flatMap((module) => module.evidence),
    ...architectureMap.relationships.flatMap((relationship) => relationship.evidence)
  ];
  const validEvidence = evidence.filter((item) => typeof item.filePath === "string" && factByFile.has(item.filePath));
  const fileCoverage = representativeFacts.files.length === 0 ? 0 : coveredFiles.size / representativeFacts.files.length;
  const evidenceCoverage = evidence.length === 0 ? 0 : validEvidence.length / evidence.length;
  const moduleIds = new Set(architectureMap.modules.map((module) => module.id));
  const reasons = [];
  for (const module of architectureMap.modules) {
    if (module.files.some((file) => !factByFile.has(file))) reasons.push(`Module ${module.id} references an unknown file.`);
    if (module.evidence.length === 0) reasons.push(`Module ${module.id} has no evidence.`);
    for (const symbol of module.symbols) {
      const fact = factByFile.get(symbol.filePath);
      if (!fact?.symbols.some((candidate) => candidate.name === symbol.name)) {
        reasons.push(`Symbol ${symbol.name} does not belong to ${symbol.filePath}.`);
      }
    }
  }
  for (const relationship of architectureMap.relationships) {
    if (!moduleIds.has(relationship.source) || !moduleIds.has(relationship.target)) {
      reasons.push(`Relationship ${relationship.id} has an invalid endpoint.`);
    }
    if (relationship.evidence.length === 0) reasons.push(`Relationship ${relationship.id} has no evidence.`);
    if (relationship.evidence.some((item) => !item.filePath || !factByFile.has(item.filePath))) {
      reasons.push(`Relationship ${relationship.id} contains invalid evidence.`);
    }
  }
  if (fileCoverage < 0.3) reasons.push(`Representative file coverage ${fileCoverage.toFixed(2)} is below 0.30.`);
  if (evidenceCoverage < 0.7) reasons.push(`Evidence coverage ${evidenceCoverage.toFixed(2)} is below 0.70.`);
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], fileCoverage, evidenceCoverage };
}
function withArchitectureMetadata(architectureMap, agentId, runId, inputFingerprint, quality) {
  const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return {
    ...architectureMap,
    version: 2,
    source: "agent",
    generatedAt,
    metadata: {
      agentId,
      runId,
      generatedAt,
      inputFingerprint,
      fileCoverage: quality.fileCoverage,
      evidenceCoverage: quality.evidenceCoverage
    }
  };
}
function failedArchitectureResult(agentId, code, message, runIds, firstFailure, retryFailure) {
  return {
    outcome: "failed",
    error: {
      code,
      message,
      agentId,
      runId: runIds.at(-1),
      attemptRunIds: runIds,
      firstFailure,
      retryFailure
    }
  };
}
function buildArchitectureRepairPrompt(originalPrompt, output, failure) {
  return `${originalPrompt}

The previous response failed validation: ${failure}
Return one corrected JSON object only. Do not include Markdown fences or explanatory text.

Previous response:
${output.slice(0, 4e4)}`;
}
function collectStdout$1(events) {
  return events.filter((event) => event.type === "stdout").map((event) => event.content ?? "").join("\n");
}
function formatError$1(error) {
  return error instanceof Error ? error.message : String(error);
}
function createFallbackArchitectureMap(project, facts, source) {
  const groups = /* @__PURE__ */ new Map();
  for (const file of facts.files) {
    const key = fallbackModuleId(file);
    groups.set(key, [...groups.get(key) ?? [], file]);
  }
  const modules = [...groups.entries()].map(([id, files]) => {
    const category = fallbackCategory(files);
    const symbols = files.flatMap((file) => file.symbols.slice(0, 12));
    return {
      id,
      title: titleFromId$1(id),
      category,
      nodeType: nodeTypeFromCategory(category),
      role: fallbackRole(category),
      description: `${titleFromId$1(id)} groups ${files.length} files by detected architecture responsibility.`,
      files: files.map((file) => file.path),
      fileRoles: files.map((file) => ({ path: file.path, role: fileRoleFromInsight(file, category) })),
      symbols,
      evidence: files.slice(0, 5).map((file) => ({
        filePath: file.path,
        symbol: file.symbols[0]?.name,
        detail: evidenceFromInsight(file)
      })),
      risk: riskFromFiles(files),
      confidence: 0.55
    };
  });
  const relationships = inferFallbackRelationships(modules, facts.files);
  return {
    version: 1,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    source,
    architectureStyle: "inferred functional architecture",
    modules,
    relationships,
    files: applyModuleIds(facts.files, modules),
    symbols: modules.flatMap((module) => module.symbols)
  };
}
function inferFallbackRelationships(modules, files) {
  const moduleByFile = /* @__PURE__ */ new Map();
  modules.forEach((module) => module.files.forEach((file) => moduleByFile.set(file, module.id)));
  const relationships = [];
  const seen = /* @__PURE__ */ new Set();
  for (const file of files) {
    const source = moduleByFile.get(file.path);
    if (!source) continue;
    for (const specifier of file.imports) {
      const targetFile = resolveImportBySuffix(specifier, moduleByFile);
      const target = targetFile ? moduleByFile.get(targetFile) : void 0;
      if (!target || target === source) continue;
      const relation = relationForModules(modules, source, target);
      const key = `${source}:${target}:${relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relationships.push({
        id: `${source}-${target}-${relation}`,
        source,
        target,
        relation,
        description: `${file.path} imports ${specifier}`,
        evidence: [{ filePath: file.path, detail: `Import reference: ${specifier}` }]
      });
    }
    if (file.externalCalls.length > 0) {
      const external = modules.find((module) => module.category === "external-integration");
      if (external && external.id !== source) {
        const key = `${source}:${external.id}:external_api`;
        if (!seen.has(key)) {
          seen.add(key);
          relationships.push({
            id: `${source}-${external.id}-external-api`,
            source,
            target: external.id,
            relation: "external_api",
            description: `${file.path} performs external calls`,
            evidence: file.externalCalls.slice(0, 3).map((call) => ({ filePath: file.path, symbol: call.symbol, detail: `${call.kind}: ${call.target}` }))
          });
        }
      }
    }
  }
  return relationships.slice(0, 180);
}
function normalizeModule(module, facts, fileSet, index) {
  const id = safeId$1(module.id ?? module.title ?? `module-${index + 1}`);
  const files = (module.files ?? []).filter((file) => fileSet.has(file));
  if (files.length === 0) return void 0;
  const category = isCategory(module.category) ? module.category : fallbackCategory(facts.files.filter((file) => files.includes(file.path)));
  const symbols = normalizeSymbols(module.symbols ?? [], files);
  return {
    id,
    title: module.title?.trim() || titleFromId$1(id),
    category,
    nodeType: nodeTypeFromCategory(category),
    role: module.role?.trim() || fallbackRole(category),
    description: module.description?.trim() || fallbackRole(category),
    files,
    fileRoles: normalizeFileRoles(module.fileRoles, files),
    symbols,
    evidence: normalizeEvidence$1(module.evidence, files),
    risk: isRisk(module.risk) ? module.risk : riskFromFiles(facts.files.filter((file) => files.includes(file.path))),
    confidence: typeof module.confidence === "number" ? module.confidence : void 0
  };
}
function normalizeRelationship(relationship, moduleIds, index) {
  if (!relationship.source || !relationship.target || !moduleIds.has(relationship.source) || !moduleIds.has(relationship.target)) return void 0;
  const relation = isRelation(relationship.relation) ? relationship.relation : "depends_on";
  return {
    id: relationship.id || `${relationship.source}-${relationship.target}-${relation}-${index}`,
    source: relationship.source,
    target: relationship.target,
    relation,
    description: relationship.description || `${relationship.source} ${relation} ${relationship.target}`,
    evidence: normalizeEvidence$1(relationship.evidence, [])
  };
}
function compactFactsForPrompt$1(facts) {
  return {
    ...facts,
    files: facts.files.slice(0, MAX_PROMPT_FILES$1).map((file) => ({
      path: file.path,
      language: file.language,
      imports: file.imports.slice(0, 40),
      exports: file.exports.slice(0, 30),
      symbols: file.symbols.slice(0, MAX_PROMPT_SYMBOLS_PER_FILE).map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        exported: symbol.exported
      })),
      calls: file.calls.slice(0, 35),
      externalCalls: file.externalCalls.slice(0, 20)
    }))
  };
}
function mockArchitectureJson(map) {
  return JSON.stringify(
    {
      architectureStyle: map.architectureStyle,
      modules: map.modules,
      relationships: map.relationships
    },
    null,
    2
  );
}
function applyModuleIds(files, modules) {
  const moduleByFile = /* @__PURE__ */ new Map();
  modules.forEach((module) => module.files.forEach((file) => moduleByFile.set(file, module.id)));
  return files.map((file) => ({ ...file, moduleId: moduleByFile.get(file.path), role: file.role ?? fileRoleFromInsight(file, modules.find((module) => module.id === moduleByFile.get(file.path))?.category) }));
}
function fallbackModuleId(file) {
  const category = fallbackCategory([file]);
  const parts = file.path.split("/");
  const srcIndex = parts.lastIndexOf("src");
  const scope = srcIndex >= 0 ? parts[srcIndex + 1] : parts[0];
  if (category === "external-integration") return "external-integrations";
  if (category === "data-access") return "data-access";
  if (category === "api-boundary") return `${scope ?? "api"}-api`;
  if (category === "test-surface") return "test-surface";
  if (category === "job-worker") return `${scope ?? "worker"}-worker`;
  if (category === "shared-utility") return "shared-utilities";
  return safeId$1(scope ?? "domain-service");
}
function fallbackCategory(files) {
  const text = files.map((file) => `${file.path} ${file.imports.join(" ")} ${file.externalCalls.map((call) => call.kind).join(" ")}`).join("\n");
  if (/test|spec|__tests__/i.test(text)) return "test-surface";
  if (/controller|route|router|api|endpoint/i.test(text)) return "api-boundary";
  if (/repository|database|prisma|schema|migration|sql|mongoose|sequelize|knex|db\b/i.test(text)) return "data-access";
  if (/https?:|fetch|axios|requests|external|webhook|client/i.test(text)) return "external-integration";
  if (/worker|job|queue|cron|schedule|consumer/i.test(text)) return "job-worker";
  if (/util|helper|shared|common|constants|config/i.test(text)) return "shared-utility";
  return "domain-service";
}
function relationForModules(modules, source, target) {
  const targetModule = modules.find((module) => module.id === target);
  if (targetModule?.category === "data-access") return "reads_writes";
  if (targetModule?.category === "external-integration") return "external_api";
  if (targetModule?.category === "test-surface") return "tests";
  return "depends_on";
}
function resolveImportBySuffix(specifier, moduleByFile) {
  const normalized = specifier.replace(/^\.\.?\//, "").replace(/\.(ts|tsx|js|jsx|py|go|java|rs|php|cs)$/i, "");
  return [...moduleByFile.keys()].find((file) => file.includes(normalized) || file.replace(/\.(ts|tsx|js|jsx|py|go|java|rs|php|cs)$/i, "").endsWith(normalized));
}
function nodeTypeFromCategory(category) {
  const map = {
    "api-boundary": "api",
    "domain-service": "service",
    "data-access": "data",
    "external-integration": "external",
    "job-worker": "worker",
    "shared-utility": "utility",
    "test-surface": "test"
  };
  return map[category];
}
function categoryLabel(category) {
  const labels = {
    "api-boundary": "API Boundary",
    "domain-service": "Domain Service",
    "data-access": "Data Access",
    "external-integration": "External Integration",
    "job-worker": "Job / Worker",
    "shared-utility": "Shared Utility",
    "test-surface": "Test Surface"
  };
  return labels[category];
}
function xForCategory(category) {
  if (category === "api-boundary") return 80;
  if (category === "domain-service") return 400;
  if (category === "data-access" || category === "external-integration") return 720;
  return 1040;
}
function yForCategory(category, index) {
  const base = category === "test-surface" || category === "shared-utility" ? 470 : 110;
  return base + Math.floor(index / 2) * 170;
}
function fallbackRole(category) {
  return `${categoryLabel(category)} module inferred from file structure and code symbols.`;
}
function fileRoleFromInsight(file, category) {
  if (file.symbols.length > 0) return `Defines ${file.symbols.slice(0, 4).map((symbol) => symbol.name).join(", ")} for ${category ? categoryLabel(category) : "this module"}.`;
  if (file.externalCalls.length > 0) return `Contains ${file.externalCalls[0].kind} integration hints.`;
  return "Contributes source code to this architecture module.";
}
function evidenceFromInsight(file) {
  if (file.imports.length > 0) return `Imports: ${file.imports.slice(0, 5).join(", ")}`;
  if (file.externalCalls.length > 0) return `External calls: ${file.externalCalls.map((call) => call.target).slice(0, 5).join(", ")}`;
  if (file.symbols.length > 0) return `Symbols: ${file.symbols.map((symbol) => symbol.name).slice(0, 5).join(", ")}`;
  return "File path and language contributed to module classification.";
}
function normalizeSymbols(symbols, files) {
  return symbols.filter((symbol) => files.includes(symbol.filePath)).slice(0, 80);
}
function normalizeFileRoles(fileRoles, files) {
  const roleByFile = new Map((fileRoles ?? []).map((item) => [item.path, item.role]));
  return files.map((path) => ({ path, role: roleByFile.get(path) || "Contributes to this architecture module." }));
}
function normalizeEvidence$1(evidence, files) {
  return (evidence ?? []).filter((item) => !item.filePath || files.length === 0 || files.includes(item.filePath)).map((item) => ({ filePath: item.filePath, symbol: item.symbol, detail: item.detail || "Architecture evidence" })).slice(0, 30);
}
function riskFromFiles(files) {
  if (files.some((file) => /secret|token|credential|\.env|\.key|\.pem/i.test(file.path))) return "blocked";
  if (files.some((file) => /auth|security|payment|billing|permission/i.test(file.path))) return "review";
  return "normal";
}
function titleFromId$1(id) {
  return id.split(/[-_/]/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function safeId$1(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "module";
}
function isCategory(value) {
  return value === "api-boundary" || value === "domain-service" || value === "data-access" || value === "external-integration" || value === "job-worker" || value === "shared-utility" || value === "test-surface";
}
function isRelation(value) {
  return value === "depends_on" || value === "calls" || value === "reads_writes" || value === "external_api" || value === "publishes_event" || value === "subscribes_event" || value === "tests";
}
function isRisk(value) {
  return value === "normal" || value === "review" || value === "blocked";
}
function stringOrUndefined$1(value) {
  return typeof value === "string" && value.trim() ? value : void 0;
}
function languageCounts(files) {
  return files.reduce((counts, file) => {
    if (!file.language) return counts;
    counts[file.language] = (counts[file.language] ?? 0) + 1;
    return counts;
  }, {});
}
async function analyzeProject(project, toolId) {
  const architecture = await analyzeArchitecture(project, toolId);
  if (architecture.outcome === "failed") {
    throw new Error(
      `Architecture analysis failed for ${architecture.error.agentId} run ${architecture.error.runId ?? "unknown"}: ${architecture.error.message}`
    );
  }
  return {
    projectMap: architectureMapToProjectMap(architecture.architectureMap),
    moduleMap: architectureMapToModuleMap(architecture.architectureMap),
    source: "agent",
    graph: architecture.graph
  };
}
function migrateCanvasToScan(canvas, projectPath, scanFingerprint, projectFiles) {
  const knownFiles = new Set(flattenFilePaths(projectFiles));
  const nodes = canvas.nodes.map((node) => sanitizeNodeFiles(node, knownFiles));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = sanitizeEdges(canvas.edges, nodeIds, knownFiles);
  return {
    ...canvas,
    version: 2,
    projectPath,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    scanFingerprint,
    artifactState: "current",
    nodes,
    edges
  };
}
function flattenFilePaths(nodes) {
  return nodes.flatMap((node) => [
    ...node.type === "file" ? [node.path] : [],
    ...flattenFilePaths(node.children ?? [])
  ]);
}
function sanitizeNodeFiles(node, knownFiles) {
  return {
    ...node,
    files: node.files.filter((filePath) => knownFiles.has(filePath)),
    fileRoles: node.fileRoles?.filter((item) => knownFiles.has(item.path)),
    symbols: node.symbols?.filter((symbol) => knownFiles.has(symbol.filePath)),
    evidence: node.evidence?.filter((item) => !item.filePath || knownFiles.has(item.filePath))
  };
}
function sanitizeEdges(edges, nodeIds, knownFiles) {
  const seen = /* @__PURE__ */ new Set();
  return edges.flatMap((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) return [];
    const guidanceFilePath = extractGuidanceFilePath(edge.guidanceNote);
    if (guidanceFilePath && !knownFiles.has(guidanceFilePath)) return [];
    const evidence = edge.evidence?.filter((item) => !item.filePath || knownFiles.has(item.filePath));
    if (edge.evidence?.length && evidence?.length === 0) return [];
    const key = `${edge.source}\0${edge.target}\0${edge.relation}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...edge, evidence }];
  });
}
function extractGuidanceFilePath(guidanceNote) {
  if (!guidanceNote) return void 0;
  const separator = guidanceNote.includes(" performs external calls") ? " performs external calls" : guidanceNote.includes(" imports ") ? " imports " : void 0;
  if (!separator) return void 0;
  return guidanceNote.slice(0, guidanceNote.indexOf(separator));
}
const FLOWWEAVE_BLOCK_START = "<!-- flowweave:start -->";
const FLOWWEAVE_BLOCK_END = "<!-- flowweave:end -->";
const CONNECTION_CONFIG_FILE = "agent-connection.json";
const AGENT_CONTEXT_FILE = "agent-context.md";
const DEFAULT_PLATFORMS = ["codex", "claude", "gemini", "cursor"];
const CURSOR_FRONTMATTER = [
  "---",
  "description: Use FlowWeave project context when analyzing or changing this project",
  "alwaysApply: true",
  "---"
].join("\n");
async function getProjectAgentConnection(projectPath) {
  const paths = connectionPaths(projectPath);
  const config = await readConnectionConfig(paths.configPath);
  if (!config) {
    return createStatus(projectPath, void 0, "disabled", "External Agent connection has not been configured.");
  }
  if (!config.enabled) {
    return createStatus(projectPath, config, "disabled", "External Agent connection is disabled for this project.");
  }
  const connectionIssue = await findConnectionFileIssue(projectPath, config.platforms);
  if (connectionIssue) {
    return createStatus(projectPath, config, "needs-refresh", connectionIssue);
  }
  const latestSourceTime = await latestArtifactModificationTime(projectPath);
  if (latestSourceTime > Date.parse(config.updatedAt)) {
    return createStatus(projectPath, config, "needs-refresh", "FlowWeave project artifacts changed after the Agent context was generated.");
  }
  return createStatus(projectPath, config, "ready", "Project instructions and FlowWeave Agent context are ready.");
}
async function enableProjectAgentConnection(projectPath) {
  await requireProjectArtifact(projectPath);
  return writeProjectAgentConnection(projectPath, DEFAULT_PLATFORMS);
}
async function refreshProjectAgentConnection(projectPath) {
  const config = await readConnectionConfig(connectionPaths(projectPath).configPath);
  if (!config) {
    throw new Error(`Cannot refresh Agent connection for "${projectPath}": the project has not been configured.`);
  }
  if (!config.enabled) {
    throw new Error(`Cannot refresh Agent connection for "${projectPath}": the connection is disabled.`);
  }
  await requireProjectArtifact(projectPath);
  return writeProjectAgentConnection(projectPath, config.platforms);
}
async function refreshProjectAgentConnectionIfEnabled(projectPath) {
  const config = await readConnectionConfig(connectionPaths(projectPath).configPath);
  if (!config?.enabled) return void 0;
  return refreshProjectAgentConnection(projectPath);
}
async function disableProjectAgentConnection(projectPath) {
  const paths = connectionPaths(projectPath);
  const existingConfig = await readConnectionConfig(paths.configPath);
  const platforms = existingConfig?.platforms ?? DEFAULT_PLATFORMS;
  const plannedUpdates = await planManagedBlockRemoval(platformEntries(projectPath, platforms));
  for (const update of plannedUpdates) {
    if (update.content.trim()) {
      await writeTextAtomic(update.filePath, update.content);
    } else {
      await rm(update.filePath, { force: true });
    }
  }
  await rm(paths.contextPath, { force: true });
  const config = {
    version: 1,
    enabled: false,
    platforms,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeJsonAtomic(paths.configPath, config);
  return createStatus(projectPath, config, "disabled", "External Agent connection is disabled for this project.");
}
function getProjectAgentContextPath(projectPath) {
  return connectionPaths(projectPath).contextPath;
}
async function writeProjectAgentConnection(projectPath, platforms) {
  const paths = connectionPaths(projectPath);
  const artifacts = await readProjectArtifacts(projectPath);
  const context = buildAgentContext(projectPath, artifacts);
  const block = buildManagedInstructionBlock();
  const plannedUpdates = await planManagedBlockUpsert(platformEntries(projectPath, platforms), block);
  await writeTextAtomic(paths.contextPath, context);
  for (const update of plannedUpdates) {
    await writeTextAtomic(update.filePath, update.content);
  }
  const config = {
    version: 1,
    enabled: true,
    platforms: [...platforms],
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeJsonAtomic(paths.configPath, config);
  return createStatus(projectPath, config, "ready", "Project instructions and FlowWeave Agent context are ready.");
}
function connectionPaths(projectPath) {
  const flowweavePath = join(projectPath, FLOWWEAVE_DIR);
  return {
    configPath: join(flowweavePath, CONNECTION_CONFIG_FILE),
    contextPath: join(flowweavePath, AGENT_CONTEXT_FILE)
  };
}
function platformEntries(projectPath, platforms) {
  const entries = {
    codex: join(projectPath, "AGENTS.md"),
    claude: join(projectPath, "CLAUDE.md"),
    gemini: join(projectPath, "GEMINI.md"),
    cursor: join(projectPath, ".cursor", "rules", "flowweave.mdc")
  };
  return platforms.map((platform) => ({ platform, filePath: entries[platform] }));
}
function generatedFilePaths(projectPath, platforms) {
  return [
    connectionPaths(projectPath).contextPath,
    ...platformEntries(projectPath, platforms).map((entry) => entry.filePath)
  ];
}
function createStatus(projectPath, config, state, message) {
  const platforms = config?.platforms ?? DEFAULT_PLATFORMS;
  const paths = connectionPaths(projectPath);
  return {
    state,
    enabled: config?.enabled ?? false,
    needsConfirmation: !config,
    projectPath,
    contextPath: paths.contextPath,
    configPath: paths.configPath,
    generatedFiles: generatedFilePaths(projectPath, platforms),
    platforms: [...platforms],
    updatedAt: config?.updatedAt,
    message
  };
}
async function readConnectionConfig(configPath) {
  const content = await readOptionalText(configPath);
  if (content === void 0) return void 0;
  let value;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid FlowWeave Agent connection config at "${configPath}": ${formatError(error)}`);
  }
  if (!isConnectionConfig(value)) {
    throw new Error(`Invalid FlowWeave Agent connection config shape at "${configPath}".`);
  }
  return value;
}
function isConnectionConfig(value) {
  if (!isRecord(value)) return false;
  if (value.version !== 1 || typeof value.enabled !== "boolean" || typeof value.updatedAt !== "string") return false;
  if (!Array.isArray(value.platforms)) return false;
  return value.platforms.every((platform) => DEFAULT_PLATFORMS.includes(platform));
}
async function requireProjectArtifact(projectPath) {
  const projectPathname = join(projectPath, FLOWWEAVE_DIR, "project.json");
  try {
    await stat(projectPathname);
  } catch (error) {
    throw new Error(`Cannot connect external Agents: required FlowWeave project artifact is missing at "${projectPathname}". ${formatError(error)}`);
  }
}
async function readProjectArtifacts(projectPath) {
  const root = join(projectPath, FLOWWEAVE_DIR);
  const project = await readRequiredJson(join(root, "project.json"));
  const [canvas, architecture, sequences, fileTree, taskPaths] = await Promise.all([
    readOptionalJson(join(root, "canvas", "main.canvas.json")),
    readOptionalJson(join(root, "architecture-map.json")),
    readOptionalJson(join(root, "sequence-diagrams.json")),
    readOptionalText(join(root, "context", "file-tree.md")),
    listTaskPaths(join(root, "tasks"), projectPath)
  ]);
  const scanFingerprint = project.scanFingerprint;
  return {
    project,
    canvas: artifactMatchesScan(scanFingerprint, canvas?.scanFingerprint) && canvas?.artifactState !== "stale" ? canvas : void 0,
    architecture: artifactMatchesScan(scanFingerprint, architecture?.metadata?.inputFingerprint) ? architecture : void 0,
    sequences: artifactMatchesScan(scanFingerprint, sequences?.metadata?.inputFingerprint) ? sequences : void 0,
    fileTree,
    taskPaths
  };
}
function artifactMatchesScan(scanFingerprint, artifactFingerprint) {
  return !scanFingerprint || scanFingerprint === artifactFingerprint;
}
function buildAgentContext(projectPath, artifacts) {
  const lines = [
    "# FlowWeave Agent Context",
    "",
    `Project: ${artifacts.project.projectName}`,
    `Project root: ${projectPath}`,
    `Generated: ${(/* @__PURE__ */ new Date()).toISOString()}`,
    "",
    "## Agent Instructions",
    "",
    "- Treat FlowWeave artifacts as navigation context, then verify important claims against the source code.",
    "- Read source files needed for the user's request. Do not invent files, symbols, calls, or behavior.",
    "- You may modify project files when the user asks you to implement a change.",
    "- After modifying files, report the changed file paths and the verification you ran.",
    "- Ask the user to return to FlowWeave to review Git diff, refresh the project scan, or rollback when needed.",
    "- When asked to process the current FlowWeave pending request, inspect `.flowweave/agent-bridge/*/request.json`, choose the newest request without a response, and follow its `instructionsPath`.",
    "",
    "## FlowWeave Artifacts",
    "",
    "- Project scan: `.flowweave/project.json`",
    "- Canvas: `.flowweave/canvas/main.canvas.json`",
    "- File tree: `.flowweave/context/file-tree.md`",
    `- Architecture map: ${artifacts.architecture ? "`.flowweave/architecture-map.json`" : "not generated"}`,
    `- Sequence diagrams: ${artifacts.sequences ? "`.flowweave/sequence-diagrams.json`" : "not generated"}`,
    `- Tasks: ${artifacts.taskPaths.length > 0 ? artifacts.taskPaths.map((path) => `\`${path}\``).join(", ") : "none"}`,
    "",
    "## Project Snapshot",
    "",
    `- Files: ${artifacts.project.summary.totalFiles}`,
    `- Folders: ${artifacts.project.summary.totalFolders}`,
    `- Languages: ${formatLanguages(artifacts.project.summary.languages)}`,
    `- Git branch: ${artifacts.project.git.branch ?? "unknown"}`,
    ""
  ];
  appendCanvasSummary(lines, artifacts.canvas);
  appendArchitectureSummary(lines, artifacts.architecture);
  appendSequenceSummary(lines, artifacts.sequences);
  if (artifacts.fileTree) {
    lines.push("## File Tree", "", artifacts.fileTree.trim(), "");
  }
  return `${lines.join("\n").trim()}
`;
}
function appendCanvasSummary(lines, canvas) {
  if (!canvas) return;
  lines.push("## Canvas Modules", "");
  for (const node of canvas.nodes) {
    const files = node.files.length > 0 ? ` Files: ${node.files.join(", ")}.` : "";
    lines.push(`- ${node.title} (${node.nodeType}): ${node.description || node.role || "No description."}${files}`);
  }
  lines.push("", "## Canvas Relationships", "");
  for (const edge of canvas.edges) {
    lines.push(`- ${edge.source} --${edge.relation}--> ${edge.target}${edge.guidanceNote ? `: ${edge.guidanceNote}` : ""}`);
  }
  lines.push("");
}
function appendArchitectureSummary(lines, architecture) {
  if (!architecture) return;
  lines.push("## Architecture Modules", "");
  for (const module of architecture.modules) {
    lines.push(`- ${module.title} (${module.category}): ${module.role}. Files: ${module.files.join(", ") || "none"}.`);
  }
  lines.push("", "## Architecture Relationships", "");
  for (const relationship of architecture.relationships) {
    lines.push(`- ${relationship.source} --${relationship.relation}--> ${relationship.target}: ${relationship.description}`);
  }
  lines.push("");
}
function appendSequenceSummary(lines, sequences) {
  if (!sequences) return;
  lines.push(
    "## Sequence Diagrams",
    "",
    `- Architectural: ${sequences.architectural.title}. ${sequences.architectural.summary}`,
    `- Detailed design: ${sequences.detailedDesign.title}. ${sequences.detailedDesign.summary}`,
    ""
  );
}
function buildManagedInstructionBlock() {
  return [
    FLOWWEAVE_BLOCK_START,
    "## FlowWeave Project Context",
    "",
    "Before analyzing or changing this project, read `.flowweave/agent-context.md`.",
    "Use it as navigation context, verify behavior against source code, and report changed files after edits.",
    "When the user says `使用 FlowWeave 上下文处理当前待办`, process the newest pending request under `.flowweave/agent-bridge` and write the required response atomically.",
    FLOWWEAVE_BLOCK_END
  ].join("\n");
}
async function planManagedBlockUpsert(entries, block) {
  return Promise.all(entries.map(async (entry) => {
    const existing = await readOptionalText(entry.filePath) ?? "";
    const content = entry.platform === "cursor" && !existing.trim() ? `${CURSOR_FRONTMATTER}

${block}
` : upsertManagedBlock(existing, block, entry.filePath);
    return { filePath: entry.filePath, content };
  }));
}
async function planManagedBlockRemoval(entries) {
  const updates = [];
  for (const entry of entries) {
    const existing = await readOptionalText(entry.filePath);
    if (existing === void 0) continue;
    let content = removeManagedBlock(existing, entry.filePath);
    if (entry.platform === "cursor" && content.trim() === CURSOR_FRONTMATTER) {
      content = "";
    }
    updates.push({ filePath: entry.filePath, content });
  }
  return updates;
}
function upsertManagedBlock(existing, block, filePath) {
  const range = findManagedBlock(existing, filePath);
  if (!range) {
    return existing.trim() ? `${existing.trimEnd()}

${block}
` : `${block}
`;
  }
  return `${existing.slice(0, range.start)}${block}${existing.slice(range.end)}`.trimEnd() + "\n";
}
function removeManagedBlock(existing, filePath) {
  const range = findManagedBlock(existing, filePath);
  if (!range) return existing;
  const before = existing.slice(0, range.start).trimEnd();
  const after = existing.slice(range.end).trimStart();
  if (before && after) return `${before}

${after}`.trimEnd() + "\n";
  return `${before}${after}`.trimEnd() + (before || after ? "\n" : "");
}
function findManagedBlock(content, filePath) {
  const starts = markerIndexes(content, FLOWWEAVE_BLOCK_START);
  const ends = markerIndexes(content, FLOWWEAVE_BLOCK_END);
  if (starts.length === 0 && ends.length === 0) return void 0;
  if (starts.length !== 1 || ends.length !== 1 || starts[0] > ends[0]) {
    throw new Error(
      `FlowWeave managed block markers are malformed or duplicated in "${filePath}". Expected exactly one "${FLOWWEAVE_BLOCK_START}" followed by one "${FLOWWEAVE_BLOCK_END}".`
    );
  }
  return {
    start: starts[0],
    end: ends[0] + FLOWWEAVE_BLOCK_END.length
  };
}
function markerIndexes(content, marker) {
  const indexes = [];
  let cursor = 0;
  while (cursor < content.length) {
    const index = content.indexOf(marker, cursor);
    if (index === -1) break;
    indexes.push(index);
    cursor = index + marker.length;
  }
  return indexes;
}
async function latestArtifactModificationTime(projectPath) {
  const root = join(projectPath, FLOWWEAVE_DIR);
  const paths = [
    join(root, "project.json"),
    join(root, "canvas", "main.canvas.json"),
    join(root, "architecture-map.json"),
    join(root, "sequence-diagrams.json"),
    join(root, "context", "file-tree.md")
  ];
  const times = await Promise.all(paths.map(async (filePath) => {
    try {
      return (await stat(filePath)).mtimeMs;
    } catch (error) {
      if (isMissingFileError(error)) return 0;
      throw error;
    }
  }));
  return Math.max(...times);
}
async function findConnectionFileIssue(projectPath, platforms) {
  const contextPath = connectionPaths(projectPath).contextPath;
  if (await readOptionalText(contextPath) === void 0) {
    return `Connection file is missing: ${contextPath}`;
  }
  for (const entry of platformEntries(projectPath, platforms)) {
    const content = await readOptionalText(entry.filePath);
    if (content === void 0) return `Connection file is missing: ${entry.filePath}`;
    if (!findManagedBlock(content, entry.filePath)) {
      return `FlowWeave managed instructions are missing from: ${entry.filePath}`;
    }
    if (entry.platform === "cursor" && !content.includes("alwaysApply: true")) {
      return `Cursor FlowWeave rule is not configured as an automatic project rule: ${entry.filePath}`;
    }
  }
  return void 0;
}
async function listTaskPaths(tasksPath, projectPath) {
  try {
    const entries = await readdir(tasksPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && (entry.name === "current.task.md" || entry.name === "current.task.json")).map((entry) => relative(projectPath, join(tasksPath, entry.name))).sort();
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw new Error(`Reading FlowWeave task artifacts failed at "${tasksPath}": ${formatError(error)}`);
  }
}
async function readRequiredJson(filePath) {
  const content = await readFile(filePath, "utf8");
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in FlowWeave artifact "${filePath}": ${formatError(error)}`);
  }
}
async function readOptionalJson(filePath) {
  const content = await readOptionalText(filePath);
  if (content === void 0) return void 0;
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in FlowWeave artifact "${filePath}": ${formatError(error)}`);
  }
}
async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return void 0;
    throw new Error(`Reading "${filePath}" failed: ${formatError(error)}`);
  }
}
async function writeJsonAtomic(filePath, value) {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}
`);
}
async function writeTextAtomic(filePath, content) {
  const parentPath = dirname(filePath);
  await mkdir(parentPath, { recursive: true });
  const temporaryPath = join(parentPath, `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new Error(`Writing FlowWeave Agent connection file "${filePath}" failed: ${formatError(error)}`);
  }
}
function formatLanguages(languages) {
  const entries = Object.entries(languages).sort((left, right) => right[1] - left[1]);
  return entries.length > 0 ? entries.map(([language, count]) => `${language} (${count})`).join(", ") : "unknown";
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isMissingFileError(error) {
  return isRecord(error) && error.code === "ENOENT";
}
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
const execFileAsync = promisify(execFile);
const DEFAULT_IGNORE = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/out/**",
  "**/build/**",
  "**/release/**",
  "**/.cache/**",
  "**/.parcel-cache/**",
  "**/.pytest_cache/**",
  "**/.ruff_cache/**",
  "**/.mypy_cache/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/env/**",
  "**/target/**",
  "**/vendor/**",
  "**/Pods/**",
  "**/DerivedData/**",
  "**/*.app/**",
  "**/.next/**",
  `**/${FLOWWEAVE_DIR}/**`,
  "**/coverage/**",
  "**/.turbo/**",
  "**/.vercel/**",
  "**/.runtime/**",
  "**/logs/**",
  "**/*.log",
  "**/.DS_Store"
];
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ENTRIES = 2500;
const LANGUAGE_BY_EXT = {
  ".js": "JavaScript",
  ".jsx": "JavaScript React",
  ".ts": "TypeScript",
  ".tsx": "TypeScript React",
  ".py": "Python",
  ".go": "Go",
  ".java": "Java",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".php": "PHP",
  ".cs": "C#",
  ".json": "JSON",
  ".md": "Markdown",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".sql": "SQL",
  ".prisma": "Prisma",
  ".css": "CSS",
  ".scss": "SCSS",
  ".html": "HTML"
};
async function scanProject(rootPath, options = {}) {
  const ignore = [...DEFAULT_IGNORE, ...options.ignore ?? []];
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = await fg("**/*", {
    cwd: rootPath,
    deep: maxDepth,
    dot: true,
    ignore,
    markDirectories: true,
    onlyFiles: false,
    stats: false,
    unique: true,
    followSymbolicLinks: false
  });
  const nonSymlinkEntries = await filterSafeEntries(rootPath, entries);
  const filteredEntries = nonSymlinkEntries.filter((entry) => {
    const depth = entry.split("/").filter(Boolean).length - 1;
    return depth <= maxDepth;
  });
  const visibleEntries = filteredEntries.slice(0, maxEntries);
  const files = buildTree(visibleEntries);
  const summary = buildSummary(visibleEntries);
  summary.displayedEntries = visibleEntries.length;
  summary.truncated = filteredEntries.length > visibleEntries.length;
  const git2 = await readGitSummary(rootPath);
  const project = {
    version: 1,
    projectName: basename(rootPath),
    rootPath,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    git: git2,
    summary,
    files
  };
  project.scanFingerprint = createStructureFingerprint(
    project.projectName,
    project.summary.languages,
    flattenFiles$1(project.files)
  );
  return project;
}
async function filterSafeEntries(rootPath, entries) {
  const canonicalRoot = await realpath(rootPath);
  const results = await Promise.all(entries.map(async (entry) => {
    const relativeEntry = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const absoluteEntry = join(rootPath, ...relativeEntry.split("/"));
    const info = await lstat(absoluteEntry);
    if (info.isSymbolicLink()) return void 0;
    const canonicalEntry = await realpath(absoluteEntry);
    const fromRoot = relative(canonicalRoot, canonicalEntry);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return void 0;
    return entry;
  }));
  return results.filter((entry) => Boolean(entry));
}
function flattenFiles$1(nodes) {
  return nodes.flatMap((node) => [
    ...node.type === "file" ? [{ path: node.path, language: node.language }] : [],
    ...flattenFiles$1(node.children ?? [])
  ]);
}
function buildTree(entries) {
  const rootNodes = [];
  const nodesByPath = /* @__PURE__ */ new Map();
  for (const rawEntry of entries.sort()) {
    const normalizedEntry = rawEntry.endsWith("/") ? rawEntry.slice(0, -1) : rawEntry;
    const parts = normalizedEntry.split("/").filter(Boolean);
    const isFolder = rawEntry.endsWith("/");
    const nodePath = parts.join("/");
    const parentPath = parts.slice(0, -1).join("/");
    const node = {
      id: nodePath,
      name: parts.at(-1) ?? nodePath,
      path: nodePath,
      type: isFolder ? "folder" : "file",
      depth: parts.length - 1,
      language: isFolder ? void 0 : detectLanguage(nodePath),
      children: isFolder ? [] : void 0
    };
    nodesByPath.set(nodePath, node);
    if (!parentPath) {
      rootNodes.push(node);
      continue;
    }
    const parent = nodesByPath.get(parentPath);
    if (parent) {
      parent.children = parent.children ?? [];
      parent.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }
  return rootNodes;
}
function buildSummary(entries) {
  const summary = {
    totalFiles: 0,
    totalFolders: 0,
    languages: {}
  };
  for (const entry of entries) {
    if (entry.endsWith("/")) {
      summary.totalFolders += 1;
      continue;
    }
    summary.totalFiles += 1;
    const language = detectLanguage(entry);
    if (language) {
      summary.languages[language] = (summary.languages[language] ?? 0) + 1;
    }
  }
  return summary;
}
function detectLanguage(filePath) {
  return LANGUAGE_BY_EXT[extname(filePath).toLowerCase()];
}
async function readGitSummary(rootPath) {
  try {
    const { stdout: inside } = await execFileAsync("git", ["-C", rootPath, "rev-parse", "--is-inside-work-tree"]);
    if (inside.trim() !== "true") return { isRepo: false };
    const [branch, remote, status] = await Promise.all([
      execFileAsync("git", ["-C", rootPath, "branch", "--show-current"]).catch(() => ({ stdout: "" })),
      execFileAsync("git", ["-C", rootPath, "remote", "get-url", "origin"]).catch(() => ({ stdout: "" })),
      execFileAsync("git", ["-C", rootPath, "status", "--short"]).catch(() => ({ stdout: "" }))
    ]);
    return {
      isRepo: true,
      branch: branch.stdout.trim() || "detached",
      remote: remote.stdout.trim() || void 0,
      status: status.stdout.trim()
    };
  } catch {
    return { isRepo: false };
  }
}
const SEQUENCE_DIAGRAM_FILE = "sequence-diagrams.json";
const MAX_PROMPT_FILES = 180;
const MAX_SYMBOLS_PER_FILE = 14;
const REPRESENTATIVE_FILE_LIMIT = 50;
const sequenceFlights = /* @__PURE__ */ new Map();
async function generateSequenceDiagrams(project, agentId) {
  const flightKey = `${project.rootPath}:${agentId}`;
  const existing = sequenceFlights.get(flightKey);
  if (existing) return existing;
  const flight = generateSequenceDiagramsOnce(project, agentId).finally(() => sequenceFlights.delete(flightKey));
  sequenceFlights.set(flightKey, flight);
  return flight;
}
async function generateSequenceDiagramsOnce(project, agentId) {
  const facts = await buildProjectStructureFacts(project);
  const representativeFacts = { ...facts, files: selectRepresentativeStructureFacts(facts, REPRESENTATIVE_FILE_LIMIT) };
  const storedArchitecture = await readArchitectureMap(project.rootPath);
  const architectureMap = storedArchitecture?.source === "agent" && storedArchitecture.metadata ? storedArchitecture : void 0;
  const inputFingerprint = project.scanFingerprint ?? createScanFingerprint({ representativeFacts, architecture: architectureMap?.metadata?.inputFingerprint });
  const prompt = buildSequenceDiagramPrompt(representativeFacts, architectureMap);
  if (agentId === "mock") {
    const inferred = createFallbackSequenceBundle(project, representativeFacts, architectureMap, "agent");
    const parsed = parseSequenceDiagramBundleJson(mockSequenceBundleJson(inferred), project);
    if (!parsed) return failedSequenceResult(agentId, "invalid-output", "Mock agent returned invalid sequence diagram JSON.", []);
    const quality = validateSequenceBundle(parsed, representativeFacts);
    if (!quality.valid) return failedSequenceResult(agentId, "quality-rejected", quality.reasons.join("; "), []);
    const bundle = withSequenceMetadata(parsed, agentId, "mock", inputFingerprint, quality);
    await writeSequenceDiagramBundle(project.rootPath, bundle);
    return { bundle, outcome: "generated" };
  }
  const projectId = await registerProject(project.rootPath);
  const runIds = [];
  try {
    const result = await startToolPlan({
      projectId,
      toolId: agentId,
      prompt,
      executionMode: "plan",
      purpose: "artifact-analysis"
    });
    runIds.push(result.id);
    if (result.status !== "completed") {
      return cachedOrFailed(project.rootPath, failedSequenceError(agentId, "agent-failed", result.stderr ?? result.summary ?? "Agent sequence diagram generation failed.", runIds));
    }
    const output = collectStdout(result.events);
    const parsed = parseSequenceDiagramBundleJson(output, project, facts, architectureMap);
    const quality = parsed ? validateSequenceBundle(parsed, representativeFacts) : void 0;
    if (parsed && quality?.valid) {
      const bundle2 = withSequenceMetadata(parsed, agentId, result.id, inputFingerprint, quality);
      await writeSequenceDiagramBundle(project.rootPath, bundle2);
      return { bundle: bundle2, outcome: "generated" };
    }
    const firstFailure = parsed ? quality?.reasons.join("; ") ?? "Sequence quality validation failed." : "Agent returned invalid sequence diagram JSON.";
    const retry = await startToolPlan({
      projectId,
      toolId: agentId,
      prompt: buildSequenceRepairPrompt(prompt, output, firstFailure),
      executionMode: "plan",
      purpose: "artifact-analysis"
    });
    runIds.push(retry.id);
    if (retry.status !== "completed") {
      return cachedOrFailed(project.rootPath, failedSequenceError(agentId, "agent-failed", retry.stderr ?? retry.summary ?? "Sequence repair run failed.", runIds, firstFailure));
    }
    const retryOutput = collectStdout(retry.events);
    const retryParsed = parseSequenceDiagramBundleJson(retryOutput, project, facts, architectureMap);
    const retryQuality = retryParsed ? validateSequenceBundle(retryParsed, representativeFacts) : void 0;
    if (!retryParsed || !retryQuality?.valid) {
      const retryFailure = retryParsed ? retryQuality?.reasons.join("; ") ?? "Sequence quality validation failed." : "Repair run returned invalid sequence diagram JSON.";
      return cachedOrFailed(
        project.rootPath,
        failedSequenceError(agentId, retryParsed ? "quality-rejected" : "invalid-output", retryFailure, runIds, firstFailure, retryFailure)
      );
    }
    const bundle = withSequenceMetadata(retryParsed, agentId, retry.id, inputFingerprint, retryQuality);
    await writeSequenceDiagramBundle(project.rootPath, bundle);
    return { bundle, outcome: "generated" };
  } catch (error) {
    return cachedOrFailed(project.rootPath, failedSequenceError(agentId, "agent-failed", formatErrorMessage(error), runIds));
  }
}
async function reviseSequenceDiagram(project, agentId, kind, instruction) {
  const facts = await buildProjectStructureFacts(project);
  const architectureMap = await readArchitectureMap(project.rootPath);
  const current = await readSequenceDiagrams(project.rootPath);
  if (!current) throw new Error("No trusted sequence diagram exists to revise.");
  const currentDiagram = selectDiagram(current, kind);
  const prompt = buildSequenceDiagramRevisionPrompt(currentDiagram, instruction, facts, architectureMap);
  if (agentId === "mock") {
    const parsed2 = parseSequenceDiagramJson(mockRevisedDiagramJson(currentDiagram, instruction), kind);
    const bundle2 = parsed2 ? replaceDiagram(current, parsed2) : current;
    await writeSequenceDiagramBundle(project.rootPath, bundle2);
    return bundle2;
  }
  const result = await startToolPlan({
    projectId: await registerProject(project.rootPath),
    toolId: agentId,
    prompt,
    executionMode: "plan",
    purpose: "artifact-analysis"
  });
  if (result.status !== "completed") {
    throw new Error(result.stderr ?? result.summary ?? "Agent sequence diagram revision failed");
  }
  const parsed = parseSequenceDiagramJson(collectStdout(result.events), kind);
  if (!parsed) {
    throw new Error("Agent did not return a valid sequence diagram JSON object.");
  }
  const bundle = replaceDiagram(current, parsed);
  await writeSequenceDiagramBundle(project.rootPath, bundle);
  return bundle;
}
async function readSequenceDiagrams(projectPath) {
  const filePath = join(projectPath, FLOWWEAVE_DIR, SEQUENCE_DIAGRAM_FILE);
  return readFile(filePath, "utf8").then((content) => JSON.parse(content)).catch(() => void 0);
}
function buildSequenceDiagramPrompt(facts, architectureMap) {
  return `You are FlowWeave's sequence diagram analyst. Return only JSON.

Goal:
Create two project sequence diagrams from the code structure and architecture map so a user can understand the real end-to-end workflow and the concrete code-level call sequence.

Project: ${facts.projectName}
Languages: ${JSON.stringify(facts.languages)}

ArchitectureMap:
${JSON.stringify(compactArchitectureMap(architectureMap), null, 2)}

ProjectStructureFacts:
${JSON.stringify(compactFactsForPrompt(facts), null, 2)}

Analysis priorities:
- Use only the supplied ArchitectureMap and ProjectStructureFacts. Do not invent files, symbols, calls, endpoints, databases, queues, or third-party systems.
- The architectural diagram should show the end-to-end workflow across macro participants such as actor, frontend/component, gateway/API boundary, service, database, external system, and worker.
- The detailed-design diagram should show the code-level call sequence across real controllers, classes, interfaces, repositories, utilities, workers, and methods.
- Order messages by the real execution flow: entry/request, validation or orchestration, domain work, data access, external calls or events, return/response.
- Fill methodName, input, output, and evidence whenever the facts provide calls, symbols, imports, exports, or externalCalls.
- When the code facts are incomplete, label the detail as inferred from imports/calls/file role instead of presenting it as certain.

Return this exact JSON shape:
{
  "architectural": {
    "id": "architectural-sequence",
    "title": "Architectural Sequence Diagram",
    "kind": "architectural",
    "summary": "macro collaboration across system components",
    "participants": [{
      "id": "stable-kebab-id",
      "title": "Frontend App|Gateway|Order Service|Payment Gateway",
      "kind": "actor|component|service|gateway|database|external|controller|class|interface|repository|worker|utility",
      "description": "one sentence role",
      "filePath": "optional source path",
      "symbol": "optional source symbol"
    }],
    "messages": [{
      "id": "stable-kebab-id",
      "sequence": 1,
      "from": "participant-id",
      "to": "participant-id",
      "kind": "sync|async|return|event|external",
      "label": "request, response, event, or integration call",
      "description": "what happens",
      "methodName": "optional method or endpoint",
      "input": "important input parameters",
      "output": "important return value",
      "evidence": [{"filePath": "path", "symbol": "optional", "detail": "specific evidence"}]
    }],
    "evidence": [{"filePath": "path", "symbol": "optional", "detail": "why this diagram is credible"}]
  },
  "detailedDesign": {
    "id": "detailed-design-sequence",
    "title": "Detailed Design Sequence Diagram",
    "kind": "detailed-design",
    "summary": "code-level method call sequence",
    "participants": [],
    "messages": [],
    "evidence": []
  }
}

Rules:
- The architectural diagram uses macro participants: frontend app, gateway, services, databases, workers, and third-party systems.
- The detailed-design diagram maps directly to code structure: Controller, Service, Repository, Interface, Class, and concrete method calls.
- Detailed-design messages must include methodName, input, output, and evidence when the code facts provide them.
- Every message must reference valid participant ids from its diagram.
- Prefer 4-10 participants and 4-14 messages per diagram.
- Return valid JSON only.`;
}
function buildSequenceDiagramRevisionPrompt(currentDiagram, instruction, facts, architectureMap) {
  return `You are FlowWeave's sequence diagram editor. Return only JSON.

Goal:
Revise the current ${currentDiagram.kind} sequence diagram according to the user instruction. Return the complete updated diagram object, not a patch.

User instruction:
${instruction}

Current diagram:
${JSON.stringify(currentDiagram, null, 2)}

ArchitectureMap:
${JSON.stringify(compactArchitectureMap(architectureMap), null, 2)}

ProjectStructureFacts:
${JSON.stringify(compactFactsForPrompt(facts), null, 2)}

Revision priorities:
- Preserve reliable existing evidence and participant mappings unless the user instruction or code facts require a change.
- Update participants and messages together when the requested change affects components, classes, methods, inputs, outputs, or ordering.
- Keep the workflow truthful to the supplied ArchitectureMap and ProjectStructureFacts. Do not invent files, symbols, calls, endpoints, databases, queues, or third-party systems.
- Keep message order aligned with the real execution flow and fill methodName, input, output, and evidence for changed method calls when possible.

Return this exact JSON shape:
{
  "id": "stable-diagram-id",
  "title": "Diagram title",
  "kind": "${currentDiagram.kind}",
  "summary": "updated summary",
  "participants": [],
  "messages": [],
  "evidence": []
}

Rules:
- Keep kind exactly "${currentDiagram.kind}".
- Every message must reference existing participant ids.
- Preserve useful evidence and add code evidence for changed method calls when possible.
- Return valid JSON only.`;
}
function parseSequenceDiagramBundleJson(output, project, facts, architectureMap) {
  const parsed = parseFirstJsonObject(output);
  if (!parsed) return void 0;
  const architectural = normalizeDiagram(parsed.architectural, "architectural");
  const detailedDesign = normalizeDiagram(parsed.detailedDesign, "detailed-design");
  if (!architectural || !detailedDesign) return void 0;
  if (!isUsableDiagram(architectural) || !isUsableDiagram(detailedDesign)) return void 0;
  return {
    version: 1,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    source: "agent",
    architectural,
    detailedDesign
  };
}
function parseSequenceDiagramJson(output, kind) {
  const parsed = parseFirstJsonObject(output);
  if (!parsed) return void 0;
  return normalizeDiagram(parsed, kind);
}
function normalizeDiagram(diagram, kind) {
  if (!diagram || diagram.kind !== kind) return void 0;
  const { participants, idAliases } = normalizeParticipants(diagram.participants);
  const participantIds = new Set(participants.map((participant) => participant.id));
  const messages = normalizeMessages(diagram.messages, participantIds, idAliases);
  const normalized = {
    id: safeId(diagram.id ?? `${kind}-sequence`),
    title: diagram.title?.trim() || defaultDiagramTitle(kind),
    kind,
    summary: diagram.summary?.trim() || defaultDiagramSummary(kind),
    participants,
    messages,
    evidence: normalizeEvidence(diagram.evidence)
  };
  return isUsableDiagram(normalized) ? normalized : void 0;
}
function normalizeParticipants(participants) {
  const seen = /* @__PURE__ */ new Set();
  const idAliases = /* @__PURE__ */ new Map();
  const normalizedParticipants = (participants ?? []).map((participant, index) => {
    const id = safeId(participant.id || participant.title || `participant-${index + 1}`);
    if (seen.has(id)) return void 0;
    seen.add(id);
    const normalizedParticipant = {
      id,
      title: participant.title?.trim() || titleFromId(id),
      kind: isParticipantKind(participant.kind) ? participant.kind : "component",
      description: participant.description?.trim() || "Sequence participant.",
      filePath: stringOrUndefined(participant.filePath),
      symbol: stringOrUndefined(participant.symbol)
    };
    addParticipantAlias(idAliases, participant.id, id);
    addParticipantAlias(idAliases, id, id);
    addParticipantAlias(idAliases, participant.title, id);
    addParticipantAlias(idAliases, normalizedParticipant.title, id);
    return normalizedParticipant;
  }).filter((participant) => Boolean(participant)).slice(0, 16);
  return { participants: normalizedParticipants, idAliases };
}
function normalizeMessages(messages, participantIds, idAliases) {
  const seen = /* @__PURE__ */ new Set();
  return (messages ?? []).map((message, index) => {
    const from = resolveParticipantId(message.from, idAliases);
    const to = resolveParticipantId(message.to, idAliases);
    if (!from || !to || !participantIds.has(from) || !participantIds.has(to) || from === to) {
      return void 0;
    }
    const id = safeId(message.id || `${from}-${to}-${index + 1}`);
    if (seen.has(id)) return void 0;
    seen.add(id);
    return {
      id,
      sequence: typeof message.sequence === "number" && Number.isFinite(message.sequence) ? message.sequence : index + 1,
      from,
      to,
      kind: isMessageKind(message.kind) ? message.kind : "sync",
      label: message.label?.trim() || message.methodName?.trim() || `${from} calls ${to}`,
      description: stringOrUndefined(message.description),
      methodName: stringOrUndefined(message.methodName),
      input: stringOrUndefined(message.input),
      output: stringOrUndefined(message.output),
      evidence: normalizeEvidence(message.evidence)
    };
  }).filter((message) => Boolean(message)).sort((a, b) => a.sequence - b.sequence).map((message, index) => ({ ...message, sequence: index + 1 })).slice(0, 40);
}
function normalizeEvidence(evidence) {
  return (evidence ?? []).map((item) => ({
    filePath: stringOrUndefined(item.filePath),
    symbol: stringOrUndefined(item.symbol),
    detail: item.detail?.trim() || "Sequence evidence"
  })).slice(0, 30);
}
function createFallbackSequenceBundle(project, facts, architectureMap, source) {
  return {
    version: 1,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    source,
    architectural: createFallbackArchitecturalDiagram(facts, architectureMap),
    detailedDesign: createFallbackDetailedDiagram(facts)
  };
}
function createFallbackArchitecturalDiagram(facts, architectureMap) {
  const architectureModules = architectureMap?.modules.slice(0, 10) ?? [];
  const participants = architectureModules.length > 0 ? architectureModules.map((module) => ({
    id: module.id,
    title: module.title,
    kind: participantKindFromCategory(module.category),
    description: module.role,
    filePath: module.files[0],
    symbol: module.symbols[0]?.name
  })) : fallbackFileParticipants(facts.files.slice(0, 6), "architectural");
  const participantIds = new Set(participants.map((participant) => participant.id));
  const relationships = architectureMap?.relationships ?? [];
  const messages = relationships.filter((relationship) => participantIds.has(relationship.source) && participantIds.has(relationship.target)).slice(0, 14).map((relationship, index) => ({
    id: safeId(relationship.id || `${relationship.source}-${relationship.target}-${index + 1}`),
    sequence: index + 1,
    from: relationship.source,
    to: relationship.target,
    kind: relationship.relation === "publishes_event" || relationship.relation === "subscribes_event" ? "event" : relationship.relation === "external_api" ? "external" : "sync",
    label: relationship.description || `${relationship.source} -> ${relationship.target}`,
    description: relationship.description,
    evidence: relationship.evidence
  }));
  return {
    id: "architectural-sequence",
    title: "Architectural Sequence Diagram",
    kind: "architectural",
    summary: "Macro collaboration inferred from architecture modules and relationships.",
    participants,
    messages: messages.length > 0 ? messages : fallbackMessages(participants),
    evidence: architectureMap?.relationships.slice(0, 6).flatMap((relationship) => relationship.evidence) ?? []
  };
}
function createFallbackDetailedDiagram(facts) {
  const symbolFiles = facts.files.filter((file) => file.symbols.length > 0).slice(0, 10);
  const participants = fallbackFileParticipants(symbolFiles.length > 0 ? symbolFiles : facts.files.slice(0, 8), "detailed-design");
  const participantByFile = new Map(participants.map((participant) => [participant.filePath, participant.id]));
  const messages = [];
  for (const file of symbolFiles) {
    const source = participantByFile.get(file.path);
    if (!source) continue;
    for (const importPath of file.imports.slice(0, 4)) {
      const targetFile = findImportedFile(importPath, symbolFiles);
      const target = targetFile ? participantByFile.get(targetFile.path) : void 0;
      if (!target || target === source) continue;
      messages.push({
        id: safeId(`${source}-${target}-${messages.length + 1}`),
        sequence: messages.length + 1,
        from: source,
        to: target,
        kind: "sync",
        label: file.calls[0] ?? `imports ${importPath}`,
        methodName: file.calls[0],
        input: "inferred from caller context",
        output: "inferred return value",
        evidence: [{ filePath: file.path, symbol: file.symbols[0]?.name, detail: `Import reference: ${importPath}` }]
      });
      if (messages.length >= 14) break;
    }
    if (messages.length >= 14) break;
  }
  return {
    id: "detailed-design-sequence",
    title: "Detailed Design Sequence Diagram",
    kind: "detailed-design",
    summary: "Code-level call sequence inferred from imports, symbols, and call expressions.",
    participants,
    messages: messages.length > 0 ? messages : fallbackMessages(participants),
    evidence: symbolFiles.slice(0, 8).map((file) => ({ filePath: file.path, symbol: file.symbols[0]?.name, detail: `Symbols: ${file.symbols.map((symbol) => symbol.name).slice(0, 4).join(", ")}` }))
  };
}
function fallbackFileParticipants(files, kind) {
  return files.slice(0, 10).map((file, index) => {
    const symbol = file.symbols[0];
    const id = safeId(symbol?.name ?? file.path);
    return {
      id,
      title: symbol?.name ?? titleFromPath(file.path),
      kind: kind === "detailed-design" ? participantKindFromSymbol(symbol?.kind, file.path) : participantKindFromPath(file.path),
      description: symbol ? `${symbol.kind} in ${file.path}.` : `Source file ${file.path}.`,
      filePath: file.path,
      symbol: symbol?.name
    };
  });
}
function fallbackMessages(participants) {
  return participants.slice(0, -1).map((participant, index) => ({
    id: safeId(`${participant.id}-${participants[index + 1].id}`),
    sequence: index + 1,
    from: participant.id,
    to: participants[index + 1].id,
    kind: "sync",
    label: `${participant.title} collaborates with ${participants[index + 1].title}`,
    description: "Inferred sequence relation from available project structure.",
    methodName: participants[index + 1].symbol,
    input: "project context",
    output: "next step result",
    evidence: participant.filePath ? [{ filePath: participant.filePath, symbol: participant.symbol, detail: "Fallback sequence participant." }] : []
  }));
}
function replaceDiagram(bundle, diagram) {
  return {
    ...bundle,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    source: "agent",
    architectural: diagram.kind === "architectural" ? diagram : bundle.architectural,
    detailedDesign: diagram.kind === "detailed-design" ? diagram : bundle.detailedDesign
  };
}
function selectDiagram(bundle, kind) {
  return kind === "architectural" ? bundle.architectural : bundle.detailedDesign;
}
async function cachedOrFailed(projectPath, error) {
  const cached = await readSequenceDiagrams(projectPath);
  if (cached) {
    return { bundle: cached, outcome: "cached", error };
  }
  return { outcome: "failed", error };
}
function validateSequenceBundle(bundle, facts) {
  const files = new Set(facts.files.map((file) => file.path));
  const diagrams = [bundle.architectural, bundle.detailedDesign];
  const evidence = diagrams.flatMap((diagram) => [
    ...diagram.evidence ?? [],
    ...diagram.messages.flatMap((message) => message.evidence ?? [])
  ]);
  const coveredFiles = new Set(evidence.map((item) => item.filePath).filter((file) => typeof file === "string" && files.has(file)));
  const validEvidence = evidence.filter((item) => Boolean(item.filePath) && files.has(item.filePath));
  const fileCoverage = facts.files.length === 0 ? 0 : coveredFiles.size / facts.files.length;
  const evidenceCoverage = evidence.length === 0 ? 0 : validEvidence.length / evidence.length;
  const reasons = [];
  for (const diagram of diagrams) {
    const participantIds = new Set(diagram.participants.map((participant) => participant.id));
    if (diagram.messages.length === 0) reasons.push(`${diagram.kind} has no messages.`);
    for (const message of diagram.messages) {
      if (!participantIds.has(message.from) || !participantIds.has(message.to)) {
        reasons.push(`${diagram.kind} message ${message.id} has an invalid endpoint.`);
      }
      if (!message.evidence?.some((item) => item.filePath && files.has(item.filePath))) {
        reasons.push(`${diagram.kind} message ${message.id} has no valid source evidence.`);
      }
    }
  }
  const firstMessage = bundle.architectural.messages[0];
  const firstParticipant = bundle.architectural.participants.find((participant) => participant.id === firstMessage?.from);
  const firstPath = firstParticipant?.filePath?.toLowerCase();
  if (!firstPath || !/(^|\/)(main|index|app|server|bootstrap)\.|ipc|controller|route|handler/.test(firstPath)) {
    reasons.push("Architectural sequence does not start from a verified source entry.");
  }
  if (evidenceCoverage < 0.7) reasons.push(`Evidence coverage ${evidenceCoverage.toFixed(2)} is below 0.70.`);
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], fileCoverage, evidenceCoverage };
}
function withSequenceMetadata(bundle, agentId, runId, inputFingerprint, quality) {
  const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return {
    ...bundle,
    version: 2,
    source: "agent",
    generatedAt,
    metadata: {
      agentId,
      runId,
      generatedAt,
      inputFingerprint,
      fileCoverage: quality.fileCoverage,
      evidenceCoverage: quality.evidenceCoverage
    }
  };
}
function failedSequenceResult(agentId, code, message, runIds) {
  return { outcome: "failed", error: failedSequenceError(agentId, code, message, runIds) };
}
function failedSequenceError(agentId, code, message, runIds, firstFailure, retryFailure) {
  return {
    code,
    message,
    agentId,
    runId: runIds.at(-1),
    attemptRunIds: runIds,
    firstFailure,
    retryFailure
  };
}
function buildSequenceRepairPrompt(originalPrompt, output, failure) {
  return `${originalPrompt}

The previous response failed validation: ${failure}
Return one corrected JSON object only. Do not include Markdown fences or explanatory text.

Previous response:
${output.slice(0, 4e4)}`;
}
async function writeSequenceDiagramBundle(projectPath, bundle) {
  const root = join(projectPath, FLOWWEAVE_DIR);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, SEQUENCE_DIAGRAM_FILE), `${JSON.stringify(bundle, null, 2)}
`, "utf8");
}
function parseFirstJsonObject(output) {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) return void 0;
  try {
    return JSON.parse(match[0]);
  } catch {
    return void 0;
  }
}
function compactFactsForPrompt(facts) {
  return {
    ...facts,
    files: facts.files.slice(0, MAX_PROMPT_FILES).map((file) => ({
      path: file.path,
      language: file.language,
      imports: file.imports.slice(0, 24),
      exports: file.exports.slice(0, 20),
      symbols: file.symbols.slice(0, MAX_SYMBOLS_PER_FILE),
      calls: file.calls.slice(0, 24),
      externalCalls: file.externalCalls.slice(0, 12),
      moduleId: file.moduleId,
      role: file.role
    }))
  };
}
function compactArchitectureMap(map) {
  if (!map) return void 0;
  return {
    architectureStyle: map.architectureStyle,
    modules: map.modules.map((module) => ({
      id: module.id,
      title: module.title,
      category: module.category,
      role: module.role,
      files: module.files.slice(0, 10),
      symbols: module.symbols.slice(0, 12)
    })),
    relationships: map.relationships.slice(0, 80)
  };
}
function mockSequenceBundleJson(bundle) {
  return JSON.stringify(
    {
      architectural: bundle.architectural,
      detailedDesign: bundle.detailedDesign
    },
    null,
    2
  );
}
function mockRevisedDiagramJson(diagram, instruction) {
  return JSON.stringify(
    {
      ...diagram,
      summary: `${diagram.summary} Revision request: ${instruction}`,
      evidence: [...diagram.evidence ?? [], { detail: `User revision: ${instruction}` }]
    },
    null,
    2
  );
}
function collectStdout(events) {
  return events.filter((event) => event.type === "stdout").map((event) => event.content).join("\n");
}
function findImportedFile(importPath, files) {
  const normalized = importPath.replace(/^\.\.?\//, "").replace(/\.(ts|tsx|js|jsx|py|go|java|rs|php|cs)$/i, "");
  return files.find((file) => file.path.includes(normalized) || file.path.replace(/\.(ts|tsx|js|jsx|py|go|java|rs|php|cs)$/i, "").endsWith(normalized));
}
function participantKindFromCategory(category) {
  const map = {
    "api-boundary": "gateway",
    "domain-service": "service",
    "data-access": "database",
    "external-integration": "external",
    "job-worker": "worker",
    "shared-utility": "utility",
    "test-surface": "component"
  };
  return map[category];
}
function participantKindFromSymbol(kind, filePath) {
  if (/controller|route|router/i.test(filePath)) return "controller";
  if (/repository|db|database/i.test(filePath)) return "repository";
  if (kind === "class") return "class";
  return "interface";
}
function participantKindFromPath(filePath) {
  if (/gateway|api|controller|route|router/i.test(filePath)) return "gateway";
  if (/repository|db|database|schema/i.test(filePath)) return "database";
  if (/worker|queue|job/i.test(filePath)) return "worker";
  if (/client|external|payment|webhook/i.test(filePath)) return "external";
  return "service";
}
function isUsableDiagram(diagram) {
  return diagram.participants.length >= 2 && diagram.messages.length >= 1;
}
function isParticipantKind(value) {
  return value === "actor" || value === "component" || value === "service" || value === "gateway" || value === "database" || value === "external" || value === "controller" || value === "class" || value === "interface" || value === "repository" || value === "worker" || value === "utility";
}
function isMessageKind(value) {
  return value === "sync" || value === "async" || value === "return" || value === "event" || value === "external";
}
function addParticipantAlias(aliases, value, id) {
  const alias = stringOrUndefined(value);
  if (!alias) return;
  aliases.set(alias, id);
  aliases.set(safeId(alias), id);
}
function resolveParticipantId(value, aliases) {
  const candidate = stringOrUndefined(value);
  if (!candidate) return void 0;
  return aliases.get(candidate) ?? aliases.get(safeId(candidate));
}
function defaultDiagramTitle(kind) {
  return kind === "architectural" ? "Architectural Sequence Diagram" : "Detailed Design Sequence Diagram";
}
function defaultDiagramSummary(kind) {
  return kind === "architectural" ? "System component collaboration sequence." : "Code-level method call sequence.";
}
function titleFromPath(path) {
  return path.split("/").at(-1)?.replace(/\.[^.]+$/, "") || "Participant";
}
function titleFromId(id) {
  return id.split(/[-_/]/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function safeId(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sequence-item";
}
function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function formatErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
const MAX_INFERRED_CODE_FILES = 600;
const MAX_INFERRED_EDGES = 140;
function createCanvasArtifact(projectPath, modules, edges = createDefaultEdges(modules), scanFingerprint = "") {
  return {
    version: 2,
    id: "main",
    title: "Main Canvas",
    projectPath,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    scanFingerprint,
    artifactState: "current",
    nodes: modules,
    edges
  };
}
function createTaskArtifact(modules, edges = createDefaultEdges(modules)) {
  return {
    version: 1,
    id: `task-${Date.now()}`,
    title: "FlowWeave generated Codex task",
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    targetTools: ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor"],
    modules: modules.map((module) => ({
      id: module.id,
      title: module.title,
      kind: module.kind,
      nodeType: module.nodeType,
      risk: module.risk,
      description: module.description,
      files: module.files,
      guidance: module.guidanceDraft
    })),
    relations: edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      guidanceNote: edge.guidanceNote
    })),
    acceptanceCriteria: [
      "Codex changes only files listed in the selected modules unless a clear dependency requires another file.",
      "Generated changes include tests or a written explanation when tests are not applicable.",
      "Security-sensitive files require explicit human approval before modification."
    ]
  };
}
function createTaskMarkdown(task) {
  return `# ${task.title}

Target Agents: ${task.targetTools.join(", ")}
Generated At: ${task.generatedAt}

## Modules

${task.modules.map(
    (module) => `### ${module.title}

${module.description}

Files:
${module.files.map((file) => `- ${file}`).join("\n")}

Guidance:
${module.guidance}
`
  ).join("\n")}

## Module Relations

${task.relations.map(
    (relation) => `- ${relation.source} -> ${relation.target} (${relation.relation})${relation.guidanceNote ? `: ${relation.guidanceNote}` : ""}`
  ).join("\n")}

## Acceptance Criteria

${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}
`;
}
async function inferGraphFromProject(project) {
  const flatFiles = flattenFiles(project.files);
  const groups = groupBackendFiles(flatFiles);
  const entries = [...groups.entries()];
  const fallbackEntries = entries.length > 0 ? entries : [["project", flatFiles.filter((file) => file.type === "file").slice(0, 12).map((file) => file.path)]];
  const nodes = fallbackEntries.map(([group, files], index) => ({
    id: toNodeId(group),
    title: toTitle(group),
    subtitle: getNodeSubtitle(group),
    kind: "module",
    nodeType: getNodeType(group),
    risk: getNodeRisk(group, files),
    description: getNodeDescription(group, files),
    files,
    guidanceDraft: `请围绕 ${toTitle(group)} 检查这些文件的职责边界，并只在连接关系要求时扩展修改范围。`,
    status: "mapped",
    x: 120 + index % 3 * 300,
    y: 120 + Math.floor(index / 3) * 210
  }));
  const importEdges = await inferImportEdges(project, nodes);
  return {
    nodes,
    edges: importEdges.length > 0 ? importEdges : inferFallbackEdges(nodes)
  };
}
function createDefaultEdges(modules) {
  return inferFallbackEdges(modules);
}
function flattenFiles(nodes) {
  const flattened = [];
  function visit(node) {
    flattened.push(node);
    node.children?.forEach(visit);
  }
  nodes.forEach(visit);
  return flattened;
}
function groupBackendFiles(files) {
  const groups = /* @__PURE__ */ new Map();
  const codeFiles = files.filter((file) => file.type === "file" && isBackendFile(file.path)).slice(0, MAX_INFERRED_CODE_FILES);
  for (const file of codeFiles) {
    const group = detectModuleGroup(file.path);
    const groupFiles = groups.get(group) ?? [];
    groupFiles.push(file.path);
    groups.set(group, groupFiles);
  }
  return new Map([...groups.entries()].sort((a, b) => scoreGroup(b[0]) - scoreGroup(a[0]) || a[0].localeCompare(b[0])));
}
function isBackendFile(path) {
  return /\.(ts|tsx|js|jsx|py|go|java|rb|rs|php|cs|prisma|sql)$/.test(path);
}
function detectModuleGroup(path) {
  const parts = path.split("/");
  const srcIndex = parts.lastIndexOf("src");
  const afterSrc = srcIndex >= 0 ? parts[srcIndex + 1] : void 0;
  if (afterSrc && !afterSrc.includes(".")) {
    return afterSrc;
  }
  if (parts.some((part) => /test|spec|__tests__/i.test(part))) {
    return "tests";
  }
  if (parts.some((part) => /prisma|migration|database|db|schema/i.test(part))) {
    return "database";
  }
  return parts[0] ?? "project";
}
function scoreGroup(group) {
  if (/api|route|controller|server|app/i.test(group)) return 5;
  if (/auth|user|order|payment|database|db|prisma/i.test(group)) return 4;
  if (/test|spec/i.test(group)) return 3;
  return 1;
}
async function inferImportEdges(project, nodes) {
  const codeFilePaths = flattenProjectFilePaths(project.files).filter(isBackendFile).slice(0, MAX_INFERRED_CODE_FILES);
  const fileContents = await Promise.all(
    codeFilePaths.map(async (path) => ({
      path,
      content: await readFile(join(project.rootPath, ...path.split("/")), "utf8").catch(() => "")
    }))
  );
  const groupByFile = /* @__PURE__ */ new Map();
  for (const node of nodes) {
    for (const file of node.files) {
      groupByFile.set(file, node.id);
    }
  }
  const existingNodeIds = new Set(nodes.map((node) => node.id));
  const importEdges = [];
  for (const reference of collectImportReferences(fileContents, project.files)) {
    const source = groupByFile.get(reference.importer);
    const target = groupByFile.get(reference.imported);
    if (!source || !target || source === target) continue;
    if (!existingNodeIds.has(source) || !existingNodeIds.has(target)) continue;
    importEdges.push({
      id: `${source}-${target}-depends-on`,
      source,
      target,
      relation: "depends_on",
      guidanceNote: `${reference.importer} imports ${reference.imported}`
    });
  }
  return dedupeEdges(importEdges).slice(0, MAX_INFERRED_EDGES);
}
function inferFallbackEdges(nodes) {
  const edges = [];
  const entry = nodes.find((node) => node.nodeType === "entrypoint") ?? nodes.find((node) => /api|route|controller|server|app/i.test(node.id));
  const data = nodes.find((node) => node.nodeType === "data");
  const tests = nodes.filter((node) => node.nodeType === "test");
  if (entry) {
    for (const node of nodes) {
      if (node.id !== entry.id && node.nodeType === "module") {
        edges.push({ id: `${entry.id}-${node.id}`, source: entry.id, target: node.id, relation: "calls" });
      }
    }
  }
  if (data) {
    for (const node of nodes) {
      if (node.id !== data.id && node.nodeType !== "test") {
        edges.push({ id: `${node.id}-${data.id}`, source: node.id, target: data.id, relation: "reads_writes" });
      }
    }
  }
  for (const test of tests) {
    const target = nodes.find((node) => node.id !== test.id && node.nodeType === "module");
    if (target) {
      edges.push({ id: `${target.id}-${test.id}`, source: target.id, target: test.id, relation: "tests" });
    }
  }
  return dedupeEdges(edges);
}
function dedupeEdges(edges) {
  const seen = /* @__PURE__ */ new Set();
  return edges.filter((edge) => {
    const key = `${edge.source}:${edge.target}:${edge.relation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function toNodeId(group) {
  return group.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "module";
}
function toTitle(group) {
  return group.split(/[-_/]/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function getNodeType(group) {
  if (/test|spec/i.test(group)) return "test";
  if (/database|db|prisma|schema|migration/i.test(group)) return "data";
  if (/api|route|controller|server|app/i.test(group)) return "entrypoint";
  return "module";
}
function getNodeRisk(group, files) {
  if (/auth|security|payment|billing/i.test(group)) return "review";
  if (files.some((file) => /\.(key|pem|p12|pfx|crt|cer)$/.test(file) || /secret|token|credential/i.test(file))) return "blocked";
  return "normal";
}
function getNodeSubtitle(group) {
  const type = getNodeType(group);
  if (type === "entrypoint") return "请求入口与编排";
  if (type === "data") return "数据模型与持久化";
  if (type === "test") return "测试与回归验证";
  return "后端业务模块";
}
function getNodeDescription(group, files) {
  return `${toTitle(group)} 模块由项目扫描生成，包含 ${files.length} 个关键文件，连接关系将作为 Agent 生成计划的范围依据。`;
}
async function writeFlowWeaveProject(rootPath, project, modules, edges, scanFingerprint, canvas) {
  return writeProjectArtifacts(rootPath, project, modules, edges, scanFingerprint, { mode: "write", canvas });
}
async function writeFlowWeaveProjectPreservingCanvas(rootPath, project, modules, edges, scanFingerprint) {
  return writeProjectArtifacts(rootPath, project, modules, edges, scanFingerprint, { mode: "preserve" });
}
async function writeProjectArtifacts(rootPath, project, modules, edges, scanFingerprint, canvasUpdate) {
  const flowweaveRoot = join(rootPath, FLOWWEAVE_DIR);
  const canvasDir = join(flowweaveRoot, "canvas");
  const tasksDir = join(flowweaveRoot, "tasks");
  const contextDir = join(flowweaveRoot, "context");
  await Promise.all([
    mkdir(canvasDir, { recursive: true }),
    mkdir(tasksDir, { recursive: true }),
    mkdir(contextDir, { recursive: true })
  ]);
  const nextCanvas = canvasUpdate.mode === "write" ? canvasUpdate.canvas ?? createCanvasArtifact(rootPath, modules, edges, scanFingerprint) : void 0;
  const task = createTaskArtifact(modules, edges);
  const updates = [
    { path: join(flowweaveRoot, "project.json"), content: jsonText({ ...project, scanFingerprint }) },
    { path: join(tasksDir, "current.task.md"), content: createTaskMarkdown(task) },
    { path: join(tasksDir, "current.task.json"), content: jsonText(task) },
    { path: join(contextDir, "file-tree.md"), content: createFileTreeMarkdown(project.files) }
  ];
  if (nextCanvas) updates.splice(1, 0, { path: join(canvasDir, "main.canvas.json"), content: jsonText(nextCanvas) });
  await writeBatchAtomic(updates);
  await removeHistoricalTasks(tasksDir);
  return {
    projectJsonPath: join(flowweaveRoot, "project.json"),
    canvasJsonPath: join(canvasDir, "main.canvas.json"),
    taskMarkdownPath: join(tasksDir, "current.task.md"),
    taskJsonPath: join(tasksDir, "current.task.json"),
    contextFileTreePath: join(contextDir, "file-tree.md")
  };
}
async function writeBatchAtomic(updates) {
  const temporary = updates.map((update) => ({
    ...update,
    temporaryPath: join(dirname(update.path), `.${basename(update.path)}.${randomUUID()}.tmp`),
    backupPath: join(dirname(update.path), `.${basename(update.path)}.${randomUUID()}.bak`),
    replaced: false,
    backedUp: false
  }));
  try {
    await Promise.all(temporary.map((update) => writeFile(update.temporaryPath, update.content, "utf8")));
    for (const update of temporary) {
      if (await pathExists(update.path)) {
        await rename(update.path, update.backupPath);
        update.backedUp = true;
      }
      await rename(update.temporaryPath, update.path);
      update.replaced = true;
    }
    await Promise.all(temporary.map((update) => rm(update.backupPath, { force: true })));
  } catch (error) {
    for (const update of [...temporary].reverse()) {
      if (update.replaced) await rm(update.path, { force: true });
      if (update.backedUp) await rename(update.backupPath, update.path);
      await rm(update.temporaryPath, { force: true });
    }
    throw error;
  }
}
async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
async function removeHistoricalTasks(tasksDir) {
  const names = await readdir(tasksDir);
  await Promise.all(names.filter((name) => name !== "current.task.json" && name !== "current.task.md").filter((name) => name.endsWith(".task.json") || name.endsWith(".task.md")).map((name) => rm(join(tasksDir, name), { force: true })));
}
function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}
`;
}
function createFileTreeMarkdown(nodes) {
  const lines = ["# Project File Tree", ""];
  function visit(node) {
    lines.push(`${"  ".repeat(node.depth)}- ${node.name}${node.type === "folder" ? "/" : ""}`);
    node.children?.forEach(visit);
  }
  nodes.forEach(visit);
  lines.push("");
  return lines.join("\n");
}
const TOOL_IDS = ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"];
function registerProjectIpc() {
  ipcMain.handle(PROJECT_CHANNELS.openProject, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open project in FlowWeave" });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const projectId = await registerProject(result.filePaths[0]);
    return scanAndPersistProject(projectId);
  });
  ipcMain.handle(PROJECT_CHANNELS.scanProject, (_event, projectId) => scanAndPersistProject(requireString(PROJECT_CHANNELS.scanProject, projectId, "projectId")));
  ipcMain.handle(PROJECT_CHANNELS.analyzeProject, async (_event, projectId, toolId) => {
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.analyzeProject, projectId, "projectId"));
    return analyzeProject(await scanProject(projectPath), requireEnum(PROJECT_CHANNELS.analyzeProject, toolId, "toolId", TOOL_IDS));
  });
  ipcMain.handle(PROJECT_CHANNELS.analyzeArchitecture, (_event, projectId, toolId) => analyzeArchitectureForProject(
    requireString(PROJECT_CHANNELS.analyzeArchitecture, projectId, "projectId"),
    requireEnum(PROJECT_CHANNELS.analyzeArchitecture, toolId, "toolId", TOOL_IDS)
  ));
  ipcMain.handle(PROJECT_CHANNELS.analyzeArchitectureWithAgent, (_event, projectId, agentId) => analyzeArchitectureForProject(
    requireString(PROJECT_CHANNELS.analyzeArchitectureWithAgent, projectId, "projectId"),
    requireRuntimeAgentId(PROJECT_CHANNELS.analyzeArchitectureWithAgent, agentId)
  ));
  ipcMain.handle(PROJECT_CHANNELS.readArchitectureMap, (_event, projectId) => readArchitectureMap(resolveProjectPath(requireString(PROJECT_CHANNELS.readArchitectureMap, projectId, "projectId"))));
  ipcMain.handle(PROJECT_CHANNELS.generateSequenceDiagrams, async (_event, projectId, agentId) => {
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.generateSequenceDiagrams, projectId, "projectId"));
    return generateSequenceDiagrams(await scanProject(projectPath), requireRuntimeAgentId(PROJECT_CHANNELS.generateSequenceDiagrams, agentId));
  });
  ipcMain.handle(PROJECT_CHANNELS.reviseSequenceDiagram, async (_event, projectId, agentId, kind, instruction) => {
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.reviseSequenceDiagram, projectId, "projectId"));
    return reviseSequenceDiagram(
      await scanProject(projectPath),
      requireRuntimeAgentId(PROJECT_CHANNELS.reviseSequenceDiagram, agentId),
      requireEnum(PROJECT_CHANNELS.reviseSequenceDiagram, kind, "kind", ["architectural", "detailed-design"]),
      requireString(PROJECT_CHANNELS.reviseSequenceDiagram, instruction, "instruction")
    );
  });
  ipcMain.handle(PROJECT_CHANNELS.readSequenceDiagrams, (_event, projectId) => readSequenceDiagrams(resolveProjectPath(requireString(PROJECT_CHANNELS.readSequenceDiagrams, projectId, "projectId"))));
  ipcMain.handle(PROJECT_CHANNELS.readFile, async (_event, projectId, filePath) => readFile(await resolveProjectFile(
    requireString(PROJECT_CHANNELS.readFile, projectId, "projectId"),
    requireString(PROJECT_CHANNELS.readFile, filePath, "filePath")
  ), "utf8"));
  ipcMain.handle(PROJECT_CHANNELS.saveDoc, async (_event, projectId, docId, content) => {
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.saveDoc, projectId, "projectId"));
    const safeDocId = requireSafeId(PROJECT_CHANNELS.saveDoc, docId, "docId");
    const docsDir = join(projectPath, FLOWWEAVE_DIR, "docs");
    await mkdir(docsDir, { recursive: true });
    const docPath = join(docsDir, `${safeDocId}.md`);
    await writeFile(docPath, requireString(PROJECT_CHANNELS.saveDoc, content, "content"), "utf8");
    return docPath;
  });
  ipcMain.handle(PROJECT_CHANNELS.readCanvas, async (_event, projectId) => {
    const result = await readCanvasArtifactState(resolveProjectPath(requireString(PROJECT_CHANNELS.readCanvas, projectId, "projectId")));
    if (result.state === "failed") {
      throw new Error(`FlowWeave Canvas is unreadable and was preserved: ${result.error}`);
    }
    return result.state === "loaded" ? result.canvas : void 0;
  });
  ipcMain.handle(PROJECT_CHANNELS.saveCanvas, async (_event, projectId, canvas) => {
    const safeProjectId = requireString(PROJECT_CHANNELS.saveCanvas, projectId, "projectId");
    const projectPath = resolveProjectPath(safeProjectId);
    const value = requireObject(PROJECT_CHANNELS.saveCanvas, canvas, "canvas");
    if (value.version !== 2 || value.artifactState !== "current") {
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Only a current Canvas v2 can be saved.`);
    }
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Canvas nodes and edges must be arrays.`);
    }
    const projectArtifact = JSON.parse(
      await readFile(join(projectPath, FLOWWEAVE_DIR, "project.json"), "utf8")
    );
    if (!value.scanFingerprint || value.scanFingerprint !== projectArtifact.scanFingerprint) {
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Canvas scan fingerprint is stale.`);
    }
    const canvasPath = join(projectPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
    await mkdir(join(projectPath, FLOWWEAVE_DIR, "canvas"), { recursive: true });
    const temporaryPath = `${canvasPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ ...value, projectPath }, null, 2)}
`, "utf8");
      await rename(temporaryPath, canvasPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    await refreshConnectionWithoutFailing(safeProjectId, projectPath);
    return canvasPath;
  });
  ipcMain.handle(PROJECT_CHANNELS.getAgentConnection, (_event, projectId) => getProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.getAgentConnection, projectId, "projectId"))));
  ipcMain.handle(PROJECT_CHANNELS.enableAgentConnection, (_event, projectId) => enableProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.enableAgentConnection, projectId, "projectId"))));
  ipcMain.handle(PROJECT_CHANNELS.refreshAgentConnection, (_event, projectId) => refreshProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.refreshAgentConnection, projectId, "projectId"))));
  ipcMain.handle(PROJECT_CHANNELS.disableAgentConnection, (_event, projectId) => disableProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.disableAgentConnection, projectId, "projectId"))));
  ipcMain.handle(PROJECT_CHANNELS.openAgentConnection, async (_event, projectId) => {
    const path = getProjectAgentContextPath(resolveProjectPath(requireString(PROJECT_CHANNELS.openAgentConnection, projectId, "projectId")));
    const error = await shell.openPath(path);
    if (error) throw new Error(`Opening FlowWeave Agent context failed: ${error}`);
  });
}
async function analyzeArchitectureForProject(projectId, agentId) {
  const projectPath = resolveProjectPath(projectId);
  return analyzeArchitecture(await scanProject(projectPath), agentId);
}
async function scanAndPersistProject(projectId) {
  const projectPath = resolveProjectPath(projectId);
  const project = await scanProject(projectPath);
  const scanFingerprint = project.scanFingerprint ?? "";
  const inferredGraph = await inferGraphFromProject(project);
  const canvasRead = await readCanvasArtifactState(projectPath);
  const canvas = canvasRead.state === "loaded" ? migrateCanvasToScan(canvasRead.canvas, projectPath, scanFingerprint, project.files) : void 0;
  const graph = canvas ? { nodes: canvas.nodes, edges: canvas.edges } : inferredGraph;
  const written = canvasRead.state === "failed" ? await writeFlowWeaveProjectPreservingCanvas(projectPath, project, graph.nodes, graph.edges, scanFingerprint) : await writeFlowWeaveProject(projectPath, project, graph.nodes, graph.edges, scanFingerprint, canvas);
  await refreshConnectionWithoutFailing(projectId, projectPath);
  const artifacts = {
    project: "current",
    canvas: canvasRead.state === "failed" ? "failed" : "current",
    task: "current",
    context: "current",
    architecture: await artifactStateForFingerprint(projectPath, "architecture-map.json", scanFingerprint),
    sequences: await artifactStateForFingerprint(projectPath, "sequence-diagrams.json", scanFingerprint)
  };
  return { canceled: false, projectId, scanFingerprint, artifacts, project, graph, written };
}
async function readCanvasArtifactState(projectPath) {
  const path = join(projectPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
  try {
    return { state: "loaded", canvas: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    if (isMissing(error)) return { state: "missing" };
    return { state: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
async function artifactStateForFingerprint(projectPath, fileName, fingerprint) {
  try {
    const artifact = JSON.parse(await readFile(join(projectPath, FLOWWEAVE_DIR, fileName), "utf8"));
    if (artifact.source === "fallback") return "missing";
    return artifact.metadata?.inputFingerprint === fingerprint ? "current" : "stale";
  } catch (error) {
    return isMissing(error) ? "missing" : "failed";
  }
}
async function refreshConnectionWithoutFailing(projectId, projectPath) {
  try {
    await refreshProjectAgentConnectionIfEnabled(projectPath);
  } catch (error) {
    console.warn("FlowWeave Agent connection refresh failed.", {
      projectId,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}
function requireRuntimeAgentId(channel, value) {
  if (typeof value === "string" && value.startsWith("custom:") && value.length > 7) return value;
  return requireEnum(channel, value, "agentId", TOOL_IDS);
}
function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function createWindow() {
  const iconPath = app.isPackaged ? join(process.resourcesPath, "logo.png") : join(app.getAppPath(), "logo", "logo.png");
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    title: "FlowWeave",
    icon: iconPath,
    backgroundColor: "#080a13",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
  return window;
}
app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    const iconPath = app.isPackaged ? join(process.resourcesPath, "logo.png") : join(app.getAppPath(), "logo", "logo.png");
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }
  configureAgentRegistry(app.getPath("userData"));
  registerProjectIpc();
  registerAgentIpc();
  registerGitIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

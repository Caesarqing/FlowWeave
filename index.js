import { ipcMain, dialog, shell, app, nativeImage, BrowserWindow } from "electron";
import { win32, extname, join, dirname, isAbsolute, posix, resolve, normalize, relative, sep, basename } from "node:path";
import { readFile, access, writeFile, mkdir, rename, rm, readdir, realpath, lstat, stat } from "node:fs/promises";
import { constants, readdirSync, readFileSync, existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { parse } from "@vue/compiler-sfc";
import { Parser, Language } from "web-tree-sitter";
import fg from "fast-glob";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const PROJECT_CHANNELS = {
  openProject: "project:open",
  scanProject: "project:scan",
  cancelOperation: "project:cancel-operation",
  operationProgress: "project:operation-progress",
  architectureReview: "project:architecture-review",
  sequenceReview: "project:sequence-review",
  analyzeProject: "project:analyze",
  analyzeArchitecture: "project:analyze-architecture",
  analyzeArchitectureWithAgent: "project:analyze-architecture-with-agent",
  readArchitectureMap: "project:read-architecture-map",
  generateSequenceDiagrams: "project:generate-sequence-diagrams",
  reviseSequenceDiagram: "project:revise-sequence-diagram",
  readSequenceDiagrams: "project:read-sequence-diagrams",
  readFile: "project:read-file",
  saveDoc: "project:save-doc",
  saveModificationDocs: "project:save-modification-docs",
  readModificationDelta: "project:read-modification-delta",
  acknowledgeModificationChanges: "project:acknowledge-modification-changes",
  readCanvas: "project:read-canvas",
  saveCanvas: "project:save-canvas",
  exportDiagnostics: "project:export-diagnostics",
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
  healthCheckAgent: "tool:health-check-agent",
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
async function prepareCommandInvocation(commandPath, args, platform) {
  const extension = platform === "win32" ? win32.extname(commandPath).toLowerCase() : extname(commandPath).toLowerCase();
  if (platform !== "win32" || extension !== ".cmd" && extension !== ".bat") {
    return { commandPath, args };
  }
  const content = await readFile(commandPath, "utf8");
  const scriptMatch = /["']?(?:%~dp0|%dp0%)[\\/]([^"\r\n]+?\.(?:cjs|js|mjs))["']?\s+%\*/i.exec(content);
  if (!scriptMatch) {
    throw new Error(`Windows command script ${commandPath} cannot be executed without a shell.`);
  }
  const scriptPath = join(dirname(commandPath), ...scriptMatch[1].split(/[\\/]/));
  return {
    commandPath: process.execPath,
    args: [scriptPath, ...args]
  };
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
  for (const candidate of getCommandCandidatesForPlatform(toolId, process.platform)) {
    const commandPath = await resolveCandidate(candidate);
    if (!commandPath) {
      continue;
    }
    const invocation = await prepareCommandInvocation(commandPath, ["--version"], process.platform);
    const version = await execFileAsync$4(invocation.commandPath, invocation.args).then(({ stdout }) => stdout.trim()).catch(() => void 0);
    return { commandPath, installed: true, version };
  }
  return { installed: false };
}
async function resolveAppPath(appPath) {
  return access(appPath).then(() => appPath).catch(() => void 0);
}
function getCommandCandidatesForPlatform(toolId, platform) {
  const candidates = commandCandidates[toolId];
  if (platform !== "win32") return [...candidates];
  return candidates.filter((candidate) => {
    if (candidate.startsWith("/")) return false;
    return toolId !== "cursor" || candidate !== "code";
  });
}
function buildCommandSearchPaths(homePath, platform, environment) {
  if (platform === "win32") {
    const appData = environment.APPDATA ?? join(homePath, "AppData", "Roaming");
    const localAppData = environment.LOCALAPPDATA ?? join(homePath, "AppData", "Local");
    return [
      win32.join(appData, "npm"),
      win32.join(localAppData, "Programs"),
      win32.join(localAppData, "Microsoft", "WindowsApps"),
      win32.join(homePath, "AppData", "Roaming", "npm"),
      win32.join(homePath, ".local", "bin"),
      win32.join(homePath, "bin")
    ];
  }
  return [
    posix.join(homePath, ".local", "bin"),
    posix.join(homePath, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/Applications/Codex.app/Contents/Resources",
    "/Applications/Claude.app/Contents/Resources",
    "/Applications/Cursor.app/Contents/Resources/app/bin"
  ];
}
function buildCommandNames(candidate, platform, environment) {
  if (platform !== "win32" || win32.extname(candidate)) return [candidate];
  const extensions = (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => extension.trim()).filter(Boolean);
  return [candidate, ...extensions.map((extension) => `${candidate}${extension}`)];
}
async function resolveCandidate(candidate) {
  return resolveCandidateForPlatform(candidate, process.platform, process.env);
}
async function resolveCandidateForPlatform(candidate, platform, environment) {
  if (isExplicitPath(candidate, platform)) {
    return access(candidate, constants.X_OK).then(() => candidate).catch(() => void 0);
  }
  const lookupCommand = platform === "win32" ? "where.exe" : "which";
  const pathMatch = await execFileAsync$4(lookupCommand, [candidate]).then(({ stdout }) => stdout.split(/\r?\n/).find((line) => line.trim())?.trim()).catch(() => void 0);
  if (pathMatch) return pathMatch;
  const knownPathMatch = await resolveCandidateFromSearchPaths(
    candidate,
    buildCommandSearchPaths(homedir(), platform, environment),
    platform,
    environment
  );
  if (knownPathMatch) return knownPathMatch;
  if (platform === "win32") return void 0;
  return execFileAsync$4("/bin/zsh", ["-lc", 'command -v -- "$1"', "flowweave-command-lookup", candidate]).then(({ stdout }) => stdout.trim() || void 0).catch(() => void 0);
}
async function resolveCandidateFromSearchPaths(candidate, searchPaths, platform, environment) {
  for (const searchPath of searchPaths) {
    for (const commandName of buildCommandNames(candidate, platform, environment)) {
      const path = platform === "win32" ? win32.join(searchPath, commandName) : join(searchPath, commandName);
      const resolved = await access(path, constants.X_OK).then(() => path).catch(() => void 0);
      if (resolved) return resolved;
    }
  }
  return void 0;
}
function isExplicitPath(candidate, platform) {
  return platform === "win32" ? win32.isAbsolute(candidate) || candidate.includes("\\") || candidate.includes("/") : isAbsolute(candidate) || candidate.includes("/");
}
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 1e4;
const FORCE_KILL_DELAY_MS = 2e3;
const BASE_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "PATHEXT",
  "SystemRoot",
  "ComSpec"
];
async function runSpawnedAgent(options, onEvent) {
  const invocation = await prepareCommandInvocation(options.commandPath, options.args, process.platform);
  const startedAt = nowIso();
  const startedMs = Date.now();
  const events = [];
  let outputBytes = 0;
  let outputTruncated = false;
  let forcedReason;
  let forceKillTimer;
  return new Promise((resolve2) => {
    let settled = false;
    const pushEvent = (event) => {
      events.push(event);
      onEvent?.(event);
    };
    const finish = (exitCode, reason) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.request.signal?.removeEventListener("abort", abortProcessTree);
      const completedAt = nowIso();
      const status = reason === "completed" ? "completed" : "failed";
      pushEvent({ type: "status", status, timestamp: completedAt });
      resolve2({
        id: options.request.id,
        toolId: options.toolId,
        status,
        projectPath: options.request.projectPath,
        startedAt,
        completedAt,
        exitCode,
        lastMessagePath: options.lastMessagePath,
        executionMode: options.request.executionMode,
        purpose: options.request.purpose,
        events,
        durationMs: Date.now() - startedMs,
        outputTruncated,
        terminationReason: reason
      });
    };
    const maxOutputBytes = options.request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    pushEvent({ type: "status", status: "running", timestamp: startedAt });
    const child = spawn(invocation.commandPath, invocation.args, {
      cwd: options.request.projectPath,
      detached: process.platform !== "win32",
      stdio: [options.stdin === void 0 ? "ignore" : "pipe", "pipe", "pipe"],
      env: safeAgentEnvironment(process.env, options.toolId)
    });
    const abortProcessTree = () => {
      forcedReason = abortReason(options.request.signal);
      pushEvent({
        type: "error",
        message: forcedReason === "timeout" ? "Agent run timed out and was terminated." : "Agent run was canceled and terminated.",
        timestamp: nowIso()
      });
      terminateProcessTree(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => terminateProcessTree(child.pid, "SIGKILL"), FORCE_KILL_DELAY_MS);
    };
    if (options.request.signal?.aborted) abortProcessTree();
    else options.request.signal?.addEventListener("abort", abortProcessTree, { once: true });
    const readOutput = (type, chunk) => {
      if (outputTruncated) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes || events.length >= MAX_EVENTS) {
        outputTruncated = true;
        forcedReason = "output-limit";
        pushEvent({
          type: "error",
          message: outputBytes > maxOutputBytes ? `Agent output exceeded the ${maxOutputBytes} byte limit.` : `Agent output exceeded the ${MAX_EVENTS} event limit.`,
          timestamp: nowIso()
        });
        terminateProcessTree(child.pid, "SIGTERM");
        forceKillTimer = setTimeout(() => terminateProcessTree(child.pid, "SIGKILL"), FORCE_KILL_DELAY_MS);
        return;
      }
      pushEvent({ type, content: chunk.toString(), timestamp: nowIso() });
    };
    if (!child.stdout || !child.stderr) {
      terminateProcessTree(child.pid, "SIGTERM");
      finish(null, "failed");
      return;
    }
    child.stdout.on("data", (chunk) => readOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => readOutput("stderr", chunk));
    child.on("error", (error) => {
      const aborted = error.name === "AbortError" || options.request.signal?.aborted;
      const reason = forcedReason ?? (aborted ? abortReason(options.request.signal) : "failed");
      pushEvent({ type: "error", message: aborted ? `Agent run ${reason}.` : error.message, timestamp: nowIso() });
      finish(null, reason);
    });
    child.on("close", (code) => {
      const reason = forcedReason ?? (options.request.signal?.aborted ? abortReason(options.request.signal) : code === 0 ? "completed" : "failed");
      finish(code, reason);
    });
    if (options.stdin !== void 0) {
      if (!child.stdin) {
        terminateProcessTree(child.pid, "SIGTERM");
        finish(null, "failed");
        return;
      }
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}
function safeAgentEnvironment(source, toolId) {
  const credentialKeys = toolId === "claude-code" ? [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "CLOUD_ML_REGION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT"
  ] : toolId === "codex-local" ? ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "CODEX_HOME"] : toolId === "gemini-cli" ? [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS"
  ] : [];
  return Object.fromEntries(
    [...BASE_ENVIRONMENT_KEYS, ...credentialKeys].flatMap((key) => source[key] === void 0 ? [] : [[key, source[key]]])
  );
}
function abortReason(signal) {
  return signal?.reason === "timeout" ? "timeout" : "canceled";
}
function terminateProcessTree(pid, signal) {
  if (pid === void 0) return;
  if (process.platform === "win32") {
    execFile("taskkill.exe", buildWindowsTaskkillArgs(pid), (error) => {
      if (error && !isMissingProcess(error)) {
        console.error("Failed to terminate Windows Agent process tree.", {
          pid,
          code: "code" in error ? error.code : void 0
        });
      }
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}
function buildWindowsTaskkillArgs(pid) {
  return ["/PID", String(pid), "/T", "/F"];
}
function isMissingProcess(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
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
  async healthCheck() {
    const resolvedCommand = await resolveToolCommand(this.id);
    const checks = [
      {
        id: "claude-command",
        label: "Claude CLI command",
        status: resolvedCommand.installed && resolvedCommand.commandPath ? "passed" : "failed",
        message: resolvedCommand.commandPath ? `Claude Code CLI resolved at ${resolvedCommand.commandPath}.` : "Claude Code CLI was not found in PATH or known locations."
      },
      {
        id: "claude-version",
        label: "Claude CLI version",
        status: resolvedCommand.version ? "passed" : resolvedCommand.installed ? "warning" : "failed",
        message: resolvedCommand.version ? `Claude Code version ${resolvedCommand.version}.` : "Claude Code version could not be read with --version."
      },
      buildClaudeAuthCheck(process.env),
      buildClaudeProviderCheck(process.env),
      buildClaudeProxyCheck(process.env)
    ];
    return {
      agentId: this.id,
      severity: healthSeverity(checks),
      checks,
      suggestedActions: buildClaudeSuggestedActions(checks),
      environmentHints: buildClaudeEnvironmentHints(process.env),
      checkedAt: nowIso()
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
    const prompt = request.prompt;
    const args = buildClaudeArgs(request.executionMode, request.model, request.purpose);
    return runSpawnedAgent({
      toolId: this.id,
      commandPath,
      args,
      request,
      stdin: prompt
    }, onEvent);
  }
}
function buildClaudeArgs(executionMode, model, purpose) {
  const args = [
    "--print",
    "--permission-mode",
    executionMode === "plan" ? "plan" : "acceptEdits",
    "--output-format",
    purpose === "artifact-analysis" ? "json" : "text",
    "--no-session-persistence"
  ];
  if (model) {
    args.push("--model", model);
  }
  return args;
}
function buildClaudeAuthCheck(environment) {
  const authKeys = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX"
  ];
  const configuredKeys = authKeys.filter((key) => Boolean(environment[key]));
  return {
    id: "claude-auth",
    label: "Claude authentication",
    status: configuredKeys.length > 0 ? "passed" : "warning",
    message: configuredKeys.length > 0 ? `Authentication signal present: ${configuredKeys.join(", ")}.` : "No Claude authentication environment variable was visible to FlowWeave. OAuth/keychain auth may still work in Claude Code, but Electron-launched runs can differ from your shell."
  };
}
function buildClaudeProviderCheck(environment) {
  const providerKeys = [
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_PROJECT_ID"
  ];
  const configuredKeys = providerKeys.filter((key) => Boolean(environment[key]));
  return {
    id: "claude-provider",
    label: "Claude provider routing",
    status: configuredKeys.length > 0 ? "warning" : "passed",
    message: configuredKeys.length > 0 ? `Custom provider routing is configured: ${configuredKeys.join(", ")}. Provider gateway errors should be checked there first.` : "No custom Claude provider routing environment variable was visible."
  };
}
function buildClaudeProxyCheck(environment) {
  const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  const configuredKeys = proxyKeys.filter((key) => Boolean(environment[key]));
  return {
    id: "claude-proxy",
    label: "Network proxy",
    status: configuredKeys.length > 0 ? "warning" : "passed",
    message: configuredKeys.length > 0 ? `Proxy configuration is visible: ${configuredKeys.join(", ")}.` : "No proxy environment variable was visible to FlowWeave."
  };
}
function healthSeverity(checks) {
  if (checks.some((check) => check.status === "failed")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}
function buildClaudeSuggestedActions(checks) {
  const actions = [];
  if (checks.some((check) => check.id === "claude-command" && check.status === "failed")) {
    actions.push("Install Claude Code CLI or add the claude executable to PATH before running FlowWeave plans.");
  }
  if (checks.some((check) => check.id === "claude-auth" && check.status === "warning")) {
    actions.push("Confirm the same Claude authentication available in your terminal is visible to the Electron app.");
  }
  if (checks.some((check) => check.id === "claude-provider" && check.status === "warning")) {
    actions.push("If runs fail with AppIdNoAuthError, ConnectionRefused, or HTTP 5xx, verify the configured Claude provider gateway credentials and base URL.");
  }
  if (checks.some((check) => check.id === "claude-proxy" && check.status === "warning")) {
    actions.push("If runs fail with connection errors, verify proxy reachability from the FlowWeave process.");
  }
  return actions.length > 0 ? actions : ["Claude Code CLI is locally detectable. Retry the run and inspect the run log if provider errors continue."];
}
function buildClaudeEnvironmentHints(environment) {
  return [
    environment.ANTHROPIC_BASE_URL ? "ANTHROPIC_BASE_URL is set." : "ANTHROPIC_BASE_URL is not set.",
    environment.HTTP_PROXY || environment.HTTPS_PROXY ? "HTTP proxy settings are visible." : "HTTP proxy settings are not visible.",
    environment.CLAUDE_CODE_USE_BEDROCK ? "Bedrock mode is enabled." : "Bedrock mode is not enabled.",
    environment.CLAUDE_CODE_USE_VERTEX ? "Vertex mode is enabled." : "Vertex mode is not enabled."
  ];
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
    const lastMessagePath = join(request.projectPath, FLOWWEAVE_DIR, "runs", request.id, "last-message.md");
    const prompt = request.prompt;
    const args = buildCodexPlanArgs({
      executionMode: request.executionMode,
      lastMessagePath,
      model: request.model,
      projectPath: request.projectPath,
      isolated: process.env.FLOWWEAVE_AGENT_SMOKE_ISOLATED === "1"
    });
    return runSpawnedAgent({
      toolId: this.id,
      commandPath,
      args,
      request,
      stdin: prompt,
      lastMessagePath
    }, onEvent);
  }
}
function buildCodexPlanArgs({
  executionMode,
  lastMessagePath,
  model,
  projectPath: projectPath2,
  isolated
}) {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--cd",
    projectPath2,
    "--sandbox",
    executionMode === "plan" ? "read-only" : "workspace-write",
    "--output-last-message",
    lastMessagePath,
    "-"
  ];
  if (isolated) {
    args.splice(1, 0, "--ephemeral", "--ignore-user-config", "--ignore-rules");
  }
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
    const platformSupport = cursorDesktopPlatformSupport(process.platform);
    if (!platformSupport.supported) {
      return {
        toolId: this.id,
        available: false,
        method: "none",
        message: platformSupport.message
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
  async openProject(projectPath2) {
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
      await execFileAsync$3(detection.commandPath, buildCursorCliOpenArgs(projectPath2));
      return {
        toolId: this.id,
        opened: true,
        method: "cli",
        message: "Opened project with Cursor CLI."
      };
    }
    if (detection.appPath) {
      await execFileAsync$3("open", buildCursorAppOpenArgs(detection.appPath, projectPath2));
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
function buildCursorCliOpenArgs(projectPath2) {
  return [projectPath2];
}
function buildCursorAppOpenArgs(appPath, projectPath2) {
  return ["-a", appPath, projectPath2];
}
function cursorDesktopPlatformSupport(platform) {
  if (platform === "darwin") return { supported: true };
  return {
    supported: false,
    message: "Cursor CLI was not found. Install the Cursor CLI to use Cursor on Windows."
  };
}
const execFileAsync$2 = promisify(execFile);
class DesktopBridgeAdapter {
  id;
  name;
  kind = "desktop";
  appPath;
  bridgeInstructions;
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.appPath = config.appPath;
    this.bridgeInstructions = config.bridgeInstructions;
  }
  async detect() {
    const platformSupport = desktopBridgePlatformSupport(process.platform);
    if (!platformSupport.supported) {
      return {
        toolId: this.id,
        available: false,
        method: "none",
        message: platformSupport.message
      };
    }
    const appPath = await resolveAppPath(this.appPath);
    return {
      toolId: this.id,
      available: Boolean(appPath),
      method: appPath ? "app" : "none",
      appPath,
      message: appPath ? `${this.name} app detected.` : `${this.name} app was not found at ${this.appPath}.`
    };
  }
  async openProject(projectPath2) {
    const detection = await this.detect();
    if (!detection.available || !detection.appPath) {
      return {
        toolId: this.id,
        opened: false,
        method: "none",
        message: detection.message
      };
    }
    await execFileAsync$2("open", buildDesktopAppOpenArgs(detection.appPath, projectPath2));
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
    await writeFile(instructionsPath, buildDesktopBridgeInstructions(this.name, request.executionMode, this.bridgeInstructions), "utf8");
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
function buildDesktopAppOpenArgs(appPath, projectPath2) {
  return ["-a", appPath, projectPath2];
}
function desktopBridgePlatformSupport(platform) {
  if (platform === "darwin") return { supported: true };
  return {
    supported: false,
    message: "Desktop Agent bridge is only supported on macOS. Use the CLI integration on Windows."
  };
}
function getDesktopBridgeDir(projectPath2, runId) {
  return join(projectPath2, FLOWWEAVE_DIR, "agent-bridge", runId);
}
function buildDesktopBridgeInstructions(agentName, executionMode, extraInstructions) {
  const baseInstructions = `# FlowWeave Desktop Bridge Instructions

Agent: ${agentName}
Execution mode: ${executionMode}

Read request.json and prompt.md from this directory.
Inspect the project at the request projectPath.
Write one response file in the same directory:

- response.json with { "runId": string, "projectId": string, "status": "completed" | "failed", "summary": string, "content": string, "completedAt": ISO timestamp }
- or response.md with the plan markdown

Prefer response.json when possible. In plan mode, do not modify project files.`;
  return extraInstructions?.trim() ? `${baseInstructions}

## Agent-specific instructions

${extraInstructions.trim()}
` : baseInstructions;
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
function buildDesktopBridgeSkillReferences(projectPath2, promptPath, instructionsPath) {
  return [
    {
      name: "FlowWeave project context",
      kind: "project",
      path: projectPath2,
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
    const commandPath = resolvedCommand.commandPath;
    const prompt = request.prompt;
    return runSpawnedAgent({
      toolId: this.id,
      commandPath,
      args: buildGeminiArgs(request.executionMode, request.model),
      request,
      stdin: prompt
    }, onEvent);
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
    if (request.executionMode === "plan" && !supportsReadOnlyPurpose(this.definition, request.purpose)) {
      throw new Error(`Custom CLI "${this.definition.name}" does not declare a verifiable read-only Plan mode.`);
    }
    const detection = await this.detect();
    if (!detection.available || !detection.commandPath) {
      const startedAt = nowIso();
      const events = [];
      const pushEvent = (event) => {
        events.push(event);
        onEvent?.(event);
      };
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
    return runSpawnedAgent({
      toolId: this.definition.id,
      commandPath,
      args: argsForRequest(this.definition, request),
      request,
      stdin: request.prompt
    }, onEvent);
  }
}
function supportsReadOnlyPurpose(definition, purpose) {
  const capabilities = new Set(definition.capabilities ?? []);
  if (purpose === "artifact-analysis") return capabilities.has("artifact-analysis");
  return capabilities.has("implementation-plan");
}
function argsForRequest(definition, request) {
  if (request.executionMode === "plan") {
    return definition.planArgs && definition.planArgs.length > 0 ? definition.planArgs : definition.args;
  }
  return definition.executeArgs && definition.executeArgs.length > 0 ? definition.executeArgs : definition.args;
}
async function readVersion(commandPath, args) {
  const invocation = await prepareCommandInvocation(commandPath, ["--version"], process.platform);
  return new Promise((resolve2) => {
    const child = spawn(invocation.commandPath, invocation.args, { stdio: ["ignore", "pipe", "ignore"] });
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
async function writeJsonAtomic$1(path, value) {
  await writeTextAtomic$1(path, `${JSON.stringify(value, null, 2)}
`);
}
async function writeTextAtomic$1(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
async function readJsonArtifact(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissing$1(error)) return void 0;
    throw new Error(`FlowWeave artifact is unreadable and was preserved: ${path}`, { cause: error });
  }
}
function isMissing$1(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
const BUILT_IN_AGENTS = [
  {
    id: "claude-code",
    name: "Claude Code CLI",
    kind: "cli",
    protocol: "cli-stdin",
    command: "claude",
    args: ["--print", "--permission-mode", "plan"],
    capabilities: ["artifact-analysis", "implementation-plan", "execute"],
    description: "调用 Claude Code 的 plan 模式输出计划，不直接修改项目文件。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    kind: "desktop",
    protocol: "desktop-bridge",
    command: "/Applications/Claude.app",
    args: [".flowweave/agent-bridge"],
    appPath: "/Applications/Claude.app",
    capabilities: ["artifact-analysis", "implementation-plan"],
    description: "检测并打开 Claude 桌面端，通过项目内文件系统桥接请求等待桌面端回写计划。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "codex-local",
    name: "Codex CLI",
    kind: "cli",
    protocol: "cli-stdin",
    command: "codex",
    args: ["exec", "--sandbox", "read-only"],
    capabilities: ["artifact-analysis", "implementation-plan", "execute"],
    description: "调用本地 Codex CLI 读取 FlowWeave 上下文，并生成可审查的实现计划。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "codex-desktop",
    name: "Codex Desktop",
    kind: "desktop",
    protocol: "desktop-bridge",
    command: "/Applications/Codex.app",
    args: [".flowweave/agent-bridge"],
    appPath: "/Applications/Codex.app",
    capabilities: ["artifact-analysis", "implementation-plan"],
    description: "检测并打开 Codex 桌面端，通过项目内文件系统桥接请求等待桌面端回写计划。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    kind: "cli",
    protocol: "cli-stdin",
    command: "gemini",
    args: [],
    capabilities: ["artifact-analysis", "implementation-plan", "execute"],
    description: "调用本地 Gemini CLI，通过 stdin 传入 FlowWeave prompt 并记录 stdout/stderr。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "desktop",
    protocol: "desktop-bridge",
    command: "cursor/code <project> / Cursor.app",
    args: [],
    capabilities: ["implementation-plan"],
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
  const protocol = input.protocol ?? "cli-stdin";
  const command = input.command?.trim() ?? "";
  const appPath = input.appPath?.trim() ?? "";
  if (!name) throw new Error("Agent name is required.");
  if (!isAgentProtocol(protocol)) throw new Error(`Unsupported Agent protocol: ${protocol}`);
  const capabilities = normalizeCapabilities(input.capabilities, protocol, input.planArgs);
  const commandPath = protocol === "cli-stdin" ? await validateCustomAgentCommand(command, input.args ?? [], input.planArgs ?? [], input.executeArgs ?? []) : validateCustomDesktopAppPath(appPath || command);
  const agents = await readCustomAgents();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const id = createCustomAgentId(name, agents);
  const agent = {
    id,
    name,
    kind: protocol === "desktop-bridge" ? "desktop" : "cli",
    protocol,
    command: commandPath,
    args: input.args ?? [],
    planArgs: input.planArgs ?? [],
    executeArgs: input.executeArgs ?? [],
    appPath: protocol === "desktop-bridge" ? commandPath : void 0,
    bridgeInstructions: input.bridgeInstructions?.trim() || void 0,
    capabilities,
    description: input.description?.trim() || (protocol === "desktop-bridge" ? "Custom Desktop Agent" : "Custom CLI Agent"),
    builtIn: false,
    createdAt: now,
    updatedAt: now
  };
  await writeCustomAgents([...agents, agent]);
  return agent;
}
async function validateCustomAgentCommand(command, args, planArgs, executeArgs) {
  if (command.length > 2048 || /[\0\r\n]/.test(command)) {
    throw new Error("Agent command contains invalid control characters or exceeds 2048 characters.");
  }
  if (!command) throw new Error("Agent command is required.");
  if (args.length > 64) {
    throw new Error("Agent arguments cannot contain more than 64 entries.");
  }
  if (planArgs.length > 64 || executeArgs.length > 64) {
    throw new Error("Agent plan or execute arguments cannot contain more than 64 entries.");
  }
  for (const argument of [...args, ...planArgs, ...executeArgs]) {
    if (argument.length > 4096 || /[\0\r\n]/.test(argument)) {
      throw new Error("Agent argument contains invalid control characters or exceeds 4096 characters.");
    }
  }
  const commandPath = await resolveCandidate(command);
  if (!commandPath) {
    throw new Error(`Agent executable was not found or is not executable: ${command}`);
  }
  return commandPath;
}
function validateCustomDesktopAppPath(appPath) {
  if (!appPath) throw new Error("Agent app path is required.");
  if (appPath.length > 2048 || /[\0\r\n]/.test(appPath)) {
    throw new Error("Agent app path contains invalid control characters or exceeds 2048 characters.");
  }
  return appPath;
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
      protocol: "cli-stdin",
      command: "built-in",
      args: [],
      capabilities: ["artifact-analysis", "implementation-plan"],
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
  if (definition.protocol === "desktop-bridge") {
    return new DesktopBridgeAdapter({
      id: definition.id,
      name: definition.name,
      appPath: definition.appPath ?? definition.command,
      bridgeInstructions: definition.bridgeInstructions
    });
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
    return parsed.filter((agent) => isCustomAgentId(agent.id) && !agent.builtIn).map(migrateCustomAgent);
  } catch {
    return [];
  }
}
async function writeCustomAgents(agents) {
  await writeJsonAtomic$1(agentConfigPath(), agents);
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
function migrateCustomAgent(agent) {
  const protocol = agent.protocol ?? (agent.kind === "desktop" ? "desktop-bridge" : "cli-stdin");
  return {
    ...agent,
    protocol,
    appPath: protocol === "desktop-bridge" ? agent.appPath ?? agent.command : agent.appPath,
    capabilities: agent.capabilities ?? (protocol === "desktop-bridge" ? ["implementation-plan"] : ["execute"])
  };
}
function isAgentProtocol(value) {
  return value === "cli-stdin" || value === "desktop-bridge";
}
function normalizeCapabilities(capabilities, protocol, planArgs) {
  const allowed = /* @__PURE__ */ new Set(["artifact-analysis", "implementation-plan", "execute"]);
  if (capabilities) {
    return [...new Set(capabilities.filter((capability) => allowed.has(capability)))];
  }
  if (protocol === "desktop-bridge") return ["artifact-analysis", "implementation-plan"];
  return planArgs && planArgs.length > 0 ? ["artifact-analysis", "implementation-plan"] : ["execute"];
}
const execFileAsync$1 = promisify(execFile);
async function getGitStatus(projectPath2) {
  const isRepo = await isGitRepo(projectPath2);
  if (!isRepo) return { isRepo: false, changedFiles: [] };
  const [{ stdout: branch }, aheadBehind, changedFiles] = await Promise.all([
    git(projectPath2, ["branch", "--show-current"]),
    readAheadBehind(projectPath2),
    getChangedFiles(projectPath2)
  ]);
  return {
    isRepo: true,
    branch: branch.trim() || "detached",
    changedFiles,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind
  };
}
async function createCheckpoint(projectPath2) {
  await assertGitRepo(projectPath2);
  const checkpointId = `flowweave-${Date.now()}`;
  const { stdout, stderr } = await git(projectPath2, ["stash", "push", "-u", "-m", checkpointId]);
  const output = `${stdout}
${stderr}`;
  if (/No local changes to save/i.test(output)) {
    await writeCheckpointMarker(projectPath2, checkpointId, false);
    return checkpointId;
  }
  const stashRef = await findStashRef(projectPath2, checkpointId);
  if (!stashRef) {
    throw new Error(`Failed to create git checkpoint: ${output.trim() || checkpointId}`);
  }
  await git(projectPath2, ["stash", "apply", "--index", stashRef]);
  await writeCheckpointMarker(projectPath2, checkpointId, true);
  return checkpointId;
}
async function getDiff(projectPath2, checkpointId) {
  const isRepo = await isGitRepo(projectPath2);
  if (!isRepo) return "";
  if (checkpointId) {
    const stashRef = await findStashRef(projectPath2, checkpointId);
    if (stashRef) {
      const diff = await git(projectPath2, ["diff", "--unified=3", stashRef]).catch(() => ({ stdout: "", stderr: "" }));
      if (diff.stdout.trim()) return diff.stdout;
    }
  }
  const { stdout } = await git(projectPath2, ["diff", "--unified=3"]);
  const { stdout: staged } = await git(projectPath2, ["diff", "--cached", "--unified=3"]);
  return [stdout, staged].filter(Boolean).join("\n");
}
async function restoreCheckpoint(projectPath2, checkpointId) {
  if (!/^flowweave-\d+$/.test(checkpointId)) throw new Error(`Invalid FlowWeave checkpoint id: ${checkpointId}`);
  await assertGitRepo(projectPath2);
  const [stashRef, marker] = await Promise.all([findStashRef(projectPath2, checkpointId), readCheckpointMarker(projectPath2, checkpointId)]);
  if (!marker) {
    throw new Error(`FlowWeave checkpoint not found: ${checkpointId}`);
  }
  if (marker.checkpointId !== checkpointId || marker.projectPath !== resolve(projectPath2)) {
    throw new Error(`FlowWeave checkpoint does not belong to this project: ${checkpointId}`);
  }
  if (marker.hasStash !== Boolean(stashRef)) {
    throw new Error(`FlowWeave checkpoint state is invalid: ${checkpointId}`);
  }
  await git(projectPath2, ["reset", "--hard"]);
  await git(projectPath2, ["clean", "-fd"]);
  if (stashRef) {
    await git(projectPath2, ["stash", "pop", stashRef]);
  }
}
async function getChangedFiles(projectPath2) {
  const isRepo = await isGitRepo(projectPath2);
  if (!isRepo) return [];
  const [{ stdout: porcelain }, { stdout: numstat }] = await Promise.all([
    git(projectPath2, ["status", "--porcelain"]),
    git(projectPath2, ["diff", "--numstat", "HEAD"]).catch(() => ({ stdout: "", stderr: "" }))
  ]);
  const stats = parseNumstat(numstat);
  return porcelain.split("\n").map((line) => line.trimEnd()).filter(Boolean).map((line) => parsePorcelainLine(line, stats));
}
async function isGitRepo(projectPath2) {
  return git(projectPath2, ["rev-parse", "--is-inside-work-tree"]).then(({ stdout }) => stdout.trim() === "true").catch(() => false);
}
async function assertGitRepo(projectPath2) {
  if (!await isGitRepo(projectPath2)) {
    throw new Error("Project is not a git repository.");
  }
}
async function readAheadBehind(projectPath2) {
  const upstream = await git(projectPath2, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => void 0);
  if (!upstream?.stdout.trim()) return {};
  const { stdout } = await git(projectPath2, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]).catch(() => ({ stdout: "" }));
  const [aheadText, behindText] = stdout.trim().split(/\s+/);
  return {
    ahead: Number(aheadText) || 0,
    behind: Number(behindText) || 0
  };
}
async function findStashRef(projectPath2, checkpointId) {
  const { stdout } = await git(projectPath2, ["stash", "list"]).catch(() => ({ stdout: "" }));
  const line = stdout.split("\n").find((item) => item.includes(checkpointId));
  return line?.match(/^stash@\{\d+\}/)?.[0];
}
async function writeCheckpointMarker(projectPath2, checkpointId, hasStash) {
  const checkpointDir = join(projectPath2, FLOWWEAVE_DIR, "checkpoints");
  await mkdir(checkpointDir, { recursive: true });
  await writeJsonAtomic$1(join(checkpointDir, `${checkpointId}.json`), {
    checkpointId,
    projectPath: resolve(projectPath2),
    hasStash,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  });
}
async function readCheckpointMarker(projectPath2, checkpointId) {
  const checkpointPath = join(projectPath2, FLOWWEAVE_DIR, "checkpoints", `${checkpointId}.json`);
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
function git(projectPath2, args) {
  return execFileAsync$1("git", args, {
    cwd: projectPath2,
    maxBuffer: 20 * 1024 * 1024
  });
}
async function prepareRunPaths(projectPath2, runId) {
  const runDir = join(projectPath2, FLOWWEAVE_DIR, "runs", runId);
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
      return `[${event.timestamp}] status ${event.status}${event.message ? ` ${event.message}` : ""}`;
    }
    if (event.type === "error") {
      return `[${event.timestamp}] error ${event.message}`;
    }
    return `[${event.timestamp}] ${event.type}
${event.content.trimEnd()}`;
  }).join("\n\n");
}
async function writeRunResult(resultPath, result, extra) {
  await writeJsonAtomic$1(resultPath, { ...result, ...extra });
}
async function listRunSummaries(projectPath2) {
  const runsDir = join(projectPath2, FLOWWEAVE_DIR, "runs");
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const summaries = await Promise.all(
    entries.filter((entry) => entry.isDirectory() && isSafeRunId(entry.name)).map((entry) => readRunSummary(projectPath2, entry.name))
  );
  return summaries.filter((summary) => Boolean(summary)).sort((a, b) => sortableTime(b.startedAt) - sortableTime(a.startedAt));
}
async function readRunArtifact(projectPath2, runId) {
  assertSafeRunId(runId);
  const summary = await readRunSummary(projectPath2, runId);
  if (!summary) {
    throw new Error(`FlowWeave run not found: ${runId}`);
  }
  const runDir = getRunDir(projectPath2, runId);
  const [prompt, plan, log, result] = await Promise.all([
    readFixedRunFile(runDir, "prompt.md"),
    readFixedRunFile(runDir, "plan.md"),
    readFixedRunFile(runDir, "agent.log"),
    readFixedRunFile(runDir, "result.json")
  ]);
  return { summary, prompt, plan, log, result };
}
async function readRunSummary(projectPath2, runId) {
  assertSafeRunId(runId);
  const resultText = await readFixedRunFile(getRunDir(projectPath2, runId), "result.json").catch(() => "");
  if (!resultText.trim()) return void 0;
  try {
    let result = JSON.parse(resultText);
    if (result.status === "pending") {
      try {
        result = await importDesktopBridgeResponse(projectPath2, runId, result);
      } catch (error) {
        const completedAt = (/* @__PURE__ */ new Date()).toISOString();
        result = {
          ...result,
          status: "failed",
          completedAt,
          exitCode: 1,
          summary: `Desktop bridge response rejected: ${formatError$2(error)}`
        };
        await writeJsonAtomic$1(join(getRunDir(projectPath2, runId), "result.json"), result);
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
      checkpointId: result.checkpointId,
      failure: result.failure
    };
  } catch {
    return void 0;
  }
}
async function importDesktopBridgeResponse(projectPath2, runId, result) {
  const response = await readDesktopBridgeResponse(getDesktopBridgeDir(projectPath2, runId));
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
  const runDir = getRunDir(projectPath2, runId);
  const updated = {
    ...result,
    status: response.status,
    completedAt,
    exitCode: response.status === "completed" ? 0 : 1,
    summary: response.summary
  };
  await Promise.all([
    writeTextAtomic$1(join(runDir, "plan.md"), response.content),
    writeJsonAtomic$1(join(runDir, "result.json"), updated)
  ]);
  return updated;
}
function getRunDir(projectPath2, runId) {
  return join(projectPath2, FLOWWEAVE_DIR, "runs", runId);
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
async function registerProject(projectPath2) {
  if (!isAbsolute(projectPath2)) {
    throw new Error(`Project path must be absolute: "${projectPath2}".`);
  }
  const canonicalPath = await realpath(projectPath2);
  const existing = [...projects.entries()].find(([, path]) => path === canonicalPath);
  if (existing) return existing[0];
  const projectId = `project-${randomUUID()}`;
  projects.set(projectId, canonicalPath);
  return projectId;
}
function resolveProjectPath(projectId) {
  assertProjectId(projectId);
  const projectPath2 = projects.get(projectId);
  if (!projectPath2) {
    throw new Error(`Project is not authorized in this FlowWeave session: "${projectId}".`);
  }
  return projectPath2;
}
async function resolveProjectFile(projectId, filePath) {
  const projectPath2 = resolveProjectPath(projectId);
  if (!filePath || isAbsolute(filePath) || filePath.split(/[\\/]/).includes("..")) {
    throw new Error(`Project file path must be a relative path inside the project: "${filePath}".`);
  }
  const absolutePath = resolve(projectPath2, filePath);
  assertInsideProject(projectPath2, absolutePath);
  const parentPath = resolve(absolutePath, "..");
  const canonicalParent = await realpath(parentPath);
  assertInsideProject(projectPath2, canonicalParent);
  try {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      const target = await realpath(absolutePath);
      assertInsideProject(projectPath2, target);
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
    files: files.map((file) => ({
      path: file.path,
      language: file.language,
      size: file.size,
      modifiedAt: file.modifiedAt
    })).sort((left, right) => left.path.localeCompare(right.path))
  });
}
function assertInsideProject(projectPath2, candidatePath) {
  const normalizedProject = normalize(projectPath2);
  const normalizedCandidate = normalize(candidatePath);
  const pathFromProject = relative(normalizedProject, normalizedCandidate);
  if (pathFromProject === ".." || pathFromProject.startsWith(`..${sep}`) || isAbsolute(pathFromProject)) {
    throw new Error(`Path escapes the authorized project: "${candidatePath}".`);
  }
}
function isMissingFileError$1(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function extractStructuredJson(output, requiredKey) {
  const candidates = collectJsonCandidates(output);
  if (candidates.length === 0) {
    return looksLikeTruncatedJson(output) ? { error: "malformed-json", raw: output.trim() } : { error: "missing-json" };
  }
  let parsedAny = false;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      parsedAny = true;
      const unwrapped = unwrapProviderValue(parsed);
      if (requiredKey && !hasObjectKey(unwrapped, requiredKey)) continue;
      return { value: unwrapped, raw: candidate };
    } catch {
      continue;
    }
  }
  return { error: parsedAny ? "missing-json" : "malformed-json", raw: candidates[0] };
}
function extractProviderOutputText(output) {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    const value = unwrapProviderValue(parsed);
    return typeof value === "string" ? value.trim() : trimmed;
  } catch {
    return trimmed;
  }
}
function collectJsonCandidates(output) {
  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of output.matchAll(fenced)) {
    candidates.push(...balancedObjects(match[1]));
  }
  candidates.push(...balancedObjects(output));
  return [...new Set(candidates)];
}
function balancedObjects(value) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}
function unwrapProviderValue(value) {
  if (!isRecord$2(value)) return value;
  for (const key of ["structured_output", "result", "response", "content", "output", "message"]) {
    const nested = value[key];
    if (typeof nested === "string") {
      const extracted = extractStructuredJson(nested);
      if ("value" in extracted) return extracted.value;
      return nested;
    }
    if (isRecord$2(nested)) return unwrapProviderValue(nested);
  }
  return value;
}
function hasObjectKey(value, key) {
  return isRecord$2(value) && key in value;
}
function looksLikeTruncatedJson(value) {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || /```json\s*[\[{]/i.test(trimmed);
}
function isRecord$2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const DEFAULT_PLAN_POLICY = {
  timeoutMs: 3e5,
  maxOutputBytes: 4 * 1024 * 1024,
  retryCount: 2,
  retryDelayMs: 1e3
};
const DEFAULT_EXECUTE_POLICY = {
  timeoutMs: 6e5,
  maxOutputBytes: 8 * 1024 * 1024,
  retryCount: 0,
  retryDelayMs: 0
};
const MAX_CONCURRENT_READS_PER_PROJECT = 2;
const MAX_QUEUED_READS_PER_PROJECT = 8;
const activeWrites = /* @__PURE__ */ new Set();
const activeReads = /* @__PURE__ */ new Map();
const queuedReads = /* @__PURE__ */ new Map();
async function executeAgentWithPolicy(adapter, request, policy) {
  const effectivePolicy = resolvePolicy(request, policy);
  if (request.executionMode === "execute" && activeWrites.has(request.projectPath)) {
    throw new Error(`Another Agent write execution is already running for project: ${request.projectPath}`);
  }
  if (request.executionMode === "execute") {
    activeWrites.add(request.projectPath);
  } else {
    await acquireReadExecutionSlot(request);
  }
  try {
    return await executeAttempts(adapter, request, effectivePolicy);
  } finally {
    if (request.executionMode === "execute") {
      activeWrites.delete(request.projectPath);
    } else {
      releaseReadExecutionSlot(request.projectPath);
    }
  }
}
async function acquireReadExecutionSlot(request) {
  if (tryAcquireReadExecutionSlot(request.projectPath)) return;
  const queue = queuedReads.get(request.projectPath) ?? [];
  if (queue.length >= MAX_QUEUED_READS_PER_PROJECT) {
    throw new Error(`Agent read execution queue is full for project: ${request.projectPath}`);
  }
  await new Promise((resolve2, reject) => {
    let settled = false;
    const releaseListener = () => {
      if (settled) return;
      settled = true;
      request.signal?.removeEventListener("abort", abortListener);
      resolve2();
    };
    const abortListener = () => {
      if (settled) return;
      settled = true;
      removeQueuedRead(request.projectPath, releaseListener);
      reject(new Error(`Agent read execution was canceled while waiting for project: ${request.projectPath}`));
    };
    queue.push(releaseListener);
    queuedReads.set(request.projectPath, queue);
    if (request.signal?.aborted) abortListener();
    else request.signal?.addEventListener("abort", abortListener, { once: true });
  });
}
function tryAcquireReadExecutionSlot(projectPath2) {
  const readCount = activeReads.get(projectPath2) ?? 0;
  if (readCount >= MAX_CONCURRENT_READS_PER_PROJECT) return false;
  activeReads.set(projectPath2, readCount + 1);
  return true;
}
function releaseReadExecutionSlot(projectPath2) {
  const remaining = (activeReads.get(projectPath2) ?? 1) - 1;
  if (remaining === 0) activeReads.delete(projectPath2);
  else activeReads.set(projectPath2, remaining);
  drainQueuedReads(projectPath2);
}
function drainQueuedReads(projectPath2) {
  const queue = queuedReads.get(projectPath2);
  if (!queue) return;
  while (queue.length > 0 && tryAcquireReadExecutionSlot(projectPath2)) {
    const next = queue.shift();
    next?.();
  }
  if (queue.length === 0) queuedReads.delete(projectPath2);
}
function removeQueuedRead(projectPath2, listener) {
  const queue = queuedReads.get(projectPath2);
  if (!queue) return;
  const index = queue.indexOf(listener);
  if (index >= 0) queue.splice(index, 1);
  if (queue.length === 0) queuedReads.delete(projectPath2);
}
async function executeAttempts(adapter, request, policy) {
  let lastResult;
  const retryEvents = [];
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
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        message: `Retrying transient Agent failure after attempt ${attempt}.`
      });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", relayAbort);
    }
    await delay(retryDelay(policy.retryDelayMs, attempt));
  }
  if (!lastResult) throw new Error(`Agent execution did not produce a result: ${adapter.id}`);
  return lastResult;
}
function resolvePolicy(request, policy) {
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
function isTransientFailure(result) {
  return result.failure?.transient === true;
}
function delay(milliseconds) {
  return new Promise((resolve2) => setTimeout(resolve2, milliseconds));
}
function retryDelay(baseDelayMs, attempt) {
  const exponentialDelay = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseDelayMs / 2)));
  return exponentialDelay + jitter;
}
function normalizeAgentResult(result) {
  const outputs = collectOutputs(result);
  const preferred = outputs.find((output) => output.source === "stdout" && output.text.trim()) ?? outputs.find((output) => output.text.trim());
  const outputText = preferred ? extractProviderOutputText(preferred.text) : "";
  const failure = result.status === "failed" ? classifyFailure(result, outputs) : void 0;
  return {
    ...result,
    outputText,
    failure,
    summary: result.status === "failed" ? failure?.message ?? result.summary : result.summary
  };
}
function collectOutputs(result) {
  const outputs = [];
  for (const event of result.events) {
    if (event.type === "stdout" || event.type === "stderr") {
      outputs.push({ source: event.type, text: event.content });
    } else if (event.type === "error") {
      outputs.push({ source: "error", text: event.message });
    }
  }
  return outputs;
}
function classifyFailure(result, outputs) {
  const selected = selectFailureOutput(outputs);
  const message = selected ? extractProviderOutputText(selected.text) : fallbackFailureMessage(result);
  const lower = message.toLowerCase();
  const code = classifyFailureCode(message, result.terminationReason);
  return {
    code,
    message,
    transient: code === "connection" || code === "provider" || code === "rate-limit" && !/(usage limit|quota|credits|billing)/i.test(message),
    source: selected?.source ?? "error",
    exitCode: result.exitCode,
    providerDetails: lower.includes("request id") || lower.includes("sid:") ? message : void 0,
    suggestedActions: suggestedActionsForFailure(code)
  };
}
function fallbackFailureMessage(result) {
  if (result.terminationReason === "timeout") {
    return `Agent run timed out after ${formatDuration(result.durationMs)}.`;
  }
  if (result.terminationReason === "canceled") {
    return "Agent run was canceled.";
  }
  if (result.exitCode === 143) {
    return "Agent process was terminated with SIGTERM (exit code 143). Check the plan timeout setting and any external process manager.";
  }
  return `Agent process failed with exit code ${result.exitCode ?? "unknown"}.`;
}
function formatDuration(durationMs) {
  if (durationMs === void 0) return "the configured timeout";
  if (durationMs >= 6e4) return `${Math.round(durationMs / 6e4)} minutes`;
  return `${durationMs}ms`;
}
function classifyFailureCode(message, terminationReason) {
  if (terminationReason === "timeout") return "timeout";
  if (/exit code 143|sigterm/i.test(message)) return "timeout";
  if (/(appidnoautherror|noauth|unauthori[sz]ed|authentication|invalid api key|permission denied|forbidden|oauth|credential)/i.test(message)) {
    return "authentication";
  }
  if (/(429|rate.?limit|too many requests)/i.test(message)) return "rate-limit";
  if (/(usage limit|quota|credits|billing)/i.test(message)) return "rate-limit";
  if (/(connectionrefused|econnrefused|econnreset|etimedout|unable to connect|network unavailable|dns|socket hang up)/i.test(message)) {
    return "connection";
  }
  if (/(http\s*5\d\d|\b5\d\d\b|server-side issue|service unavailable|provider|temporar(?:y|ily))/i.test(message)) return "provider";
  if (terminationReason === "output-limit") return "invalid-output";
  return "process";
}
function suggestedActionsForFailure(code) {
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
  if (code === "timeout") return ["Increase the plan timeout or retry with a smaller prompt."];
  if (code === "invalid-output") return ["Reduce Agent output size or inspect the run log for runaway output."];
  return ["Open the run log and verify the Agent command, arguments, and environment."];
}
function selectFailureOutput(outputs) {
  const meaningful = outputs.filter((output) => output.text.trim());
  return meaningful.find((output) => /(error|failed|refused|unauthor|noauth|429|limit|timeout|quota|forbidden)/i.test(output.text)) ?? meaningful.find((output) => output.source === "stderr") ?? meaningful[0];
}
const SENSITIVE_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b(\s*[:=]\s*)["']?([^\s"',;]{8,})/gi,
  /\b(AWS_SECRET_ACCESS_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY)(\s*=\s*)([^\s]+)/g
];
function redactSensitiveText(value) {
  return SENSITIVE_PATTERNS.reduce((text, pattern) => text.replace(pattern, (match, prefix, separator) => {
    if (/^Bearer\s+/i.test(match)) return `${prefix}[REDACTED]`;
    if (separator !== void 0) return `${prefix}${separator}[REDACTED]`;
    return "[REDACTED]";
  }), value);
}
async function recordDiagnostic(projectPath2, input) {
  const history = await readDiagnostics(projectPath2);
  const record = {
    ...input,
    id: `diagnostic-${Date.now()}-${history.length}`,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    message: redactSensitiveText(input.message),
    context: redactContext(input.context)
  };
  await writeJsonAtomic$1(historyPath(projectPath2), [...history, record].slice(-100));
  return record;
}
async function readDiagnostics(projectPath2) {
  const value = await readJsonArtifact(historyPath(projectPath2));
  if (value === void 0) return [];
  if (!Array.isArray(value) || !value.every(isDiagnosticRecord)) {
    throw new Error(`FlowWeave diagnostic history is invalid: ${historyPath(projectPath2)}`);
  }
  return value;
}
async function exportDiagnostics(projectPath2) {
  const path = join(projectPath2, FLOWWEAVE_DIR, "diagnostics", `export-${Date.now()}.json`);
  await writeJsonAtomic$1(path, {
    version: 1,
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    diagnostics: await readDiagnostics(projectPath2)
  });
  return path;
}
function historyPath(projectPath2) {
  return join(projectPath2, FLOWWEAVE_DIR, "diagnostics", "history.json");
}
function redactContext(context) {
  return Object.fromEntries(Object.entries(context).map(([key, value]) => [
    key,
    typeof value === "string" ? redactSensitiveText(value) : value
  ]));
}
function isDiagnosticRecord(value) {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && "timestamp" in value && typeof value.timestamp === "string" && "category" in value && typeof value.category === "string" && "code" in value && typeof value.code === "string" && "message" in value && typeof value.message === "string" && "context" in value && typeof value.context === "object" && value.context !== null;
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
  const projectPath2 = resolveProjectPath(options.projectId);
  const runId = `run-${Date.now()}`;
  const paths = await prepareRunPaths(projectPath2, runId);
  const prompt = redactSensitiveText(buildRunPrompt(await resolvePrompt(options), options.executionMode, options.purpose));
  await writeTextAtomic$1(paths.promptPath, prompt);
  const adapter = await getAgentAdapter(options.toolId);
  const executionMode = options.executionMode;
  if (executionMode === "execute" && options.confirmedExecute !== true) {
    throw new Error("Execute mode requires explicit user confirmation.");
  }
  const checkpointId = executionMode === "execute" ? await createCheckpoint(projectPath2) : void 0;
  const result = await executeAgentWithPolicy(adapter, {
    id: runId,
    projectId: options.projectId,
    projectPath: projectPath2,
    prompt,
    guidancePath: options.guidancePath,
    executionMode,
    purpose: options.purpose,
    model: options.model,
    signal: options.signal
  }, resolveRunPolicyOverride(executionMode, options));
  const logText = redactSensitiveText(serializeAgentEvents(result.events));
  const planText = await resolvePlanText(result, logText);
  await Promise.all([
    writeTextAtomic$1(paths.logPath, logText),
    writeTextAtomic$1(paths.planPath, planText)
  ]);
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
    summary: result.failure?.message ?? result.summary ?? firstUsefulLine(planText),
    stderr: result.failure?.message ?? collectStderr(result.events)
  };
  await writeRunResult(paths.resultPath, finalResult, {});
  if (finalResult.status === "failed") {
    await recordAgentRunFailure(projectPath2, finalResult);
  }
  return finalResult;
}
async function recordAgentRunFailure(projectPath2, result) {
  const errorMessage = result.events.filter((event) => event.type === "stderr" || event.type === "error").map((event) => event.type === "error" ? event.message : event.content).filter(Boolean).join("\n");
  await recordDiagnostic(projectPath2, {
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
async function healthCheckAgent(agentId) {
  const adapter = await getAgentAdapter(agentId);
  if (adapter.healthCheck) {
    return adapter.healthCheck();
  }
  const detection = await adapter.detect();
  return {
    agentId,
    severity: detection.available ? "ok" : "error",
    checks: [{
      id: "agent-detection",
      label: "Agent detection",
      status: detection.available ? "passed" : "failed",
      message: detection.message ?? (detection.available ? `${adapter.name} detected.` : `${adapter.name} was not detected.`)
    }],
    suggestedActions: detection.available ? [`${adapter.name} is detectable. Review the run log if executions fail.`] : [`Install or configure ${adapter.name}, then run detection again.`],
    environmentHints: [],
    checkedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function getAgentAdapter(agentId) {
  if (agentId === "mock" || isBuiltInAgentId(agentId)) {
    return Promise.resolve(adapters[agentId]);
  }
  return getAgentAdapter$1(agentId);
}
async function openToolProject(agentId, projectPath2) {
  const adapter = await getAgentAdapter(agentId);
  if (!adapter.openProject) {
    return {
      toolId: agentId,
      opened: false,
      method: "none",
      message: `${adapter.name} does not support opening projects from FlowWeave.`
    };
  }
  return adapter.openProject(projectPath2);
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
  if (result.outputText?.trim()) {
    return result.outputText;
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
function resolveRunPolicyOverride(executionMode, options) {
  if (executionMode === "execute" && options.executeTimeoutMs !== void 0) {
    return { timeoutMs: options.executeTimeoutMs };
  }
  if (executionMode === "plan" && options.planTimeoutMs !== void 0) {
    return { timeoutMs: options.planTimeoutMs };
  }
  return void 0;
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
function optionalTrimmedString(channel, value, name) {
  if (value === void 0) return void 0;
  if (typeof value !== "string") {
    throw new Error(`[${channel}] Invalid "${name}": expected a string when provided.`);
  }
  return value.trim() || void 0;
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
function requireBoolean(channel, value, name) {
  if (typeof value !== "boolean") {
    throw new Error(`[${channel}] Invalid "${name}": expected a boolean.`);
  }
  return value;
}
function requireInteger(channel, value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`[${channel}] Invalid "${name}": expected an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
function requireBoundedString(channel, value, name, maxLength) {
  const text = requireString(channel, value, name);
  if (text.length > maxLength) {
    throw new Error(`[${channel}] Invalid "${name}": exceeds ${maxLength} characters.`);
  }
  return text;
}
class FlowWeaveError extends Error {
  code;
  category;
  context;
  suggestedActions;
  technicalDetails;
  constructor(data) {
    super(data.message);
    this.name = "FlowWeaveError";
    this.code = data.code;
    this.category = data.category;
    this.context = data.context;
    this.suggestedActions = data.suggestedActions;
    this.technicalDetails = data.technicalDetails;
  }
}
function throwIfAborted(signal, operation) {
  if (!signal?.aborted) return;
  throw new FlowWeaveError({
    code: "operation-canceled",
    category: "canceled",
    message: `${operation} was canceled.`,
    context: { operation, reason: String(signal.reason ?? "canceled") },
    suggestedActions: ["Retry the operation when ready."]
  });
}
function throwIfRunCanceled(result, operation, signal) {
  if (result.terminationReason !== "canceled" || !signal?.aborted || signal.reason !== "user-canceled") return;
  throw new FlowWeaveError({
    code: "operation-canceled",
    category: "canceled",
    message: `${operation} was canceled.`,
    context: { operation, reason: "agent-run-canceled" },
    suggestedActions: ["Retry the operation when ready."]
  });
}
const FLOWWEAVE_ERROR_PREFIX = "FLOWWEAVE_ERROR:";
function handleIpc(channel, listener) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await listener(event, ...args);
    } catch (error) {
      const data = normalizeIpcError(channel, error);
      throw new Error(`${FLOWWEAVE_ERROR_PREFIX}${JSON.stringify(data)}`);
    }
  });
}
function normalizeIpcError(channel, error) {
  if (error instanceof FlowWeaveError) {
    return {
      code: error.code,
      category: error.category,
      message: error.message,
      context: { channel, ...error.context },
      suggestedActions: error.suggestedActions,
      technicalDetails: error.category === "canceled" ? void 0 : error.technicalDetails ?? error.stack
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const category = categorizeError(message);
  return {
    code: `${category}-operation-failed`,
    category,
    message,
    context: { channel },
    suggestedActions: suggestedActions(category, message),
    technicalDetails: error instanceof Error ? error.stack : void 0
  };
}
function categorizeError(message) {
  if (/cancel/i.test(message)) return "canceled";
  if (/unauthori[sz]ed|escapes|traversal|sensitive|permission|checkpoint/i.test(message)) return "security";
  if (/agent|codex|claude|gemini|cursor|cli|timeout|output limit/i.test(message)) return "agent";
  if (/ENOENT|EACCES|file|directory|path|read|write|artifact/i.test(message)) return "filesystem";
  if (/invalid|required|expected|must|cannot contain|exceeds/i.test(message)) return "validation";
  return "internal";
}
function suggestedActions(category, message) {
  if (/already running|read execution|queue is full|concurrent/i.test(message)) {
    return [
      "Wait for the current Agent run to finish, then retry.",
      "Open the Agent run history to check whether another plan is still running or pending."
    ];
  }
  if (category === "validation") return ["Review the submitted values and retry."];
  if (category === "security") return ["Verify the project path, Git state, and requested permissions before retrying."];
  if (category === "filesystem") return ["Verify the file still exists and that FlowWeave has permission to access it."];
  if (category === "agent") return ["Check the Agent installation and configuration, then retry the operation."];
  if (category === "canceled") return ["Retry the operation when ready."];
  return ["Export diagnostics and review the technical details before retrying."];
}
function registerAgentIpc() {
  handleIpc(TOOL_CHANNELS.listAgents, async () => {
    return listAgents();
  });
  handleIpc(TOOL_CHANNELS.saveCustomAgent, async (_event, input) => {
    const value = requireObject(TOOL_CHANNELS.saveCustomAgent, input, "input");
    return saveAgent({
      name: requireBoundedString(TOOL_CHANNELS.saveCustomAgent, value.name, "name", 120),
      protocol: value.protocol === void 0 ? void 0 : requireEnum(TOOL_CHANNELS.saveCustomAgent, value.protocol, "protocol", ["cli-stdin", "desktop-bridge"]),
      command: value.command === void 0 ? void 0 : requireBoundedString(TOOL_CHANNELS.saveCustomAgent, value.command, "command", 2048),
      args: value.args === void 0 ? void 0 : requireStringArray(TOOL_CHANNELS.saveCustomAgent, value.args, "args"),
      planArgs: value.planArgs === void 0 ? void 0 : requireStringArray(TOOL_CHANNELS.saveCustomAgent, value.planArgs, "planArgs"),
      executeArgs: value.executeArgs === void 0 ? void 0 : requireStringArray(TOOL_CHANNELS.saveCustomAgent, value.executeArgs, "executeArgs"),
      appPath: value.appPath === void 0 ? void 0 : requireBoundedString(TOOL_CHANNELS.saveCustomAgent, value.appPath, "appPath", 2048),
      bridgeInstructions: value.bridgeInstructions === void 0 ? void 0 : requireBoundedString(TOOL_CHANNELS.saveCustomAgent, value.bridgeInstructions, "bridgeInstructions", 4e3),
      capabilities: value.capabilities === void 0 ? void 0 : requireCapabilityArray(value.capabilities),
      description: value.description === void 0 ? void 0 : requireBoundedString(TOOL_CHANNELS.saveCustomAgent, value.description, "description", 2e3)
    });
  });
  handleIpc(TOOL_CHANNELS.deleteCustomAgent, async (_event, agentId) => {
    return deleteAgent(requireCustomAgentId(TOOL_CHANNELS.deleteCustomAgent, agentId));
  });
  handleIpc(TOOL_CHANNELS.detectAgent, async (_event, agentId) => {
    return detectAgent(requireAgentId(TOOL_CHANNELS.detectAgent, agentId));
  });
  handleIpc(TOOL_CHANNELS.healthCheckAgent, async (_event, agentId) => {
    return healthCheckAgent(requireAgentId(TOOL_CHANNELS.healthCheckAgent, agentId));
  });
  handleIpc(TOOL_CHANNELS.detect, async (_event, toolId) => {
    return detectTool(requireEnum(TOOL_CHANNELS.detect, toolId, "toolId", ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"]));
  });
  handleIpc(TOOL_CHANNELS.runPlan, async (_event, value) => {
    const options = requireObject(TOOL_CHANNELS.runPlan, value, "options");
    const projectId = requireString(TOOL_CHANNELS.runPlan, options.projectId, "projectId");
    return startToolPlan({
      projectId,
      toolId: requireAgentId(TOOL_CHANNELS.runPlan, options.toolId),
      prompt: requireBoundedString(TOOL_CHANNELS.runPlan, options.prompt, "prompt", 1e6),
      guidancePath: options.guidancePath ? await resolveProjectFile(projectId, requireString(TOOL_CHANNELS.runPlan, options.guidancePath, "guidancePath")) : void 0,
      executionMode: requireEnum(TOOL_CHANNELS.runPlan, options.executionMode, "executionMode", ["plan", "execute"]),
      purpose: requireEnum(TOOL_CHANNELS.runPlan, options.purpose, "purpose", ["implementation-plan", "artifact-analysis"]),
      model: options.model === void 0 ? void 0 : requireBoundedString(TOOL_CHANNELS.runPlan, options.model, "model", 200),
      confirmedExecute: options.executionMode === "execute" ? requireBoolean(TOOL_CHANNELS.runPlan, options.confirmedExecute, "confirmedExecute") : false,
      executeTimeoutMs: options.executionMode === "execute" ? requireInteger(TOOL_CHANNELS.runPlan, options.executeTimeoutMs, "executeTimeoutMs", 6e4, 72e5) : void 0,
      planTimeoutMs: options.executionMode === "plan" && options.planTimeoutMs !== void 0 ? requireInteger(TOOL_CHANNELS.runPlan, options.planTimeoutMs, "planTimeoutMs", 6e4, 18e5) : void 0
    });
  });
  handleIpc(TOOL_CHANNELS.listRuns, async (_event, projectId) => {
    return listRunSummaries(resolveProjectPath(requireString(TOOL_CHANNELS.listRuns, projectId, "projectId")));
  });
  handleIpc(TOOL_CHANNELS.readRun, async (_event, projectId, runId) => {
    return readRunArtifact(
      resolveProjectPath(requireString(TOOL_CHANNELS.readRun, projectId, "projectId")),
      requireRunId(TOOL_CHANNELS.readRun, runId)
    );
  });
  handleIpc(TOOL_CHANNELS.openProject, async (_event, toolId, projectId) => {
    return openToolProject(
      requireAgentId(TOOL_CHANNELS.openProject, toolId),
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
function requireCapabilityArray(value) {
  const capabilities = requireStringArray(TOOL_CHANNELS.saveCustomAgent, value, "capabilities");
  const allowed = /* @__PURE__ */ new Set(["artifact-analysis", "implementation-plan", "execute"]);
  for (const capability of capabilities) {
    if (!allowed.has(capability)) {
      throw new Error(`[${TOOL_CHANNELS.saveCustomAgent}] Invalid "capabilities": unsupported capability "${capability}".`);
    }
  }
  return capabilities;
}
const BLOCKED_PATH_PATTERN = /(^|[\\/])(\.env($|\.)|credentials\.[^\\/]+$)|\.(key|pem|p12|pfx|crt|cer)$/i;
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
  handleIpc(GIT_CHANNELS.status, async (_event, projectId) => {
    return getGitStatus(resolveProjectPath(requireString(GIT_CHANNELS.status, projectId, "projectId")));
  });
  handleIpc(GIT_CHANNELS.diff, async (_event, projectId, checkpointId) => {
    const projectPath2 = resolveProjectPath(requireString(GIT_CHANNELS.diff, projectId, "projectId"));
    const safeCheckpointId = checkpointId === void 0 ? void 0 : requireString(GIT_CHANNELS.diff, checkpointId, "checkpointId");
    const [patch, changedFiles] = await Promise.all([getDiff(projectPath2, safeCheckpointId), getChangedFiles(projectPath2)]);
    return {
      isRepo: (await getGitStatus(projectPath2)).isRepo,
      patch,
      changedFiles,
      safety: checkSafety(changedFiles)
    };
  });
  handleIpc(GIT_CHANNELS.checkpoint, async (_event, projectId) => {
    return createCheckpoint(resolveProjectPath(requireString(GIT_CHANNELS.checkpoint, projectId, "projectId")));
  });
  handleIpc(GIT_CHANNELS.rollback, async (_event, projectId, checkpointId) => {
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
const require$2 = createRequire(import.meta.url);
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
function extractTypeScriptInsight(filePath, content, language = detectLanguage$1(filePath)) {
  const loadedTypeScript = loadTypeScript$1();
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
    symbols: dedupeSymbols$1(symbols),
    calls: [...calls].slice(0, 80),
    externalCalls: dedupeExternalCalls(externalCalls)
  };
}
function loadTypeScript$1() {
  try {
    return require$2("typescript");
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
    symbols: dedupeSymbols$1(symbols),
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
function dedupeSymbols$1(symbols) {
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
const require$1 = createRequire(import.meta.url);
function analyzeTypeScriptProject(rootPath, files) {
  const loadedTypeScript = loadTypeScript();
  const sourcePaths = files.filter((file) => isTypeScriptFile(file.path)).map((file) => `${rootPath}/${file.path}`);
  if (!loadedTypeScript || sourcePaths.length === 0) return { relations: [], symbolsByFile: /* @__PURE__ */ new Map() };
  const ts = loadedTypeScript;
  const options = compilerOptions(ts, rootPath);
  const program = ts.createProgram({ rootNames: sourcePaths, options });
  const checker = program.getTypeChecker();
  const relations = [];
  const symbolsByFile = /* @__PURE__ */ new Map();
  for (const sourceFile of program.getSourceFiles()) {
    let visit = function(node) {
      const symbol = typedSymbol(ts, checker, sourceFile, currentPath, node);
      if (symbol) symbols.push(symbol);
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        addModuleRelation(ts, relations, options, rootPath, sourceFile.fileName, currentPath, node.moduleSpecifier.text);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        addModuleRelation(ts, relations, options, rootPath, sourceFile.fileName, currentPath, node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          addModuleRelation(ts, relations, options, rootPath, sourceFile.fileName, currentPath, node.arguments[0].text);
          ts.forEachChild(node, visit);
          return;
        }
        const targetPath = declarationProjectPath(rootPath, checker, checker.getSymbolAtLocation(node.expression));
        if (targetPath && targetPath !== currentPath) {
          relations.push(relation("call", currentPath, targetPath, currentPath, targetPath, node.expression.getText(sourceFile)));
        }
      }
      if (ts.isHeritageClause(node)) {
        for (const type of node.types) {
          const targetPath = declarationProjectPath(rootPath, checker, checker.getSymbolAtLocation(type.expression));
          if (targetPath) {
            relations.push(relation("inherit", currentPath, targetPath, currentPath, targetPath, type.expression.getText(sourceFile)));
          }
        }
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const targetPath = declarationProjectPath(rootPath, checker, checker.getSymbolAtLocation(node.tagName));
        if (targetPath && targetPath !== currentPath) {
          relations.push(relation("render", currentPath, targetPath, currentPath, targetPath, node.tagName.getText(sourceFile)));
        }
      }
      ts.forEachChild(node, visit);
    };
    const sourcePath = projectPath(rootPath, sourceFile.fileName);
    if (!sourcePath) continue;
    const currentPath = sourcePath;
    const symbols = [];
    visit(sourceFile);
    symbolsByFile.set(currentPath, dedupeSymbols(symbols));
  }
  return { relations: dedupeRelations$1(relations), symbolsByFile };
}
function compilerOptions(ts, rootPath, sourcePaths) {
  const workspacePaths = workspaceCompilerPaths(rootPath);
  const configPath = ts.findConfigFile(rootPath, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    return {
      allowJs: true,
      baseUrl: rootPath,
      checkJs: false,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      paths: workspacePaths,
      target: ts.ScriptTarget.ES2022
    };
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) return compilerOptionsWithoutConfig(ts);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, rootPath, void 0, configPath);
  return {
    ...parsed.options,
    allowJs: true,
    baseUrl: parsed.options.baseUrl ?? rootPath,
    noEmit: true,
    paths: { ...workspacePaths, ...parsed.options.paths },
    rootDir: parsed.options.rootDir ?? rootPath
  };
}
function compilerOptionsWithoutConfig(ts) {
  return {
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    target: ts.ScriptTarget.ES2022
  };
}
function addModuleRelation(ts, relations, options, rootPath, sourceFileName, sourcePath, specifier) {
  const resolved = ts.resolveModuleName(specifier, sourceFileName, options, ts.sys).resolvedModule;
  const targetPath = resolved ? projectPath(rootPath, resolved.resolvedFileName) : void 0;
  if (targetPath) relations.push(relation("import", sourcePath, targetPath, sourcePath, targetPath, specifier));
}
function workspaceCompilerPaths(rootPath) {
  const paths = {};
  for (const parent of ["packages", "apps"]) {
    const parentPath = join(rootPath, parent);
    for (const entry of safeDirectories(parentPath)) {
      const packageRoot = join(parentPath, entry);
      const manifest = readPackageManifest(join(packageRoot, "package.json"));
      if (!manifest?.name) continue;
      const relativeRoot = relative(rootPath, packageRoot).split(sep).join("/");
      paths[manifest.name] = [workspaceEntry(relativeRoot, manifest)];
      paths[`${manifest.name}/*`] = [`${relativeRoot}/src/*`];
    }
  }
  return paths;
}
function safeDirectories(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
function readPackageManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return void 0;
  }
}
function workspaceEntry(relativeRoot, manifest) {
  const exported = manifest.exports;
  if (typeof exported === "string") return `${relativeRoot}/${stripRelativePrefix(exported)}`;
  if (exported && typeof exported === "object" && "." in exported) {
    const rootExport = exported["."];
    if (typeof rootExport === "string") return `${relativeRoot}/${stripRelativePrefix(rootExport)}`;
    if (rootExport && typeof rootExport === "object") {
      const conditions = rootExport;
      for (const condition of ["types", "import", "default"]) {
        if (typeof conditions[condition] === "string") {
          return `${relativeRoot}/${stripRelativePrefix(conditions[condition])}`;
        }
      }
    }
  }
  return `${relativeRoot}/${stripRelativePrefix(manifest.types ?? manifest.main ?? "src/index.ts")}`;
}
function stripRelativePrefix(path) {
  return path.replace(/^\.\//, "");
}
function typedSymbol(ts, checker, sourceFile, filePath, node) {
  if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node) && !ts.isClassDeclaration(node) && !(ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))) {
    return void 0;
  }
  const nameNode = node.name;
  if (!nameNode || !ts.isIdentifier(nameNode)) return void 0;
  const kind = ts.isClassDeclaration(node) ? "class" : ts.isMethodDeclaration(node) ? "method" : "function";
  const signature = ts.isClassDeclaration(node) ? checker.typeToString(checker.getTypeAtLocation(node)) : signatureForDeclaration(ts, checker, node);
  return {
    name: nameNode.text,
    kind,
    filePath,
    exported: ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)),
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    signature
  };
}
function signatureForDeclaration(ts, checker, node) {
  const callable = ts.isVariableDeclaration(node) ? node.initializer : node;
  if (!callable || !ts.isFunctionLike(callable) && !ts.isFunctionDeclaration(callable)) return void 0;
  const signature = checker.getSignatureFromDeclaration(callable);
  return signature ? checker.signatureToString(signature) : void 0;
}
function declarationProjectPath(rootPath, checker, symbol) {
  const resolvedSymbol = resolveAliasSymbol(checker, symbol);
  const declaration = resolvedSymbol?.valueDeclaration ?? resolvedSymbol?.declarations?.[0];
  return declaration ? projectPath(rootPath, declaration.getSourceFile().fileName) : void 0;
}
function resolveAliasSymbol(checker, symbol) {
  if (!symbol) return void 0;
  const ts = loadTypeScript();
  if (!ts || !(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  return checker.getAliasedSymbol(symbol);
}
function projectPath(rootPath, absolutePath) {
  const fromRoot = relative(rootPath, absolutePath);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot) || fromRoot.includes("node_modules")) {
    return void 0;
  }
  return fromRoot.split(sep).join("/");
}
function relation(kind, source, target, sourceFile, targetFile, symbol) {
  return {
    id: createHash("sha256").update(`${kind}\0${source}\0${target}\0${symbol}`).digest("hex").slice(0, 24),
    kind,
    source,
    target,
    sourceFile,
    targetFile,
    symbol,
    detail: `${sourceFile} ${kind}s ${symbol} from ${targetFile}`,
    confidence: "confirmed"
  };
}
function dedupeRelations$1(relations) {
  const seen = /* @__PURE__ */ new Set();
  return relations.filter((item) => {
    const key = `${item.kind}:${item.source}:${item.target}:${item.symbol ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function dedupeSymbols(symbols) {
  const seen = /* @__PURE__ */ new Set();
  return symbols.filter((symbol) => {
    const key = `${symbol.kind}:${symbol.name}:${symbol.line ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function isTypeScriptFile(path) {
  return /\.(tsx?|jsx?|mjs|cjs)$/.test(path);
}
function loadTypeScript() {
  try {
    return require$1("typescript");
  } catch {
    return void 0;
  }
}
const analyzers = [
  createVueAnalyzer(),
  createTypeScriptAnalyzer(),
  createPythonAnalyzer(),
  createJavaAnalyzer(),
  createGoAnalyzer(),
  createLightweightAnalyzer()
];
async function analyzeSourceFile(filePath, content, projectFiles) {
  const analyzer = analyzers.find((candidate) => candidate.supports(filePath));
  if (!analyzer) throw new Error(`No language analyzer registered for: ${filePath}`);
  return analyzer.analyze(filePath, content, projectFiles);
}
function createTypeScriptAnalyzer() {
  return {
    id: "typescript-ast",
    supports: (filePath) => /\.(tsx?|jsx?|mjs|cjs)$/.test(filePath),
    analyze: (filePath, content) => ({
      analyzerId: "typescript-ast",
      analysisDepth: "syntax",
      insight: extractTypeScriptInsight(filePath, content),
      httpEndpoints: extractHttpEndpoints(filePath, content),
      renderTargets: extractJsxRenderTargets(content)
    })
  };
}
function createVueAnalyzer() {
  return {
    id: "vue-compiler-sfc",
    supports: (filePath) => filePath.endsWith(".vue"),
    analyze: (filePath, content) => {
      const parsed = parse(content, { filename: filePath, sourceMap: false });
      if (parsed.errors.length > 0) {
        throw new Error(`Vue SFC parse failed for ${filePath}: ${parsed.errors.map(formatVueError).join("; ")}`);
      }
      const script = [parsed.descriptor.script?.content, parsed.descriptor.scriptSetup?.content].filter((value) => Boolean(value)).join("\n");
      const scriptInsight = extractTypeScriptInsight(filePath, script, "Vue");
      const template = parsed.descriptor.template?.content ?? "";
      return {
        analyzerId: "vue-compiler-sfc",
        analysisDepth: "semantic",
        insight: scriptInsight,
        httpEndpoints: extractHttpEndpoints(filePath, script),
        renderTargets: extractVueRenderTargets(template)
      };
    }
  };
}
function formatVueError(error) {
  return typeof error === "string" ? error : error.message;
}
function createPythonAnalyzer() {
  return createTreeSitterAnalyzer("python", ".py", "Python");
}
function createJavaAnalyzer() {
  return createTreeSitterAnalyzer("java", ".java", "Java");
}
function createGoAnalyzer() {
  return createTreeSitterAnalyzer("go", ".go", "Go");
}
function createTreeSitterAnalyzer(languageId, extension, languageLabel) {
  return {
    id: `${languageId}-tree-sitter-wasm`,
    supports: (filePath) => filePath.endsWith(extension),
    analyze: async (filePath, content, projectFiles) => ({
      analyzerId: `${languageId}-tree-sitter-wasm`,
      analysisDepth: "semantic",
      insight: enhanceSymbols(
        extractLightweightInsight(filePath, content, languageLabel, projectFiles),
        await collectTreeSitterSymbols(languageId, filePath, content)
      ),
      httpEndpoints: extractHttpEndpoints(filePath, content),
      renderTargets: []
    })
  };
}
let parserInitialization;
const treeSitterLanguages = /* @__PURE__ */ new Map();
async function collectTreeSitterSymbols(languageId, filePath, content) {
  await initializeTreeSitter();
  const parser = new Parser();
  const language = await loadTreeSitterLanguage(languageId);
  parser.setLanguage(language);
  const tree = parser.parse(content);
  if (!tree) {
    parser.delete();
    throw new Error(`Tree-sitter returned no syntax tree for ${filePath}`);
  }
  try {
    if (tree.rootNode.hasError) {
      throw new Error(`Tree-sitter found syntax errors in ${filePath}`);
    }
    return collectSyntaxTreeSymbols(languageId, filePath, tree.rootNode);
  } finally {
    tree.delete();
    parser.delete();
  }
}
function initializeTreeSitter() {
  parserInitialization ??= Parser.init({
    locateFile: () => resolveParserAsset("web-tree-sitter.wasm")
  });
  return parserInitialization;
}
function loadTreeSitterLanguage(languageId) {
  const existing = treeSitterLanguages.get(languageId);
  if (existing) return existing;
  const language = Language.load(resolveParserAsset(`tree-sitter-${languageId}.wasm`));
  treeSitterLanguages.set(languageId, language);
  return language;
}
function resolveParserAsset(fileName) {
  const resourcesPath = process.resourcesPath;
  const packagedPath = resourcesPath ? join(resourcesPath, "parsers", fileName) : "";
  if (packagedPath && existsSync(packagedPath)) return packagedPath;
  const packageName = fileName === "web-tree-sitter.wasm" ? "web-tree-sitter" : fileName.replace(".wasm", "");
  const developmentPath = join(process.cwd(), "node_modules", packageName, fileName);
  if (!existsSync(developmentPath)) {
    throw new Error(`Tree-sitter WASM asset not found: ${fileName}`);
  }
  return developmentPath;
}
function collectSyntaxTreeSymbols(languageId, filePath, root) {
  const symbols = [];
  const visit = (node) => {
    const kind = syntaxSymbolKind(languageId, node.type);
    const name = kind ? node.childForFieldName("name") : null;
    if (kind && name) {
      symbols.push({
        name: name.text,
        kind,
        filePath,
        line: node.startPosition.row + 1,
        signature: syntaxSignature(node.text)
      });
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return symbols;
}
function syntaxSymbolKind(languageId, nodeType) {
  if (languageId === "python") {
    if (nodeType === "class_definition") return "class";
    if (nodeType === "function_definition") return "function";
  }
  if (languageId === "java") {
    if (["class_declaration", "interface_declaration", "record_declaration", "enum_declaration"].includes(nodeType)) return "class";
    if (["method_declaration", "constructor_declaration"].includes(nodeType)) return "method";
  }
  if (languageId === "go") {
    if (nodeType === "type_spec") return "class";
    if (nodeType === "function_declaration") return "function";
    if (nodeType === "method_declaration") return "method";
  }
  return void 0;
}
function syntaxSignature(text) {
  return text.split(/\r?\n/, 1)[0]?.replace(/\s*\{\s*$/, "").replace(/:\s*$/, "").trim() ?? "";
}
function createLightweightAnalyzer() {
  return {
    id: "lightweight-language",
    supports: () => true,
    analyze: (filePath, content, projectFiles) => ({
      analyzerId: "lightweight-language",
      analysisDepth: "lightweight",
      insight: extractLightweightInsight(filePath, content, languageForPath$1(filePath), projectFiles),
      httpEndpoints: extractHttpEndpoints(filePath, content),
      renderTargets: []
    })
  };
}
function enhanceSymbols(insight, symbols) {
  const seen = /* @__PURE__ */ new Set();
  return {
    ...insight,
    symbols: [...symbols, ...insight.symbols].filter((symbol) => {
      const key = `${symbol.kind}:${symbol.name}:${symbol.line ?? 0}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
  };
}
function extractHttpEndpoints(filePath, content) {
  const endpoints = [];
  collectEndpointMatches(endpoints, filePath, content, /\b(fetch)\s*\(\s*([`"'])([^`"']+)\2/g, "request", "GET", 3);
  collectMethodRequestMatches(endpoints, filePath, content, /\b(?:axios|http|client)\.(get|post|put|patch|delete|options|head)\s*\(\s*([`"'])([^`"']+)\2/gi);
  collectRouteMatches(endpoints, filePath, content, /\b(?:app|router)\.(get|post|put|patch|delete|options|head)\s*\(\s*["']([^"']+)["']/gi);
  collectDecoratorRoutes(endpoints, filePath, content, /@\w+\.(get|post|put|patch|delete|options|head)\s*\(\s*["']([^"']+)["']/gi);
  collectSpringRoutes(endpoints, filePath, content);
  collectGoRoutes(endpoints, filePath, content);
  return dedupeEndpoints(endpoints);
}
function collectEndpointMatches(endpoints, filePath, content, pattern, kind, method, pathGroup) {
  let match;
  while (match = pattern.exec(content)) {
    if (match[pathGroup]) endpoints.push(endpoint(kind, filePath, method, match[pathGroup], match[1]));
  }
}
function collectMethodRequestMatches(endpoints, filePath, content, pattern) {
  let match;
  while (match = pattern.exec(content)) {
    if (match[1] && match[3]) endpoints.push(endpoint("request", filePath, httpMethod(match[1]), match[3], match[1]));
  }
}
function collectRouteMatches(endpoints, filePath, content, pattern) {
  let match;
  while (match = pattern.exec(content)) {
    if (match[1] && match[2]) endpoints.push(endpoint("route", filePath, httpMethod(match[1]), match[2], match[1]));
  }
}
function collectDecoratorRoutes(endpoints, filePath, content, pattern) {
  collectRouteMatches(endpoints, filePath, content, pattern);
}
function collectSpringRoutes(endpoints, filePath, content) {
  const pattern = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi;
  let match;
  while (match = pattern.exec(content)) {
    if (match[1] && match[2]) {
      const method = match[1].toLowerCase() === "request" ? "UNKNOWN" : httpMethod(match[1]);
      endpoints.push(endpoint("route", filePath, method, match[2], `${match[1]}Mapping`));
    }
  }
}
function collectGoRoutes(endpoints, filePath, content) {
  const pattern = /\b(?:HandleFunc|Handle)\s*\(\s*["']([^"']+)["']/g;
  let match;
  while (match = pattern.exec(content)) {
    if (match[1]) endpoints.push(endpoint("route", filePath, "UNKNOWN", match[1], "HandleFunc"));
  }
}
function endpoint(kind, filePath, method, path, symbol) {
  return {
    id: createHash("sha256").update(`${kind}\0${filePath}\0${method}\0${path}`).digest("hex").slice(0, 24),
    kind,
    filePath,
    method,
    path,
    normalizedPath: normalizeHttpPath(path),
    symbol,
    confidence: path.includes("${") ? "inferred" : "confirmed"
  };
}
function normalizeHttpPath(path) {
  const withoutQuery = path.split("?")[0] ?? path;
  return `/${withoutQuery}`.replace(/^\/+/, "/").replace(/\$\{[^}]+\}|:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}/g, ":param").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}
function httpMethod(value) {
  const method = value.toUpperCase();
  return method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE" || method === "OPTIONS" || method === "HEAD" ? method : "UNKNOWN";
}
function extractJsxRenderTargets(content) {
  return [...content.matchAll(/<([A-Z][A-Za-z0-9_.]*)\b/g)].map((match) => match[1]).filter(Boolean);
}
function extractVueRenderTargets(template) {
  return [...template.matchAll(/<([A-Z][A-Za-z0-9]*|[a-z]+-[a-z0-9-]+)\b/g)].map((match) => match[1]).filter(Boolean);
}
function dedupeEndpoints(endpoints) {
  const seen = /* @__PURE__ */ new Set();
  return endpoints.filter((item) => {
    const key = `${item.kind}:${item.method}:${item.normalizedPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function languageForPath$1(filePath) {
  const labels = {
    ".rs": "Rust",
    ".php": "PHP",
    ".cs": "C#"
  };
  return labels[extname(filePath).toLowerCase()];
}
function buildCrossStackHttpRelations(endpoints) {
  const requests = endpoints.filter((endpoint2) => endpoint2.kind === "request");
  const routes = endpoints.filter((endpoint2) => endpoint2.kind === "route");
  const relations = [];
  for (const request of requests) {
    for (const route of routes) {
      if (!methodsMatch(request, route) || !pathsMatch(request.path, route.path)) continue;
      const confidence = request.confidence === "confirmed" && route.confidence === "confirmed" ? "confirmed" : "inferred";
      relations.push({
        id: createHash("sha256").update(`http\0${request.filePath}\0${route.filePath}\0${request.method}\0${request.path}`).digest("hex").slice(0, 24),
        kind: "http",
        source: request.filePath,
        target: route.filePath,
        sourceFile: request.filePath,
        targetFile: route.filePath,
        symbol: request.symbol,
        detail: `${request.method} ${request.path} matches backend route ${route.method} ${route.path}`,
        confidence
      });
    }
  }
  return relations;
}
function methodsMatch(request, route) {
  return request.method === route.method || request.method === "UNKNOWN" || route.method === "UNKNOWN";
}
function pathsMatch(requestPath, routePath) {
  const requestSegments = normalizeSegments(requestPath);
  const routeSegments = normalizeSegments(routePath);
  if (requestSegments.length !== routeSegments.length) return false;
  return requestSegments.every((segment, index) => {
    const candidate = routeSegments[index];
    return isParameter(segment) || isParameter(candidate) || segment === candidate;
  });
}
function normalizeSegments(path) {
  const pathOnly = path.split("?")[0] ?? path;
  return pathOnly.split("/").filter(Boolean);
}
function isParameter(segment) {
  return Boolean(segment && (segment.startsWith(":") || segment.startsWith("{") && segment.endsWith("}") || segment.startsWith("${") && segment.endsWith("}")));
}
const GENERATOR_VERSION$1 = "1.0.0";
const INDEX_VERSION = 1;
const DEFAULT_PARSE_CONCURRENCY = 8;
const MAX_FILE_BYTES = 22e4;
const CODE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".py",
  ".go",
  ".java",
  ".rs",
  ".php",
  ".cs"
]);
async function buildSemanticIndex(project, options) {
  const paths = flattenProjectFilePaths(project.files).filter((path) => CODE_EXTENSIONS.has(extname(path).toLowerCase())).sort();
  const previousManifest = await readManifest(project.rootPath);
  const previousIndex = await readSemanticIndex(project.rootPath);
  const configurationFingerprint = await createConfigurationFingerprint(project.rootPath);
  const previousByPath = new Map(previousManifest?.files.map((file) => [file.path, file]) ?? []);
  const projectFileSet = new Set(paths);
  const concurrency = normalizeConcurrency$1(options?.concurrency);
  let completed = 0;
  let failed = 0;
  options?.onProgress?.({
    stage: "hashing",
    completed: 0,
    total: paths.length,
    failed: 0,
    message: `Preparing ${paths.length} source files.`
  });
  const semanticFiles = await mapWithConcurrency$1(
    paths,
    concurrency,
    async (path) => {
      throwIfAborted(options?.signal, "Semantic indexing");
      const file = await buildSemanticFile(project, path, previousByPath.get(path));
      completed += 1;
      if (file?.status === "failed") failed += 1;
      options?.onProgress?.({
        stage: "parsing",
        completed,
        total: paths.length,
        failed,
        message: `Analyzed ${completed} of ${paths.length} source files.`
      });
      return file;
    }
  );
  throwIfAborted(options?.signal, "Semantic indexing");
  const files = semanticFiles.filter((file) => Boolean(file));
  const manifestEntries = files.map(toManifestEntry);
  const delta = createScanDelta(previousManifest?.files ?? [], manifestEntries);
  const configurationChanged = previousManifest?.configurationFingerprint !== configurationFingerprint;
  const canReuseLinkedIndex = previousIndex !== void 0 && !configurationChanged && delta.added.length === 0 && delta.modified.length === 0 && delta.deleted.length === 0;
  const typeScriptResult = canReuseLinkedIndex ? { relations: [], symbolsByFile: /* @__PURE__ */ new Map() } : analyzeTypeScriptProject(project.rootPath, files);
  const enrichedFiles = canReuseLinkedIndex ? files : files.map((file) => enrichTypeScriptSymbols(file, typeScriptResult.symbolsByFile.get(file.path)));
  const httpEndpoints = enrichedFiles.flatMap((file) => file.httpEndpoints);
  options?.onProgress?.({
    stage: "linking",
    completed: paths.length,
    total: paths.length,
    failed,
    message: "Linking symbols and cross-stack relations."
  });
  const relations = canReuseLinkedIndex ? previousIndex.relations : dedupeRelations([
    ...buildSemanticRelations(enrichedFiles, projectFileSet),
    ...typeScriptResult.relations,
    ...buildCrossStackHttpRelations(httpEndpoints)
  ]);
  const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const index = {
    version: INDEX_VERSION,
    generatorVersion: GENERATOR_VERSION$1,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt,
    scanFingerprint: project.scanFingerprint ?? "",
    files: enrichedFiles,
    symbols: enrichedFiles.flatMap((file) => file.insight?.symbols ?? []),
    relations,
    httpEndpoints,
    diagnostics: files.flatMap((file) => file.diagnostics)
  };
  const manifest = {
    version: INDEX_VERSION,
    generatorVersion: GENERATOR_VERSION$1,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt,
    scanFingerprint: project.scanFingerprint ?? "",
    configurationFingerprint,
    files: enrichedFiles.map(toManifestEntry)
  };
  throwIfAborted(options?.signal, "Semantic indexing");
  options?.onProgress?.({
    stage: "persisting",
    completed: paths.length,
    total: paths.length,
    failed,
    message: "Persisting semantic index."
  });
  const cacheWritePaths = configurationChanged ? new Set(paths) : /* @__PURE__ */ new Set([...delta.added, ...delta.modified]);
  await persistSemanticIndex(
    project.rootPath,
    index,
    manifest,
    cacheWritePaths,
    delta.deleted,
    previousByPath,
    options?.signal
  );
  project.scanDelta = delta;
  return { index, delta };
}
function enrichTypeScriptSymbols(file, symbols) {
  if (!file.insight || !symbols || symbols.length === 0) return file;
  return {
    ...file,
    analyzerId: "typescript-program",
    analysisDepth: "semantic",
    insight: {
      ...file.insight,
      symbols
    }
  };
}
async function readSemanticIndex(projectPath2) {
  const value = await readJsonArtifact(join(indexRoot(projectPath2), "semantic-index.json"));
  return isSemanticIndex(value) ? value : void 0;
}
function semanticIndexToStructureFacts(project, index) {
  return {
    projectName: project.projectName,
    rootPath: project.rootPath,
    languages: project.summary.languages,
    files: index.files.flatMap((file) => file.insight ? [file.insight] : []),
    relations: index.relations
  };
}
function normalizeConcurrency$1(value) {
  if (value === void 0) return DEFAULT_PARSE_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1 || value > 32) {
    throw new Error(`Semantic index concurrency must be an integer between 1 and 32: ${value}`);
  }
  return value;
}
async function buildSemanticFile(project, path, previous) {
  const absolutePath = join(project.rootPath, ...path.split("/"));
  const info = await stat(absolutePath);
  const modifiedAt = info.mtime.toISOString();
  if (previous && previous.size === info.size && previous.modifiedAt === modifiedAt) {
    const cached = await readCachedFile(project.rootPath, previous.cacheKey);
    if (cached) return cached;
  }
  if (info.size > MAX_FILE_BYTES) {
    const contentHash = createHash("sha256").update(`${path}:${info.size}:${modifiedAt}`).digest("hex");
    return {
      path,
      language: languageForPath(path),
      size: info.size,
      modifiedAt,
      contentHash,
      cacheKey: cacheKeyForPath(path),
      analyzerId: "size-guard",
      analysisDepth: "lightweight",
      status: "failed",
      httpEndpoints: [],
      renderTargets: [],
      diagnostics: [{
        code: "file-too-large",
        severity: "warning",
        message: `File exceeds the ${MAX_FILE_BYTES} byte semantic analysis limit.`,
        filePath: path
      }]
    };
  }
  try {
    const content = await readFile(absolutePath, "utf8");
    const contentHash = createHash("sha256").update(content).digest("hex");
    const analysis = await analyzeSourceFile(path, content, project.files);
    return {
      path,
      language: analysis.insight.language,
      framework: detectFramework(path, content),
      size: info.size,
      modifiedAt,
      contentHash,
      cacheKey: cacheKeyForPath(path),
      analyzerId: analysis.analyzerId,
      analysisDepth: analysis.analysisDepth,
      status: "parsed",
      diagnostics: [],
      insight: analysis.insight,
      httpEndpoints: analysis.httpEndpoints,
      renderTargets: analysis.renderTargets
    };
  } catch (error) {
    const contentHash = createHash("sha256").update(`${path}:${info.size}:${modifiedAt}`).digest("hex");
    return {
      path,
      language: languageForPath(path),
      size: info.size,
      modifiedAt,
      contentHash,
      cacheKey: cacheKeyForPath(path),
      analyzerId: "unavailable",
      analysisDepth: "lightweight",
      status: "failed",
      httpEndpoints: [],
      renderTargets: [],
      diagnostics: [{
        code: "parse-failed",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        filePath: path
      }]
    };
  }
}
function buildSemanticRelations(files, projectFiles) {
  const relations = [];
  for (const file of files) {
    const insight = file.insight;
    if (!insight) continue;
    for (const specifier of insight.imports) {
      const targetFile = resolveProjectImport(file.path, specifier, projectFiles);
      relations.push({
        id: relationId("import", file.path, targetFile ?? specifier),
        kind: "import",
        source: file.path,
        target: targetFile ?? specifier,
        sourceFile: file.path,
        targetFile,
        detail: targetFile ? `${file.path} imports ${targetFile}` : `${file.path} imports external module ${specifier}`,
        confidence: targetFile ? "confirmed" : "inferred"
      });
    }
    for (const external of insight.externalCalls) {
      relations.push({
        id: relationId(external.kind, file.path, external.target),
        kind: externalKind(external.kind),
        source: file.path,
        target: external.target,
        sourceFile: file.path,
        symbol: external.symbol,
        detail: `${file.path} performs ${external.kind} operation ${external.target}`,
        confidence: external.symbol ? "confirmed" : "inferred"
      });
    }
  }
  return dedupeRelations(relations);
}
async function persistSemanticIndex(projectPath2, index, manifest, cacheWritePaths, deletedPaths, previousByPath, signal) {
  const root = indexRoot(projectPath2);
  const filesRoot = join(root, "files");
  await mkdir(filesRoot, { recursive: true });
  await Promise.all(index.files.filter((file) => cacheWritePaths.has(file.path)).map((file) => writeJsonAtomic$1(join(filesRoot, `${file.cacheKey}.json`), file)));
  await Promise.all(deletedPaths.map(async (path) => {
    const previous = previousByPath.get(path);
    if (previous) await rm(join(filesRoot, `${previous.cacheKey}.json`), { force: true });
  }));
  throwIfAborted(signal, "Semantic index persistence");
  await Promise.all([
    writeJsonAtomic$1(join(root, "manifest.json"), manifest),
    writeJsonAtomic$1(join(root, "semantic-index.json"), index)
  ]);
}
async function readManifest(projectPath2) {
  const value = await readJsonArtifact(join(indexRoot(projectPath2), "manifest.json"));
  return isManifest(value) ? value : void 0;
}
async function readCachedFile(projectPath2, cacheKey) {
  const value = await readJsonArtifact(join(indexRoot(projectPath2), "files", `${cacheKey}.json`));
  return isSemanticFile(value) ? value : void 0;
}
function createScanDelta(previousFiles, currentFiles) {
  const previous = new Map(previousFiles.map((file) => [file.path, file]));
  const current = new Map(currentFiles.map((file) => [file.path, file]));
  const added = [];
  const modified = [];
  const unchanged = [];
  for (const file of currentFiles) {
    const before = previous.get(file.path);
    if (!before) added.push(file.path);
    else if (before.contentHash !== file.contentHash) modified.push(file.path);
    else unchanged.push(file.path);
  }
  const deleted = previousFiles.filter((file) => !current.has(file.path)).map((file) => file.path);
  return { added, modified, deleted, unchanged };
}
function toManifestEntry(file) {
  return {
    path: file.path,
    size: file.size,
    modifiedAt: file.modifiedAt,
    contentHash: file.contentHash,
    cacheKey: file.cacheKey
  };
}
function indexRoot(projectPath2) {
  return join(projectPath2, FLOWWEAVE_DIR, "index");
}
async function createConfigurationFingerprint(projectPath2) {
  const hash = createHash("sha256");
  for (const path of ["tsconfig.json", "jsconfig.json", "package.json"]) {
    try {
      hash.update(path);
      hash.update(await readFile(join(projectPath2, path)));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return hash.digest("hex");
}
function cacheKeyForPath(path) {
  return createHash("sha256").update(path).digest("hex");
}
function relationId(kind, source, target) {
  return createHash("sha256").update(`${kind}\0${source}\0${target}`).digest("hex").slice(0, 24);
}
function dedupeRelations(relations) {
  const seen = /* @__PURE__ */ new Set();
  return relations.filter((relation2) => {
    if (seen.has(relation2.id)) return false;
    seen.add(relation2.id);
    return true;
  });
}
function externalKind(kind) {
  if (kind === "queue") return "event";
  if (kind === "unknown") return "call";
  return kind;
}
function languageForPath(path) {
  const labels = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript React",
    ".js": "JavaScript",
    ".jsx": "JavaScript React",
    ".vue": "Vue",
    ".py": "Python",
    ".go": "Go",
    ".java": "Java",
    ".rs": "Rust",
    ".php": "PHP",
    ".cs": "C#"
  };
  return labels[extname(path).toLowerCase()];
}
function detectFramework(path, content) {
  if (path.endsWith(".vue")) return "Vue";
  if (/\.(tsx|jsx)$/.test(path) && /(?:from\s+["']react["']|use[A-Z]\w*\s*\()/.test(content)) return "React";
  return void 0;
}
async function mapWithConcurrency$1(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}
function isManifest(value) {
  if (!isRecord$1(value) || value.version !== INDEX_VERSION || !Array.isArray(value.files)) return false;
  return typeof value.projectName === "string" && typeof value.rootPath === "string" && typeof value.scanFingerprint === "string" && (value.configurationFingerprint === void 0 || typeof value.configurationFingerprint === "string") && value.files.every(isManifestEntry);
}
function isManifestEntry(value) {
  return isRecord$1(value) && typeof value.path === "string" && typeof value.size === "number" && typeof value.modifiedAt === "string" && typeof value.contentHash === "string" && typeof value.cacheKey === "string";
}
function isSemanticIndex(value) {
  return isRecord$1(value) && value.version === INDEX_VERSION && typeof value.projectName === "string" && typeof value.rootPath === "string" && Array.isArray(value.files) && value.files.every(isSemanticFile) && Array.isArray(value.relations) && Array.isArray(value.httpEndpoints) && Array.isArray(value.symbols) && Array.isArray(value.diagnostics);
}
function isSemanticFile(value) {
  return isRecord$1(value) && typeof value.path === "string" && typeof value.size === "number" && typeof value.modifiedAt === "string" && typeof value.contentHash === "string" && typeof value.cacheKey === "string" && typeof value.analyzerId === "string" && Array.isArray(value.httpEndpoints) && Array.isArray(value.renderTargets) && Array.isArray(value.diagnostics);
}
function isRecord$1(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMissingFile(error) {
  return isRecord$1(error) && error.code === "ENOENT";
}
const CONFIDENCE_MAX = {
  parsing: 25,
  symbols: 25,
  relations: 25,
  evidence: 15,
  freshness: 10
};
const ASSESSMENT_GENERATOR_VERSION = "1.0.0";
function assessModules(modules, edges, index, scanFingerprint, assessedAt) {
  return modules.map((module) => {
    const assessment = assessModule(module, modules, edges, index, scanFingerprint, assessedAt);
    return {
      ...module,
      risk: assessment.risk.effectiveLevel,
      confidence: void 0,
      assessment
    };
  });
}
function unknownAssessment(fingerprint, assessedAt) {
  return {
    version: 1,
    generatorVersion: ASSESSMENT_GENERATOR_VERSION,
    confidence: { level: "unknown", factors: [] },
    risk: { systemLevel: "unknown", effectiveLevel: "unknown", factors: [] },
    fingerprint,
    assessedAt
  };
}
function assessModule(module, modules, edges, index, scanFingerprint, assessedAt) {
  const filesByPath = new Map(index.files.map((file) => [file.path, file]));
  const semanticFiles = module.files.map((file) => filesByPath.get(file)).filter((file) => Boolean(file));
  if (semanticFiles.length === 0) {
    const unknown = unknownAssessment(scanFingerprint, assessedAt);
    return preserveOverride(unknown, module.assessment);
  }
  const moduleFiles = new Set(semanticFiles.map((file) => file.path));
  const semanticRelations = index.relations.filter((relation2) => relationTouchesFiles(relation2, moduleFiles));
  const graphEdges = edges.filter((edge) => edge.source === module.id || edge.target === module.id);
  const confidenceFactors = buildConfidenceFactors(module, semanticFiles, semanticRelations, graphEdges, index, scanFingerprint);
  const confidenceScore = roundedSum(confidenceFactors);
  const riskFactors = buildRiskFactors(module, modules, graphEdges, semanticFiles, semanticRelations);
  const riskScore = roundedSum(riskFactors);
  const assessment = {
    version: 1,
    generatorVersion: ASSESSMENT_GENERATOR_VERSION,
    confidence: {
      score: confidenceScore,
      level: confidenceLevel(confidenceScore),
      factors: confidenceFactors
    },
    risk: {
      systemScore: riskScore,
      systemLevel: riskLevel(riskScore),
      effectiveLevel: riskLevel(riskScore),
      factors: riskFactors
    },
    fingerprint: scanFingerprint,
    assessedAt
  };
  return preserveOverride(assessment, module.assessment);
}
function buildConfidenceFactors(module, files, relations, edges, index, scanFingerprint) {
  const parsingRatio = average(files.map((file) => parsingQuality(file)));
  const declaredSymbols = module.symbols ?? [];
  const matchedSymbols = declaredSymbols.filter(
    (symbol) => index.symbols.some((candidate) => candidate.filePath === symbol.filePath && candidate.name === symbol.name)
  );
  const symbolRatio = declaredSymbols.length > 0 ? matchedSymbols.length / declaredSymbols.length : average(files.map((file) => file.insight?.symbols.length ? 0.7 : 0.35));
  const relationRatio = relations.length > 0 ? average(relations.map((relation2) => relation2.confidence === "confirmed" ? 1 : 0.5)) : 0.4;
  const evidence = [...module.evidence ?? [], ...edges.flatMap((edge) => edge.evidence ?? [])];
  const evidenceRatio = evidence.length > 0 ? average(evidence.map(evidenceCompleteness)) : 0;
  const isCurrent = Boolean(scanFingerprint) && index.scanFingerprint === scanFingerprint;
  return [
    factor(
      "parsing-coverage",
      "Parsing coverage",
      parsingRatio * CONFIDENCE_MAX.parsing,
      CONFIDENCE_MAX.parsing,
      `${files.filter((file) => file.status === "parsed").length} of ${files.length} module files parsed successfully.`,
      fileEvidence(files)
    ),
    factor(
      "symbol-resolution",
      "Symbol resolution",
      symbolRatio * CONFIDENCE_MAX.symbols,
      CONFIDENCE_MAX.symbols,
      declaredSymbols.length > 0 ? `${matchedSymbols.length} of ${declaredSymbols.length} declared module symbols matched the semantic index.` : "No curated module symbols were available; the score uses symbols discovered in mapped files.",
      declaredSymbols.length > 0 ? declaredSymbols.slice(0, 5).map(symbolEvidence) : fileEvidence(files)
    ),
    factor(
      "relation-confirmation",
      "Relation confirmation",
      relationRatio * CONFIDENCE_MAX.relations,
      CONFIDENCE_MAX.relations,
      relations.length > 0 ? `${relations.filter((relation2) => relation2.confidence === "confirmed").length} of ${relations.length} semantic relations are confirmed.` : "No semantic relations were available for this module.",
      relationEvidence(relations, files)
    ),
    factor(
      "evidence-completeness",
      "Evidence completeness",
      evidenceRatio * CONFIDENCE_MAX.evidence,
      CONFIDENCE_MAX.evidence,
      evidence.length > 0 ? `${evidence.length} module and connection evidence records were evaluated.` : "No module or connection evidence was recorded.",
      evidence.length > 0 ? evidence.slice(0, 5) : fileEvidence(files)
    ),
    factor(
      "data-freshness",
      "Data freshness",
      isCurrent ? CONFIDENCE_MAX.freshness : 0,
      CONFIDENCE_MAX.freshness,
      isCurrent ? "The semantic index matches the current scan fingerprint." : "The semantic index does not match the current scan fingerprint.",
      fileEvidence(files)
    )
  ];
}
function buildRiskFactors(module, modules, edges, files, relations) {
  const behavioralEvidence = [
    ...files.flatMap((file) => file.insight?.symbols.map((symbol) => `${symbol.name} ${symbol.signature ?? ""}`) ?? []),
    ...files.flatMap((file) => file.insight?.calls ?? []),
    ...files.flatMap((file) => file.insight?.externalCalls.map((call) => `${call.kind} ${call.target}`) ?? []),
    ...relations.map((relation2) => `${relation2.kind} ${relation2.detail} ${relation2.target}`)
  ].join(" ").toLowerCase();
  const descriptiveEvidence = [module.title, module.description, module.role ?? ""].join(" ").toLowerCase();
  const pathOnly = files.map((file) => file.path).join(" ").toLowerCase();
  const strongSensitiveMatches = countMatches(behavioralEvidence, [
    /\bauth(?:entication|orization)?\b/g,
    /\bpermission\b|\baccess control\b|\brbac\b/g,
    /\bpayment\b|\bbilling\b|\bcheckout\b/g,
    /\bcredential\b|\bsecret\b|\btoken\b|\bprivate key\b/g,
    /\bpersonal data\b|\bprivacy\b|\buser data\b|\bpii\b/g
  ]);
  const descriptiveMatches = countMatches(descriptiveEvidence, [/\bauth\b|\bsecurity\b|\bpayment\b|\bbilling\b|\bpermission\b|\bprivacy\b/g]);
  const pathSensitiveMatches = countMatches(pathOnly, [/\bauth\b/g, /\bsecurity\b/g, /\bpayment\b/g, /\bpermission\b/g]);
  const sensitiveScore = Math.min(30, strongSensitiveMatches * 8 + Math.min(8, descriptiveMatches * 4) + Math.min(6, pathSensitiveMatches * 3));
  const moduleIds = new Set(modules.map((candidate) => candidate.id));
  const crossModuleEdges = edges.filter((edge) => moduleIds.has(edge.source) && moduleIds.has(edge.target));
  const centralityRatio = modules.length > 1 ? Math.min(1, crossModuleEdges.length / Math.min(6, modules.length - 1)) : 0;
  const centralityScore = centralityRatio * 25;
  const sideEffectKinds = new Set(relations.filter((relation2) => ["database", "filesystem", "process", "http", "event"].includes(relation2.kind)).map((relation2) => relation2.kind));
  const externalCalls = files.flatMap((file) => file.insight?.externalCalls ?? []);
  const sideEffectScore = Math.min(20, sideEffectKinds.size * 4 + externalCalls.length * 2);
  const layers = new Set(edges.map((edge) => edge.relation));
  const fileScale = Math.min(5, Math.max(0, files.length - 1));
  const impactScore = Math.min(15, crossModuleEdges.length * 3 + layers.size * 2 + fileScale);
  const hasTestProtection = files.some((file) => /(^|\/)(test|tests|spec|specs)(\/|$)|\.(test|spec)\./i.test(file.path)) || edges.some((edge) => edge.relation === "tests") || relations.some((relation2) => relation2.kind === "test");
  const testScore = hasTestProtection ? 0 : 10;
  return [
    factor(
      "sensitive-surface",
      "Sensitive business surface",
      sensitiveScore,
      30,
      sensitiveScore > 0 ? "Sensitive business or security concepts were found in code evidence." : "No sensitive business or security behavior was identified.",
      matchingEvidence(files, relations, /auth|permission|payment|billing|credential|secret|token|privacy|user data/i)
    ),
    factor(
      "dependency-centrality",
      "Dependency centrality",
      centralityScore,
      25,
      `${crossModuleEdges.length} cross-module connections touch this module.`,
      edgeEvidence(edges, files)
    ),
    factor(
      "side-effects",
      "Side effects",
      sideEffectScore,
      20,
      sideEffectScore > 0 ? `${sideEffectKinds.size} side-effect categories and ${externalCalls.length} external operations were detected.` : "No database, filesystem, process, event, or external HTTP side effects were detected.",
      sideEffectEvidence(files, relations)
    ),
    factor(
      "change-impact",
      "Change impact",
      impactScore,
      15,
      `The module spans ${files.length} files and ${layers.size} relation types.`,
      edgeEvidence(edges, files)
    ),
    factor(
      "test-protection",
      "Test protection gap",
      testScore,
      10,
      hasTestProtection ? "A test file or test relation is associated with this module." : "No directly associated test file or test relation was found.",
      hasTestProtection ? matchingEvidence(files, relations, /test|spec/i) : fileEvidence(files)
    )
  ];
}
function preserveOverride(next, previous) {
  const override = previous?.risk.override;
  if (!previous || !override?.reason.trim()) return next;
  return {
    ...next,
    risk: {
      ...next.risk,
      effectiveLevel: override.level,
      previousSystemLevel: previous.risk.systemLevel,
      systemLevelChanged: previous.risk.systemLevel !== next.risk.systemLevel,
      override
    }
  };
}
function factor(id, label, score, maxScore, reason, evidence) {
  return {
    id,
    label,
    score: round(score),
    maxScore,
    reason,
    evidence: evidence.length > 0 ? evidence.slice(0, 5) : [{ detail: reason }]
  };
}
function parsingQuality(file) {
  if (file.status !== "parsed") return file.status === "unsupported" ? 0.25 : 0;
  if (file.analysisDepth === "semantic") return 1;
  if (file.analysisDepth === "syntax") return 0.8;
  return 0.55;
}
function evidenceCompleteness(evidence) {
  return (evidence.filePath ? 0.4 : 0) + (evidence.symbol ? 0.3 : 0) + (evidence.line ? 0.3 : 0);
}
function relationTouchesFiles(relation2, files) {
  return files.has(relation2.sourceFile) || Boolean(relation2.targetFile && files.has(relation2.targetFile));
}
function fileEvidence(files) {
  return files.slice(0, 5).map((file) => ({
    filePath: file.path,
    symbol: file.insight?.symbols[0]?.name,
    line: file.insight?.symbols[0]?.line,
    detail: `${file.analysisDepth} analysis: ${file.status}`
  }));
}
function symbolEvidence(symbol) {
  return { filePath: symbol.filePath, symbol: symbol.name, line: symbol.line, detail: symbol.signature ?? `${symbol.kind} symbol` };
}
function relationEvidence(relations, files) {
  if (relations.length === 0) return fileEvidence(files);
  return relations.slice(0, 5).map((relation2) => ({
    filePath: relation2.sourceFile,
    symbol: relation2.symbol,
    detail: `${relation2.confidence} ${relation2.kind}: ${relation2.detail}`
  }));
}
function edgeEvidence(edges, files) {
  const evidence = edges.flatMap((edge) => edge.evidence ?? []);
  if (evidence.length > 0) return evidence.slice(0, 5);
  return edges.slice(0, 5).map((edge) => ({ detail: `${edge.source} ${edge.relation} ${edge.target}` })).concat(fileEvidence(files)).slice(0, 5);
}
function matchingEvidence(files, relations, pattern) {
  const relationMatches = relations.filter((relation2) => pattern.test(`${relation2.detail} ${relation2.target}`));
  pattern.lastIndex = 0;
  const fileMatches = files.filter((file) => pattern.test(`${file.path} ${file.insight?.symbols.map((symbol) => symbol.name).join(" ") ?? ""}`));
  pattern.lastIndex = 0;
  const combined = [
    ...relationMatches.map((relation2) => ({ filePath: relation2.sourceFile, symbol: relation2.symbol, detail: relation2.detail })),
    ...fileMatches.map((file) => ({ filePath: file.path, detail: "Matched module code evidence." }))
  ];
  return [...combined, ...fileEvidence(files)].slice(0, 5);
}
function sideEffectEvidence(files, relations) {
  const relevant = relations.filter((relation2) => ["database", "filesystem", "process", "http", "event"].includes(relation2.kind));
  if (relevant.length > 0) return relationEvidence(relevant, files);
  const calls = files.flatMap((file) => (file.insight?.externalCalls ?? []).map((call) => ({
    filePath: file.path,
    symbol: call.symbol,
    detail: `${call.kind}: ${call.target}`
  })));
  return calls.length > 0 ? calls.slice(0, 5) : fileEvidence(files);
}
function countMatches(value, patterns) {
  return patterns.reduce((total, pattern) => {
    const matches = value.match(pattern);
    return total + (matches?.length ?? 0);
  }, 0);
}
function confidenceLevel(score) {
  if (score >= 80) return "high";
  if (score >= 50) return "medium";
  return "low";
}
function riskLevel(score) {
  if (score >= 70) return "high";
  if (score >= 30) return "medium";
  return "low";
}
function roundedSum(factors) {
  return round(factors.reduce((total, current) => total + current.score, 0));
}
function average(values) {
  return values.length > 0 ? values.reduce((total, current) => total + current, 0) / values.length : 0;
}
function round(value) {
  return Math.round(value * 10) / 10;
}
const REVIEW_STATE_FILENAME$1 = "architecture-review.json";
const activeReviewIds$1 = /* @__PURE__ */ new Set();
async function startArchitectureReview(input) {
  const reviewing = {
    state: "reviewing",
    reviewId: input.reviewId,
    scanFingerprint: input.scanFingerprint,
    agentId: input.agentId,
    startedAt: input.startedAt
  };
  await writeArchitectureReviewStatus(input.projectPath, reviewing);
  input.onEvent(reviewEvent$1(input, reviewing));
  activeReviewIds$1.add(input.reviewId);
  void completeArchitectureReview(input, reviewing).finally(() => activeReviewIds$1.delete(input.reviewId));
  return reviewing;
}
function isArchitectureReviewActive(reviewId) {
  return activeReviewIds$1.has(reviewId);
}
async function readArchitectureReviewStatus(projectPath2, scanFingerprint) {
  const value = await readJsonArtifact(reviewStatePath$1(projectPath2));
  if (!isArchitectureReviewStatus(value)) {
    return deriveReviewStatusFromArchitecture(projectPath2, scanFingerprint);
  }
  if (value.scanFingerprint && value.scanFingerprint !== scanFingerprint) {
    return { ...value, state: "stale" };
  }
  if (value.state === "reviewed") {
    const derived = await deriveReviewStatusFromArchitecture(projectPath2, scanFingerprint);
    if (derived.state !== "reviewed") return derived;
  }
  return value;
}
async function writeArchitectureReviewStatus(projectPath2, status) {
  await writeJsonAtomic$1(reviewStatePath$1(projectPath2), status);
}
function compareArchitectureMaps(local, reviewed) {
  return {
    modules: compareById$2(local.modules, reviewed.modules),
    relationships: compareById$2(local.relationships, reviewed.relationships)
  };
}
function compareById$2(local, reviewed) {
  const localById = new Map(local.map((item) => [item.id, item]));
  const reviewedById = new Map(reviewed.map((item) => [item.id, item]));
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const [id, reviewedItem] of reviewedById) {
    const localItem = localById.get(id);
    if (!localItem) {
      added += 1;
      continue;
    }
    if (stableJson$1(localItem) !== stableJson$1(reviewedItem)) {
      modified += 1;
    }
  }
  for (const id of localById.keys()) {
    if (!reviewedById.has(id)) {
      removed += 1;
    }
  }
  return { added, removed, modified };
}
function stableJson$1(value) {
  return JSON.stringify(sortValue$1(value));
}
function sortValue$1(value) {
  if (Array.isArray(value)) return value.map(sortValue$1);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortValue$1(entry)])
  );
}
async function completeArchitectureReview(input, reviewing) {
  try {
    const result = await input.run(async (runId) => {
      const running = { ...reviewing, runId };
      await writeArchitectureReviewStatus(input.projectPath, running);
      input.onEvent(reviewEvent$1(input, running));
    });
    if (result.outcome === "failed") {
      const failed = {
        ...reviewing,
        state: "review-failed",
        runId: result.runId,
        completedAt: (/* @__PURE__ */ new Date()).toISOString(),
        error: result.error
      };
      await writeArchitectureReviewStatus(input.projectPath, failed);
      input.onEvent(reviewEvent$1(input, failed));
      return;
    }
    await input.persist(result.architectureMap);
    const reviewed = {
      ...reviewing,
      state: "reviewed",
      runId: result.runId,
      completedAt: result.architectureMap.generatedAt,
      diff: compareArchitectureMaps(input.localArchitecture, result.architectureMap)
    };
    await writeArchitectureReviewStatus(input.projectPath, reviewed);
    input.onEvent({
      ...reviewEvent$1(input, reviewed),
      architectureMap: result.architectureMap,
      graph: input.toGraph(result.architectureMap)
    });
  } catch (error) {
    const failed = {
      ...reviewing,
      state: "review-failed",
      completedAt: (/* @__PURE__ */ new Date()).toISOString(),
      error: {
        code: "persistence-failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
    await writeArchitectureReviewStatus(input.projectPath, failed).catch(() => void 0);
    input.onEvent(reviewEvent$1(input, failed));
  }
}
function reviewEvent$1(input, status) {
  return {
    projectId: input.projectId,
    reviewId: input.reviewId,
    scanFingerprint: input.scanFingerprint,
    status
  };
}
function reviewStatePath$1(projectPath2) {
  return join(projectPath2, FLOWWEAVE_DIR, REVIEW_STATE_FILENAME$1);
}
function isArchitectureReviewStatus(value) {
  if (typeof value !== "object" || value === null || !("state" in value)) return false;
  return value.state === "local" || value.state === "reviewing" || value.state === "reviewed" || value.state === "review-failed" || value.state === "stale" || value.state === "missing";
}
async function deriveReviewStatusFromArchitecture(projectPath2, scanFingerprint) {
  const value = await readJsonArtifact(join(projectPath2, FLOWWEAVE_DIR, "architecture-map.json"));
  if (typeof value !== "object" || value === null) {
    return { state: "missing", scanFingerprint };
  }
  const source = "source" in value ? value.source : void 0;
  const metadata = "metadata" in value && typeof value.metadata === "object" && value.metadata !== null ? value.metadata : void 0;
  const inputFingerprint = metadata && "inputFingerprint" in metadata ? metadata.inputFingerprint : void 0;
  if (typeof inputFingerprint === "string" && inputFingerprint !== scanFingerprint) {
    return { state: "stale", scanFingerprint: inputFingerprint };
  }
  if (source !== "agent" || typeof inputFingerprint !== "string") {
    return { state: "local", scanFingerprint };
  }
  return {
    state: "reviewed",
    scanFingerprint,
    agentId: metadata && "agentId" in metadata && typeof metadata.agentId === "string" ? metadata.agentId : void 0,
    runId: metadata && "runId" in metadata && typeof metadata.runId === "string" ? metadata.runId : void 0,
    completedAt: metadata && "generatedAt" in metadata && typeof metadata.generatedAt === "string" ? metadata.generatedAt : void 0
  };
}
const MAX_PROMPT_FILES$1 = 80;
const MAX_PROMPT_SYMBOLS_PER_FILE = 8;
const REPRESENTATIVE_FILE_LIMIT$1 = 40;
const architectureFlights = /* @__PURE__ */ new Map();
async function analyzeArchitecture(project, toolId, options) {
  if (options?.signal) return analyzeArchitectureOnce(project, toolId, options);
  const flightKey = `${project.rootPath}:${toolId}`;
  const existing = architectureFlights.get(flightKey);
  if (existing) return existing;
  const flight = analyzeArchitectureOnce(project, toolId, options).then(async (result) => {
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
async function analyzeArchitectureOnce(project, toolId, options) {
  const { index } = await buildSemanticIndex(project, {
    signal: options?.signal,
    onProgress: options?.onProgress
  });
  throwIfAborted(options?.signal, "Architecture analysis");
  const facts = semanticIndexToStructureFacts(project, index);
  const representativeFacts = { ...facts, files: selectRepresentativeStructureFacts(facts, REPRESENTATIVE_FILE_LIMIT$1) };
  const inputFingerprint = project.scanFingerprint ?? createScanFingerprint(representativeFacts);
  const prompt = buildArchitecturePrompt(representativeFacts);
  const localArchitectureBase = createLocalArchitectureMap(project, facts, "local");
  const localQuality = validateArchitectureMap(localArchitectureBase, facts);
  const localArchitecture = assessArchitectureMap(
    withLocalArchitectureMetadata(localArchitectureBase, inputFingerprint, localQuality),
    index,
    inputFingerprint
  );
  options?.onProgress?.({
    stage: "analyzing",
    completed: 0,
    total: 1,
    failed: 0,
    message: `Analyzing architecture with ${toolId}.`
  });
  if (toolId === "mock") {
    const agentOutput = mockArchitectureJson(createLocalArchitectureMap(project, representativeFacts, "agent"));
    const parsed = parseArchitectureJson(agentOutput, project, facts);
    if (!parsed) return failedArchitectureResult(toolId, "invalid-output", "Mock agent returned invalid architecture JSON.", []);
    const quality = validateArchitectureMap(parsed, representativeFacts);
    if (!quality.valid) return failedArchitectureResult(toolId, "quality-rejected", quality.reasons.join("; "), []);
    const architectureMap = assessArchitectureMap(
      withArchitectureMetadata(parsed, toolId, "mock", inputFingerprint, quality),
      index,
      inputFingerprint
    );
    throwIfAborted(options?.signal, "Architecture analysis");
    await writeArchitectureArtifacts(project.rootPath, architectureMap);
    const review2 = {
      state: "reviewed",
      reviewId: `review-${randomUUID()}`,
      scanFingerprint: inputFingerprint,
      agentId: toolId,
      runId: "mock",
      completedAt: architectureMap.generatedAt
    };
    await writeArchitectureReviewStatus(project.rootPath, review2);
    return architectureMapToResult(architectureMap, review2, "mock");
  }
  throwIfAborted(options?.signal, "Architecture analysis");
  await writeLocalArchitectureArtifacts(project.rootPath, localArchitecture);
  const projectId = options?.projectId ?? await registerProject(project.rootPath);
  const reviewId = options?.resumeArchitectureReview?.reviewId ?? `review-${randomUUID()}`;
  const review = await startArchitectureReview({
    projectId,
    projectPath: project.rootPath,
    reviewId,
    scanFingerprint: inputFingerprint,
    agentId: toolId,
    localArchitecture,
    startedAt: localArchitecture.generatedAt,
    persist: (architectureMap) => writeArchitectureArtifacts(project.rootPath, architectureMap),
    toGraph: architectureMapToGraph,
    run: (onRunId) => runArchitectureReview(
      project,
      toolId,
      prompt,
      facts,
      representativeFacts,
      index,
      inputFingerprint,
      onRunId,
      options?.resumeArchitectureReview?.runId
    ),
    onEvent: options?.onArchitectureReview ?? (() => void 0)
  });
  return architectureMapToResult(localArchitecture, review);
}
async function readArchitectureMap(projectPath2) {
  const architecturePath = join(projectPath2, FLOWWEAVE_DIR, "architecture-map.json");
  const value = await readJsonArtifact(architecturePath);
  if (value === void 0) return void 0;
  if (!isArchitectureMap(value)) {
    throw new Error(`FlowWeave architecture artifact is invalid and was preserved: ${architecturePath}`);
  }
  return migrateLegacyArchitectureSource(migrateArchitectureAssessments(value));
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
    "description": "one concise paragraph that explains this module's function and purpose in the project",
    "files": ["path"],
    "fileRoles": [{"path": "path", "role": "short purpose for this file or folder"}],
    "symbols": [{"name": "symbol", "kind": "function|class|method|export|variable", "filePath": "path", "role": "why it matters"}],
    "evidence": [{"filePath": "path", "symbol": "optional", "detail": "import/function/call evidence"}],
    "assessmentNotes": "optional explanation of uncertainty or change impact; FlowWeave calculates final risk and confidence locally"
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
- For fileRoles, include short explanations for important folders and files. Folder paths such as "src/services" are allowed when several files share a responsibility.
- File and folder roles must describe functional purpose, such as request handling, orchestration, validation, persistence, integration, configuration, or tests. Do not only list symbols.
- For symbols, choose key functions, classes, methods, or exports that explain how the module works; include a role that tells the user why the symbol matters.
- Every relationship must explain how modules connect using imports, calls, symbols, or external call hints.
- Relationship descriptions should describe real workflow collaboration, e.g. API boundary calls domain service, service reads/writes data access, service calls external integration, worker consumes queue work, or tests cover a target module.
- Use only relation and category enum values shown above.`;
}
function parseArchitectureJson(output, project, facts) {
  const extracted = extractStructuredJson(output, "modules");
  if (!("value" in extracted)) return void 0;
  try {
    const parsed = extracted.value;
    if (!Array.isArray(parsed.modules) || parsed.modules.length === 0) return void 0;
    const fileSet = new Set(facts.files.map((file) => file.path));
    const modules = parsed.modules.map((module, index) => normalizeModule$1(module, facts, fileSet, index)).filter((module) => Boolean(module));
    if (modules.length === 0) return void 0;
    const relationships = inferFallbackRelationships(modules, facts);
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
function architectureMapToResult(architectureMap, review, runId) {
  return {
    outcome: "generated",
    architectureMap,
    graph: architectureMapToGraph(architectureMap),
    review,
    runId
  };
}
async function writeLocalArchitectureArtifacts(projectPath2, architectureMap) {
  const previous = await readArchitectureMap(projectPath2);
  if (previous?.source === "agent") return;
  await writeArchitectureArtifacts(projectPath2, architectureMap);
}
async function runArchitectureReview(project, toolId, prompt, facts, representativeFacts, index, inputFingerprint, onRunId, resumeRunId) {
  try {
    const projectId = await registerProject(project.rootPath);
    const firstStarted = resumeRunId ? await readArchitectureRun(project.rootPath, resumeRunId, toolId) : await startToolPlan({
      projectId,
      toolId,
      prompt,
      executionMode: "plan",
      purpose: "artifact-analysis"
    });
    await onRunId(firstStarted.id);
    const firstRun = await waitForArchitectureRun(project.rootPath, firstStarted);
    if (firstRun.status !== "completed") {
      return reviewFailure(toolId, "agent-failed", firstRun.failure?.message ?? firstRun.summary ?? "Agent review did not complete.", firstRun.id);
    }
    const firstOutput = firstRun.outputText ?? collectStdout$1(firstRun.events);
    const firstParsed = parseArchitectureJson(firstOutput, project, facts);
    const firstQuality = firstParsed ? validateArchitectureMap(firstParsed, representativeFacts) : void 0;
    if (firstParsed && firstQuality?.valid) {
      const architectureMap2 = assessArchitectureMap(
        withArchitectureMetadata(firstParsed, toolId, firstRun.id, inputFingerprint, firstQuality),
        index,
        inputFingerprint
      );
      if (!await architectureInputIsCurrent(project.rootPath, inputFingerprint)) {
        return reviewFailure(toolId, "agent-failed", "Project scan changed before the Agent review completed.", firstRun.id);
      }
      return { outcome: "reviewed", architectureMap: architectureMap2, runId: firstRun.id };
    }
    const firstFailure = firstParsed ? firstQuality?.reasons.join("; ") ?? "Architecture quality validation failed." : "Agent returned invalid architecture JSON.";
    const retryStarted = await startToolPlan({
      projectId,
      toolId,
      prompt: buildArchitectureRepairPrompt(prompt, firstOutput, firstFailure),
      executionMode: "plan",
      purpose: "artifact-analysis"
    });
    await onRunId(retryStarted.id);
    const retry = await waitForArchitectureRun(project.rootPath, retryStarted);
    if (retry.status !== "completed") {
      return reviewFailure(toolId, "agent-failed", retry.failure?.message ?? retry.summary ?? "Agent repair review did not complete.", retry.id);
    }
    const retryOutput = retry.outputText ?? collectStdout$1(retry.events);
    const retryParsed = parseArchitectureJson(retryOutput, project, facts);
    const retryQuality = retryParsed ? validateArchitectureMap(retryParsed, representativeFacts) : void 0;
    if (!retryParsed) {
      return reviewFailure(toolId, "invalid-output", "Agent returned invalid architecture JSON after one repair attempt.", retry.id);
    }
    if (!retryQuality?.valid) {
      return reviewFailure(toolId, "quality-rejected", retryQuality?.reasons.join("; ") ?? "Architecture quality validation failed.", retry.id);
    }
    const architectureMap = assessArchitectureMap(
      withArchitectureMetadata(retryParsed, toolId, retry.id, inputFingerprint, retryQuality),
      index,
      inputFingerprint
    );
    if (!await architectureInputIsCurrent(project.rootPath, inputFingerprint)) {
      return reviewFailure(toolId, "agent-failed", "Project scan changed before the Agent review completed.", retry.id);
    }
    return { outcome: "reviewed", architectureMap, runId: retry.id };
  } catch (error) {
    if (error instanceof FlowWeaveError && error.category === "canceled") {
      return reviewFailure(toolId, "agent-failed", error.message, void 0);
    }
    return reviewFailure(toolId, "agent-failed", formatError$1(error), void 0);
  }
}
async function readArchitectureRun(projectPath2, runId, toolId) {
  const artifact = await readRunArtifact(projectPath2, runId);
  return {
    id: artifact.summary.id,
    toolId,
    status: artifact.summary.status,
    projectPath: projectPath2,
    startedAt: artifact.summary.startedAt,
    completedAt: artifact.summary.completedAt,
    summary: artifact.summary.summary,
    outputText: artifact.plan,
    failure: artifact.summary.failure,
    events: [],
    executionMode: "plan",
    purpose: "artifact-analysis"
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
    guidanceDraft: `Modify code around ${module.title}'s functional architecture responsibility. Prioritize the Files, Functions, and Connections evidence in the details panel.`,
    status: architectureMap.source === "agent" ? "mapped" : "needs-review",
    x: xForCategory(module.category) + index % 2 * 34,
    y: yForCategory(module.category, index),
    category: module.category,
    role: module.role,
    fileRoles: module.fileRoles,
    symbols: module.symbols,
    evidence: module.evidence,
    assessment: module.assessment,
    technologyStack: technologyStackForModule(module),
    architectureLayer: architectureLayerForCategory(module.category)
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
function technologyStackForModule(module) {
  const paths = module.files.map((file) => file.toLowerCase());
  if (paths.some((file) => /\.(tsx|jsx|vue|svelte|css|scss|html)$/.test(file))) return "frontend";
  if (paths.some((file) => /\.(swift|kt|kts|dart)$/.test(file))) return "mobile";
  if (module.category === "data-access" || paths.some((file) => /\.(sql|prisma)$/.test(file))) return "data";
  if (module.category === "external-integration") return "infrastructure";
  if (paths.some((file) => /\.(py|java|go|rs|php|cs|rb)$/.test(file))) return "backend";
  return module.category === "api-boundary" || module.category === "domain-service" ? "backend" : "shared";
}
function architectureLayerForCategory(category) {
  if (category === "api-boundary") return "api";
  if (category === "domain-service") return "domain";
  if (category === "data-access") return "data";
  if (category === "external-integration") return "integration";
  if (category === "test-surface") return "test";
  return "infrastructure";
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
async function writeArchitectureArtifacts(projectPath2, architectureMap) {
  const root = join(projectPath2, FLOWWEAVE_DIR);
  await Promise.all([
    writeJsonAtomic$1(join(root, "architecture-map.json"), architectureMap),
    writeJsonAtomic$1(join(root, "file-insights.json"), architectureMap.files),
    writeJsonAtomic$1(join(root, "module-map.json"), architectureMapToModuleMap(architectureMap))
  ]);
}
async function waitForArchitectureRun(projectPath2, initial) {
  if (initial.status !== "pending") return initial;
  const deadline = Date.now() + 24 * 60 * 60 * 1e3;
  while (Date.now() < deadline) {
    await new Promise((resolve2) => setTimeout(resolve2, 1e3));
    const artifact = await readRunArtifact(projectPath2, initial.id);
    if (artifact.summary.status === "pending") continue;
    return {
      ...initial,
      status: artifact.summary.status,
      completedAt: artifact.summary.completedAt,
      summary: artifact.summary.summary,
      outputText: artifact.plan
    };
  }
  return {
    ...initial,
    status: "failed",
    summary: `Agent review remained pending for 24 hours: ${initial.id}`
  };
}
function reviewFailure(agentId, code, message, runId) {
  return {
    outcome: "failed",
    runId,
    error: { code, message }
  };
}
async function architectureInputIsCurrent(projectPath2, inputFingerprint) {
  const projectArtifact = await readJsonArtifact(join(projectPath2, FLOWWEAVE_DIR, "project.json"));
  if (projectArtifact === void 0) return true;
  if (typeof projectArtifact !== "object" || projectArtifact === null || !("scanFingerprint" in projectArtifact)) {
    return false;
  }
  return projectArtifact.scanFingerprint === inputFingerprint;
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
      source: "agent",
      agentId,
      runId,
      generatedAt,
      inputFingerprint,
      fileCoverage: quality.fileCoverage,
      evidenceCoverage: quality.evidenceCoverage
    }
  };
}
function withLocalArchitectureMetadata(architectureMap, inputFingerprint, quality) {
  const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return {
    ...architectureMap,
    version: 2,
    source: "local",
    generatedAt,
    metadata: {
      source: "local",
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
function createLocalArchitectureMap(project, facts, source) {
  const groups = /* @__PURE__ */ new Map();
  for (const file of facts.files) {
    const key = fallbackModuleId(file, facts);
    groups.set(key, [...groups.get(key) ?? [], file]);
  }
  const modules = [...groups.entries()].map(([id, files]) => {
    const category = fallbackCategoryWithRelations(files, facts);
    const symbols = files.flatMap((file) => file.symbols.slice(0, 12));
    const title = titleFromId$1(id);
    return {
      id,
      title,
      category,
      nodeType: nodeTypeFromCategory(category),
      role: fallbackRole(category, files),
      description: fallbackModuleDescription(title, category, files),
      files: files.map((file) => file.path),
      fileRoles: fallbackFileRoles(files, category),
      symbols,
      evidence: files.slice(0, 5).map((file) => ({
        filePath: file.path,
        symbol: file.symbols[0]?.name,
        line: file.symbols[0]?.line,
        detail: evidenceFromInsight(file)
      })),
      risk: "unknown"
    };
  });
  const relationships = inferFallbackRelationships(modules, facts);
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
function inferFallbackRelationships(modules, facts) {
  const moduleByFile = /* @__PURE__ */ new Map();
  modules.forEach((module) => module.files.forEach((file) => moduleByFile.set(file, module.id)));
  const relationships = [];
  const seen = /* @__PURE__ */ new Set();
  for (const semanticRelation of facts.relations ?? []) {
    if (!semanticRelation.sourceFile || !semanticRelation.targetFile) continue;
    const source = moduleByFile.get(semanticRelation.sourceFile);
    const target = moduleByFile.get(semanticRelation.targetFile);
    if (!source || !target || source === target) continue;
    const relation2 = architectureRelationFromSemantic(semanticRelation.kind);
    const key = `${source}:${target}:${relation2}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relationships.push({
      id: `${source}-${target}-${relation2}`,
      source,
      target,
      relation: relation2,
      description: semanticRelation.detail,
      evidence: [{
        filePath: semanticRelation.sourceFile,
        symbol: semanticRelation.symbol,
        line: facts.files.find((file) => file.path === semanticRelation.sourceFile)?.symbols.find((symbol) => symbol.name === semanticRelation.symbol)?.line,
        detail: semanticRelation.detail
      }]
    });
  }
  for (const file of facts.files) {
    const source = moduleByFile.get(file.path);
    if (!source) continue;
    for (const specifier of file.imports) {
      const targetFile = resolveImportBySuffix(specifier, moduleByFile);
      const target = targetFile ? moduleByFile.get(targetFile) : void 0;
      if (!target || target === source) continue;
      const relation2 = relationForModules(modules, source, target);
      const key = `${source}:${target}:${relation2}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relationships.push({
        id: `${source}-${target}-${relation2}`,
        source,
        target,
        relation: relation2,
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
function normalizeModule$1(module, facts, fileSet, index) {
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
    role: module.role?.trim() || fallbackRole(category, facts.files.filter((file) => files.includes(file.path))),
    description: module.description?.trim() || fallbackModuleDescription(titleFromId$1(id), category, facts.files.filter((file) => files.includes(file.path))),
    files,
    fileRoles: normalizeFileRoles(module.fileRoles, files, facts.files, category),
    symbols,
    evidence: normalizeEvidence$1(module.evidence, files),
    risk: "unknown",
    confidence: void 0,
    assessment: void 0
  };
}
function compactFactsForPrompt$1(facts) {
  return {
    ...facts,
    files: facts.files.slice(0, MAX_PROMPT_FILES$1).map((file) => ({
      path: file.path,
      language: file.language,
      imports: file.imports.slice(0, 16),
      exports: file.exports.slice(0, 12),
      symbols: file.symbols.slice(0, MAX_PROMPT_SYMBOLS_PER_FILE).map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        exported: symbol.exported
      })),
      calls: file.calls.slice(0, 12),
      externalCalls: file.externalCalls.slice(0, 8)
    })),
    relations: facts.relations?.slice(0, 120)
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
function fallbackModuleId(file, facts) {
  const category = fallbackCategoryWithRelations([file], facts);
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
function fallbackCategoryWithRelations(files, facts) {
  const paths = new Set(files.map((file) => file.path));
  const httpRelations = (facts.relations ?? []).filter((relation2) => relation2.kind === "http");
  if (httpRelations.some((relation2) => relation2.targetFile && paths.has(relation2.targetFile))) {
    return "api-boundary";
  }
  if (httpRelations.some((relation2) => relation2.sourceFile && paths.has(relation2.sourceFile)) && files.some((file) => /(^|\/)(app|index|main|page|view|screen)[^/]*\.(tsx?|jsx?|vue)$/i.test(file.path))) {
    return "api-boundary";
  }
  return fallbackCategory(files);
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
function architectureRelationFromSemantic(kind) {
  if (kind === "database" || kind === "filesystem") return "reads_writes";
  if (kind === "event") return "publishes_event";
  if (kind === "test") return "tests";
  return "calls";
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
function fallbackRole(category, files) {
  const scope = commonDirectory(files.map((file) => file.path));
  const prefix = scope ? `${scope} contains` : "This module contains";
  const descriptions = {
    "api-boundary": `${prefix} request entry points and interface orchestration.`,
    "domain-service": `${prefix} business logic and application workflow code.`,
    "data-access": `${prefix} persistence, project data, and storage access code.`,
    "external-integration": `${prefix} code that connects FlowWeave to external runtimes or APIs.`,
    "job-worker": `${prefix} background analysis and generated artifact workflows.`,
    "shared-utility": `${prefix} shared utilities, UI helpers, configuration, and cross-cutting support.`,
    "test-surface": `${prefix} tests that verify behavior and protect regressions.`
  };
  return descriptions[category];
}
function fallbackModuleDescription(title, category, files) {
  const scope = commonDirectory(files.map((file) => file.path));
  const fileCount = files.length;
  const symbolNames = files.flatMap((file) => file.symbols.map((symbol) => symbol.name)).slice(0, 4);
  const evidence = symbolNames.length > 0 ? ` Key code signals include ${symbolNames.join(", ")}.` : "";
  const location = scope ? ` under ${scope}` : "";
  const descriptions = {
    "api-boundary": `${title} handles project entry points and routes user or process requests into the rest of the system.`,
    "domain-service": `${title} owns the main application behavior and coordinates related code paths${location}.`,
    "data-access": `${title} manages persisted project data, artifact storage, or schema-oriented access paths${location}.`,
    "external-integration": `${title} isolates calls into external tools, runtimes, or service boundaries${location}.`,
    "job-worker": `${title} runs background analysis or generated-artifact workflows across ${fileCount} files${location}.`,
    "shared-utility": `${title} provides reusable support code used across FlowWeave features${location}.`,
    "test-surface": `${title} verifies expected behavior and regression coverage for the project${location}.`
  };
  return `${descriptions[category]}${evidence}`;
}
function fallbackFileRoles(files, category) {
  const fileRoles = files.map((file) => ({ path: file.path, role: fileRoleFromInsight(file, category) }));
  const folderRoles = folderRolesFromFiles(files, category);
  return [...folderRoles, ...fileRoles];
}
function folderRolesFromFiles(files, category) {
  const byFolder = /* @__PURE__ */ new Map();
  for (const file of files) {
    for (const folder of folderPathsForFile$1(file.path)) {
      byFolder.set(folder, [...byFolder.get(folder) ?? [], file]);
    }
  }
  return [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 30).map(([path, folderFiles]) => ({
    path,
    role: folderRoleFromInsights(path, folderFiles, category)
  }));
}
function folderRoleFromInsights(path, files, category) {
  const folderName = path.split("/").at(-1) ?? path;
  const categoryName = categoryLabel(category).toLowerCase();
  if (/test|spec|__tests__/i.test(path)) return `Groups regression coverage for the ${categoryName}.`;
  if (/component|view|page|panel|workspace|node/i.test(path)) return `Groups UI components and interaction surfaces for the ${categoryName}.`;
  if (/service|domain|core|workflow|analysis|analyzer/i.test(path)) return `Groups service logic and workflow orchestration for the ${categoryName}.`;
  if (/store|storage|schema|database|repo|repository|data/i.test(path)) return `Groups storage and data handling code for the ${categoryName}.`;
  if (/agent|cli|ipc|adapter|bridge/i.test(path)) return `Groups agent, command, or process-boundary integration code for the ${categoryName}.`;
  if (/util|helper|shared|common|config/i.test(path)) return `Groups shared support utilities for the ${categoryName}.`;
  return `Groups ${files.length} related files in ${folderName} for the ${categoryName}.`;
}
function fileRoleFromInsight(file, category) {
  const fileName = file.path.split("/").at(-1) ?? file.path;
  const categoryName = category ? categoryLabel(category).toLowerCase() : "module";
  const symbolSummary = file.symbols.slice(0, 3).map((symbol) => symbol.name).join(", ");
  if (/test|spec|__tests__/i.test(file.path)) {
    return symbolSummary ? `Verifies ${symbolSummary} behavior for the ${categoryName}.` : `Provides regression coverage for the ${categoryName}.`;
  }
  if (file.externalCalls.length > 0) {
    return `Handles ${file.externalCalls[0].kind} integration work used by the ${categoryName}.`;
  }
  if (/config|vite|eslint|tsconfig|package/i.test(fileName)) {
    return `Configures build, runtime, or tooling behavior for the ${categoryName}.`;
  }
  if (/store|storage|schema|database|repo|repository/i.test(file.path)) {
    return `Manages persisted data shape or storage access for the ${categoryName}.`;
  }
  if (/component|workspace|panel|view|page|node/i.test(file.path)) {
    return `Implements user-facing interface behavior for the ${categoryName}.`;
  }
  if (/hook|use[A-Z]/.test(fileName)) {
    return `Coordinates stateful UI or workflow behavior for the ${categoryName}.`;
  }
  if (/adapter|agent|cli|ipc/i.test(file.path)) {
    return `Connects commands, agents, or process boundaries for the ${categoryName}.`;
  }
  if (symbolSummary) {
    return `Implements ${symbolSummary} responsibilities for the ${categoryName}.`;
  }
  return `Supports the ${categoryName} responsibility in this project.`;
}
function folderPathsForFiles$1(files) {
  return [...new Set(files.flatMap((file) => folderPathsForFile$1(file)))];
}
function folderPathsForFile$1(filePath) {
  const parts = filePath.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}
function commonDirectory(files) {
  const folders = files.map((file) => file.split("/").filter(Boolean).slice(0, -1));
  if (folders.length === 0) return void 0;
  const common = [];
  const shortest = Math.min(...folders.map((parts) => parts.length));
  for (let index = 0; index < shortest; index += 1) {
    const part = folders[0][index];
    if (!folders.every((folder) => folder[index] === part)) break;
    common.push(part);
  }
  return common.length > 0 ? common.join("/") : void 0;
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
function normalizeFileRoles(fileRoles, files, factsFiles, category) {
  const allowedPaths = /* @__PURE__ */ new Set([...files, ...folderPathsForFiles$1(files)]);
  const roles = (fileRoles ?? []).map((item) => ({ path: item.path.trim(), role: item.role.trim() })).filter((item) => item.path && item.role && allowedPaths.has(item.path));
  const roleByPath = new Map(roles.map((item) => [item.path, item.role]));
  const fileInsights = factsFiles.filter((file) => files.includes(file.path));
  const generatedRoles = fallbackFileRoles(fileInsights, category).filter((item) => !roleByPath.has(item.path));
  return [...roles, ...generatedRoles];
}
function normalizeEvidence$1(evidence, files) {
  return (evidence ?? []).filter((item) => !item.filePath || files.length === 0 || files.includes(item.filePath)).map((item) => ({
    filePath: item.filePath,
    symbol: item.symbol,
    line: Number.isInteger(item.line) ? item.line : void 0,
    detail: item.detail || "Architecture evidence"
  })).slice(0, 30);
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
function isArchitectureMap(value) {
  return typeof value === "object" && value !== null && "version" in value && (value.version === 1 || value.version === 2) && "projectName" in value && typeof value.projectName === "string" && "rootPath" in value && typeof value.rootPath === "string" && "modules" in value && Array.isArray(value.modules) && "relationships" in value && Array.isArray(value.relationships) && "files" in value && Array.isArray(value.files) && "symbols" in value && Array.isArray(value.symbols);
}
function assessArchitectureMap(architectureMap, index, scanFingerprint) {
  const graph = architectureMapToGraph(architectureMap);
  const assessedNodes = assessModules(graph.nodes, graph.edges, index, scanFingerprint, architectureMap.generatedAt);
  const assessedById = new Map(assessedNodes.map((node) => [node.id, node]));
  return {
    ...architectureMap,
    modules: architectureMap.modules.map((module) => {
      const assessed = assessedById.get(module.id);
      return assessed ? {
        ...module,
        risk: assessed.risk,
        confidence: void 0,
        assessment: assessed.assessment
      } : module;
    })
  };
}
function migrateArchitectureAssessments(architectureMap) {
  return {
    ...architectureMap,
    modules: architectureMap.modules.map((module) => {
      if (module.assessment) return module;
      const legacyRisk = module.risk;
      const risk = legacyRisk === "blocked" ? "high" : legacyRisk === "review" ? "medium" : legacyRisk === "normal" ? "low" : module.risk;
      const assessment = unknownAssessment(architectureMap.metadata?.inputFingerprint ?? "", architectureMap.generatedAt);
      const legacyConfidence = typeof module.confidence === "number" ? Math.max(0, Math.min(100, Math.round(module.confidence * 100))) : void 0;
      return {
        ...module,
        risk,
        confidence: void 0,
        assessment: {
          ...assessment,
          confidence: legacyConfidence === void 0 ? assessment.confidence : {
            score: legacyConfidence,
            level: legacyConfidence >= 80 ? "high" : legacyConfidence >= 50 ? "medium" : "low",
            factors: [{
              id: "legacy-confidence",
              label: "Legacy confidence",
              score: legacyConfidence,
              maxScore: 100,
              reason: "Migrated from a previous architecture artifact. Regenerate architecture to calculate evidence-backed confidence.",
              evidence: [{ detail: "Legacy architecture confidence value" }]
            }]
          },
          risk: {
            systemLevel: risk,
            effectiveLevel: risk,
            factors: [{
              id: "legacy-risk",
              label: "Legacy risk",
              score: risk === "high" ? 70 : risk === "medium" ? 30 : 0,
              maxScore: 100,
              reason: "Migrated from a previous architecture artifact. Regenerate architecture to calculate impact risk.",
              evidence: [{ detail: "Legacy architecture risk value" }]
            }]
          }
        }
      };
    })
  };
}
function migrateLegacyArchitectureSource(architectureMap) {
  const legacySource = architectureMap.source;
  if (legacySource !== "fallback") return architectureMap;
  return { ...architectureMap, source: "local", metadata: void 0 };
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
    source: architecture.architectureMap.source,
    graph: architecture.graph
  };
}
const REVIEW_STATE_FILENAME = "sequence-review.json";
const activeReviewIds = /* @__PURE__ */ new Set();
async function startSequenceReview(input) {
  const reviewing = {
    state: "reviewing",
    reviewId: input.reviewId,
    scanFingerprint: input.scanFingerprint,
    agentId: input.agentId,
    startedAt: input.startedAt
  };
  await writeSequenceReviewStatus(input.projectPath, reviewing);
  input.onEvent(reviewEvent(input, reviewing));
  activeReviewIds.add(input.reviewId);
  void completeSequenceReview(input, reviewing).finally(() => activeReviewIds.delete(input.reviewId));
  return reviewing;
}
function isSequenceReviewActive(reviewId) {
  return activeReviewIds.has(reviewId);
}
async function readSequenceReviewStatus(projectPath2, scanFingerprint) {
  const value = await readJsonArtifact(reviewStatePath(projectPath2));
  if (!isSequenceReviewStatus(value)) {
    return deriveReviewStatusFromBundle(projectPath2, scanFingerprint);
  }
  if (value.scanFingerprint && value.scanFingerprint !== scanFingerprint) {
    return { ...value, state: "stale" };
  }
  if (value.state === "reviewed") {
    const derived = await deriveReviewStatusFromBundle(projectPath2, scanFingerprint);
    if (derived.state !== "reviewed") return derived;
  }
  return value;
}
async function writeSequenceReviewStatus(projectPath2, status) {
  await writeJsonAtomic$1(reviewStatePath(projectPath2), status);
}
function compareSequenceBundles(local, reviewed) {
  return {
    participants: compareById$1(local.architectural.participants, reviewed.architectural.participants),
    messages: compareById$1(local.architectural.messages, reviewed.architectural.messages)
  };
}
function compareById$1(local, reviewed) {
  const localById = new Map(local.map((item) => [item.id, item]));
  const reviewedById = new Map(reviewed.map((item) => [item.id, item]));
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const [id, reviewedItem] of reviewedById) {
    const localItem = localById.get(id);
    if (!localItem) {
      added += 1;
    } else if (stableJson(localItem) !== stableJson(reviewedItem)) {
      modified += 1;
    }
  }
  for (const id of localById.keys()) {
    if (!reviewedById.has(id)) removed += 1;
  }
  return { added, removed, modified };
}
function stableJson(value) {
  return JSON.stringify(sortValue(value));
}
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortValue(entry)])
  );
}
async function completeSequenceReview(input, reviewing) {
  let result;
  try {
    result = await input.run(async (runId) => {
      const running = { ...reviewing, runId };
      await writeSequenceReviewStatus(input.projectPath, running);
      input.onEvent(reviewEvent(input, running));
    });
  } catch (error) {
    await publishFailedReview(input, reviewing, {
      code: "agent-failed",
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  if (result.outcome === "failed") {
    await publishFailedReview(input, reviewing, result.error, result.runId);
    return;
  }
  try {
    await input.persist(result.bundle);
    const reviewed = {
      ...reviewing,
      state: "reviewed",
      runId: result.runId,
      completedAt: result.bundle.generatedAt,
      diff: compareSequenceBundles(input.localBundle, result.bundle)
    };
    await writeSequenceReviewStatus(input.projectPath, reviewed);
    input.onEvent({
      ...reviewEvent(input, reviewed),
      bundle: result.bundle
    });
  } catch (error) {
    const failed = {
      ...reviewing,
      state: "review-failed",
      completedAt: (/* @__PURE__ */ new Date()).toISOString(),
      error: {
        code: "persistence-failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
    await writeSequenceReviewStatus(input.projectPath, failed).catch(() => void 0);
    input.onEvent(reviewEvent(input, failed));
  }
}
async function publishFailedReview(input, reviewing, error, runId) {
  const failed = {
    ...reviewing,
    state: "review-failed",
    runId,
    completedAt: (/* @__PURE__ */ new Date()).toISOString(),
    error
  };
  await writeSequenceReviewStatus(input.projectPath, failed);
  input.onEvent(reviewEvent(input, failed));
}
function reviewEvent(input, status) {
  return {
    projectId: input.projectId,
    reviewId: input.reviewId,
    scanFingerprint: input.scanFingerprint,
    status
  };
}
function reviewStatePath(projectPath2) {
  return join(projectPath2, FLOWWEAVE_DIR, REVIEW_STATE_FILENAME);
}
function isSequenceReviewStatus(value) {
  if (typeof value !== "object" || value === null || !("state" in value)) return false;
  return value.state === "local" || value.state === "reviewing" || value.state === "reviewed" || value.state === "review-failed" || value.state === "stale" || value.state === "missing";
}
async function deriveReviewStatusFromBundle(projectPath2, scanFingerprint) {
  const value = await readJsonArtifact(join(projectPath2, FLOWWEAVE_DIR, "sequence-diagrams.json"));
  if (typeof value !== "object" || value === null) {
    return { state: "missing", scanFingerprint };
  }
  const source = "source" in value ? value.source : void 0;
  const metadata = "metadata" in value && typeof value.metadata === "object" && value.metadata !== null ? value.metadata : void 0;
  const inputFingerprint = metadata && "inputFingerprint" in metadata ? metadata.inputFingerprint : void 0;
  if (typeof inputFingerprint === "string" && inputFingerprint !== scanFingerprint) {
    return { state: "stale", scanFingerprint: inputFingerprint };
  }
  if (source !== "agent" || typeof inputFingerprint !== "string") {
    return { state: "local", scanFingerprint };
  }
  return {
    state: "reviewed",
    scanFingerprint,
    agentId: metadata && "agentId" in metadata && typeof metadata.agentId === "string" ? metadata.agentId : void 0,
    runId: metadata && "runId" in metadata && typeof metadata.runId === "string" ? metadata.runId : void 0,
    completedAt: metadata && "generatedAt" in metadata && typeof metadata.generatedAt === "string" ? metadata.generatedAt : void 0
  };
}
function migrateCanvasToScan(canvas, projectPath2, scanFingerprint, projectFiles) {
  const knownFiles = new Set(flattenFilePaths(projectFiles));
  const knownFileOrFolderPaths = /* @__PURE__ */ new Set([...knownFiles, ...folderPathsForFiles([...knownFiles])]);
  const nodes = canvas.nodes.map((node) => sanitizeNodeFiles(node, knownFiles, knownFileOrFolderPaths));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = sanitizeEdges(canvas.edges, nodeIds, knownFiles);
  return {
    ...canvas,
    version: 3,
    projectPath: projectPath2,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    scanFingerprint,
    artifactState: "current",
    layout: migrateLayout(canvas, nodes),
    nodes,
    edges
  };
}
function migrateLayout(canvas, nodes) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const manualPositions = canvas.layout?.manualPositions ?? Object.fromEntries(
    nodes.map((node) => [node.id, { x: node.x, y: node.y }])
  );
  return {
    activeMode: canvas.layout?.activeMode ?? "manual",
    manualPositions: filterPositions(manualPositions, nodeIds),
    autoLayouts: Object.fromEntries(
      Object.entries(canvas.layout?.autoLayouts ?? {}).map(([mode, positions]) => [
        mode,
        filterPositions(positions ?? {}, nodeIds)
      ])
    ),
    collapsedGroups: [...new Set(canvas.layout?.collapsedGroups ?? [])]
  };
}
function filterPositions(positions, nodeIds) {
  return Object.fromEntries(
    Object.entries(positions).filter(
      ([nodeId, position]) => nodeIds.has(nodeId) && Number.isFinite(position.x) && Number.isFinite(position.y)
    )
  );
}
function flattenFilePaths(nodes) {
  return nodes.flatMap((node) => [
    ...node.type === "file" ? [node.path] : [],
    ...flattenFilePaths(node.children ?? [])
  ]);
}
function sanitizeNodeFiles(node, knownFiles, knownFileOrFolderPaths) {
  const risk = normalizeLegacyRisk(node.risk);
  const assessment = node.assessment ?? migrateLegacyAssessment(node, risk);
  return {
    ...node,
    risk: assessment.risk.effectiveLevel,
    confidence: void 0,
    assessment,
    files: node.files.filter((filePath) => knownFiles.has(filePath)),
    fileRoles: node.fileRoles?.filter((item) => knownFileOrFolderPaths.has(item.path)),
    symbols: node.symbols?.filter((symbol) => knownFiles.has(symbol.filePath)),
    evidence: node.evidence?.filter((item) => !item.filePath || knownFiles.has(item.filePath))
  };
}
function folderPathsForFiles(files) {
  return [...new Set(files.flatMap((file) => folderPathsForFile(file)))];
}
function folderPathsForFile(filePath) {
  const parts = filePath.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}
function migrateLegacyAssessment(node, risk) {
  const assessment = unknownAssessment("", (/* @__PURE__ */ new Date(0)).toISOString());
  const legacyConfidence = typeof node.confidence === "number" ? Math.max(0, Math.min(100, Math.round(node.confidence * 100))) : void 0;
  return {
    ...assessment,
    confidence: legacyConfidence === void 0 ? assessment.confidence : {
      score: legacyConfidence,
      level: scoreLevel(legacyConfidence),
      factors: [{
        id: "legacy-confidence",
        label: "Legacy confidence",
        score: legacyConfidence,
        maxScore: 100,
        reason: "Migrated from the previous unstructured confidence value. A rescan will replace it.",
        evidence: [{ detail: "Legacy Canvas confidence value" }]
      }]
    },
    risk: {
      systemLevel: risk,
      effectiveLevel: risk,
      factors: [{
        id: "legacy-risk",
        label: "Legacy risk",
        score: risk === "high" ? 70 : risk === "medium" ? 30 : 0,
        maxScore: 100,
        reason: "Migrated from the previous risk label. A rescan will replace it.",
        evidence: [{ detail: "Legacy Canvas risk value" }]
      }]
    }
  };
}
function normalizeLegacyRisk(risk) {
  if (risk === "normal") return "low";
  if (risk === "review") return "medium";
  if (risk === "blocked") return "high";
  return risk;
}
function scoreLevel(score) {
  if (score >= 80) return "high";
  if (score >= 50) return "medium";
  return "low";
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
async function getProjectAgentConnection(projectPath2) {
  const paths = connectionPaths(projectPath2);
  const config = await readConnectionConfig(paths.configPath);
  if (!config) {
    return createStatus(projectPath2, void 0, "disabled", "External Agent connection has not been configured.");
  }
  if (!config.enabled) {
    return createStatus(projectPath2, config, "disabled", "External Agent connection is disabled for this project.");
  }
  const connectionIssue = await findConnectionFileIssue(projectPath2, config.platforms);
  if (connectionIssue) {
    return createStatus(projectPath2, config, "needs-refresh", connectionIssue);
  }
  const latestSourceTime = await latestArtifactModificationTime(projectPath2);
  if (latestSourceTime > Date.parse(config.updatedAt)) {
    return createStatus(projectPath2, config, "needs-refresh", "FlowWeave project artifacts changed after the Agent context was generated.");
  }
  return createStatus(projectPath2, config, "ready", "Project instructions and FlowWeave Agent context are ready.");
}
async function enableProjectAgentConnection(projectPath2) {
  await requireProjectArtifact(projectPath2);
  return writeProjectAgentConnection(projectPath2, DEFAULT_PLATFORMS);
}
async function refreshProjectAgentConnection(projectPath2) {
  const config = await readConnectionConfig(connectionPaths(projectPath2).configPath);
  if (!config) {
    throw new Error(`Cannot refresh Agent connection for "${projectPath2}": the project has not been configured.`);
  }
  if (!config.enabled) {
    throw new Error(`Cannot refresh Agent connection for "${projectPath2}": the connection is disabled.`);
  }
  await requireProjectArtifact(projectPath2);
  return writeProjectAgentConnection(projectPath2, config.platforms);
}
async function refreshProjectAgentConnectionIfEnabled(projectPath2) {
  const config = await readConnectionConfig(connectionPaths(projectPath2).configPath);
  if (!config?.enabled) return void 0;
  return refreshProjectAgentConnection(projectPath2);
}
async function disableProjectAgentConnection(projectPath2) {
  const paths = connectionPaths(projectPath2);
  const existingConfig = await readConnectionConfig(paths.configPath);
  const platforms = existingConfig?.platforms ?? DEFAULT_PLATFORMS;
  const plannedUpdates = await planManagedBlockRemoval(platformEntries(projectPath2, platforms));
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
  return createStatus(projectPath2, config, "disabled", "External Agent connection is disabled for this project.");
}
function getProjectAgentContextPath(projectPath2) {
  return connectionPaths(projectPath2).contextPath;
}
async function writeProjectAgentConnection(projectPath2, platforms) {
  const paths = connectionPaths(projectPath2);
  const artifacts = await readProjectArtifacts(projectPath2);
  const context = buildAgentContext(projectPath2, artifacts);
  const block = buildManagedInstructionBlock();
  const plannedUpdates = await planManagedBlockUpsert(platformEntries(projectPath2, platforms), block);
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
  return createStatus(projectPath2, config, "ready", "Project instructions and FlowWeave Agent context are ready.");
}
function connectionPaths(projectPath2) {
  const flowweavePath = join(projectPath2, FLOWWEAVE_DIR);
  return {
    configPath: join(flowweavePath, CONNECTION_CONFIG_FILE),
    contextPath: join(flowweavePath, AGENT_CONTEXT_FILE)
  };
}
function platformEntries(projectPath2, platforms) {
  const entries = {
    codex: join(projectPath2, "AGENTS.md"),
    claude: join(projectPath2, "CLAUDE.md"),
    gemini: join(projectPath2, "GEMINI.md"),
    cursor: join(projectPath2, ".cursor", "rules", "flowweave.mdc")
  };
  return platforms.map((platform) => ({ platform, filePath: entries[platform] }));
}
function generatedFilePaths(projectPath2, platforms) {
  return [
    connectionPaths(projectPath2).contextPath,
    ...platformEntries(projectPath2, platforms).map((entry) => entry.filePath)
  ];
}
function createStatus(projectPath2, config, state, message) {
  const platforms = config?.platforms ?? DEFAULT_PLATFORMS;
  const paths = connectionPaths(projectPath2);
  return {
    state,
    enabled: config?.enabled ?? false,
    needsConfirmation: !config,
    projectPath: projectPath2,
    contextPath: paths.contextPath,
    configPath: paths.configPath,
    generatedFiles: generatedFilePaths(projectPath2, platforms),
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
async function requireProjectArtifact(projectPath2) {
  const projectPathname = join(projectPath2, FLOWWEAVE_DIR, "project.json");
  try {
    await stat(projectPathname);
  } catch (error) {
    throw new Error(`Cannot connect external Agents: required FlowWeave project artifact is missing at "${projectPathname}". ${formatError(error)}`);
  }
}
async function readProjectArtifacts(projectPath2) {
  const root = join(projectPath2, FLOWWEAVE_DIR);
  const project = await readRequiredJson(join(root, "project.json"));
  const [canvas, architecture, sequences, fileTree, taskPaths] = await Promise.all([
    readOptionalJson(join(root, "canvas", "main.canvas.json")),
    readOptionalJson(join(root, "architecture-map.json")),
    readOptionalJson(join(root, "sequence-diagrams.json")),
    readOptionalText(join(root, "context", "file-tree.md")),
    listTaskPaths(join(root, "tasks"), projectPath2)
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
function buildAgentContext(projectPath2, artifacts) {
  const lines = [
    "# FlowWeave Agent Context",
    "",
    `Project: ${artifacts.project.projectName}`,
    `Project root: ${projectPath2}`,
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
    `- Architectural sequence diagram: ${artifacts.sequences ? "`.flowweave/sequence-diagrams.json`" : "not generated"}`,
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
    const assessment = node.assessment ? ` Risk: ${node.assessment.risk.effectiveLevel}${node.assessment.risk.systemScore === void 0 ? "" : ` (${node.assessment.risk.systemScore}/100)`}. Confidence: ${node.assessment.confidence.level}${node.assessment.confidence.score === void 0 ? "" : ` (${node.assessment.confidence.score}/100)`}.` : " Assessment unavailable.";
    lines.push(`- ${node.title} (${node.nodeType}): ${node.description || node.role || "No description."}${assessment}${files}`);
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
    const assessment = module.assessment ? ` Risk: ${module.assessment.risk.effectiveLevel}. Confidence: ${module.assessment.confidence.level}.` : "";
    lines.push(`- ${module.title} (${module.category}): ${module.role}.${assessment} Files: ${module.files.join(", ") || "none"}.`);
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
async function latestArtifactModificationTime(projectPath2) {
  const root = join(projectPath2, FLOWWEAVE_DIR);
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
async function findConnectionFileIssue(projectPath2, platforms) {
  const contextPath = connectionPaths(projectPath2).contextPath;
  if (await readOptionalText(contextPath) === void 0) {
    return `Connection file is missing: ${contextPath}`;
  }
  for (const entry of platformEntries(projectPath2, platforms)) {
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
async function listTaskPaths(tasksPath, projectPath2) {
  try {
    const entries = await readdir(tasksPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && (entry.name === "current.task.md" || entry.name === "current.task.json")).map((entry) => relative(projectPath2, join(tasksPath, entry.name))).sort();
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
  "**/.DS_Store",
  "**/.env",
  "**/.env.*",
  "**/*.{key,pem,p12,pfx,crt,cer}",
  "**/credentials.{json,yml,yaml}",
  "**/*credentials*.{json,yml,yaml}",
  "**/*secret*.{json,yml,yaml}"
];
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ENTRIES = 1e4;
const DEFAULT_SCAN_CONCURRENCY = 32;
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
async function scanProject(rootPath, options) {
  const ignore = [...DEFAULT_IGNORE, ...options?.ignore ?? []];
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const concurrency = normalizeConcurrency(options?.concurrency);
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
  const nonSymlinkEntries = await filterSafeEntries(rootPath, entries, concurrency);
  const filteredEntries = nonSymlinkEntries.filter((entry) => {
    const depth = entry.split("/").filter(Boolean).length - 1;
    return depth <= maxDepth;
  });
  const visibleEntries = filteredEntries.slice(0, maxEntries);
  const metadata = await readEntryMetadata(rootPath, visibleEntries, concurrency);
  const files = buildTree(visibleEntries, metadata);
  const summary = buildSummary(visibleEntries);
  summary.displayedEntries = visibleEntries.length;
  summary.truncated = filteredEntries.length > visibleEntries.length;
  const git2 = await readGitSummary(rootPath);
  const project = {
    version: 2,
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
async function readEntryMetadata(rootPath, entries, concurrency) {
  const files = entries.filter((entry) => !entry.endsWith("/"));
  const results = await mapWithConcurrency(files, concurrency, async (entry) => {
    const info = await stat(join(rootPath, ...entry.split("/")));
    return [entry, { size: info.size, modifiedAt: info.mtime.toISOString() }];
  });
  return new Map(results);
}
async function filterSafeEntries(rootPath, entries, concurrency) {
  const canonicalRoot = await realpath(rootPath);
  const results = await mapWithConcurrency(entries, concurrency, async (entry) => {
    const relativeEntry = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const absoluteEntry = join(rootPath, ...relativeEntry.split("/"));
    const info = await lstat(absoluteEntry);
    if (info.isSymbolicLink()) return void 0;
    const canonicalEntry = await realpath(absoluteEntry);
    const fromRoot = relative(canonicalRoot, canonicalEntry);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return void 0;
    return entry;
  });
  return results.filter((entry) => Boolean(entry));
}
function normalizeConcurrency(value) {
  if (value === void 0) return DEFAULT_SCAN_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1 || value > 128) {
    throw new Error(`Project scan concurrency must be an integer between 1 and 128: ${value}`);
  }
  return value;
}
async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}
function flattenFiles$1(nodes) {
  return nodes.flatMap((node) => [
    ...node.type === "file" ? [{
      path: node.path,
      language: node.language,
      size: node.size,
      modifiedAt: node.modifiedAt
    }] : [],
    ...flattenFiles$1(node.children ?? [])
  ]);
}
function buildTree(entries, metadata) {
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
      size: isFolder ? void 0 : metadata.get(nodePath)?.size,
      modifiedAt: isFolder ? void 0 : metadata.get(nodePath)?.modifiedAt,
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
function buildModificationContext(input) {
  const sequenceInstruction = input.sequenceInstruction?.trim() || void 0;
  return {
    schemaVersion: 1,
    source: "FlowWeave",
    generatedAt: input.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    project: {
      label: input.projectLabel,
      path: input.projectPath,
      scanFingerprint: input.scanFingerprint
    },
    canvas: {
      selectedModuleId: input.selectedNodeId,
      modules: input.nodes,
      relations: input.edges
    },
    sequence: input.sequenceBundle ? {
      source: input.sequenceBundle.source,
      generatedAt: input.sequenceBundle.generatedAt,
      activeKind: "architectural",
      revisionInstruction: sequenceInstruction,
      selectedMessageId: input.selectedSequenceMessageId,
      selectedParticipantId: input.selectedSequenceParticipantId,
      diagrams: {
        architectural: serializeSequenceDiagram(input.sequenceBundle.architectural)
      }
    } : void 0,
    userInstructions: {
      canvas: input.nodes.filter((node) => node.guidanceDraft.trim()).map((node) => ({ moduleId: node.id, title: node.title, guidance: node.guidanceDraft })),
      sequence: sequenceInstruction
    }
  };
}
function buildModificationContextJson(context) {
  return `${JSON.stringify(context, null, 2)}
`;
}
function buildModificationDeltaContextJson(context) {
  return `${JSON.stringify(context, null, 2)}
`;
}
function createModificationGuidanceContext(projectLabel, projectPath2, result) {
  return {
    schemaVersion: 2,
    source: "FlowWeave",
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    project: {
      label: projectLabel,
      path: projectPath2,
      scanFingerprint: result.snapshot.scanFingerprint
    },
    delta: result.delta,
    hasChanges: result.hasChanges,
    artifactReferences: [
      ".flowweave/project.json",
      ".flowweave/canvas/main.canvas.json",
      ".flowweave/architecture-map.json",
      ".flowweave/sequence-diagrams.json"
    ]
  };
}
function buildModificationDeltaGuidanceMarkdown(context) {
  const delta = context.delta;
  return `# FlowWeave Pending Modification Guidance

Generated: ${context.generatedAt}
Project: ${context.project.label}
Project path: ${context.project.path}

Read existing project and FlowWeave artifacts when historical context is needed:
${context.artifactReferences.map((path) => `- ${path}`).join("\n")}

${context.hasChanges ? formatPendingChanges(delta) : "No unacknowledged user modifications."}
`;
}
function buildAgentPrompt(context, promptKind, executionMode) {
  const effectiveKind = promptKind;
  return `You are FlowWeave's agent.

Prompt kind: ${effectiveKind}
Execution mode: ${executionMode}

Rules:
- Use the JSON context as the source of truth.
- Do not infer files, APIs, symbols, or behavior not present in context or source code.
- In plan mode, do not edit files.
- Return the requested output contract.

Output contract:
${outputContract()}

Context JSON:
\`\`\`json
${buildModificationContextJson(context).trimEnd()}
\`\`\``;
}
function outputContract(promptKind) {
  {
    return [
      "Return a complete updated architectural sequence diagram JSON object when revising the diagram.",
      "If code changes are needed instead, return a plan with affected files, risks, and tests.",
      "Do not return a patch fragment."
    ].join("\n");
  }
}
function formatPendingChanges(delta) {
  const sections = [];
  if (delta.modules.added.length) {
    sections.push(`## Added Modules

${delta.modules.added.map(
      (module) => `### ${module.title} (${module.id})

${JSON.stringify(module, null, 2)}`
    ).join("\n\n")}`);
  }
  if (delta.modules.updated.length) {
    sections.push(`## Updated Modules

${delta.modules.updated.map(
      (module) => `### ${module.title} (${module.id})

${JSON.stringify(module.changes, null, 2)}`
    ).join("\n\n")}`);
  }
  if (delta.modules.deleted.length) {
    sections.push(`## Deleted Modules

${delta.modules.deleted.map(
      (module) => `- ${module.title} (${module.id})`
    ).join("\n")}`);
  }
  if (delta.relations.added.length) {
    sections.push(`## Added Relations

${delta.relations.added.map(
      (relation2) => `- ${relation2.source} -> ${relation2.target}: ${relation2.relation}${relation2.guidanceNote ? ` — ${relation2.guidanceNote}` : ""}`
    ).join("\n")}`);
  }
  if (delta.relations.updated.length) {
    sections.push(`## Updated Relations

${delta.relations.updated.map(
      (relation2) => `- ${relation2.id}: ${JSON.stringify(relation2.changes)}`
    ).join("\n")}`);
  }
  if (delta.relations.deleted.length) {
    sections.push(`## Deleted Relations

${delta.relations.deleted.map(
      (relation2) => `- ${relation2.source} -> ${relation2.target} (${relation2.id})`
    ).join("\n")}`);
  }
  if (delta.sequenceInstruction) {
    sections.push(`## Sequence Diagram Instruction

${delta.sequenceInstruction}`);
  }
  return sections.join("\n\n");
}
function serializeSequenceDiagram(diagram) {
  return {
    id: diagram.id,
    title: diagram.title,
    kind: diagram.kind,
    summary: diagram.summary,
    participants: diagram.participants.map((participant) => ({
      id: participant.id,
      title: participant.title,
      kind: participant.kind,
      description: participant.description,
      filePath: participant.filePath,
      symbol: participant.symbol
    })),
    messages: diagram.messages.slice().sort((left, right) => left.sequence - right.sequence).map((message) => ({
      id: message.id,
      sequence: message.sequence,
      from: message.from,
      to: message.to,
      kind: message.kind,
      label: message.label,
      description: message.description,
      methodName: message.methodName,
      input: message.input,
      output: message.output,
      evidence: message.evidence
    })),
    evidence: diagram.evidence
  };
}
function normalizeModificationSnapshot(canvas, sequenceInstruction) {
  return {
    scanFingerprint: canvas.scanFingerprint,
    canvas: {
      modules: canvas.nodes.map(normalizeModule).sort(compareById),
      relations: canvas.edges.map(normalizeRelation).sort(compareById)
    },
    sequenceInstruction: sequenceInstruction.trim() || void 0
  };
}
function buildModificationDelta(baseline, current) {
  const baselineModules = new Map(baseline.canvas.modules.map((module) => [module.id, module]));
  const currentModules = new Map(current.canvas.modules.map((module) => [module.id, module]));
  const baselineRelations = new Map(baseline.canvas.relations.map((relation2) => [relation2.id, relation2]));
  const currentRelations = new Map(current.canvas.relations.map((relation2) => [relation2.id, relation2]));
  return {
    modules: {
      added: current.canvas.modules.filter((module) => !baselineModules.has(module.id)).map(
        (module) => baseline.moduleGuidanceAcknowledgements?.[module.id] === module.guidanceDraft ? { ...module, guidanceDraft: "" } : module
      ),
      updated: current.canvas.modules.flatMap((module) => {
        const previous = baselineModules.get(module.id);
        if (!previous) return [];
        const changes = changedFields(previous, module, ["id"]);
        return Object.keys(changes).length > 0 ? [{ id: module.id, title: module.title, changes }] : [];
      }),
      deleted: baseline.canvas.modules.filter((module) => !currentModules.has(module.id)).map(({ id, title }) => ({ id, title }))
    },
    relations: {
      added: current.canvas.relations.filter((relation2) => !baselineRelations.has(relation2.id)),
      updated: current.canvas.relations.flatMap((relation2) => {
        const previous = baselineRelations.get(relation2.id);
        if (!previous) return [];
        const changes = changedFields(previous, relation2, ["id"]);
        return Object.keys(changes).length > 0 ? [{ id: relation2.id, changes }] : [];
      }),
      deleted: baseline.canvas.relations.filter((relation2) => !currentRelations.has(relation2.id)).map(({ id, source, target }) => ({ id, source, target }))
    },
    sequenceInstruction: current.sequenceInstruction && current.sequenceInstruction !== baseline.sequenceInstruction ? current.sequenceInstruction : void 0
  };
}
function hasModificationDelta(delta) {
  return Boolean(
    delta.sequenceInstruction || delta.modules.added.length || delta.modules.updated.length || delta.modules.deleted.length || delta.relations.added.length || delta.relations.updated.length || delta.relations.deleted.length
  );
}
function acknowledgeModificationDelta(baseline, sentSnapshot, scope, acknowledgedAt) {
  if (scope.kind === "all") {
    return {
      version: 1,
      acknowledgedAt,
      ...sentSnapshot,
      moduleGuidanceAcknowledgements: {}
    };
  }
  if (scope.kind === "sequence") {
    return {
      ...baseline,
      acknowledgedAt,
      sequenceInstruction: sentSnapshot.sequenceInstruction
    };
  }
  const sentModule = sentSnapshot.canvas.modules.find((module) => module.id === scope.moduleId);
  if (!sentModule) {
    throw new Error(`Cannot acknowledge guidance for missing module: ${scope.moduleId}`);
  }
  const baselineModule = baseline.canvas.modules.find((module) => module.id === scope.moduleId);
  if (!baselineModule) {
    return {
      ...baseline,
      acknowledgedAt,
      moduleGuidanceAcknowledgements: {
        ...baseline.moduleGuidanceAcknowledgements,
        [scope.moduleId]: sentModule.guidanceDraft
      }
    };
  }
  return {
    ...baseline,
    acknowledgedAt,
    canvas: {
      ...baseline.canvas,
      modules: baseline.canvas.modules.map(
        (module) => module.id === scope.moduleId ? { ...module, guidanceDraft: sentModule.guidanceDraft } : module
      )
    },
    moduleGuidanceAcknowledgements: {
      ...baseline.moduleGuidanceAcknowledgements,
      [scope.moduleId]: sentModule.guidanceDraft
    }
  };
}
function normalizeModule(module) {
  const riskOverride = module.assessment?.risk.override;
  return {
    id: module.id,
    title: module.title,
    nodeType: module.nodeType,
    description: module.description,
    files: [...new Set(module.files.map((file) => file.trim()).filter(Boolean))].sort(),
    guidanceDraft: module.guidanceDraft.trim(),
    riskOverride: riskOverride ? { level: riskOverride.level, reason: riskOverride.reason.trim() } : void 0
  };
}
function normalizeRelation(relation2) {
  return {
    id: relation2.id,
    source: relation2.source,
    target: relation2.target,
    relation: relation2.relation,
    guidanceNote: relation2.guidanceNote?.trim() || void 0
  };
}
function changedFields(previous, current, excluded) {
  const excludedFields = new Set(excluded);
  return Object.fromEntries(
    Object.keys(current).filter((key) => !excludedFields.has(key)).filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(current[key])).map((key) => [key, current[key]])
  );
}
function compareById(left, right) {
  return left.id.localeCompare(right.id);
}
const MODIFICATION_BASELINE_FILE = "modification-baseline.json";
async function readModificationDelta(projectPath2, sequenceInstruction, canvas) {
  const currentCanvas = canvas ?? await readCurrentCanvas(projectPath2);
  const snapshot = normalizeModificationSnapshot(currentCanvas, sequenceInstruction);
  const baseline = await readOrInitializeBaseline(projectPath2, snapshot, currentCanvas);
  const delta = buildModificationDelta(baseline, snapshot);
  return {
    baseline,
    snapshot,
    delta,
    hasChanges: hasModificationDelta(delta)
  };
}
async function acknowledgeModificationChanges(projectPath2, sentSnapshot, scope) {
  const baseline = await readBaseline(projectPath2);
  if (!baseline) {
    throw new Error(`Modification baseline does not exist for project: ${projectPath2}`);
  }
  const acknowledged = acknowledgeModificationDelta(
    baseline,
    sentSnapshot,
    scope,
    (/* @__PURE__ */ new Date()).toISOString()
  );
  await writeJsonAtomic$1(baselinePath(projectPath2), acknowledged);
  return acknowledged;
}
async function readOrInitializeBaseline(projectPath2, snapshot, canvas) {
  const existing = await readBaseline(projectPath2);
  if (existing) {
    if (snapshot.scanFingerprint && snapshot.scanFingerprint !== existing.scanFingerprint) {
      const reconciled = reconcileGeneratedAdditions(existing, snapshot, canvas);
      await writeJsonAtomic$1(baselinePath(projectPath2), reconciled);
      return reconciled;
    }
    return existing;
  }
  const baseline = {
    version: 1,
    acknowledgedAt: (/* @__PURE__ */ new Date()).toISOString(),
    scanFingerprint: snapshot.scanFingerprint,
    canvas: snapshot.canvas,
    sequenceInstruction: void 0
  };
  await writeJsonAtomic$1(baselinePath(projectPath2), baseline);
  return baseline;
}
function reconcileGeneratedAdditions(baseline, snapshot, canvas) {
  const baselineModuleIds = new Set(baseline.canvas.modules.map((module) => module.id));
  const baselineRelationIds = new Set(baseline.canvas.relations.map((relation2) => relation2.id));
  const userDraftModuleIds = new Set(
    canvas.nodes.filter((module) => module.status === "draft").map((module) => module.id)
  );
  const generatedRelationIds = new Set(
    canvas.edges.filter((relation2) => Boolean(relation2.evidence?.length)).map((relation2) => relation2.id)
  );
  return {
    ...baseline,
    scanFingerprint: snapshot.scanFingerprint,
    canvas: {
      modules: [
        ...baseline.canvas.modules,
        ...snapshot.canvas.modules.filter(
          (module) => !baselineModuleIds.has(module.id) && !userDraftModuleIds.has(module.id)
        )
      ].sort((left, right) => left.id.localeCompare(right.id)),
      relations: [
        ...baseline.canvas.relations,
        ...snapshot.canvas.relations.filter(
          (relation2) => !baselineRelationIds.has(relation2.id) && generatedRelationIds.has(relation2.id)
        )
      ].sort((left, right) => left.id.localeCompare(right.id))
    }
  };
}
async function readBaseline(projectPath2) {
  const path = baselinePath(projectPath2);
  const value = await readJsonArtifact(path);
  if (value === void 0) return void 0;
  if (!isModificationBaseline(value)) {
    throw new Error(`FlowWeave modification baseline is invalid and was preserved: ${path}`);
  }
  return value;
}
async function readCurrentCanvas(projectPath2) {
  const path = join(projectPath2, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
  let value;
  try {
    value = await readJsonArtifact(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("FlowWeave artifact is unreadable and was preserved:")) {
      return emptyCanvas(projectPath2);
    }
    throw error;
  }
  if (!value || typeof value !== "object") {
    return emptyCanvas(projectPath2);
  }
  const canvas = value;
  if (canvas.version !== 3 || !Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) {
    throw new Error(`FlowWeave Canvas is invalid and was preserved: ${path}`);
  }
  return canvas;
}
function emptyCanvas(projectPath2) {
  return {
    version: 3,
    id: "main",
    title: "Main Canvas",
    projectPath: projectPath2,
    generatedAt: (/* @__PURE__ */ new Date(0)).toISOString(),
    artifactState: "current",
    nodes: [],
    edges: []
  };
}
function baselinePath(projectPath2) {
  return join(projectPath2, FLOWWEAVE_DIR, MODIFICATION_BASELINE_FILE);
}
function isModificationBaseline(value) {
  if (!value || typeof value !== "object") return false;
  const baseline = value;
  return baseline.version === 1 && typeof baseline.acknowledgedAt === "string" && Boolean(baseline.canvas) && Array.isArray(baseline.canvas?.modules) && Array.isArray(baseline.canvas?.relations);
}
function modificationProjectLabel(projectPath2) {
  return basename(projectPath2);
}
const MODIFICATION_GUIDANCE_DOC_ID = "modification-guidance";
const MODIFICATION_CONTEXT_DOC_ID = "modification-context";
async function writeModificationDocs(projectPath2, input) {
  const result = await readModificationDelta(
    projectPath2,
    input.sequenceInstruction ?? "",
    input.canvas
  );
  const context = createModificationGuidanceContext(
    input.sequence?.projectName ?? input.canvas?.title ?? modificationProjectLabel(projectPath2),
    projectPath2,
    result
  );
  const guidancePath = join(projectPath2, FLOWWEAVE_DIR, "docs", `${MODIFICATION_GUIDANCE_DOC_ID}.md`);
  const contextPath = join(projectPath2, FLOWWEAVE_DIR, "docs", `${MODIFICATION_CONTEXT_DOC_ID}.json`);
  await Promise.all([
    writeTextAtomic$1(guidancePath, buildModificationDeltaGuidanceMarkdown(context)),
    writeTextAtomic$1(contextPath, buildModificationDeltaContextJson(context))
  ]);
  return { guidancePath, contextPath };
}
const SEQUENCE_DIAGRAM_FILE = "sequence-diagrams.json";
const MAX_PROMPT_FILES = 70;
const MAX_SYMBOLS_PER_FILE = 8;
const REPRESENTATIVE_FILE_LIMIT = 35;
const sequenceFlights = /* @__PURE__ */ new Map();
async function generateSequenceDiagrams(project, agentId, options) {
  if (options?.signal) return generateSequenceDiagramsOnce(project, agentId, options);
  const flightKey = `${project.rootPath}:${agentId}`;
  const existing = sequenceFlights.get(flightKey);
  if (existing) return existing;
  const flight = generateSequenceDiagramsOnce(project, agentId, options).finally(() => sequenceFlights.delete(flightKey));
  sequenceFlights.set(flightKey, flight);
  return flight;
}
async function generateSequenceDiagramsOnce(project, agentId, options) {
  const { index } = await buildSemanticIndex(project, {
    signal: options?.signal,
    onProgress: options?.onProgress
  });
  throwIfAborted(options?.signal, "Sequence analysis");
  const facts = semanticIndexToStructureFacts(project, index);
  const representativeFacts = { ...facts, files: selectRepresentativeStructureFacts(facts, REPRESENTATIVE_FILE_LIMIT) };
  const storedArchitecture = await readArchitectureMap(project.rootPath);
  const architectureMap = storedArchitecture;
  const inputFingerprint = project.scanFingerprint ?? createScanFingerprint({ representativeFacts, architecture: architectureMap?.metadata?.inputFingerprint });
  const prompt = buildSequenceDiagramPrompt(representativeFacts, architectureMap);
  const localBundleBase = createLocalSequenceBundle(project, facts, architectureMap, "local");
  const localQuality = validateSequenceBundle(localBundleBase, facts);
  const localBundle = withLocalSequenceMetadata(localBundleBase, inputFingerprint, localQuality);
  options?.onProgress?.({
    stage: "analyzing",
    completed: 0,
    total: 1,
    failed: 0,
    message: `Analyzing architectural sequence diagram with ${agentId}.`
  });
  if (agentId === "mock") {
    const inferred = createLocalSequenceBundle(project, representativeFacts, architectureMap, "agent");
    const parsed = parseSequenceDiagramBundleJson(mockSequenceBundleJson(inferred), project);
    if (!parsed) return failedSequenceResult(agentId, "invalid-output", "Mock agent returned invalid sequence diagram JSON.", []);
    const quality = validateSequenceBundle(parsed, representativeFacts);
    if (!quality.valid) return failedSequenceResult(agentId, "quality-rejected", quality.reasons.join("; "), []);
    const bundle = withSequenceMetadata(parsed, agentId, "mock", inputFingerprint, quality);
    throwIfAborted(options?.signal, "Sequence analysis");
    await writeSequenceDiagramBundle(project.rootPath, bundle, void 0);
    const review2 = {
      state: "reviewed",
      reviewId: `sequence-review-${randomUUID()}`,
      scanFingerprint: inputFingerprint,
      agentId,
      runId: "mock",
      completedAt: bundle.generatedAt
    };
    await writeSequenceReviewStatus(project.rootPath, review2);
    return { bundle, outcome: "generated", review: review2 };
  }
  throwIfAborted(options?.signal, "Sequence analysis");
  const publishedBundle = await writeLocalSequenceDiagramBundle(project.rootPath, localBundle);
  const projectId = options?.projectId ?? await registerProject(project.rootPath);
  const reviewId = options?.resumeSequenceReview?.reviewId ?? `sequence-review-${randomUUID()}`;
  const review = await startSequenceReview({
    projectId,
    projectPath: project.rootPath,
    reviewId,
    scanFingerprint: inputFingerprint,
    agentId,
    localBundle: publishedBundle,
    startedAt: publishedBundle.generatedAt,
    persist: (bundle) => writeSequenceDiagramBundle(project.rootPath, bundle, void 0),
    run: (onRunId) => runSequenceReview(
      project,
      agentId,
      prompt,
      facts,
      representativeFacts,
      architectureMap,
      inputFingerprint,
      options?.planTimeoutMs,
      onRunId
    ),
    onEvent: options?.onSequenceReview ?? (() => void 0)
  });
  return { bundle: publishedBundle, outcome: "generated", review };
}
async function reviseSequenceDiagram(project, agentId, instruction, options) {
  const { index } = await buildSemanticIndex(project, {
    signal: options?.signal,
    onProgress: options?.onProgress
  });
  throwIfAborted(options?.signal, "Sequence revision");
  const current = await readSequenceDiagrams(project.rootPath);
  if (!current) throw new Error("No trusted sequence diagram exists to revise.");
  const currentDiagram = current.architectural;
  const prompt = buildAgentPrompt(
    buildModificationContext({
      projectLabel: project.projectName,
      projectPath: project.rootPath,
      nodes: [],
      edges: [],
      sequenceBundle: current,
      sequenceInstruction: instruction
    }),
    "sequence-revision",
    "plan"
  );
  options?.onProgress?.({
    stage: "analyzing",
    completed: 0,
    total: 1,
    failed: 0,
    message: `Revising architectural sequence diagram with ${agentId}.`
  });
  if (agentId === "mock") {
    const parsed2 = parseSequenceDiagramJson(mockRevisedDiagramJson(currentDiagram, instruction));
    const bundle2 = parsed2 ? replaceDiagram(current, parsed2) : current;
    throwIfAborted(options?.signal, "Sequence revision");
    await writeSequenceDiagramBundle(project.rootPath, bundle2, instruction);
    return bundle2;
  }
  const result = await startToolPlan({
    projectId: await registerProject(project.rootPath),
    toolId: agentId,
    prompt,
    executionMode: "plan",
    purpose: "artifact-analysis",
    planTimeoutMs: options?.planTimeoutMs,
    signal: options?.signal
  });
  throwIfRunCanceled(result, "Sequence revision", options?.signal);
  if (result.status !== "completed") {
    throw new Error(result.stderr ?? result.summary ?? "Agent sequence diagram revision failed");
  }
  const parsed = parseSequenceDiagramJson(collectStdout(result.events));
  if (!parsed) {
    throw new Error("Agent did not return a valid sequence diagram JSON object.");
  }
  const bundle = replaceDiagram(current, parsed);
  throwIfAborted(options?.signal, "Sequence revision");
  await writeSequenceDiagramBundle(project.rootPath, bundle, instruction);
  return bundle;
}
async function readSequenceDiagrams(projectPath2) {
  const filePath = join(projectPath2, FLOWWEAVE_DIR, SEQUENCE_DIAGRAM_FILE);
  const value = await readJsonArtifact(filePath);
  if (value === void 0) return void 0;
  if (!isSequenceDiagramBundle(value)) {
    throw new Error(`FlowWeave sequence diagram artifact is invalid and was preserved: ${filePath}`);
  }
  return storedSequenceDiagramBundle(value);
}
function buildSequenceDiagramPrompt(facts, architectureMap) {
  return `You are FlowWeave's sequence diagram analyst. Return only JSON.

Goal:
Create one detailed architectural project sequence diagram from the code structure and architecture map so a user can understand the real end-to-end workflow across system modules.

Project: ${facts.projectName}
Languages: ${JSON.stringify(facts.languages)}

ArchitectureMap:
${JSON.stringify(compactArchitectureMap(architectureMap), null, 2)}

ProjectStructureFacts:
${JSON.stringify(compactFactsForPrompt(facts), null, 2)}

Analysis priorities:
- Use only the supplied ArchitectureMap and ProjectStructureFacts. Do not invent files, symbols, calls, endpoints, databases, queues, or third-party systems.
- Generate a Detailed Architectural Sequence Diagram: keep kind exactly "architectural" while making the architecture flow detailed and complete.
- Cover the main architecture modules and important relationships when evidence exists: entry/user action, UI or desktop shell, IPC/API boundary, service orchestration, domain work, data access, external integrations, asynchronous events or workers, and return/response paths.
- Use macro participants such as actor, frontend/component, desktop shell, IPC/API boundary, service, data store, external system, and worker. Do not create a class-level or method-level detailed-design diagram.
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
  }
}

Rules:
- The architectural diagram uses macro participants: frontend app, gateway, services, databases, workers, and third-party systems.
- Do not return detailedDesign, a second diagram, or any diagram whose kind is "detailed-design".
- Every message must reference valid participant ids from its diagram.
- Prefer 6-14 participants and 8-24 messages when the supplied evidence supports that level of detail.
- Return valid JSON only.`;
}
function parseSequenceDiagramBundleJson(output, project, facts, architectureMap) {
  const parsed = parseFirstJsonObject(output);
  if (!parsed) return void 0;
  const architectural = normalizeDiagram(parsed.architectural, "architectural");
  if (!architectural) return void 0;
  if (!isUsableDiagram(architectural)) return void 0;
  return {
    version: 1,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    source: "agent",
    architectural
  };
}
function parseSequenceDiagramJson(output) {
  const parsed = parseFirstJsonObject(output);
  if (!parsed) return void 0;
  return normalizeDiagram(parsed, "architectural");
}
function normalizeDiagram(diagram, kind) {
  if (!diagram || diagram.kind !== kind) return void 0;
  const { participants, idAliases } = normalizeParticipants(diagram.participants);
  const participantIds = new Set(participants.map((participant) => participant.id));
  const messages = normalizeMessages(diagram.messages, participantIds, idAliases);
  const normalized = {
    id: safeId(diagram.id ?? `${kind}-sequence`),
    title: diagram.title?.trim() || defaultDiagramTitle(),
    kind,
    summary: diagram.summary?.trim() || defaultDiagramSummary(),
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
    line: Number.isInteger(item.line) ? item.line : void 0,
    detail: item.detail?.trim() || "Sequence evidence"
  })).slice(0, 30);
}
function createLocalSequenceBundle(project, facts, architectureMap, source) {
  return {
    version: 1,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    source,
    architectural: createLocalArchitecturalDiagram(facts, architectureMap)
  };
}
function createLocalArchitecturalDiagram(facts, architectureMap) {
  const architectureModules = architectureMap?.modules.slice().sort((left, right) => participantPriority(left.category) - participantPriority(right.category)).slice(0, 14) ?? [];
  const participants = architectureModules.length > 0 ? architectureModules.map((module) => ({
    id: module.id,
    title: module.title,
    kind: participantKindFromCategory(module.category),
    description: module.role,
    filePath: module.files[0],
    symbol: module.symbols[0]?.name
  })) : fallbackFileParticipants(facts.files.slice(0, 6));
  const participantIds = new Set(participants.map((participant) => participant.id));
  const relationships = architectureMap?.relationships ?? [];
  const relationshipMessages = relationships.filter((relationship) => participantIds.has(relationship.source) && participantIds.has(relationship.target)).sort((left, right) => relationPriority(left.relation) - relationPriority(right.relation)).slice(0, 18).map((relationship, index) => ({
    id: safeId(relationship.id || `${relationship.source}-${relationship.target}-${index + 1}`),
    sequence: index + 1,
    from: relationship.source,
    to: relationship.target,
    kind: relationship.relation === "publishes_event" || relationship.relation === "subscribes_event" ? "event" : relationship.relation === "external_api" ? "external" : "sync",
    label: relationship.description || `${relationship.source} -> ${relationship.target}`,
    description: relationship.description,
    evidence: relationship.evidence
  }));
  const returnMessages = relationshipMessages.filter((message) => message.kind === "sync" || message.kind === "external").slice(0, Math.max(0, 24 - relationshipMessages.length)).map((message, index) => ({
    id: safeId(`${message.id}-return`),
    sequence: relationshipMessages.length + index + 1,
    from: message.to,
    to: message.from,
    kind: "return",
    label: `${message.to} returns to ${message.from}`,
    description: "Response path inferred from the request relationship.",
    output: "response",
    evidence: message.evidence
  }));
  const messages = [...relationshipMessages, ...returnMessages].slice(0, 24);
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
function fallbackFileParticipants(files) {
  return files.slice(0, 10).map((file, index) => {
    const symbol = file.symbols[0];
    const id = safeId(symbol?.name ?? file.path);
    return {
      id,
      title: symbol?.name ?? titleFromPath(file.path),
      kind: participantKindFromPath(file.path),
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
    evidence: participant.filePath ? [{ filePath: participant.filePath, symbol: participant.symbol, detail: "Inferred sequence participant." }] : []
  }));
}
function replaceDiagram(bundle, diagram) {
  return {
    ...bundle,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    source: "agent",
    architectural: diagram
  };
}
async function runSequenceReview(project, agentId, prompt, facts, representativeFacts, architectureMap, inputFingerprint, planTimeoutMs, onRunId) {
  const projectId = await registerProject(project.rootPath);
  const result = await startToolPlan({
    projectId,
    toolId: agentId,
    prompt,
    executionMode: "plan",
    purpose: "artifact-analysis",
    planTimeoutMs
  });
  await onRunId(result.id);
  if (result.status !== "completed") {
    return {
      outcome: "failed",
      runId: result.id,
      error: {
        code: "agent-failed",
        message: result.stderr ?? result.summary ?? "Agent sequence diagram review failed."
      }
    };
  }
  const output = result.outputText ?? collectStdout(result.events);
  const parsed = parseSequenceDiagramBundleJson(output, project);
  const quality = parsed ? validateSequenceBundle(parsed, representativeFacts) : void 0;
  if (parsed && quality?.valid) {
    const bundle2 = withSequenceMetadata(parsed, agentId, result.id, inputFingerprint, quality);
    return { outcome: "reviewed", bundle: bundle2, runId: result.id };
  }
  const firstFailure = parsed ? quality?.reasons.join("; ") ?? "Sequence quality validation failed." : "Agent returned invalid sequence diagram JSON.";
  const retry = await startToolPlan({
    projectId,
    toolId: agentId,
    prompt: buildSequenceRepairPrompt(prompt, output, firstFailure),
    executionMode: "plan",
    purpose: "artifact-analysis",
    planTimeoutMs
  });
  await onRunId(retry.id);
  if (retry.status !== "completed") {
    return {
      outcome: "failed",
      runId: retry.id,
      error: {
        code: "agent-failed",
        message: retry.stderr ?? retry.summary ?? "Agent sequence diagram repair failed."
      }
    };
  }
  const retryOutput = retry.outputText ?? collectStdout(retry.events);
  const retryParsed = parseSequenceDiagramBundleJson(retryOutput, project);
  const retryQuality = retryParsed ? validateSequenceBundle(retryParsed, representativeFacts) : void 0;
  if (!retryParsed) {
    return {
      outcome: "failed",
      runId: retry.id,
      error: {
        code: "invalid-output",
        message: "Agent returned invalid sequence diagram JSON after repair."
      }
    };
  }
  if (!retryQuality?.valid) {
    return {
      outcome: "failed",
      runId: retry.id,
      error: {
        code: "quality-rejected",
        message: retryQuality?.reasons.join("; ") ?? "Sequence quality validation failed after repair."
      }
    };
  }
  const bundle = withSequenceMetadata(retryParsed, agentId, retry.id, inputFingerprint, retryQuality);
  return { outcome: "reviewed", bundle, runId: retry.id };
}
function validateSequenceBundle(bundle, facts) {
  const files = new Set(facts.files.map((file) => file.path));
  const diagram = bundle.architectural;
  const evidence = [
    ...diagram.evidence ?? [],
    ...diagram.messages.flatMap((message) => message.evidence ?? [])
  ];
  const coveredFiles = new Set(evidence.map((item) => item.filePath).filter((file) => typeof file === "string" && files.has(file)));
  const validEvidence = evidence.filter((item) => Boolean(item.filePath) && files.has(item.filePath));
  const fileCoverage = facts.files.length === 0 ? 0 : coveredFiles.size / facts.files.length;
  const evidenceCoverage = evidence.length === 0 ? 0 : validEvidence.length / evidence.length;
  const reasons = [];
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
  const firstMessage = bundle.architectural.messages[0];
  const firstParticipant = bundle.architectural.participants.find((participant) => participant.id === firstMessage?.from);
  const firstPath = firstParticipant?.filePath?.toLowerCase();
  if (!firstPath || !/(^|\/)(main|index|app|server|bootstrap)\.|ipc|controller|route|handler|page|view|screen/.test(firstPath)) {
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
      source: "agent",
      agentId,
      runId,
      generatedAt,
      inputFingerprint,
      fileCoverage: quality.fileCoverage,
      evidenceCoverage: quality.evidenceCoverage
    }
  };
}
function withLocalSequenceMetadata(bundle, inputFingerprint, quality) {
  const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return {
    ...bundle,
    version: 2,
    source: "local",
    generatedAt,
    metadata: {
      source: "local",
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
async function writeSequenceDiagramBundle(projectPath2, bundle, sequenceInstruction) {
  const root = join(projectPath2, FLOWWEAVE_DIR);
  await writeJsonAtomic$1(join(root, SEQUENCE_DIAGRAM_FILE), bundle);
  await writeModificationDocs(projectPath2, { sequence: bundle, sequenceInstruction });
}
async function writeLocalSequenceDiagramBundle(projectPath2, bundle) {
  const previous = await readSequenceDiagrams(projectPath2);
  if (previous?.source === "agent") return bundle;
  await writeSequenceDiagramBundle(projectPath2, bundle, void 0);
  return bundle;
}
function parseFirstJsonObject(output) {
  const extracted = extractStructuredJson(output);
  return "value" in extracted ? extracted.value : void 0;
}
function compactFactsForPrompt(facts) {
  return {
    ...facts,
    files: facts.files.slice(0, MAX_PROMPT_FILES).map((file) => ({
      path: file.path,
      language: file.language,
      imports: file.imports.slice(0, 12),
      exports: file.exports.slice(0, 10),
      symbols: file.symbols.slice(0, MAX_SYMBOLS_PER_FILE).map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        exported: symbol.exported
      })),
      calls: file.calls.slice(0, 10),
      externalCalls: file.externalCalls.slice(0, 6),
      moduleId: file.moduleId,
      role: file.role
    })),
    relations: facts.relations?.slice(0, 100)
  };
}
function compactArchitectureMap(map) {
  if (!map) return void 0;
  return {
    architectureStyle: map.architectureStyle,
    modules: map.modules.slice(0, 20).map((module) => ({
      id: module.id,
      title: module.title,
      category: module.category,
      role: module.role,
      files: module.files.slice(0, 6),
      symbols: module.symbols.slice(0, 6).map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        filePath: symbol.filePath
      }))
    })),
    relationships: map.relationships.slice(0, 50).map((relationship) => ({
      source: relationship.source,
      target: relationship.target,
      relation: relationship.relation,
      description: relationship.description,
      evidence: relationship.evidence.slice(0, 2)
    }))
  };
}
function mockSequenceBundleJson(bundle) {
  return JSON.stringify(
    {
      architectural: bundle.architectural
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
function isSequenceDiagramBundle(value) {
  if (typeof value !== "object" || value === null) return false;
  if (!("version" in value) || value.version !== 1 && value.version !== 2) return false;
  if (!("projectName" in value) || typeof value.projectName !== "string") return false;
  if (!("rootPath" in value) || typeof value.rootPath !== "string") return false;
  return "architectural" in value && isStoredSequenceDiagram(value.architectural);
}
function storedSequenceDiagramBundle(value) {
  const legacySource = value.source;
  return {
    version: value.version,
    projectName: value.projectName,
    rootPath: value.rootPath,
    generatedAt: value.generatedAt,
    source: legacySource === "fallback" ? "local" : value.source,
    metadata: value.metadata,
    architectural: value.architectural
  };
}
function participantPriority(category) {
  const priorities = {
    "api-boundary": 0,
    "domain-service": 1,
    "job-worker": 2,
    "data-access": 3,
    "external-integration": 4,
    "shared-utility": 5,
    "test-surface": 6
  };
  return priorities[category];
}
function relationPriority(relation2) {
  const priorities = {
    calls: 0,
    depends_on: 1,
    reads_writes: 2,
    external_api: 3,
    publishes_event: 4,
    subscribes_event: 5,
    tests: 6
  };
  return priorities[relation2];
}
function isStoredSequenceDiagram(value) {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "architectural" && "participants" in value && Array.isArray(value.participants) && "messages" in value && Array.isArray(value.messages);
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
function defaultDiagramTitle() {
  return "Architectural Sequence Diagram";
}
function defaultDiagramSummary() {
  return "System component collaboration sequence.";
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
const MAX_INFERRED_CODE_FILES = 600;
const MAX_INFERRED_EDGES = 140;
const GENERATOR_VERSION = "1.0.0";
function createCanvasArtifact(projectPath2, modules, edges, scanFingerprint) {
  return {
    version: 3,
    generatorVersion: GENERATOR_VERSION,
    inputFingerprint: scanFingerprint,
    id: "main",
    title: "Main Canvas",
    projectPath: projectPath2,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    scanFingerprint,
    artifactState: "current",
    layout: {
      activeMode: "manual",
      manualPositions: Object.fromEntries(modules.map((node) => [node.id, { x: node.x, y: node.y }])),
      autoLayouts: {},
      collapsedGroups: []
    },
    nodes: modules,
    edges: edges ?? createDefaultEdges(modules)
  };
}
function createTaskArtifact(modules, edges, scanFingerprint) {
  return {
    version: 2,
    generatorVersion: GENERATOR_VERSION,
    inputFingerprint: scanFingerprint,
    artifactState: "current",
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
    relations: (edges ?? createDefaultEdges(modules)).map((edge) => ({
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
    (relation2) => `- ${relation2.source} -> ${relation2.target} (${relation2.relation})${relation2.guidanceNote ? `: ${relation2.guidanceNote}` : ""}`
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
    risk: "unknown",
    description: getNodeDescription(group, files),
    files,
    guidanceDraft: `Review the responsibility boundaries of these files around ${toTitle(group)}, and expand the modification scope only when required by its connections.`,
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
function getNodeSubtitle(group) {
  const type = getNodeType(group);
  if (type === "entrypoint") return "Request entry and orchestration";
  if (type === "data") return "Data model and persistence";
  if (type === "test") return "Testing and regression validation";
  return "Backend business module";
}
function getNodeDescription(group, files) {
  return `${toTitle(group)} was generated from the project scan with ${files.length} key files. Connections define the scope used for Agent planning.`;
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
  const task = createTaskArtifact(modules, edges, scanFingerprint);
  const updates = [
    {
      path: join(flowweaveRoot, "project.json"),
      content: jsonText({
        ...project,
        generatorVersion: "1.0.0",
        inputFingerprint: scanFingerprint,
        artifactState: "current",
        scanFingerprint
      })
    },
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
const operations = /* @__PURE__ */ new Map();
function startOperation(kind, message) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const operation = {
    operationId: `operation-${randomUUID()}`,
    kind,
    stage: "discovery",
    completed: 0,
    total: 0,
    failed: 0,
    startedAt: timestamp,
    updatedAt: timestamp,
    message
  };
  const controller = new AbortController();
  operations.set(operation.operationId, { state: operation, controller });
  return { operation, signal: controller.signal };
}
function updateOperation(operationId, update) {
  const active = requireOperation(operationId);
  const state = { ...active.state, ...update, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  operations.set(operationId, { ...active, state });
  return state;
}
function cancelOperation(operationId) {
  const active = requireOperation(operationId);
  active.controller.abort("user-canceled");
  return updateOperation(operationId, {
    stage: "canceled",
    completed: active.state.completed,
    total: active.state.total,
    failed: active.state.failed,
    message: "Operation canceled by user."
  });
}
function finishOperation(operationId) {
  operations.delete(operationId);
}
function requireOperation(operationId) {
  if (!/^operation-[a-f0-9-]{36}$/.test(operationId)) {
    throw new Error(`Invalid FlowWeave operation id: ${operationId}`);
  }
  const operation = operations.get(operationId);
  if (!operation) throw new Error(`FlowWeave operation not found: ${operationId}`);
  return operation;
}
const TOOL_IDS = ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"];
function registerProjectIpc() {
  handleIpc(PROJECT_CHANNELS.openProject, async (event, options) => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open project in FlowWeave" });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const projectId = await registerProject(result.filePaths[0]);
    return scanAndPersistProject(projectId, event.sender, requireScanOptions(PROJECT_CHANNELS.openProject, options));
  });
  handleIpc(PROJECT_CHANNELS.scanProject, (event, projectId, options) => scanAndPersistProject(
    requireString(PROJECT_CHANNELS.scanProject, projectId, "projectId"),
    event.sender,
    requireScanOptions(PROJECT_CHANNELS.scanProject, options)
  ));
  handleIpc(PROJECT_CHANNELS.cancelOperation, (event, operationId) => {
    const operation = cancelOperation(requireString(PROJECT_CHANNELS.cancelOperation, operationId, "operationId"));
    event.sender.send(PROJECT_CHANNELS.operationProgress, operation);
    return operation;
  });
  handleIpc(PROJECT_CHANNELS.analyzeProject, async (_event, projectId, toolId) => {
    const projectPath2 = resolveProjectPath(requireString(PROJECT_CHANNELS.analyzeProject, projectId, "projectId"));
    return analyzeProject(await scanProject(projectPath2), requireEnum(PROJECT_CHANNELS.analyzeProject, toolId, "toolId", TOOL_IDS));
  });
  handleIpc(PROJECT_CHANNELS.analyzeArchitecture, (event, projectId, toolId) => analyzeArchitectureForProject(
    requireString(PROJECT_CHANNELS.analyzeArchitecture, projectId, "projectId"),
    requireEnum(PROJECT_CHANNELS.analyzeArchitecture, toolId, "toolId", TOOL_IDS),
    event.sender
  ));
  handleIpc(PROJECT_CHANNELS.analyzeArchitectureWithAgent, (event, projectId, agentId) => analyzeArchitectureForProject(
    requireString(PROJECT_CHANNELS.analyzeArchitectureWithAgent, projectId, "projectId"),
    requireRuntimeAgentId(PROJECT_CHANNELS.analyzeArchitectureWithAgent, agentId),
    event.sender
  ));
  handleIpc(PROJECT_CHANNELS.readArchitectureMap, (_event, projectId) => readArchitectureMap(resolveProjectPath(requireString(PROJECT_CHANNELS.readArchitectureMap, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.generateSequenceDiagrams, (event, projectId, agentId, planTimeoutMs) => generateSequenceDiagramsForProject(
    requireString(PROJECT_CHANNELS.generateSequenceDiagrams, projectId, "projectId"),
    requireRuntimeAgentId(PROJECT_CHANNELS.generateSequenceDiagrams, agentId),
    planTimeoutMs === void 0 ? void 0 : requireInteger(PROJECT_CHANNELS.generateSequenceDiagrams, planTimeoutMs, "planTimeoutMs", 6e4, 18e5),
    event.sender
  ));
  handleIpc(PROJECT_CHANNELS.reviseSequenceDiagram, (event, projectId, agentId, instruction, planTimeoutMs) => reviseSequenceDiagramForProject(
    requireString(PROJECT_CHANNELS.reviseSequenceDiagram, projectId, "projectId"),
    requireRuntimeAgentId(PROJECT_CHANNELS.reviseSequenceDiagram, agentId),
    requireString(PROJECT_CHANNELS.reviseSequenceDiagram, instruction, "instruction"),
    planTimeoutMs === void 0 ? void 0 : requireInteger(PROJECT_CHANNELS.reviseSequenceDiagram, planTimeoutMs, "planTimeoutMs", 6e4, 18e5),
    event.sender
  ));
  handleIpc(PROJECT_CHANNELS.readSequenceDiagrams, (_event, projectId) => readSequenceDiagrams(resolveProjectPath(requireString(PROJECT_CHANNELS.readSequenceDiagrams, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.readFile, async (_event, projectId, filePath) => {
    const requestedPath = requireString(PROJECT_CHANNELS.readFile, filePath, "filePath");
    return readOptionalProjectTextFile(
      await resolveProjectFile(
        requireString(PROJECT_CHANNELS.readFile, projectId, "projectId"),
        requestedPath
      ),
      requestedPath
    );
  });
  handleIpc(PROJECT_CHANNELS.saveDoc, async (_event, projectId, docId, content) => {
    const projectPath2 = resolveProjectPath(requireString(PROJECT_CHANNELS.saveDoc, projectId, "projectId"));
    const safeDocId = requireSafeId(PROJECT_CHANNELS.saveDoc, docId, "docId");
    const docsDir = join(projectPath2, FLOWWEAVE_DIR, "docs");
    await mkdir(docsDir, { recursive: true });
    const docPath = join(docsDir, `${safeDocId}.md`);
    await writeFile(docPath, requireString(PROJECT_CHANNELS.saveDoc, content, "content"), "utf8");
    return docPath;
  });
  handleIpc(PROJECT_CHANNELS.saveModificationDocs, (_event, projectId, sequenceInstruction) => writeModificationDocs(
    resolveProjectPath(requireString(PROJECT_CHANNELS.saveModificationDocs, projectId, "projectId")),
    {
      sequenceInstruction: optionalTrimmedString(
        PROJECT_CHANNELS.saveModificationDocs,
        sequenceInstruction,
        "sequenceInstruction"
      )
    }
  ));
  handleIpc(PROJECT_CHANNELS.readModificationDelta, (_event, projectId, sequenceInstruction, canvas) => {
    const value = canvas === void 0 ? void 0 : requireCanvas(PROJECT_CHANNELS.readModificationDelta, canvas);
    return readModificationDelta(
      resolveProjectPath(requireString(PROJECT_CHANNELS.readModificationDelta, projectId, "projectId")),
      optionalTrimmedString(
        PROJECT_CHANNELS.readModificationDelta,
        sequenceInstruction,
        "sequenceInstruction"
      ) ?? "",
      value
    );
  });
  handleIpc(PROJECT_CHANNELS.acknowledgeModificationChanges, (_event, projectId, snapshot, scope) => acknowledgeModificationChanges(
    resolveProjectPath(requireString(PROJECT_CHANNELS.acknowledgeModificationChanges, projectId, "projectId")),
    requireModificationSnapshot(PROJECT_CHANNELS.acknowledgeModificationChanges, snapshot),
    requireModificationAcknowledgementScope(PROJECT_CHANNELS.acknowledgeModificationChanges, scope)
  ));
  handleIpc(PROJECT_CHANNELS.readCanvas, async (_event, projectId) => {
    const result = await readCanvasArtifactState(resolveProjectPath(requireString(PROJECT_CHANNELS.readCanvas, projectId, "projectId")));
    if (result.state === "failed") {
      throw new Error(`FlowWeave Canvas is unreadable and was preserved: ${result.error}`);
    }
    return result.state === "loaded" ? result.canvas : void 0;
  });
  handleIpc(PROJECT_CHANNELS.saveCanvas, async (_event, projectId, canvas) => {
    const safeProjectId = requireString(PROJECT_CHANNELS.saveCanvas, projectId, "projectId");
    const projectPath2 = resolveProjectPath(safeProjectId);
    const value = requireObject(PROJECT_CHANNELS.saveCanvas, canvas, "canvas");
    if (value.version !== 3 || value.artifactState !== "current") {
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Only a current Canvas v3 can be saved.`);
    }
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Canvas nodes and edges must be arrays.`);
    }
    for (const node of value.nodes) {
      const override = node.assessment?.risk.override;
      if (override && !override.reason.trim()) {
        throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Risk override for "${node.id}" requires a reason.`);
      }
    }
    const projectArtifact = JSON.parse(
      await readFile(join(projectPath2, FLOWWEAVE_DIR, "project.json"), "utf8")
    );
    if (!value.scanFingerprint || value.scanFingerprint !== projectArtifact.scanFingerprint) {
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Canvas scan fingerprint is stale.`);
    }
    const canvasPath = join(projectPath2, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
    await mkdir(join(projectPath2, FLOWWEAVE_DIR, "canvas"), { recursive: true });
    const temporaryPath = `${canvasPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ ...value, projectPath: projectPath2 }, null, 2)}
`, "utf8");
      await rename(temporaryPath, canvasPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    await refreshConnectionWithoutFailing(safeProjectId, projectPath2);
    return canvasPath;
  });
  handleIpc(PROJECT_CHANNELS.exportDiagnostics, (_event, projectId) => exportDiagnostics(resolveProjectPath(
    requireString(PROJECT_CHANNELS.exportDiagnostics, projectId, "projectId")
  )));
  handleIpc(PROJECT_CHANNELS.getAgentConnection, (_event, projectId) => getProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.getAgentConnection, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.enableAgentConnection, (_event, projectId) => enableProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.enableAgentConnection, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.refreshAgentConnection, (_event, projectId) => refreshProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.refreshAgentConnection, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.disableAgentConnection, (_event, projectId) => disableProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.disableAgentConnection, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.openAgentConnection, async (_event, projectId) => {
    const path = getProjectAgentContextPath(resolveProjectPath(requireString(PROJECT_CHANNELS.openAgentConnection, projectId, "projectId")));
    const error = await shell.openPath(path);
    if (error) throw new Error(`Opening FlowWeave Agent context failed: ${error}`);
  });
}
async function analyzeArchitectureForProject(projectId, agentId, sender) {
  const projectPath2 = resolveProjectPath(projectId);
  return runTrackedAnalysis("architecture-analysis", "Preparing architecture analysis.", sender, async (signal, onProgress) => {
    const result = await analyzeArchitecture(await scanProject(projectPath2), agentId, {
      signal,
      onProgress,
      projectId,
      onArchitectureReview: (reviewEvent2) => sendArchitectureReview(sender, reviewEvent2)
    });
    if (result.outcome === "failed") throw new Error(result.error.message);
    return result;
  }, projectPath2);
}
async function generateSequenceDiagramsForProject(projectId, agentId, planTimeoutMs, sender) {
  const projectPath2 = resolveProjectPath(projectId);
  return runTrackedAnalysis("sequence-analysis", "Preparing sequence diagram analysis.", sender, async (signal, onProgress) => {
    const result = await generateSequenceDiagrams(await scanProject(projectPath2), agentId, {
      signal,
      onProgress,
      planTimeoutMs,
      projectId,
      onSequenceReview: (reviewEvent2) => sendSequenceReview(sender, reviewEvent2)
    });
    if (result.outcome === "failed") throw new Error(result.error.message);
    return result;
  }, projectPath2);
}
async function reviseSequenceDiagramForProject(projectId, agentId, instruction, planTimeoutMs, sender) {
  const projectPath2 = resolveProjectPath(projectId);
  return runTrackedAnalysis("sequence-analysis", "Preparing sequence diagram revision.", sender, async (signal, onProgress) => {
    return reviseSequenceDiagram(await scanProject(projectPath2), agentId, instruction, { signal, onProgress, planTimeoutMs });
  }, projectPath2);
}
async function scanAndPersistProject(projectId, sender, options) {
  const started = startOperation("project-scan", "Discovering project files.");
  const notify = (operation) => {
    if (!sender.isDestroyed()) sender.send(PROJECT_CHANNELS.operationProgress, operation);
  };
  notify(started.operation);
  const projectPath2 = resolveProjectPath(projectId);
  try {
    const project = await scanProject(projectPath2, options);
    const total = project.summary.totalFiles;
    notify(updateOperation(started.operation.operationId, {
      stage: "hashing",
      completed: 0,
      total,
      failed: 0,
      message: `Discovered ${total} project files.`
    }));
    const { index } = await buildSemanticIndex(project, {
      signal: started.signal,
      onProgress: (progress) => notify(updateOperation(started.operation.operationId, progress))
    });
    const scanFingerprint = project.scanFingerprint ?? "";
    const inferredGraph = await inferGraphFromProject(project);
    const canvasRead = await readCanvasArtifactState(projectPath2);
    const canvas = canvasRead.state === "loaded" ? migrateCanvasToScan(canvasRead.canvas, projectPath2, scanFingerprint, project.files) : void 0;
    const baseGraph = canvas ? { nodes: canvas.nodes, edges: canvas.edges } : inferredGraph;
    const graph = {
      nodes: assessModules(baseGraph.nodes, baseGraph.edges, index, scanFingerprint, (/* @__PURE__ */ new Date()).toISOString()),
      edges: baseGraph.edges
    };
    const assessedCanvas = canvas ? { ...canvas, nodes: graph.nodes, edges: graph.edges } : void 0;
    const written = canvasRead.state === "failed" ? await writeFlowWeaveProjectPreservingCanvas(projectPath2, project, graph.nodes, graph.edges, scanFingerprint) : await writeFlowWeaveProject(projectPath2, project, graph.nodes, graph.edges, scanFingerprint, assessedCanvas);
    if (canvasRead.state !== "failed") {
      await readModificationDelta(projectPath2, "");
    }
    await refreshConnectionWithoutFailing(projectId, projectPath2);
    const artifacts = {
      project: "current",
      canvas: canvasRead.state === "failed" ? "failed" : "current",
      task: "current",
      context: "current",
      architecture: await artifactStateForFingerprint(projectPath2, "architecture-map.json", scanFingerprint),
      sequences: await artifactStateForFingerprint(projectPath2, "sequence-diagrams.json", scanFingerprint)
    };
    let architectureReview = await readArchitectureReviewStatus(projectPath2, scanFingerprint);
    if (architectureReview.state === "reviewing" && architectureReview.reviewId && architectureReview.agentId && !isArchitectureReviewActive(architectureReview.reviewId)) {
      const resumed = await analyzeArchitecture(project, architectureReview.agentId, {
        projectId,
        resumeArchitectureReview: architectureReview,
        onArchitectureReview: (reviewEvent2) => sendArchitectureReview(sender, reviewEvent2)
      });
      if (resumed.outcome === "generated") {
        architectureReview = resumed.review;
      }
    }
    let sequenceReview = await readSequenceReviewStatus(projectPath2, scanFingerprint);
    if (sequenceReview.state === "reviewing" && sequenceReview.reviewId && sequenceReview.agentId && !isSequenceReviewActive(sequenceReview.reviewId)) {
      const resumed = await generateSequenceDiagrams(project, sequenceReview.agentId, {
        projectId,
        resumeSequenceReview: sequenceReview,
        onSequenceReview: (reviewEvent2) => sendSequenceReview(sender, reviewEvent2)
      });
      if (resumed.outcome === "generated") {
        sequenceReview = resumed.review;
      }
    }
    notify(updateOperation(started.operation.operationId, {
      stage: "completed",
      completed: total,
      total,
      failed: 0,
      message: "Project scan completed."
    }));
    return {
      canceled: false,
      projectId,
      scanFingerprint,
      artifacts,
      architectureReview,
      sequenceReview,
      project,
      graph,
      written
    };
  } catch (error) {
    if (!started.signal.aborted) {
      notify(updateOperation(started.operation.operationId, {
        stage: "failed",
        completed: 0,
        total: 0,
        failed: 1,
        message: error instanceof Error ? error.message : String(error)
      }));
    }
    if (!started.signal.aborted) {
      await recordDiagnostic(projectPath2, {
        category: "scan",
        code: "project-scan-failed",
        message: error instanceof Error ? error.message : String(error),
        context: { projectId }
      });
    }
    throw error;
  } finally {
    finishOperation(started.operation.operationId);
  }
}
function sendArchitectureReview(sender, event) {
  if (!sender.isDestroyed()) {
    sender.send(PROJECT_CHANNELS.architectureReview, event);
  }
}
function sendSequenceReview(sender, event) {
  if (!sender.isDestroyed()) {
    sender.send(PROJECT_CHANNELS.sequenceReview, event);
  }
}
function requireScanOptions(channel, value) {
  const options = requireObject(channel, value, "options");
  return {
    maxEntries: requireInteger(channel, options.maxEntries, "maxEntries", 1e3, 1e5),
    concurrency: requireInteger(channel, options.concurrency, "concurrency", 1, 128)
  };
}
async function runTrackedAnalysis(kind, message, sender, task, projectPath2) {
  const started = startOperation(kind, message);
  const notify = (operation) => {
    if (!sender.isDestroyed()) sender.send(PROJECT_CHANNELS.operationProgress, operation);
  };
  notify(started.operation);
  try {
    const result = await task(
      started.signal,
      (progress) => notify(updateOperation(started.operation.operationId, progress))
    );
    notify(updateOperation(started.operation.operationId, {
      stage: "completed",
      completed: 1,
      total: 1,
      failed: 0,
      message: "Analysis completed."
    }));
    return result;
  } catch (error) {
    if (!started.signal.aborted) {
      notify(updateOperation(started.operation.operationId, {
        stage: "failed",
        completed: 0,
        total: 1,
        failed: 1,
        message: error instanceof Error ? error.message : String(error)
      }));
      await recordDiagnostic(projectPath2, {
        category: "analysis",
        code: `${kind}-failed`,
        message: error instanceof Error ? error.message : String(error),
        context: { kind }
      });
    }
    throw error;
  } finally {
    finishOperation(started.operation.operationId);
  }
}
async function readCanvasArtifactState(projectPath2) {
  const path = join(projectPath2, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
  try {
    return { state: "loaded", canvas: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    if (isMissing(error)) return { state: "missing" };
    return { state: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
async function artifactStateForFingerprint(projectPath2, fileName, fingerprint) {
  try {
    const artifact = JSON.parse(await readFile(join(projectPath2, FLOWWEAVE_DIR, fileName), "utf8"));
    return artifact.metadata?.inputFingerprint === fingerprint ? "current" : "stale";
  } catch (error) {
    return isMissing(error) ? "missing" : "failed";
  }
}
async function refreshConnectionWithoutFailing(projectId, projectPath2) {
  try {
    await refreshProjectAgentConnectionIfEnabled(projectPath2);
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
function requireCanvas(channel, value) {
  const canvas = requireObject(channel, value, "canvas");
  if (canvas.version !== 3 || !Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) {
    throw new Error(`[${channel}] Canvas must be a valid v3 Canvas.`);
  }
  return canvas;
}
function requireModificationSnapshot(channel, value) {
  const snapshot = requireObject(channel, value, "snapshot");
  if (!snapshot.canvas || !Array.isArray(snapshot.canvas.modules) || !Array.isArray(snapshot.canvas.relations)) {
    throw new Error(`[${channel}] Modification snapshot must include Canvas modules and relations.`);
  }
  return snapshot;
}
function requireModificationAcknowledgementScope(channel, value) {
  const scope = requireObject(channel, value, "scope");
  if (scope.kind === "all" || scope.kind === "sequence") return { kind: scope.kind };
  if (scope.kind === "module-guidance" && "moduleId" in scope) {
    return {
      kind: "module-guidance",
      moduleId: requireString(channel, scope.moduleId, "scope.moduleId")
    };
  }
  throw new Error(`[${channel}] Unsupported modification acknowledgement scope.`);
}
function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
async function readOptionalProjectTextFile(resolvedPath, requestedPath) {
  try {
    return await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (isMissing(error) && isOptionalFlowWeaveDocPath(requestedPath)) return void 0;
    throw error;
  }
}
function isOptionalFlowWeaveDocPath(filePath) {
  return /^\.flowweave\/docs\/[A-Za-z0-9_-]+\.(md|json)$/.test(filePath);
}
const SMOKE_TEST_ARGUMENT = "--flowweave-smoke-test";
const SMOKE_TEST_TIMEOUT_MS = 15e3;
function createWindow() {
  const iconPath = app.isPackaged ? join(process.resourcesPath, "flowweave-app-icon.png") : join(app.getAppPath(), "logo", "flowweave-app-icon.png");
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
    const iconPath = app.isPackaged ? join(process.resourcesPath, "flowweave-app-icon.png") : join(app.getAppPath(), "logo", "flowweave-app-icon.png");
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }
  configureAgentRegistry(app.getPath("userData"));
  registerProjectIpc();
  registerAgentIpc();
  registerGitIpc();
  const window = createWindow();
  if (process.argv.includes(SMOKE_TEST_ARGUMENT)) {
    runSmokeTest(window);
    return;
  }
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
function runSmokeTest(window) {
  const timeout = setTimeout(() => {
    console.error("FlowWeave packaged smoke test timed out.");
    app.exit(1);
  }, SMOKE_TEST_TIMEOUT_MS);
  window.webContents.once("did-finish-load", () => {
    clearTimeout(timeout);
    console.log("FlowWeave packaged smoke test passed.");
    app.exit(0);
  });
  window.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
    clearTimeout(timeout);
    console.error("FlowWeave packaged smoke test failed.", {
      errorCode,
      errorDescription
    });
    app.exit(1);
  });
}

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import type { ToolId } from "./agent-adapter";
import { prepareCommandInvocation } from "./command-invocation";

const execFileAsync = promisify(execFile);

const commandCandidates: Record<ToolId, string[]> = {
  "claude-code": ["claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
  "claude-desktop": [],
  "codex-local": [
    "codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
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

export type ResolvedToolCommand = {
  commandPath?: string;
  installed: boolean;
  version?: string;
};

export async function resolveToolCommand(toolId: ToolId): Promise<ResolvedToolCommand> {
  if (toolId === "mock") {
    return { commandPath: "built-in", installed: true, version: "mock" };
  }

  for (const candidate of getCommandCandidatesForPlatform(toolId, process.platform)) {
    const commandPath = await resolveCandidate(candidate);
    if (!commandPath) {
      continue;
    }

    const invocation = await prepareCommandInvocation(commandPath, ["--version"], process.platform);
    const version = await execFileAsync(invocation.commandPath, invocation.args)
      .then(({ stdout }) => stdout.trim())
      .catch(() => undefined);
    return { commandPath, installed: true, version };
  }

  return { installed: false };
}

export async function resolveAppPath(appPath: string) {
  return access(appPath)
    .then(() => appPath)
    .catch(() => undefined);
}

export async function resolveAppPathFromCandidates(appPaths: string[]) {
  for (const appPath of appPaths) {
    const resolved = await resolveAppPath(appPath);
    if (resolved) return resolved;
  }
  return undefined;
}

export function getCommandCandidates(toolId: ToolId) {
  return [...commandCandidates[toolId]];
}

export function getCommandCandidatesForPlatform(toolId: ToolId, platform: NodeJS.Platform): string[] {
  const candidates = commandCandidates[toolId];
  if (platform !== "win32") return [...candidates];
  return candidates.filter((candidate) => {
    if (candidate.startsWith("/")) return false;
    return toolId !== "cursor" || candidate !== "code";
  });
}

export function buildCommandSearchPaths(
  homePath: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
) {
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
    "/Applications/ChatGPT.app/Contents/Resources",
    "/Applications/Codex.app/Contents/Resources",
    "/Applications/Claude.app/Contents/Resources",
    "/Applications/Cursor.app/Contents/Resources/app/bin"
  ];
}

export function buildCommandNames(
  candidate: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): string[] {
  if (platform !== "win32" || win32.extname(candidate)) return [candidate];
  const extensions = (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return [candidate, ...extensions.map((extension) => `${candidate}${extension}`)];
}

export async function resolveCandidate(candidate: string) {
  return resolveCandidateForPlatform(candidate, process.platform, process.env);
}

export async function resolveCandidateForPlatform(
  candidate: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
) {
  if (isExplicitPath(candidate, platform)) {
    return access(candidate, constants.X_OK)
      .then(() => candidate)
      .catch(() => undefined);
  }

  const lookupCommand = platform === "win32" ? "where.exe" : "which";
  const pathMatch = await execFileAsync(lookupCommand, [candidate])
    .then(({ stdout }) => stdout.split(/\r?\n/).find((line) => line.trim())?.trim())
    .catch(() => undefined);
  if (pathMatch) return pathMatch;

  const knownPathMatch = await resolveCandidateFromSearchPaths(
    candidate,
    buildCommandSearchPaths(homedir(), platform, environment),
    platform,
    environment
  );
  if (knownPathMatch) return knownPathMatch;

  if (platform === "win32") return undefined;
  return execFileAsync("/bin/zsh", ["-lc", "command -v -- \"$1\"", "flowweave-command-lookup", candidate])
    .then(({ stdout }) => stdout.trim() || undefined)
    .catch(() => undefined);
}

export async function resolveCandidateFromSearchPaths(
  candidate: string,
  searchPaths: string[],
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
) {
  for (const searchPath of searchPaths) {
    for (const commandName of buildCommandNames(candidate, platform, environment)) {
      const path = platform === "win32" ? win32.join(searchPath, commandName) : join(searchPath, commandName);
      const resolved = await access(path, constants.X_OK)
        .then(() => path)
        .catch(() => undefined);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function isExplicitPath(candidate: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? win32.isAbsolute(candidate) || candidate.includes("\\") || candidate.includes("/")
    : isAbsolute(candidate) || candidate.includes("/");
}

export const resolveAgentCommand = resolveToolCommand;
export type ResolvedAgentCommand = ResolvedToolCommand;

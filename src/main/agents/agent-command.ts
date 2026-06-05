import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ToolId } from "./agent-adapter";

const execFileAsync = promisify(execFile);

const commandCandidates: Record<ToolId, string[]> = {
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

export type ResolvedToolCommand = {
  commandPath?: string;
  installed: boolean;
  version?: string;
};

export async function resolveToolCommand(toolId: ToolId): Promise<ResolvedToolCommand> {
  if (toolId === "mock") {
    return { commandPath: "built-in", installed: true, version: "mock" };
  }

  for (const candidate of commandCandidates[toolId]) {
    const commandPath = await resolveCandidate(candidate);
    if (!commandPath) {
      continue;
    }

    const version = await execFileAsync(commandPath, ["--version"])
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

export function getCommandCandidates(toolId: ToolId) {
  return [...commandCandidates[toolId]];
}

export function buildCommandSearchPaths(homePath = homedir()) {
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

export async function resolveCandidate(candidate: string) {
  if (candidate.includes("/")) {
    return access(candidate)
      .then(() => candidate)
      .catch(() => undefined);
  }

  const pathMatch = await execFileAsync("which", [candidate])
    .then(({ stdout }) => stdout.trim() || undefined)
    .catch(() => undefined);
  if (pathMatch) return pathMatch;

  const knownPathMatch = await resolveCandidateFromSearchPaths(candidate);
  if (knownPathMatch) return knownPathMatch;

  return execFileAsync("/bin/zsh", ["-lc", "command -v -- \"$1\"", "flowweave-command-lookup", candidate])
    .then(({ stdout }) => stdout.trim() || undefined)
    .catch(() => undefined);
}

export async function resolveCandidateFromSearchPaths(candidate: string, searchPaths = buildCommandSearchPaths()) {
  for (const searchPath of searchPaths) {
    const resolved = await access(join(searchPath, candidate))
      .then(() => join(searchPath, candidate))
      .catch(() => undefined);
    if (resolved) return resolved;
  }
  return undefined;
}

export const resolveAgentCommand = resolveToolCommand;
export type ResolvedAgentCommand = ResolvedToolCommand;

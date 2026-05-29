import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolId } from "./agent-adapter";

const execFileAsync = promisify(execFile);

const commandCandidates: Record<ToolId, string[]> = {
  "codex-local": [
    "codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex"
  ],
  "claude-code": ["claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
  cursor: ["cursor", "/Applications/Cursor.app/Contents/Resources/app/bin/cursor", "/usr/local/bin/cursor", "/opt/homebrew/bin/cursor"],
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

export async function resolveCandidate(candidate: string) {
  if (candidate.includes("/")) {
    return access(candidate)
      .then(() => candidate)
      .catch(() => undefined);
  }

  return execFileAsync("which", [candidate])
    .then(({ stdout }) => stdout.trim() || undefined)
    .catch(() => undefined);
}

export const resolveAgentCommand = resolveToolCommand;
export type ResolvedAgentCommand = ResolvedToolCommand;

import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ChangedFile, ChangedFileStatus, GitStatus } from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { writeJsonAtomic } from "../storage/artifact-store";

const execFileAsync = promisify(execFile);

export async function getGitStatus(projectPath: string): Promise<GitStatus> {
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

export async function createCheckpoint(projectPath: string): Promise<string> {
  await assertGitRepo(projectPath);
  const checkpointId = `flowweave-${Date.now()}`;
  const { stdout, stderr } = await git(projectPath, ["stash", "push", "-u", "-m", checkpointId]);
  const output = `${stdout}\n${stderr}`;
  if (/No local changes to save/i.test(output)) {
    await writeCheckpointMarker(projectPath, checkpointId, false);
    return checkpointId;
  }
  const stashRef = await findStashRef(projectPath, checkpointId);
  if (!stashRef) {
    throw new Error(`Failed to create git checkpoint: ${output.trim() || checkpointId}`);
  }
  await git(projectPath, ["stash", "apply", "--index", stashRef]);
  await writeCheckpointMarker(projectPath, checkpointId, true);
  return checkpointId;
}

export async function getDiff(projectPath: string, checkpointId?: string): Promise<string> {
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

export async function restoreCheckpoint(projectPath: string, checkpointId: string): Promise<void> {
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

export async function getChangedFiles(projectPath: string): Promise<ChangedFile[]> {
  const isRepo = await isGitRepo(projectPath);
  if (!isRepo) return [];

  const [{ stdout: porcelain }, { stdout: numstat }] = await Promise.all([
    git(projectPath, ["status", "--porcelain"]),
    git(projectPath, ["diff", "--numstat", "HEAD"]).catch(() => ({ stdout: "", stderr: "" }))
  ]);

  const stats = parseNumstat(numstat);
  return porcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => parsePorcelainLine(line, stats));
}

export async function importPullRequestDiff(_projectPath: string, _prUrl: string): Promise<string> {
  throw new Error("GitHub PR diff import is not implemented in this local-only build.");
}

async function isGitRepo(projectPath: string) {
  return git(projectPath, ["rev-parse", "--is-inside-work-tree"])
    .then(({ stdout }) => stdout.trim() === "true")
    .catch(() => false);
}

async function assertGitRepo(projectPath: string) {
  if (!(await isGitRepo(projectPath))) {
    throw new Error("Project is not a git repository.");
  }
}

async function readAheadBehind(projectPath: string) {
  const upstream = await git(projectPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => undefined);
  if (!upstream?.stdout.trim()) return {};
  const { stdout } = await git(projectPath, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]).catch(() => ({ stdout: "" }));
  const [aheadText, behindText] = stdout.trim().split(/\s+/);
  return {
    ahead: Number(aheadText) || 0,
    behind: Number(behindText) || 0
  };
}

async function findStashRef(projectPath: string, checkpointId: string) {
  const { stdout } = await git(projectPath, ["stash", "list"]).catch(() => ({ stdout: "" }));
  const line = stdout
    .split("\n")
    .find((item) => item.includes(checkpointId));
  return line?.match(/^stash@\{\d+\}/)?.[0];
}

async function writeCheckpointMarker(projectPath: string, checkpointId: string, hasStash: boolean) {
  const checkpointDir = join(projectPath, FLOWWEAVE_DIR, "checkpoints");
  await mkdir(checkpointDir, { recursive: true });
  await writeJsonAtomic(join(checkpointDir, `${checkpointId}.json`), {
    checkpointId,
    projectPath: resolve(projectPath),
    hasStash,
    createdAt: new Date().toISOString()
  });
}

async function readCheckpointMarker(projectPath: string, checkpointId: string) {
  const checkpointPath = join(projectPath, FLOWWEAVE_DIR, "checkpoints", `${checkpointId}.json`);
  return readFile(checkpointPath, "utf8")
    .then((content) => JSON.parse(content) as { checkpointId: string; projectPath?: string; hasStash: boolean; createdAt: string })
    .catch(() => undefined);
}

function parseNumstat(output: string) {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split("\n")) {
    const [additionsText, deletionsText, path] = line.split("\t");
    if (!path) continue;
    stats.set(path, {
      additions: additionsText === "-" ? 0 : Number(additionsText) || 0,
      deletions: deletionsText === "-" ? 0 : Number(deletionsText) || 0
    });
  }
  return stats;
}

function parsePorcelainLine(line: string, stats: Map<string, { additions: number; deletions: number }>): ChangedFile {
  const code = line.slice(0, 2);
  const rawPath = line.slice(3);
  const [previousPath, currentPath] = rawPath.includes(" -> ") ? rawPath.split(" -> ") : [undefined, rawPath];
  const path = currentPath ?? rawPath;
  const stat = stats.get(path) ?? { additions: 0, deletions: 0 };

  return {
    path,
    previousPath,
    status: statusFromPorcelain(code),
    additions: stat.additions,
    deletions: stat.deletions
  };
}

function statusFromPorcelain(code: string): ChangedFileStatus {
  if (code.includes("?")) return "untracked";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("M")) return "modified";
  return "unknown";
}

function git(projectPath: string, args: string[]) {
  return execFileAsync("git", args, {
    cwd: projectPath,
    maxBuffer: 20 * 1024 * 1024
  });
}

import { execFile } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ChangedFile, ChangedFileStatus, GitStatus } from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { writeJsonAtomic } from "../storage/artifact-store";

const execFileAsync = promisify(execFile);

export async function getGitStatus(projectPath: string): Promise<GitStatus> {
  const context = await resolveGitContext(projectPath);
  if (!context) return { isRepo: false, changedFiles: [] };

  const [{ stdout: branch }, aheadBehind, changedFiles] = await Promise.all([
    git(context.repoRoot, ["branch", "--show-current"]),
    readAheadBehind(context),
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
  const context = await assertGitContext(projectPath);
  const checkpointId = `flowweave-${Date.now()}`;
  const { stdout, stderr } = await git(context.repoRoot, ["stash", "push", "-u", "-m", checkpointId, "--", context.pathspec]);
  const output = `${stdout}\n${stderr}`;
  if (/No local changes to save/i.test(output)) {
    await writeCheckpointMarker(projectPath, checkpointId, false);
    return checkpointId;
  }
  const stashRef = await findStashRef(context, checkpointId);
  if (!stashRef) {
    throw new Error(`Failed to create git checkpoint: ${output.trim() || checkpointId}`);
  }
  await git(context.repoRoot, ["stash", "apply", "--index", stashRef]);
  await writeCheckpointMarker(projectPath, checkpointId, true);
  return checkpointId;
}

export async function getDiff(projectPath: string, checkpointId?: string): Promise<string> {
  const context = await resolveGitContext(projectPath);
  if (!context) return "";

  if (checkpointId) {
    const stashRef = await findStashRef(context, checkpointId);
    if (stashRef) {
      const diff = await git(context.repoRoot, ["diff", "--unified=3", ...relativeDiffArgs(context), stashRef, "--", context.pathspec]).catch(() => ({ stdout: "", stderr: "" }));
      if (diff.stdout.trim()) return diff.stdout;
    }
  }

  const { stdout } = await git(context.repoRoot, ["diff", "--unified=3", ...relativeDiffArgs(context), "--", context.pathspec]);
  const { stdout: staged } = await git(context.repoRoot, ["diff", "--cached", "--unified=3", ...relativeDiffArgs(context), "--", context.pathspec]);
  return [stdout, staged].filter(Boolean).join("\n");
}

export async function restoreCheckpoint(projectPath: string, checkpointId: string): Promise<void> {
  if (!/^flowweave-\d+$/.test(checkpointId)) throw new Error(`Invalid FlowWeave checkpoint id: ${checkpointId}`);
  const context = await assertGitContext(projectPath);
  const [stashRef, marker] = await Promise.all([findStashRef(context, checkpointId), readCheckpointMarker(projectPath, checkpointId)]);
  if (!marker) {
    throw new Error(`FlowWeave checkpoint not found: ${checkpointId}`);
  }
  if (marker.checkpointId !== checkpointId || marker.projectPath !== resolve(projectPath)) {
    throw new Error(`FlowWeave checkpoint does not belong to this project: ${checkpointId}`);
  }
  if (marker.hasStash !== Boolean(stashRef)) {
    throw new Error(`FlowWeave checkpoint state is invalid: ${checkpointId}`);
  }
  if (await hasTrackedFiles(context)) {
    await git(context.repoRoot, ["restore", "--staged", "--worktree", "--", context.pathspec]);
  }
  await git(context.repoRoot, ["clean", "-fd", "--", context.pathspec]);
  if (stashRef) {
    await git(context.repoRoot, ["stash", "pop", stashRef]);
  }
}

export async function getChangedFiles(projectPath: string): Promise<ChangedFile[]> {
  const context = await resolveGitContext(projectPath);
  if (!context) return [];

  const [{ stdout: porcelain }, { stdout: numstat }] = await Promise.all([
    git(context.repoRoot, ["status", "--porcelain", "--", context.pathspec]),
    git(context.repoRoot, ["diff", "--numstat", "HEAD", "--", context.pathspec]).catch(() => ({ stdout: "", stderr: "" }))
  ]);

  const stats = parseNumstat(numstat, context);
  return porcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => parsePorcelainLine(line, stats, context))
    .filter((file): file is ChangedFile => Boolean(file));
}

export async function importPullRequestDiff(_projectPath: string, _prUrl: string): Promise<string> {
  throw new Error("GitHub PR diff import is not implemented in this local-only build.");
}

type GitContext = {
  repoRoot: string;
  pathspec: string;
};

async function resolveGitContext(projectPath: string): Promise<GitContext | undefined> {
  const requestedProjectPath = resolve(projectPath);
  const inside = await git(requestedProjectPath, ["rev-parse", "--is-inside-work-tree"])
    .then(({ stdout }) => stdout.trim() === "true")
    .catch(() => false);
  if (!inside) return undefined;

  const { stdout } = await git(requestedProjectPath, ["rev-parse", "--show-toplevel"]);
  const [projectRoot, repoRoot] = await Promise.all([
    realpath(requestedProjectPath),
    realpath(resolve(stdout.trim()))
  ]);
  const pathspec = normalizeGitPath(relative(repoRoot, projectRoot)) || ".";
  if (pathspec.startsWith("../") || pathspec === ".." || isAbsolute(pathspec)) return undefined;

  return { repoRoot, pathspec };
}

async function assertGitContext(projectPath: string): Promise<GitContext> {
  const context = await resolveGitContext(projectPath);
  if (!context) {
    throw new Error("Project is not a git repository.");
  }
  return context;
}

async function readAheadBehind(context: GitContext) {
  const upstream = await git(context.repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => undefined);
  if (!upstream?.stdout.trim()) return {};
  const { stdout } = await git(context.repoRoot, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]).catch(() => ({ stdout: "" }));
  const [aheadText, behindText] = stdout.trim().split(/\s+/);
  return {
    ahead: Number(aheadText) || 0,
    behind: Number(behindText) || 0
  };
}

async function findStashRef(context: GitContext, checkpointId: string) {
  const { stdout } = await git(context.repoRoot, ["stash", "list"]).catch(() => ({ stdout: "" }));
  const line = stdout
    .split("\n")
    .find((item) => item.includes(checkpointId));
  return line?.match(/^stash@\{\d+\}/)?.[0];
}

async function hasTrackedFiles(context: GitContext) {
  const { stdout } = await git(context.repoRoot, ["ls-files", "--error-unmatch", "--", context.pathspec]).catch(() => ({ stdout: "" }));
  return Boolean(stdout.trim());
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

function parseNumstat(output: string, context: GitContext) {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split("\n")) {
    const [additionsText, deletionsText, path] = line.split("\t");
    if (!path) continue;
    const scopedPath = stripProjectPath(path, context);
    if (!scopedPath) continue;
    stats.set(scopedPath, {
      additions: additionsText === "-" ? 0 : Number(additionsText) || 0,
      deletions: deletionsText === "-" ? 0 : Number(deletionsText) || 0
    });
  }
  return stats;
}

function parsePorcelainLine(line: string, stats: Map<string, { additions: number; deletions: number }>, context: GitContext): ChangedFile | undefined {
  const code = line.slice(0, 2);
  const rawPath = line.slice(3);
  const [previousPath, currentPath] = rawPath.includes(" -> ") ? rawPath.split(" -> ") : [undefined, rawPath];
  const path = stripProjectPath(currentPath ?? rawPath, context);
  if (!path) return undefined;
  const stat = stats.get(path) ?? { additions: 0, deletions: 0 };

  return {
    path,
    previousPath: previousPath ? stripProjectPath(previousPath, context) : undefined,
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

function relativeDiffArgs(context: GitContext) {
  return context.pathspec === "." ? [] : [`--relative=${context.pathspec}`];
}

function stripProjectPath(filePath: string, context: GitContext) {
  if (context.pathspec === ".") return filePath;
  if (filePath === context.pathspec || filePath === `${context.pathspec}/`) return ".";
  const prefix = `${context.pathspec}/`;
  if (!filePath.startsWith(prefix)) return undefined;
  return filePath.slice(prefix.length) || ".";
}

function normalizeGitPath(filePath: string) {
  return filePath.replaceAll("\\", "/");
}

function git(projectPath: string, args: string[]) {
  return execFileAsync("git", args, {
    cwd: projectPath,
    maxBuffer: 20 * 1024 * 1024
  });
}

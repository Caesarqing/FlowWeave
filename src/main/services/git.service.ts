import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ChangedFile, ChangedFileStatus, GitRollbackPreview, GitStatus } from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { writeJsonAtomic } from "../storage/artifact-store";

const execFileAsync = promisify(execFile);
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 10 * 1024 * 1024;
const ROLLBACK_PREVIEW_TTL_MS = 5 * 60 * 1000;
const rollbackPreviews = new Map<string, {
  projectPath: string;
  checkpointId: string;
  fingerprint: string;
  expiresAt: number;
}>();

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
  const { stdout, stderr } = await git(context.repoRoot, ["stash", "push", "-u", "-m", checkpointId, "--", ...rollbackPathspecs(context)]);
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
  return (await getDiffResult(projectPath, checkpointId)).patch;
}

export async function getDiffResult(projectPath: string, checkpointId?: string) {
  const context = await resolveGitContext(projectPath);
  if (!context) return { patch: "", unpreviewableFiles: [] as Array<{ path: string; reason: string }> };

  let trackedPatch = "";
  if (checkpointId) {
    const stashRef = await findStashRef(context, checkpointId);
    if (stashRef) {
      const diff = await git(context.repoRoot, ["diff", "--unified=3", ...relativeDiffArgs(context), stashRef, "--", context.pathspec]).catch(() => ({ stdout: "", stderr: "" }));
      trackedPatch = diff.stdout;
    }
  }

  if (!trackedPatch) {
    const [{ stdout }, { stdout: staged }] = await Promise.all([
      git(context.repoRoot, ["diff", "--unified=3", ...relativeDiffArgs(context), "--", context.pathspec]),
      git(context.repoRoot, ["diff", "--cached", "--unified=3", ...relativeDiffArgs(context), "--", context.pathspec])
    ]);
    trackedPatch = [stdout, staged].filter(Boolean).join("\n");
  }
  const untracked = await getUntrackedDiff(context);
  return {
    patch: [trackedPatch, untracked.patch].filter(Boolean).join("\n"),
    unpreviewableFiles: untracked.unpreviewableFiles
  };
}

export async function getRollbackPreview(projectPath: string, checkpointId: string): Promise<GitRollbackPreview> {
  const { context, stashRef } = await validateCheckpoint(projectPath, checkpointId);
  const [changedFiles, checkpointTrackedFiles, checkpointUntrackedFiles, fingerprint] = await Promise.all([
    getChangedFiles(projectPath),
    getCheckpointTrackedFiles(context, stashRef),
    getCheckpointUntrackedFiles(context, stashRef),
    rollbackStateFingerprint(context, stashRef)
  ]);
  const projectChanges = changedFiles.filter((file) => !isFlowWeavePath(file.path));
  const currentUntrackedFiles = projectChanges
    .filter((file) => file.status === "untracked")
    .map((file) => file.path);
  const checkpointPaths = new Set(checkpointUntrackedFiles);
  const expiresAt = Date.now() + ROLLBACK_PREVIEW_TTL_MS;
  const previewId = randomUUID();
  rollbackPreviews.set(previewId, {
    projectPath: resolve(projectPath),
    checkpointId,
    fingerprint,
    expiresAt
  });
  return {
    previewId,
    checkpointId,
    trackedFilesToRestore: [...new Set([
      ...projectChanges.filter((file) => file.status !== "untracked").map((file) => file.path),
      ...checkpointTrackedFiles
    ])].sort(),
    untrackedFilesToDelete: currentUntrackedFiles.filter((path) => !checkpointPaths.has(path)),
    checkpointUntrackedFilesToRestore: checkpointUntrackedFiles,
    preservedPaths: [".flowweave/ (run logs, review records, diagnostics, and checkpoints)"],
    expiresAt: new Date(expiresAt).toISOString()
  };
}

export async function restoreCheckpoint(projectPath: string, checkpointId: string, previewId: string): Promise<void> {
  if (!/^flowweave-\d+$/.test(checkpointId)) throw new Error(`Invalid FlowWeave checkpoint id: ${checkpointId}`);
  const preview = rollbackPreviews.get(previewId);
  if (!preview || preview.projectPath !== resolve(projectPath) || preview.checkpointId !== checkpointId) {
    throw new Error("A valid rollback preview is required before restoring this checkpoint.");
  }
  if (preview.expiresAt < Date.now()) {
    rollbackPreviews.delete(previewId);
    throw new Error("Rollback preview expired. Generate a new preview before confirming.");
  }
  // Claim the one-time confirmation synchronously, before any asynchronous Git work.
  // A second IPC request with the same preview must fail rather than interleave restore/clean/pop.
  rollbackPreviews.delete(previewId);
  const { context, stashRef } = await validateCheckpoint(projectPath, checkpointId);
  const currentFingerprint = await rollbackStateFingerprint(context, stashRef);
  if (currentFingerprint !== preview.fingerprint) {
    throw new Error("Project changes changed after the rollback preview. Generate a fresh preview before confirming.");
  }
  if (await hasTrackedFiles(context)) {
    await git(context.repoRoot, ["restore", "--staged", "--worktree", "--", ...rollbackPathspecs(context)]);
  }
  await git(context.repoRoot, ["clean", "-fd", "--", ...rollbackPathspecs(context)]);
  if (stashRef) {
    await git(context.repoRoot, ["stash", "pop", stashRef]);
  }
}

export async function getChangedFiles(projectPath: string): Promise<ChangedFile[]> {
  const context = await resolveGitContext(projectPath);
  if (!context) return [];

  const [{ stdout: porcelain }, { stdout: numstat }, { stdout: untrackedOutput }] = await Promise.all([
    git(context.repoRoot, ["status", "--porcelain", "--", context.pathspec]),
    git(context.repoRoot, ["diff", "--numstat", "HEAD", "--", context.pathspec]).catch(() => ({ stdout: "", stderr: "" })),
    git(context.repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", context.pathspec])
  ]);

  const stats = parseNumstat(numstat, context);
  const tracked = porcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => parsePorcelainLine(line, stats, context))
    .filter((file): file is ChangedFile => file !== undefined && file.status !== "untracked");
  const untracked = untrackedOutput
    .split("\0")
    .filter(Boolean)
    .map((repoPath): ChangedFile | undefined => {
      const path = stripProjectPath(repoPath, context);
      if (!path) return undefined;
      return { path, status: "untracked", additions: 0, deletions: 0 };
    })
    .filter((file): file is ChangedFile => Boolean(file));
  return [...tracked, ...untracked].sort((left, right) => left.path.localeCompare(right.path));
}

async function getUntrackedDiff(context: GitContext): Promise<{
  patch: string;
  unpreviewableFiles: Array<{ path: string; reason: string }>;
}> {
  const { stdout } = await git(context.repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", context.pathspec]);
  const filePaths = stdout.split("\0").filter(Boolean);
  const patches: string[] = [];
  const unpreviewableFiles: Array<{ path: string; reason: string }> = [];
  let totalBytes = 0;

  for (const repoPath of filePaths) {
    const path = stripProjectPath(repoPath, context);
    if (!path) continue;
    const absolutePath = resolve(context.repoRoot, repoPath);
    const info = await lstat(absolutePath);
    if (!info.isFile()) {
      unpreviewableFiles.push({ path, reason: "Not a regular file." });
      continue;
    }
    if (info.size > MAX_UNTRACKED_FILE_BYTES) {
      unpreviewableFiles.push({ path, reason: "File exceeds the 1 MiB preview limit." });
      continue;
    }
    if (totalBytes + info.size > MAX_UNTRACKED_TOTAL_BYTES) {
      unpreviewableFiles.push({ path, reason: "Untracked files exceed the 10 MiB total preview limit." });
      continue;
    }
    totalBytes += info.size;
    const content = await readFile(absolutePath);
    const decoded = content.toString("utf8");
    if (content.includes(0) || !Buffer.from(decoded, "utf8").equals(content)) {
      unpreviewableFiles.push({ path, reason: "Binary or non-UTF-8 file." });
      continue;
    }
    const relativePath = context.pathspec === "." ? repoPath : `${context.pathspec}/${path}`;
    const diff = await gitAllowDiffExit(context.repoRoot, ["diff", "--no-index", "--unified=3", "--", "/dev/null", relativePath]);
    patches.push(diff);
  }

  return { patch: patches.filter(Boolean).join("\n"), unpreviewableFiles };
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
  const { stdout } = await git(context.repoRoot, ["ls-files", "--error-unmatch", "--", ...rollbackPathspecs(context)]).catch(() => ({ stdout: "" }));
  return Boolean(stdout.trim());
}

async function validateCheckpoint(projectPath: string, checkpointId: string) {
  if (!/^flowweave-\d+$/.test(checkpointId)) throw new Error("Invalid FlowWeave checkpoint id: " + checkpointId);
  const context = await assertGitContext(projectPath);
  const [stashRef, marker] = await Promise.all([
    findStashRef(context, checkpointId),
    readCheckpointMarker(projectPath, checkpointId)
  ]);
  if (!marker) throw new Error("FlowWeave checkpoint not found: " + checkpointId);
  if (marker.checkpointId !== checkpointId || marker.projectPath !== resolve(projectPath)) {
    throw new Error("FlowWeave checkpoint does not belong to this project: " + checkpointId);
  }
  if (marker.hasStash !== Boolean(stashRef)) {
    throw new Error("FlowWeave checkpoint state is invalid: " + checkpointId);
  }
  if (stashRef) {
    const protectedFiles = await getCheckpointFlowWeaveFiles(context, stashRef);
    if (protectedFiles.length > 0) {
      throw new Error(
        "This checkpoint contains FlowWeave history and cannot be rolled back safely. Create a new checkpoint after this update."
      );
    }
  }
  return { context, stashRef };
}

async function getCheckpointFlowWeaveFiles(context: GitContext, stashRef: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(context.repoRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", stashRef + "^1", stashRef, "--", context.pathspec])
      .catch(() => ({ stdout: "", stderr: "" })),
    git(context.repoRoot, ["ls-tree", "-r", "--name-only", "-z", stashRef + "^3", "--", context.pathspec])
      .catch(() => ({ stdout: "", stderr: "" }))
  ]);
  return [...tracked.stdout.split("\n"), ...untracked.stdout.split("\0")]
    .filter(Boolean)
    .map((path) => stripProjectPath(path, context))
    .filter((path): path is string => typeof path === "string" && isFlowWeavePath(path));
}

async function getCheckpointUntrackedFiles(context: GitContext, stashRef: string | undefined): Promise<string[]> {
  if (!stashRef) return [];
  const { stdout } = await git(context.repoRoot, ["ls-tree", "-r", "--name-only", "-z", stashRef + "^3", "--", context.pathspec])
    .catch(() => ({ stdout: "" }));
  return stdout.split("\0").filter(Boolean)
    .map((repoPath) => stripProjectPath(repoPath, context))
    .filter((path): path is string => typeof path === "string" && !isFlowWeavePath(path));
}

async function getCheckpointTrackedFiles(context: GitContext, stashRef: string | undefined): Promise<string[]> {
  if (!stashRef) return [];
  const { stdout } = await git(context.repoRoot, [
    "diff-tree", "--no-commit-id", "--name-only", "-z", stashRef + "^1", stashRef, "--", context.pathspec
  ]).catch(() => ({ stdout: "", stderr: "" }));
  return stdout.split("\0").filter(Boolean)
    .map((repoPath) => stripProjectPath(repoPath, context))
    .filter((path): path is string => typeof path === "string" && !isFlowWeavePath(path));
}

async function rollbackStateFingerprint(context: GitContext, stashRef: string | undefined): Promise<string> {
  const pathspecs = rollbackPathspecs(context);
  const [status, unstaged, staged, untracked, head] = await Promise.all([
    git(context.repoRoot, ["status", "--porcelain=v1", "-z", "--", ...pathspecs]),
    git(context.repoRoot, ["diff", "--binary", "--", ...pathspecs]),
    git(context.repoRoot, ["diff", "--cached", "--binary", "--", ...pathspecs]).catch(() => ({ stdout: "", stderr: "" })),
    git(context.repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs]),
    git(context.repoRoot, ["rev-parse", "HEAD"]).catch(() => ({ stdout: "", stderr: "" }))
  ]);
  const hash = createHash("sha256");
  hash.update(status.stdout);
  hash.update(unstaged.stdout);
  hash.update(staged.stdout);
  hash.update(head.stdout);
  if (stashRef) {
    const stashCommit = await git(context.repoRoot, ["rev-parse", stashRef]).catch(() => ({ stdout: "", stderr: "" }));
    hash.update(stashCommit.stdout);
  }
  for (const repoPath of untracked.stdout.split("\0").filter(Boolean).sort()) {
    const absolutePath = resolve(context.repoRoot, repoPath);
    const info = await lstat(absolutePath);
    updateHashField(hash, "path", repoPath);
    if (info.isSymbolicLink()) {
      updateHashField(hash, "type", "symbolic-link");
      updateHashField(hash, "target", await readlink(absolutePath));
    } else if (info.isFile()) {
      hash.update(`type:file:size:${info.size}:content:`);
      for await (const chunk of createReadStream(absolutePath)) {
        hash.update(chunk);
      }
    } else {
      updateHashField(hash, "type", `other:${info.mode}:${info.size}:${info.mtimeMs}`);
    }
  }
  return hash.digest("hex");
}

function updateHashField(hash: ReturnType<typeof createHash>, name: string, value: string): void {
  const content = Buffer.from(value, "utf8");
  hash.update(`${name}:${content.byteLength}:`);
  hash.update(content);
}

function rollbackPathspecs(context: GitContext): string[] {
  const flowWeavePath = context.pathspec === "." ? ".flowweave/**" : context.pathspec + "/.flowweave/**";
  return [context.pathspec, ":(exclude)" + flowWeavePath];
}

function isFlowWeavePath(path: string): boolean {
  return path === FLOWWEAVE_DIR || path.startsWith(FLOWWEAVE_DIR + "/");
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

async function gitAllowDiffExit(projectPath: string, args: string[]): Promise<string> {
  try {
    return (await git(projectPath, args)).stdout;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1 && "stdout" in error) {
      const output = error.stdout;
      if (typeof output === "string") return output;
    }
    throw error;
  }
}

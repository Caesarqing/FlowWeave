import { mkdir, mkdtemp, open, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createCheckpoint,
  getChangedFiles,
  getDiff,
  getDiffResult,
  getGitStatus,
  getRollbackPreview,
  restoreCheckpoint
} from "../../src/main/services/git.service";

const execFileAsync = promisify(execFile);

describe("git.service", () => {
  it("returns non-repo status outside git repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-non-git-"));

    await expect(getGitStatus(root)).resolves.toMatchObject({ isRepo: false, changedFiles: [] });
  });

  it("reads changes, creates checkpoint, and restores the worktree", async () => {
    const root = await createRepo();
    const filePath = join(root, "app.ts");
    await writeFile(filePath, "export const app = 2;\n");

    const changed = await getChangedFiles(root);
    expect(changed).toContainEqual(expect.objectContaining({ path: "app.ts", status: "modified" }));

    const checkpointId = await createCheckpoint(root);
    await expect(readFile(filePath, "utf8")).resolves.toContain("app = 2");
    await writeFile(filePath, "export const app = 3;\n");

    const diff = await getDiff(root, checkpointId);
    expect(diff).toContain("app.ts");

    await restoreCheckpoint(root, checkpointId, (await getRollbackPreview(root, checkpointId)).previewId);
    await expect(readFile(filePath, "utf8")).resolves.toContain("app = 2");
  });

  it("scopes changed files and diff to the selected project inside a parent repository", async () => {
    const root = await createRepo();
    const projectPath = await createNestedProject(root);
    await writeFile(join(projectPath, "app.ts"), "export const nested = 2;\n");
    await writeFile(join(projectPath, "scratch.ts"), "export const scratch = true;\n");
    await writeFile(join(root, "sibling.ts"), "export const sibling = 2;\n");

    const status = await getGitStatus(projectPath);
    expect(status.isRepo).toBe(true);
    expect(status.changedFiles).toEqual([
      expect.objectContaining({ path: "app.ts", status: "modified" }),
      expect.objectContaining({ path: "scratch.ts", status: "untracked" })
    ]);

    const diff = await getDiff(projectPath);
    expect(diff).toContain("diff --git a/app.ts b/app.ts");
    expect(diff).not.toContain("sibling.ts");
    expect(diff).not.toContain("nested/app.ts");
  });

  it("includes untracked text file content in the diff without adding it to the Git index", async () => {
    const root = await createRepo();
    const filePath = join(root, "new file.ts");
    await writeFile(filePath, "export const created = true;\n", "utf8");

    const diff = await getDiff(root);
    const status = await getGitStatus(root);
    const staged = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: root });

    expect(diff).toContain("new file.ts");
    expect(diff).toContain("export const created = true;");
    expect(status.changedFiles).toContainEqual(expect.objectContaining({ path: "new file.ts", status: "untracked" }));
    expect(staged.stdout).toBe("");
  });

  it("reports an untracked selected project directory without leaking sibling changes", async () => {
    const root = await createRepo();
    const projectPath = join(root, "untracked-project");
    await mkdir(projectPath);
    await writeFile(join(projectPath, "app.ts"), "export const app = true;\n");
    await writeFile(join(root, "sibling.ts"), "export const sibling = 2;\n");

    const status = await getGitStatus(projectPath);
    expect(status.isRepo).toBe(true);
    expect(status.changedFiles).toEqual([
      expect.objectContaining({ path: "app.ts", status: "untracked" })
    ]);
  });

  it("reports binary and oversized untracked files as not previewable", async () => {
    const root = await createRepo();
    await writeFile(join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, "large.txt"), "x".repeat(1024 * 1024 + 1), "utf8");

    const result = await getDiffResult(root);

    expect(result.unpreviewableFiles).toEqual([
      { path: "image.bin", reason: "Binary or non-UTF-8 file." },
      { path: "large.txt", reason: "File exceeds the 1 MiB preview limit." }
    ]);
    expect(result.patch).not.toContain("image.bin");
    expect(result.patch).not.toContain("large.txt");
  });

  it("checkpoints and restores an untracked selected project directory without touching siblings", async () => {
    const root = await createRepo();
    const projectPath = join(root, "untracked-project");
    await mkdir(projectPath);
    await writeFile(join(projectPath, "app.ts"), "export const app = 1;\n");
    await writeFile(join(root, "sibling.ts"), "export const sibling = 2;\n");

    const checkpointId = await createCheckpoint(projectPath);
    await writeFile(join(projectPath, "app.ts"), "export const app = 2;\n");
    await writeFile(join(root, "sibling.ts"), "export const sibling = 3;\n");

    await restoreCheckpoint(projectPath, checkpointId, (await getRollbackPreview(projectPath, checkpointId)).previewId);

    await expect(readFile(join(projectPath, "app.ts"), "utf8")).resolves.toContain("app = 1");
    await expect(readFile(join(root, "sibling.ts"), "utf8")).resolves.toContain("sibling = 3");
  });

  it("restores checkpoints without resetting sibling changes in a parent repository", async () => {
    const root = await createRepo();
    const projectPath = await createNestedProject(root);
    const projectFilePath = join(projectPath, "app.ts");
    const siblingFilePath = join(root, "sibling.ts");
    await writeFile(projectFilePath, "export const nested = 2;\n");
    await writeFile(siblingFilePath, "export const sibling = 2;\n");

    const checkpointId = await createCheckpoint(projectPath);
    await expect(readFile(projectFilePath, "utf8")).resolves.toContain("nested = 2");
    await expect(readFile(siblingFilePath, "utf8")).resolves.toContain("sibling = 2");

    await writeFile(projectFilePath, "export const nested = 3;\n");
    await writeFile(join(projectPath, "scratch.ts"), "export const scratch = true;\n");
    await writeFile(siblingFilePath, "export const sibling = 3;\n");

    await restoreCheckpoint(projectPath, checkpointId, (await getRollbackPreview(projectPath, checkpointId)).previewId);

    await expect(readFile(projectFilePath, "utf8")).resolves.toContain("nested = 2");
    await expect(readFile(siblingFilePath, "utf8")).resolves.toContain("sibling = 3");
    await expect(readFile(join(projectPath, "scratch.ts"), "utf8")).rejects.toThrow();
  });

  it("does not reset the worktree for an unknown checkpoint", async () => {
    const root = await createRepo();
    const filePath = join(root, "app.ts");
    await writeFile(filePath, "export const app = 99;\n");

    await expect(getRollbackPreview(root, "flowweave-123456")).rejects.toThrow("FlowWeave checkpoint not found");
    await expect(readFile(filePath, "utf8")).resolves.toContain("app = 99");
  });

  it("requires a fresh preview and preserves FlowWeave run and review records on rollback", async () => {
    const root = await createRepo();
    const flowweavePath = join(root, ".flowweave");
    await mkdir(join(flowweavePath, "runs"), { recursive: true });
    const reviewPath = join(flowweavePath, "architecture-review.json");
    await writeFile(reviewPath, "review baseline", "utf8");
    await execFileAsync("git", ["add", ".flowweave/architecture-review.json"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "add FlowWeave review"], { cwd: root });
    await writeFile(reviewPath, "review before checkpoint", "utf8");
    await writeFile(join(root, "app.ts"), "export const app = 2;\n", "utf8");
    const checkpointFile = join(root, "checkpoint.txt");
    await writeFile(checkpointFile, "checkpoint version", "utf8");
    const checkpointId = await createCheckpoint(root);

    await writeFile(reviewPath, "review completed after checkpoint", "utf8");
    await writeFile(join(flowweavePath, "runs", "run-1.json"), "run record", "utf8");
    await writeFile(join(root, "app.ts"), "export const app = 1;\n", "utf8");
    await rm(checkpointFile);
    await writeFile(join(root, "new-file.txt"), "discard this", "utf8");

    const preview = await getRollbackPreview(root, checkpointId);
    expect(preview.trackedFilesToRestore).toContain("app.ts");
    expect(preview.untrackedFilesToDelete).toEqual(["new-file.txt"]);
    expect(preview.checkpointUntrackedFilesToRestore).toEqual(["checkpoint.txt"]);
    expect(preview.preservedPaths[0]).toContain(".flowweave/");
    await restoreCheckpoint(root, checkpointId, preview.previewId);

    await expect(readFile(join(root, "app.ts"), "utf8")).resolves.toContain("app = 2");
    await expect(readFile(checkpointFile, "utf8")).resolves.toBe("checkpoint version");
    await expect(readFile(join(root, "new-file.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(reviewPath, "utf8")).resolves.toBe("review completed after checkpoint");
    await expect(readFile(join(flowweavePath, "runs", "run-1.json"), "utf8")).resolves.toBe("run record");
  });

  it("refuses rollback when the project changes after its preview", async () => {
    const root = await createRepo();
    await writeFile(join(root, "app.ts"), "export const app = 2;\n", "utf8");
    const checkpointId = await createCheckpoint(root);
    await writeFile(join(root, "late.txt"), "before preview", "utf8");
    const preview = await getRollbackPreview(root, checkpointId);
    await writeFile(join(root, "late.txt"), "after preview", "utf8");

    await expect(restoreCheckpoint(root, checkpointId, preview.previewId)).rejects.toThrow("changed after the rollback preview");
    await expect(readFile(join(root, "late.txt"), "utf8")).resolves.toBe("after preview");
  });

  it("fingerprints large untracked files without loading the whole file into memory", async () => {
    const root = await createRepo();
    const checkpointId = await createCheckpoint(root);
    const filePath = join(root, "large-sparse.bin");
    const fileBytes = 128 * 1024 * 1024;
    await writeFile(filePath, "");
    await truncate(filePath, fileBytes);
    const maxRssBeforePreview = normalizedMaxRssBytes();

    const preview = await getRollbackPreview(root, checkpointId);

    expect(normalizedMaxRssBytes() - maxRssBeforePreview).toBeLessThan(96 * 1024 * 1024);
    const file = await open(filePath, "r+");
    try {
      await file.write(Buffer.from([1]), 0, 1, fileBytes - 1);
    } finally {
      await file.close();
    }

    await expect(restoreCheckpoint(root, checkpointId, preview.previewId)).rejects.toThrow(
      "changed after the rollback preview"
    );
  }, 20_000);

  it("frames untracked file fingerprints so bytes cannot shift across file boundaries", async () => {
    const root = await createRepo();
    const checkpointId = await createCheckpoint(root);
    await writeFile(join(root, "a"), "X", "utf8");
    await writeFile(join(root, "b"), "YbZ", "utf8");
    const preview = await getRollbackPreview(root, checkpointId);

    await writeFile(join(root, "a"), "XbY", "utf8");
    await writeFile(join(root, "b"), "Z", "utf8");

    await expect(restoreCheckpoint(root, checkpointId, preview.previewId)).rejects.toThrow(
      "changed after the rollback preview"
    );
  });

  it("accepts a rollback preview only once when confirmations race", async () => {
    const root = await createRepo();
    await writeFile(join(root, "app.ts"), "export const app = 2;\n", "utf8");
    const checkpointId = await createCheckpoint(root);
    await writeFile(join(root, "app.ts"), "export const app = 3;\n", "utf8");
    const preview = await getRollbackPreview(root, checkpointId);

    const attempts = await Promise.allSettled([
      restoreCheckpoint(root, checkpointId, preview.previewId),
      restoreCheckpoint(root, checkpointId, preview.previewId)
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    await expect(readFile(join(root, "app.ts"), "utf8")).resolves.toContain("app = 2");
  });
});

function normalizedMaxRssBytes(): number {
  return process.resourceUsage().maxRSS * 1024;
}

async function createRepo() {
  const root = await mkdtemp(join(tmpdir(), "flowweave-git-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "flowweave@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "FlowWeave"], { cwd: root });
  await writeFile(join(root, "app.ts"), "export const app = 1;\n");
  await execFileAsync("git", ["add", "app.ts"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
  return root;
}

async function createNestedProject(root: string) {
  const projectPath = join(root, "nested");
  await mkdir(projectPath);
  await writeFile(join(projectPath, "app.ts"), "export const nested = 1;\n");
  await writeFile(join(root, "sibling.ts"), "export const sibling = 1;\n");
  await execFileAsync("git", ["add", "nested/app.ts", "sibling.ts"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "add nested project"], { cwd: root });
  return projectPath;
}

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createCheckpoint, getChangedFiles, getDiff, getGitStatus, restoreCheckpoint } from "../../src/main/services/git.service";

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

    await restoreCheckpoint(root, checkpointId);
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

  it("reports an untracked selected project directory without leaking sibling changes", async () => {
    const root = await createRepo();
    const projectPath = join(root, "untracked-project");
    await mkdir(projectPath);
    await writeFile(join(projectPath, "app.ts"), "export const app = true;\n");
    await writeFile(join(root, "sibling.ts"), "export const sibling = 2;\n");

    const status = await getGitStatus(projectPath);
    expect(status.isRepo).toBe(true);
    expect(status.changedFiles).toEqual([
      expect.objectContaining({ path: ".", status: "untracked" })
    ]);
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

    await restoreCheckpoint(projectPath, checkpointId);

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

    await restoreCheckpoint(projectPath, checkpointId);

    await expect(readFile(projectFilePath, "utf8")).resolves.toContain("nested = 2");
    await expect(readFile(siblingFilePath, "utf8")).resolves.toContain("sibling = 3");
    await expect(readFile(join(projectPath, "scratch.ts"), "utf8")).rejects.toThrow();
  });

  it("does not reset the worktree for an unknown checkpoint", async () => {
    const root = await createRepo();
    const filePath = join(root, "app.ts");
    await writeFile(filePath, "export const app = 99;\n");

    await expect(restoreCheckpoint(root, "flowweave-123456")).rejects.toThrow("FlowWeave checkpoint not found");
    await expect(readFile(filePath, "utf8")).resolves.toContain("app = 99");
  });
});

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

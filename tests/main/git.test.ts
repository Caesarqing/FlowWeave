import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

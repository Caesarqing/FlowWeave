import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOptionalProjectTextFile } from "../../src/main/ipc/project.ipc";

describe("project ipc document reads", () => {
  it("returns undefined for missing FlowWeave docs files", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-doc-read-"));
    const resolvedPath = join(root, ".flowweave", "docs", "task-spec.md");

    await expect(readOptionalProjectTextFile(resolvedPath, ".flowweave/docs/task-spec.md")).resolves.toBeUndefined();
  });

  it("throws for missing non-doc project files", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-doc-read-nondoc-"));
    const resolvedPath = join(root, "README.md");

    await expect(readOptionalProjectTextFile(resolvedPath, "README.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads existing FlowWeave docs files", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-doc-read-existing-"));
    const resolvedPath = join(root, ".flowweave", "docs", "task-spec.md");
    await mkdir(join(root, ".flowweave", "docs"), { recursive: true });
    await writeFile(resolvedPath, "# Existing task\n", "utf8");

    await expect(readOptionalProjectTextFile(resolvedPath, ".flowweave/docs/task-spec.md")).resolves.toBe("# Existing task\n");
    await expect(readFile(resolvedPath, "utf8")).resolves.toBe("# Existing task\n");
  });
});

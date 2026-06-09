import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  registerProject,
  resetProjectRegistryForTests,
  resolveProjectFile,
  resolveProjectPath
} from "../../src/main/services/project-registry.service";

describe("project-registry.service", () => {
  beforeEach(() => resetProjectRegistryForTests());

  it("resolves only projects registered from an absolute directory path", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-project-registry-"));
    const projectId = await registerProject(projectPath);

    expect(resolveProjectPath(projectId)).toBe(await realpath(projectPath));
    expect(() => resolveProjectPath("project-00000000-0000-0000-0000-000000000000")).toThrow("not authorized");
  });

  it("rejects traversal, absolute paths, and symbolic links outside the project", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-project-files-"));
    const outsidePath = await mkdtemp(join(tmpdir(), "flowweave-project-outside-"));
    await writeFile(join(outsidePath, "secret.txt"), "secret", "utf8");
    await symlink(join(outsidePath, "secret.txt"), join(projectPath, "secret-link.txt"));
    const projectId = await registerProject(projectPath);

    await expect(resolveProjectFile(projectId, "../secret.txt")).rejects.toThrow("relative path");
    await expect(resolveProjectFile(projectId, join(outsidePath, "secret.txt"))).rejects.toThrow("relative path");
    await expect(resolveProjectFile(projectId, "secret-link.txt")).rejects.toThrow("escapes");
  });
});

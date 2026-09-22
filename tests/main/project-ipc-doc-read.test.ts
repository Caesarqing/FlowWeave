import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOptionalProjectTextFile, requireCanvasV5, requireProjectWorkspaceSession } from "../../src/main/ipc/project.ipc";

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

  it("accepts only known workspace pages in project tab sessions", () => {
    expect(requireProjectWorkspaceSession("project:save-workspace-session", {
      openProjectIds: ["project-00000000-0000-0000-0000-000000000000"],
      activeProjectId: "project-00000000-0000-0000-0000-000000000000",
      lastPageByProject: { "project-00000000-0000-0000-0000-000000000000": "canvas" },
      contextsByProject: {}
    })).toEqual({
      openProjectIds: ["project-00000000-0000-0000-0000-000000000000"],
      activeProjectId: "project-00000000-0000-0000-0000-000000000000",
      lastPageByProject: { "project-00000000-0000-0000-0000-000000000000": "canvas" },
      contextsByProject: {}
    });

    expect(() => requireProjectWorkspaceSession("project:save-workspace-session", {
      openProjectIds: [],
      lastPageByProject: { "project-00000000-0000-0000-0000-000000000000": "unknown" }
    })).toThrow("lastPageByProject");
  });

  it("accepts Canvas v5 and rejects Canvas v4 at the IPC boundary", () => {
    const canvas = { version: 5, nodes: [], edges: [] };

    expect(requireCanvasV5("project:save-canvas", canvas)).toBe(canvas);
    expect(() => requireCanvasV5("project:save-canvas", { ...canvas, version: 4 }))
      .toThrow("current v5 Canvas. Re-scan the project");
  });
});

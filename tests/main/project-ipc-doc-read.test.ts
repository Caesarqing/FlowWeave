import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canvasArtifactShapeIssue, readOptionalProjectTextFile, requireCanvasV6, requireProjectWorkspaceSession } from "../../src/main/ipc/project.ipc";

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

  it("accepts Canvas v6 and rejects older Canvas versions at the IPC boundary", () => {
    const canvas = { version: 6, id: "canvas", title: "Canvas", projectPath: "/project", generatedAt: "2026-09-29", nodes: [], edges: [] };

    expect(requireCanvasV6("project:save-canvas", canvas)).toBe(canvas);
    expect(() => requireCanvasV6("project:save-canvas", { ...canvas, version: 5 }))
      .toThrow("current v6 Canvas. Re-scan the project");
  });

  it("validates legacy and current Canvas node and edge shapes with field paths", () => {
    const canvas = {
      version: 5,
      id: "canvas",
      title: "Canvas",
      projectPath: "/project",
      generatedAt: "2026-09-29",
      nodes: [{ id: "module", title: "Module", subtitle: "Module", kind: "module", nodeType: "module", risk: "normal", description: "Description", files: [], guidanceDraft: "", status: "mapped", x: 0, y: 0 }],
      edges: [{ id: "edge", source: "module", target: "module", relation: "calls", evidence: [{ detail: "calls", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } } }] }]
    };

    expect(canvasArtifactShapeIssue(canvas)).toBeUndefined();
    expect(canvasArtifactShapeIssue({ ...canvas, nodes: [null] })).toBe("nodes[0] must be an object");
    expect(canvasArtifactShapeIssue({ ...canvas, edges: [{ ...canvas.edges[0], relation: "unknown" }] })).toBe("edges[0].relation is invalid");
    expect(canvasArtifactShapeIssue({ ...canvas, edges: [{ ...canvas.edges[0], evidence: [null] }] })).toBe("edges[0].evidence[0] must include a detail string");
    expect(canvasArtifactShapeIssue({ ...canvas, edges: [{ ...canvas.edges[0], evidence: [{ detail: "calls", eventId: 4 }] }] })).toBe("edges[0].evidence[0].eventId must be a string");

    expect(() => requireCanvasV6("project:save-canvas", { ...canvas, version: 6, nodes: [null] }))
      .toThrow("nodes[0] must be an object");
  });
});

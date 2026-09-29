import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { graphEdges, graphNodes } from "./graph.fixture";
import { writeBatchAtomic, writeFlowWeaveProject } from "../../src/main/storage/flowweave-store";
import type { CodeflowProject } from "../../src/types";

describe("flowweave-store", () => {
  it("preserves the entire old batch when an artifact target is a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-invalid-batch-"));
    const artifact = join(root, "valid.json");
    const directory = join(root, "invalid.json");
    await writeFile(artifact, "old valid artifact", "utf8");
    await mkdir(directory);
    await writeFile(join(directory, "user-data.txt"), "retained user data", "utf8");

    await expect(writeBatchAtomic(root, [
      { path: artifact, content: "new artifact" },
      { path: directory, content: "invalid replacement" }
    ])).rejects.toThrow("not a regular file");
    expect(await readFile(artifact, "utf8")).toBe("old valid artifact");
    expect(await readFile(join(directory, "user-data.txt"), "utf8")).toBe("retained user data");
    expect((await readdir(root)).sort()).toEqual(["invalid.json", "valid.json"]);
  });

  it("writes fixed current task artifacts and removes stale task snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-"));
    const tasksPath = join(root, ".flowweave", "tasks");
    await mkdir(tasksPath, { recursive: true });
    await writeFile(join(tasksPath, "task-old.task.md"), "old", "utf8");
    await writeFile(join(tasksPath, "task-old.task.json"), "{}", "utf8");

    await writeFlowWeaveProject(root, projectFixture(root), graphNodes, graphEdges, "scan-1");

    expect((await readdir(tasksPath)).sort()).toEqual(["current.task.json", "current.task.md"]);
    expect(await readFile(join(tasksPath, "current.task.md"), "utf8")).toContain("FlowWeave generated Codex task");
    expect(JSON.parse(await readFile(join(root, ".flowweave", "project.json"), "utf8")).scanFingerprint).toBe("scan-1");
  });

  it("discards unsupported older Canvas fields when scanning rebuilds v6", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-corrupt-canvas-"));
    const canvasPath = join(root, ".flowweave", "canvas", "main.canvas.json");
    await mkdir(join(root, ".flowweave", "canvas"), { recursive: true });
    await writeFile(canvasPath, JSON.stringify({
      version: 4,
      id: "legacy",
      nodes: [{ id: "legacy-note", origin: "manual" }],
      edges: [{ id: "legacy-edge", source: "legacy-note", target: "gone", origin: "manual" }],
      layout: { activeMode: "role", manualPositions: { "legacy-note": { x: 1, y: 2 } }, autoLayouts: {}, collapsedGroups: [] }
    }), "utf8");

    await writeFlowWeaveProject(root, projectFixture(root), graphNodes, graphEdges, "scan-2");

    const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
    expect(canvas.version).toBe(6);
    expect(canvas.nodes).toEqual(graphNodes.map((node) => expect.objectContaining({ id: node.id, origin: "generated" })));
    expect(canvas.nodes.map((node: { id: string }) => node.id)).not.toContain("legacy-note");
    expect(canvas.edges.map((edge: { id: string }) => edge.id)).not.toContain("legacy-edge");
    expect(canvas.orphanedEdges).toEqual([]);
    expect(JSON.parse(await readFile(join(root, ".flowweave", "project.json"), "utf8")).scanFingerprint).toBe("scan-2");
  });

  it("rejects a linked FlowWeave root instead of writing artifacts outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-linked-root-"));
    const outside = await mkdtemp(join(tmpdir(), "flowweave-store-linked-outside-"));
    await symlink(outside, join(root, ".flowweave"), "dir");

    await expect(writeFlowWeaveProject(root, projectFixture(root), graphNodes, graphEdges, "scan-link"))
      .rejects.toThrow("symbolic link");
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});

function projectFixture(rootPath: string): CodeflowProject {
  return {
    version: 1,
    projectName: "fixture",
    rootPath,
    generatedAt: "2026-06-09T00:00:00.000Z",
    git: { isRepo: false },
    summary: { totalFiles: 0, totalFolders: 0, languages: {} },
    files: []
  };
}

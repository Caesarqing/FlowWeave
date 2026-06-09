import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { graphEdges, graphNodes } from "../../src/data";
import { writeFlowWeaveProject, writeFlowWeaveProjectPreservingCanvas } from "../../src/main/storage/flowweave-store";
import type { CodeflowProject } from "../../src/types";

describe("flowweave-store", () => {
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

  it("updates scan artifacts without overwriting a corrupt Canvas", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-corrupt-canvas-"));
    const canvasPath = join(root, ".flowweave", "canvas", "main.canvas.json");
    await mkdir(join(root, ".flowweave", "canvas"), { recursive: true });
    await writeFile(canvasPath, "{invalid-json", "utf8");

    await writeFlowWeaveProjectPreservingCanvas(root, projectFixture(root), graphNodes, graphEdges, "scan-2");

    expect(await readFile(canvasPath, "utf8")).toBe("{invalid-json");
    expect(JSON.parse(await readFile(join(root, ".flowweave", "project.json"), "utf8")).scanFingerprint).toBe("scan-2");
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

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acknowledgeModificationChanges,
  readModificationDelta
} from "../../src/main/services/modification-delta.service";
import { writeModificationDocs } from "../../src/main/services/modification-doc.service";
import type { CodeflowCanvas, GraphNode } from "../../src/types";

describe("modification delta service", () => {
  it("initializes a persistent baseline from the current Canvas", async () => {
    const projectPath = await createProject();

    const first = await readModificationDelta(projectPath, "");
    const second = await readModificationDelta(projectPath, "");

    expect(first.hasChanges).toBe(false);
    expect(second.hasChanges).toBe(false);
    expect(JSON.parse(await readFile(baselinePath(projectPath), "utf8"))).toMatchObject({
      version: 1,
      canvas: { modules: [{ id: "api" }] }
    });
  });

  it("persists pending delta across reads and writes compact docs", async () => {
    const projectPath = await createProject();
    await readModificationDelta(projectPath, "");
    await writeCanvas(projectPath, canvasFixture(projectPath, {
      guidanceDraft: "Keep handlers thin."
    }));

    const paths = await writeModificationDocs(projectPath, {
      sequenceInstruction: "Split authorize and capture."
    });
    const markdown = await readFile(paths.guidancePath, "utf8");
    const context = JSON.parse(await readFile(paths.contextPath, "utf8"));

    expect(context.schemaVersion).toBe(2);
    expect(context.delta.modules.updated[0].changes).toEqual({
      guidanceDraft: "Keep handlers thin."
    });
    expect(context.delta.sequenceInstruction).toBe("Split authorize and capture.");
    expect(context.artifactReferences).toContain(".flowweave/sequence-diagrams.json");
    expect(context).not.toHaveProperty("canvas");
    expect(context).not.toHaveProperty("sequence");
    expect(markdown).toContain("Keep handlers thin.");
    expect(markdown).toContain(".flowweave/canvas/main.canvas.json");
    expect(markdown).not.toContain("API boundary");
  });

  it("acknowledges only the requested sent snapshot", async () => {
    const projectPath = await createProject();
    await readModificationDelta(projectPath, "");
    await writeCanvas(projectPath, canvasFixture(projectPath, {
      title: "Public API",
      guidanceDraft: "Keep handlers thin."
    }));
    const sent = await readModificationDelta(projectPath, "Split authorize and capture.");

    await acknowledgeModificationChanges(
      projectPath,
      sent.snapshot,
      { kind: "module-guidance", moduleId: "api" }
    );
    const afterModule = await readModificationDelta(projectPath, "Split authorize and capture.");
    await acknowledgeModificationChanges(
      projectPath,
      sent.snapshot,
      { kind: "sequence" }
    );
    const afterSequence = await readModificationDelta(projectPath, "Split authorize and capture.");

    expect(afterModule.delta.modules.updated[0].changes).toEqual({ title: "Public API" });
    expect(afterModule.delta.sequenceInstruction).toBe("Split authorize and capture.");
    expect(afterSequence.delta.sequenceInstruction).toBeUndefined();
    expect(afterSequence.delta.modules.updated[0].changes).toEqual({ title: "Public API" });
  });

  it("uses the sent snapshot when acknowledging all changes", async () => {
    const projectPath = await createProject();
    await readModificationDelta(projectPath, "");
    await writeCanvas(projectPath, canvasFixture(projectPath, {
      guidanceDraft: "Sent guidance."
    }));
    const sent = await readModificationDelta(projectPath, "");
    await writeCanvas(projectPath, canvasFixture(projectPath, {
      guidanceDraft: "Edited while agent was running."
    }));

    await acknowledgeModificationChanges(projectPath, sent.snapshot, { kind: "all" });
    const pending = await readModificationDelta(projectPath, "");

    expect(pending.delta.modules.updated[0].changes).toEqual({
      guidanceDraft: "Edited while agent was running."
    });
  });

  it("preserves and reports an unreadable baseline", async () => {
    const projectPath = await createProject();
    await mkdir(join(projectPath, ".flowweave"), { recursive: true });
    await writeFile(baselinePath(projectPath), "{invalid", "utf8");

    await expect(readModificationDelta(projectPath, "")).rejects.toThrow("unreadable and was preserved");
    await expect(readFile(baselinePath(projectPath), "utf8")).resolves.toBe("{invalid");
  });

  it("absorbs newly generated modules on a new scan without clearing pending user edits", async () => {
    const projectPath = await createProject();
    await readModificationDelta(projectPath, "");
    const rescanned = canvasFixture(projectPath, {
      guidanceDraft: "Keep handlers thin."
    });
    rescanned.scanFingerprint = "scan-2";
    rescanned.nodes.push({
      ...rescanned.nodes[0],
      id: "generated-worker",
      title: "Generated Worker",
      guidanceDraft: ""
    });
    await writeCanvas(projectPath, rescanned);

    const result = await readModificationDelta(projectPath, "");

    expect(result.delta.modules.added).toEqual([]);
    expect(result.delta.modules.updated).toEqual([{
      id: "api",
      title: "API",
      changes: { guidanceDraft: "Keep handlers thin." }
    }]);
    expect(result.baseline.canvas.modules.map((module) => module.id)).toEqual(["api", "generated-worker"]);
  });

  it("does not absorb a manually added draft module when the scan fingerprint changes", async () => {
    const projectPath = await createProject();
    await readModificationDelta(projectPath, "");
    const rescanned = canvasFixture(projectPath);
    rescanned.scanFingerprint = "scan-2";
    rescanned.nodes.push({
      ...rescanned.nodes[0],
      id: "module-1",
      title: "Manual Module",
      status: "draft",
      guidanceDraft: "Implement the new boundary."
    });
    await writeCanvas(projectPath, rescanned);

    const result = await readModificationDelta(projectPath, "");

    expect(result.delta.modules.added.map((module) => module.id)).toEqual(["module-1"]);
  });
});

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-delta-"));
  await writeCanvas(projectPath, canvasFixture(projectPath));
  return projectPath;
}

async function writeCanvas(projectPath: string, canvas: CodeflowCanvas): Promise<void> {
  const path = join(projectPath, ".flowweave", "canvas", "main.canvas.json");
  await mkdir(join(projectPath, ".flowweave", "canvas"), { recursive: true });
  await writeFile(path, `${JSON.stringify(canvas, null, 2)}\n`, "utf8");
}

function baselinePath(projectPath: string): string {
  return join(projectPath, ".flowweave", "modification-baseline.json");
}

function canvasFixture(projectPath: string, patch: Partial<GraphNode> = {}): CodeflowCanvas {
  return {
    version: 3,
    id: "main",
    title: "Main Canvas",
    projectPath,
    generatedAt: "2026-06-25T00:00:00.000Z",
    scanFingerprint: "scan-1",
    artifactState: "current",
    nodes: [{
      id: "api",
      title: "API",
      subtitle: "API",
      kind: "module",
      nodeType: "api",
      risk: "medium",
      description: "API boundary",
      files: ["src/api.ts"],
      guidanceDraft: "",
      status: "mapped",
      x: 0,
      y: 0,
      ...patch
    }],
    edges: []
  };
}

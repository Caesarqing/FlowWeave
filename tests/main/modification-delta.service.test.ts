import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acknowledgeModificationChanges,
  readModificationDelta,
  prepareModificationBaseline
} from "../../src/main/services/modification-delta.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { buildSemanticIndex } from "../../src/main/services/semantic-index.service";
import { buildStaticArchitecture } from "../../src/main/services/static-architecture.service";
import { normalizeModificationSnapshot } from "../../src/utils/modification-delta";
import { writeModificationDocs } from "../../src/main/services/modification-doc.service";
import type { CodeflowCanvas, GraphNode } from "../../src/types";

describe("modification delta service", () => {
  it("reads a committed baseline without modifying it", async () => {
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

  it("rejects a persisted Canvas v3 and requires a project re-scan", async () => {
    const projectPath = await createProject();
    const legacyCanvas = { ...canvasFixture(projectPath), version: 3 };
    const path = join(projectPath, ".flowweave", "canvas", "main.canvas.json");
    await writeFile(path, `${JSON.stringify(legacyCanvas, null, 2)}\n`, "utf8");

    await expect(readModificationDelta(projectPath, "")).rejects.toThrow("must be v6. Re-scan the project");
  });

  it("remaps a legacy graph baseline while preserving pending guidance and its acknowledgement time", async () => {
    const projectPath = await createProject();
    await writeFile(baselinePath(projectPath), JSON.stringify({
      version: 1,
      acknowledgedAt: "2026-09-01T00:00:00.000Z",
      scanFingerprint: "scan-1",
      canvas: {
        modules: [{ id: "components", title: "Components", nodeType: "service", description: "", files: ["src/api.ts"], guidanceDraft: "" }],
        relations: []
      }
    }), "utf8");
    await writeCanvas(projectPath, canvasFixture(projectPath, { guidanceDraft: "Pending guidance." }));

    const migratedBaseline = await prepareModificationBaseline(projectPath, canvasFixture(projectPath, { guidanceDraft: "Pending guidance." }), canvasFixture(projectPath));
    await writeFile(baselinePath(projectPath), JSON.stringify(migratedBaseline));
    const result = await readModificationDelta(projectPath, "");
    const migrated = JSON.parse(await readFile(baselinePath(projectPath), "utf8"));

    expect(result.hasChanges).toBe(true);
    expect(result.delta.modules.updated[0].changes.guidanceDraft).toBe("Pending guidance.");
    expect(migrated.acknowledgedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(migrated.graphModelVersion).toBe(6);
    expect(migrated.canvas.modules.map((module: { id: string }) => module.id)).toEqual(["api"]);
  });

  it("rebases against a real generated architecture artifact without acknowledging pending edits", async () => {
    const projectPath = await createProject();
    await mkdir(join(projectPath, "src"), { recursive: true });
    await writeFile(join(projectPath, "src", "api.ts"), "export function handle() { return 1; }\n", "utf8");
    const project = await scanProject(projectPath);
    const { index } = await buildSemanticIndex(project);
    const generated = await buildStaticArchitecture(project, index);
    const generatedCanvas = { ...canvasFixture(projectPath), ...generated.graph, scanFingerprint: generated.scanFingerprint };
    const prior = normalizeModificationSnapshot({ ...generatedCanvas, nodes: generatedCanvas.nodes.map((node) => ({ ...node, id: "legacy", title: "Old generated title", guidanceDraft: "Already sent." })) }, "");
    await writeFile(baselinePath(projectPath), JSON.stringify({ version: 1, acknowledgedAt: "2026-09-01T00:00:00.000Z", ...prior }), "utf8");
    await writeFile(join(projectPath, ".flowweave", "architecture-local.json"), JSON.stringify(generated.architectureMap), "utf8");
    await writeCanvas(projectPath, { ...generatedCanvas, nodes: generatedCanvas.nodes.map((node) => ({ ...node, title: "My title", guidanceDraft: "Pending user guidance." })) });

    const currentCanvas = JSON.parse(await readFile(join(projectPath, ".flowweave/canvas/main.canvas.json"), "utf8")) as CodeflowCanvas;
    await writeFile(baselinePath(projectPath), JSON.stringify(await prepareModificationBaseline(projectPath, currentCanvas, generatedCanvas)));
    const result = await readModificationDelta(projectPath, "");

    expect(result.baseline.acknowledgedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(result.delta.modules.added).toEqual([]);
    expect(result.delta.modules.deleted).toEqual([]);
    expect(result.delta.modules.updated[0].changes).toMatchObject({ title: "My title", guidanceDraft: "Pending user guidance." });
    expect(result.baseline.canvas.modules[0].title).toBe(generated.graph.nodes[0].title);
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
    const generated = { ...rescanned, nodes: rescanned.nodes.filter((node) => node.status !== "draft").map((node) => ({ ...node, guidanceDraft: "" })) };
    await writeFile(baselinePath(projectPath), JSON.stringify(await prepareModificationBaseline(projectPath, rescanned, generated)));

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
    const generated = { ...rescanned, nodes: rescanned.nodes.filter((node) => node.status !== "draft").map((node) => ({ ...node, guidanceDraft: "" })) };
    await writeFile(baselinePath(projectPath), JSON.stringify(await prepareModificationBaseline(projectPath, rescanned, generated)));

    const result = await readModificationDelta(projectPath, "");

    expect(result.delta.modules.added.map((module) => module.id)).toEqual(["module-1"]);
  });
});

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-delta-"));
  await writeCanvas(projectPath, canvasFixture(projectPath));
  await writeFile(baselinePath(projectPath), JSON.stringify({ ...normalizeModificationSnapshot(canvasFixture(projectPath), ""), version: 1, graphModelVersion: 6, acknowledgedAt: "2026-09-01T00:00:00.000Z" }));
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
    version: 6,
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

it("keeps legacy v5 Canvas and confirmation bytes unchanged on read and rejects acknowledgement", async () => {
  const root = await createProject();
  const canvasPath = join(root, ".flowweave/canvas/main.canvas.json");
  const legacy = JSON.stringify({ ...canvasFixture(root), version: 5 });
  await writeFile(canvasPath, legacy);
  const baseline = await readFile(baselinePath(root), "utf8");
  const delta = await readModificationDelta(root, "pending");
  await expect(acknowledgeModificationChanges(root, delta.snapshot, { kind: "all" })).rejects.toThrow("Legacy Canvas is read-only");
  expect(await readFile(canvasPath, "utf8")).toBe(legacy);
  expect(await readFile(baselinePath(root), "utf8")).toBe(baseline);
});

it("does not initialize a baseline while reading legacy artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-modification-readonly-"));
  await writeCanvas(root, canvasFixture(root));
  await readModificationDelta(root, "pending");
  await expect(readFile(baselinePath(root), "utf8")).rejects.toHaveProperty("code", "ENOENT");
});

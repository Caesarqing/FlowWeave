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
import { migrateModificationBaseline, normalizeModificationSnapshot } from "../../src/utils/modification-delta";
import { writeModificationDocs } from "../../src/main/services/modification-doc.service";
import type { CodeflowCanvas, CodeflowProject, GraphNode } from "../../src/types";
import { readProjectProtocolCanvas, saveProjectProtocolCanvas } from "../../src/main/storage/flowweave-store";
import { writeProtocolFixture } from "./protocol.fixture";

describe("modification delta service", () => {
  it("does not remap acknowledged guidance across modules that only share one file", () => {
    const previous = {
      id: "old-api-user", title: "Edited API", nodeType: "service" as const, description: "API responsibility",
      files: ["src/api/user.ts", "src/shared.ts"], guidanceDraft: "Keep this with the API."
    };
    const current = {
      id: "storage-user", title: "Storage User", nodeType: "data" as const, description: "Storage responsibility",
      files: ["src/storage/user.ts", "src/shared.ts"], guidanceDraft: ""
    };
    const baseline = {
      version: 1 as const,
      graphModelVersion: 7,
      acknowledgedAt: "2026-09-01T00:00:00.000Z",
      canvas: { modules: [previous], relations: [] }
    };
    const snapshot = { canvas: { modules: [current], relations: [] } };

    const migrated = migrateModificationBaseline(baseline, snapshot, snapshot);

    expect(migrated.canvas.modules.map((module) => module.id)).toEqual(["old-api-user", "storage-user"]);
    expect(migrated.canvas.modules.find((module) => module.id === "old-api-user")?.guidanceDraft).toBe("Keep this with the API.");
  });

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
    expect(markdown).toContain(".flowweave/graph-overview.json");
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

  it("ignores a stale legacy Canvas mirror after protocol v7 is committed", async () => {
    const projectPath = await createProject();
    const legacyCanvas = { ...canvasFixture(projectPath), version: 3 };
    const path = join(projectPath, ".flowweave", "canvas", "main.canvas.json");
    await writeFile(path, `${JSON.stringify(legacyCanvas, null, 2)}\n`, "utf8");

    const result = await readModificationDelta(projectPath, "");
    expect(result.snapshot.canvas.modules.length).toBeGreaterThan(0);
    await expect(readFile(path, "utf8")).resolves.toContain('"version": 3');
  });

  it("remaps a legacy graph baseline while preserving pending guidance and its acknowledgement time", async () => {
    const projectPath = await createProject();
    const current = await requireCurrentCanvas(projectPath);
    await writeFile(baselinePath(projectPath), JSON.stringify({
      version: 1,
      generation: current.generation,
      acknowledgedAt: "2026-09-01T00:00:00.000Z",
      scanFingerprint: "scan-1",
      canvas: {
        modules: [{ id: "components", title: "Components", nodeType: "service", description: "", files: ["src/api.ts"], guidanceDraft: "" }],
        relations: []
      }
    }), "utf8");
    await writeCanvas(projectPath, canvasFixture(projectPath, { guidanceDraft: "Pending guidance." }));

    const currentWithPendingGuidance = await requireCurrentCanvas(projectPath);
    const generatedCanvas = { ...currentWithPendingGuidance, nodes: currentWithPendingGuidance.nodes.map((node) => ({ ...node, guidanceDraft: "" })) };
    const migratedBaseline = await prepareModificationBaseline(projectPath, currentWithPendingGuidance, generatedCanvas);
    await writeFile(baselinePath(projectPath), JSON.stringify(migratedBaseline));
    const result = await readModificationDelta(projectPath, "");
    const migrated = JSON.parse(await readFile(baselinePath(projectPath), "utf8"));

    expect(result.hasChanges).toBe(true);
    expect(result.delta.modules.updated[0].changes.guidanceDraft).toBe("Pending guidance.");
    expect(migrated.acknowledgedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(migrated.graphModelVersion).toBe(7);
    expect(migrated.canvas.modules.map((module: { id: string }) => module.id)).toEqual(["api"]);
  });

  it("rebases against a real generated architecture artifact without acknowledging pending edits", async () => {
    const projectPath = await createProject();
    const project = await scanProject(projectPath);
    const { index } = await buildSemanticIndex(project);
    const generated = await buildStaticArchitecture(project, index);
    const previousCanvas = await requireCurrentCanvas(projectPath);
    const generatedCanvas = {
      ...previousCanvas,
      ...generated.graph,
      scanFingerprint: generated.scanFingerprint,
      inputFingerprint: generated.inputFingerprint
    };
    const committedCanvas = await writeProtocolFixture(projectPath, {
      ...project,
      scanFingerprint: generated.scanFingerprint
    }, generatedCanvas);
    const prior = normalizeModificationSnapshot({ ...generatedCanvas, nodes: generatedCanvas.nodes.map((node) => ({ ...node, id: "legacy", title: "Old generated title", guidanceDraft: "Already sent." })) }, "");
    await writeFile(baselinePath(projectPath), JSON.stringify({
      version: 1,
      generation: committedCanvas.generation,
      acknowledgedAt: "2026-09-01T00:00:00.000Z",
      ...prior
    }), "utf8");
    await writeCanvas(projectPath, { ...generatedCanvas, nodes: generatedCanvas.nodes.map((node) => ({ ...node, title: "My title", guidanceDraft: "Pending user guidance." })) });

    const currentCanvas = await requireCurrentCanvas(projectPath);
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
    const previous = await requireCurrentCanvas(projectPath);
    const rescanned = {
      ...previous,
      scanFingerprint: "scan-2",
      nodes: previous.nodes.map((node) => ({
        ...node,
        guidanceDraft: "Keep handlers thin."
      }))
    };
    const generated = {
      ...rescanned,
      nodes: previous.nodes.map((node) => ({ ...node, guidanceDraft: "" }))
    };
    generated.nodes.push({
      ...generated.nodes[0],
      id: "generated-worker",
      title: "Generated Worker",
      guidanceDraft: ""
    });
    const userCanvas = {
      ...generated,
      nodes: generated.nodes.map((node) => node.id === previous.nodes[0].id
        ? { ...node, guidanceDraft: "Keep handlers thin." }
        : node)
    };
    const project = { ...projectFixture(projectPath), scanFingerprint: "scan-2" };
    await writeProtocolFixture(projectPath, project, generated, userCanvas);
    const current = await requireCurrentCanvas(projectPath);
    const migratedBaseline = await prepareModificationBaseline(projectPath, current, generated);
    await writeFile(baselinePath(projectPath), JSON.stringify(migratedBaseline));

    const result = await readModificationDelta(projectPath, "");

    expect(result.delta.modules.added).toEqual([]);
    expect(result.delta.modules.updated).toEqual([{
      id: previous.nodes[0].id,
      title: previous.nodes[0].title,
      changes: { guidanceDraft: "Keep handlers thin." }
    }]);
    expect(result.baseline.canvas.modules.map((module) => module.id)).toEqual([previous.nodes[0].id, "generated-worker"]);
  });

  it("does not absorb a manually added draft module when the scan fingerprint changes", async () => {
    const projectPath = await createProject();
    await readModificationDelta(projectPath, "");
    const previous = await requireCurrentCanvas(projectPath);
    const generated = {
      ...previous,
      scanFingerprint: "scan-2"
    };
    const userCanvas = {
      ...generated,
      nodes: [...generated.nodes, {
        ...generated.nodes[0],
        id: "module-1",
        title: "Manual Module",
        origin: "manual" as const,
        status: "draft" as const,
        guidanceDraft: "Implement the new boundary."
      }]
    };
    await writeProtocolFixture(projectPath, { ...projectFixture(projectPath), scanFingerprint: "scan-2" }, generated, userCanvas);
    const current = await requireCurrentCanvas(projectPath);
    const migratedBaseline = await prepareModificationBaseline(projectPath, current, generated);
    await writeFile(baselinePath(projectPath), JSON.stringify(migratedBaseline));

    const result = await readModificationDelta(projectPath, "");

    expect(result.delta.modules.added.map((module) => module.id)).toEqual(["module-1"]);
  });
});

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-delta-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "src", "api.ts"), "export function handle() { return 1; }\n", "utf8");
  const canvas = await writeProtocolFixture(projectPath, projectFixture(projectPath), canvasFixture(projectPath));
  await writeFile(baselinePath(projectPath), JSON.stringify({
    ...normalizeModificationSnapshot(canvas, ""),
    generation: canvas.generation,
    version: 1,
    graphModelVersion: 7,
    acknowledgedAt: "2026-09-01T00:00:00.000Z"
  }));
  return projectPath;
}

async function writeCanvas(projectPath: string, canvas: CodeflowCanvas): Promise<void> {
  const current = await requireCurrentCanvas(projectPath);
  const persisted = await saveProjectProtocolCanvas(projectPath, {
    ...canvas,
    generation: current.generation,
    inputFingerprint: current.inputFingerprint,
    scanFingerprint: current.scanFingerprint,
    userRevision: current.userRevision
  });
  if (!persisted) throw new Error(`Protocol v7 Canvas fixture is missing: ${projectPath}`);
}

async function requireCurrentCanvas(projectPath: string): Promise<CodeflowCanvas> {
  const canvas = await readProjectProtocolCanvas(projectPath);
  if (!canvas) throw new Error(`Protocol v7 Canvas fixture is missing: ${projectPath}`);
  return canvas;
}

function projectFixture(projectPath: string, scanFingerprint = "scan-1"): CodeflowProject {
  return {
    version: 1,
    projectName: "Modification Fixture",
    rootPath: projectPath,
    generatedAt: "2026-06-25T00:00:00.000Z",
    git: { isRepo: false, branch: "main" },
    summary: { totalFiles: 1, totalFolders: 1, languages: { TypeScript: 1 } },
    files: [],
    scanFingerprint
  };
}

function baselinePath(projectPath: string): string {
  return join(projectPath, ".flowweave", "modification-baseline.json");
}

function canvasFixture(projectPath: string, patch: Partial<GraphNode> = {}): CodeflowCanvas {
  return {
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

it("ignores an old Canvas mirror and acknowledges the v7 user state", async () => {
  const root = await createProject();
  const canvasPath = join(root, ".flowweave/canvas/main.canvas.json");
  const legacy = JSON.stringify({ ...canvasFixture(root), version: 5 });
  await writeFile(canvasPath, legacy);
  const baseline = await readFile(baselinePath(root), "utf8");
  const delta = await readModificationDelta(root, "pending");
  await acknowledgeModificationChanges(root, delta.snapshot, { kind: "all" });
  expect(await readFile(canvasPath, "utf8")).toBe(legacy);
  expect(await readFile(baselinePath(root), "utf8")).not.toBe(baseline);
});

it("requires protocol v7 without initializing a baseline for legacy-only artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-modification-readonly-"));
  await mkdir(join(root, ".flowweave", "canvas"), { recursive: true });
  await writeFile(join(root, ".flowweave", "canvas", "main.canvas.json"), JSON.stringify(canvasFixture(root)));
  await expect(readModificationDelta(root, "pending")).rejects.toThrow("protocol v7");
  await expect(readFile(baselinePath(root), "utf8")).rejects.toHaveProperty("code", "ENOENT");
});

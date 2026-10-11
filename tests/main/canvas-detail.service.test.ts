import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasDetailGenerationChangedError, CanvasDetailRevisionChangedError, readCanvasEdgeDetail, readCanvasNodeDetail, readGeneratedCanvasGraph } from "../../src/main/services/canvas-detail.service";
import { readProjectProtocolCanvas, saveProjectProtocolCanvas } from "../../src/main/storage/flowweave-store";
import type { ArchitectureMap, CodeflowCanvas, CodeflowProject, StaticSnapshotV1 } from "../../src/types";
import { writeArchitectureProtocolFixture, writeEmptyProtocolFixture } from "./protocol.fixture";
import { withArchitectureArtifactLock } from "../../src/main/services/architecture-review.service";
import { performance } from "node:perf_hooks";

const protocolSnapshotReader = vi.hoisted(() => vi.fn());
vi.mock("../../src/main/storage/flowweave-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/storage/flowweave-store")>();
  protocolSnapshotReader.mockImplementation(actual.readProjectProtocolSnapshot);
  return { ...actual, readProjectProtocolSnapshot: protocolSnapshotReader };
});

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canvas detail", () => {
  it("skips internal timing probes when the optional detail measurement callback is absent", async () => {
    const root = await createDetailProject("flowweave-detail-uninstrumented-");
    const canvas = await writeEmptyProtocolFixture(root, "detail-uninstrumented");
    const generationId = canvas.generation?.requestId;
    if (!generationId) throw new Error("Fixture generation is missing");
    const originalNow = performance.now.bind(performance);
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(originalNow);

    try {
      const response = await readCanvasNodeDetail(root, generationId, 0, "missing-node");
      expect(response).toMatchObject({ generationId, userRevision: 0, nodeId: "missing-node" });
      expect(nowSpy).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("separates snapshot file verification, parsing and indexing while warm reads skip all three", async () => {
    const root = await createDetailProject("flowweave-detail-stages-");
    const canvas = await writeEmptyProtocolFixture(root, "detail-stages");
    const generationId = canvas.generation?.requestId;
    if (!generationId) throw new Error("Fixture generation is missing");
    const cold: Array<{ metric: string; durationMs: number; outcome: string }> = [];
    const warm: typeof cold = [];

    await readCanvasNodeDetail(root, generationId, 0, "missing-node", (metric, durationMs, outcome) => {
      cold.push({ metric, durationMs, outcome });
    });
    await readCanvasNodeDetail(root, generationId, 0, "missing-node", (metric, durationMs, outcome) => {
      warm.push({ metric, durationMs, outcome });
    });

    expect(cold.map(({ metric }) => metric)).toEqual([
      "lockWaitMs", "snapshotReadMs", "snapshotParseMs", "snapshotValidationMs", "detailIndexMs", "lockWaitMs"
    ]);
    expect(cold.every(({ durationMs, outcome }) => Number.isFinite(durationMs) && durationMs >= 0 && outcome === "completed")).toBe(true);
    expect(warm.map(({ metric }) => metric)).toEqual(["lockWaitMs"]);

    await writeFile(join(root, ".flowweave", "static-snapshot.json"), "corrupt", "utf8");
    const failed: typeof cold = [];
    await expect(readCanvasNodeDetail(root, generationId, 0, "missing-node", (metric, durationMs, outcome) => {
      failed.push({ metric, durationMs, outcome });
    })).rejects.toThrow("hash mismatch");
    expect(failed).toEqual([
      { metric: "lockWaitMs", durationMs: expect.any(Number), outcome: "completed" },
      { metric: "snapshotReadMs", durationMs: expect.any(Number), outcome: "failed" }
    ]);
  });

  it("shares one verified snapshot read among concurrent cold detail requests", async () => {
    const root = await createDetailProject("flowweave-detail-concurrent-");
    const canvas = await writeDetailProtocolFixture(root, "concurrent-scan", "serve");
    const generationId = canvas.generation?.requestId;
    if (!generationId) throw new Error("Fixture generation is missing");

    const pausedRead = await pauseSnapshotRead(root);
    const stages: string[] = [];
    const onMeasurement = (metric: string) => { stages.push(metric); };
    try {
      const nodes = Array.from({ length: 4 }, () => readCanvasNodeDetail(root, generationId, 0, "api", onMeasurement));
      const edges = Array.from({ length: 4 }, () => readCanvasEdgeDetail(root, generationId, 0, "call", onMeasurement));
      await pausedRead.started;
      await vi.waitFor(() => expect(stages.filter((metric) => metric === "lockWaitMs")).toHaveLength(8));
      pausedRead.release();
      expect((await Promise.all(nodes)).every((response) => response.detail?.symbols?.[0]?.name === "serve")).toBe(true);
      expect((await Promise.all(edges)).every((response) => response.detail?.evidence?.[0]?.detail === "Calls the API")).toBe(true);
      for (const metric of ["snapshotReadMs", "snapshotParseMs", "snapshotValidationMs", "detailIndexMs"]) {
        expect(stages.filter((stage) => stage === metric)).toHaveLength(1);
      }
    } finally {
      pausedRead.release();
      pausedRead.restore();
    }
  });

  it("keeps project details separate when generation and target IDs match", async () => {
    const firstRoot = await createDetailProject("flowweave-detail-isolation-");
    const secondRoot = await createDetailProject("flowweave-detail-isolation-");
    const first = await writeDetailProtocolFixture(firstRoot, "same-input", "firstProjectSymbol");
    const second = await writeDetailProtocolFixture(secondRoot, "same-input", "secondProjectSymbol");
    const generationId = first.generation?.requestId;
    if (!generationId) throw new Error("Fixture generation is missing");
    expect(second.generation?.requestId).toBe(generationId);

    for (const [projectPath, expectedSymbol] of [
      [firstRoot, "firstProjectSymbol"], [secondRoot, "secondProjectSymbol"], [firstRoot, "firstProjectSymbol"]
    ]) {
      expect((await readCanvasNodeDetail(projectPath, generationId, 0, "api")).detail?.symbols).toEqual([
        { name: expectedSymbol, kind: "function", filePath: "src/api.ts" }
      ]);
    }
  });

  it("rejects a cold response whose generation was replaced while the snapshot was loading", async () => {
    const root = await createDetailProject("flowweave-detail-generation-race-");
    const oldCanvas = await writeDetailProtocolFixture(root, "old-input", "oldSymbol");
    const generationId = oldCanvas.generation?.requestId;
    if (!generationId) throw new Error("Fixture generation is missing");
    const pausedRead = await pauseSnapshotRead(root);
    const oldResponse = readCanvasNodeDetail(root, generationId, 0, "api");
    const rejected = expect(oldResponse).rejects.toThrow("snapshot changed while reading");
    try {
      await pausedRead.started;
      const currentCanvas = await withArchitectureArtifactLock(root, () =>
        writeDetailProtocolFixture(root, "new-input", "newSymbol"));
      const currentGeneration = currentCanvas.generation?.requestId;
      if (!currentGeneration) throw new Error("Replacement fixture generation is missing");
      expect((await readCanvasNodeDetail(root, currentGeneration, 0, "api")).detail?.symbols?.[0]?.name).toBe("newSymbol");
      pausedRead.release();
      await rejected;
      expect((await readCanvasNodeDetail(root, currentGeneration, 0, "api")).detail?.symbols?.[0]?.name).toBe("newSymbol");
      await expect(readCanvasNodeDetail(root, generationId, 0, "api")).rejects.toBeInstanceOf(CanvasDetailGenerationChangedError);
    } finally {
      pausedRead.release();
      pausedRead.restore();
    }
  });

  it("rejects a cold response after a save and reads the latest revision from the warmed snapshot", async () => {
    const root = await createDetailProject("flowweave-detail-revision-race-");
    const canvas = await writeDetailProtocolFixture(root, "revision-input", "serve");
    const generationId = canvas.generation?.requestId;
    if (!generationId) throw new Error("Fixture generation is missing");
    const pausedRead = await pauseSnapshotRead(root);
    const oldResponse = readCanvasNodeDetail(root, generationId, 0, "api");
    const rejected = expect(oldResponse).rejects.toBeInstanceOf(CanvasDetailRevisionChangedError);
    try {
      await pausedRead.started;
      await withArchitectureArtifactLock(root, () => saveProjectProtocolCanvas(root, { ...canvas,
        nodes: canvas.nodes.map((node) => ({ ...node, files: [] })),
        edges: canvas.edges.map((edge) => ({ ...edge, relation: "uses" }))
      }));
      pausedRead.release();
      await rejected;
      const warmStages: string[] = [];
      expect((await readCanvasNodeDetail(root, generationId, 1, "api", (metric) => warmStages.push(metric))).detail?.symbols).toEqual([]);
      expect(await readCanvasEdgeDetail(root, generationId, 1, "call")).toMatchObject({
        userRevision: 1, detail: { relation: "uses", confidence: "inferred", evidence: [], semanticKinds: [], operations: [] }
      });
      expect(warmStages).toEqual(["lockWaitMs"]);
      await expect(readCanvasEdgeDetail(root, generationId, 0, "call")).rejects.toBeInstanceOf(CanvasDetailRevisionChangedError);
    } finally {
      pausedRead.release();
      pausedRead.restore();
    }
  });

  it("evicts the least-recently-used project when retained detail-index bytes exceed the shared budget", async () => {
    const roots = await Promise.all(["first", "second", "third"].map(() => createDetailProject("flowweave-detail-budget-")));
    const canvases = await Promise.all(roots.map((root, index) => writeEmptyProtocolFixture(root, `budget-scan-${index}`)));
    const generationIds = canvases.map((canvas) => canvas.generation?.requestId);
    if (generationIds.some((generationId) => !generationId)) throw new Error("Fixture generation is missing");

    const retainedBytes = 43 * 1024 * 1024;
    for (const root of roots) {
      const snapshotPath = join(root, ".flowweave", "static-snapshot.json");
      const manifestPath = join(root, ".flowweave", "generation.json");
      const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as StaticSnapshotV1;
      const paddedSnapshot = JSON.stringify({ ...snapshot, localArchitecture: { ...snapshot.localArchitecture,
        resources: [{ id: "large-detail", kind: "package", scopeId: "typescript:.", key: "fixture", title: "Fixture",
          detail: "x".repeat(retainedBytes), evidence: [] }] } });
      await writeFile(snapshotPath, paddedSnapshot, "utf8");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        artifacts: { staticSnapshot: string; [artifact: string]: string };
        [key: string]: unknown;
      };
      manifest.artifacts.staticSnapshot = createHash("sha256").update(paddedSnapshot).digest("hex");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }

    const parseCounts = [0, 0, 0];
    // The cache retains these resources; unrelated snapshot data is not part of its byte budget.
    for (const index of [0, 1, 0, 2, 0, 1]) {
      await readCanvasNodeDetail(roots[index], generationIds[index]!, 0, "missing-node", (metric) => {
        if (metric === "snapshotParseMs") parseCounts[index] += 1;
      });
    }
    expect(parseCounts).toEqual([1, 2, 1]);
  }, 30_000);

  it("does not cache a slow load after more than sixteen other projects become active", async () => {
    const roots = await Promise.all(Array.from({ length: 17 }, () => createDetailProject("flowweave-detail-project-window-")));
    const canvases = await Promise.all(roots.map((root, index) => writeEmptyProtocolFixture(root, `window-scan-${index}`)));
    const generationIds = canvases.map((canvas) => canvas.generation?.requestId);
    if (generationIds.some((generationId) => !generationId)) throw new Error("Fixture generation is missing");
    const canonicalRoots = await Promise.all(roots.map((root) => realpath(root)));
    const readSnapshot = protocolSnapshotReader.getMockImplementation();
    if (!readSnapshot) throw new Error("Protocol snapshot reader implementation is missing");

    let markFirstReadStarted: (() => void) | undefined;
    let releaseFirstRead: (() => void) | undefined;
    const firstReadStarted = new Promise<void>((resolve) => { markFirstReadStarted = resolve; });
    const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    let firstReadCount = 0;
    protocolSnapshotReader.mockImplementation(async (projectPath) => {
      if (projectPath === canonicalRoots[0]) {
        firstReadCount += 1;
        if (firstReadCount === 1) {
          markFirstReadStarted?.();
          await firstReadGate;
        }
      }
      return readSnapshot(projectPath);
    });

    try {
      const firstProjectRead = readCanvasNodeDetail(roots[0], generationIds[0]!, 0, "missing-node");
      await firstReadStarted;
      await Promise.all(roots.slice(1).map((root, index) =>
        readCanvasNodeDetail(root, generationIds[index + 1]!, 0, "missing-node")));
      releaseFirstRead?.();
      await firstProjectRead;
      await readCanvasNodeDetail(roots[0], generationIds[0]!, 0, "missing-node");

      expect(firstReadCount).toBe(2);
    } finally {
      releaseFirstRead?.();
      protocolSnapshotReader.mockImplementation(readSnapshot);
    }
  });

  it("shows facts for a file reassigned to another generated module", async () => {
    const root = await createDetailProject("flowweave-detail-reassigned-");
    const generatedAt = "2026-10-03T00:00:00.000Z";
    const project: CodeflowProject = { version: 2, projectName: "Fixture", rootPath: root, generatedAt,
      git: { isRepo: false }, summary: { totalFiles: 2, totalFolders: 0, languages: {} }, files: [], scanFingerprint: "scan" };
    const nodes = ["api", "data"].map((id) => ({ id, title: id, subtitle: "", kind: "module" as const,
      nodeType: "module" as const, risk: "unknown" as const, description: id, files: [`src/${id}.ts`],
      guidanceDraft: "", status: "mapped" as const, x: 0, y: 0, origin: "generated" as const }));
    const canvas: CodeflowCanvas = { id: "main", title: "Main", projectPath: root, generatedAt,
      scanFingerprint: "scan", nodes, edges: [] };
    const architecture: ArchitectureMap = { version: 3, source: "local", generatedAt,
      modules: nodes.map((node) => ({ id: node.id, title: node.title, category: "service" as const,
        nodeType: "module" as const, role: node.title, description: node.title, files: node.files,
        fileRoles: [{ path: node.files[0], role: `${node.id} role` }],
        symbols: [{ name: `${node.id}Symbol`, kind: "function" as const, filePath: node.files[0] }],
        evidence: [{ filePath: node.files[0], detail: `${node.id} evidence` }], risk: "high" as const,
        relationDiagnostics: [{ code: `${node.id}-unresolved`, severity: "warning" as const,
          message: `${node.id} target unresolved`, filePath: node.files[0] }],
        assessment: { version: 1 as const, generatorVersion: "test", confidence: { score: 90, level: "high" as const, factors: [] },
          risk: { systemScore: 90, systemLevel: "high" as const, effectiveLevel: "high" as const, factors: [] },
          fingerprint: "scan", assessedAt: generatedAt } })),
      relationships: [] };
    const written = await writeArchitectureProtocolFixture(root, project, canvas, architecture);
    const generationId = written.canvas.generation?.requestId;
    if (!generationId) throw new Error("Fixture generation is missing");
    await saveProjectProtocolCanvas(root, { ...written.canvas,
      nodes: written.canvas.nodes.map((node) => node.id === "api" ? { ...node, files: [] } : { ...node, files: ["src/data.ts", "src/api.ts"] })
    });

    expect(await readCanvasNodeDetail(root, generationId, 1, "data")).toMatchObject({ detail: {
      symbols: [{ name: "apiSymbol" }, { name: "dataSymbol" }],
      fileRoles: [{ path: "src/api.ts" }, { path: "src/data.ts" }],
      relationDiagnostics: [{ filePath: "src/api.ts" }, { filePath: "src/data.ts" }],
      assessment: { confidence: { level: "unknown" }, risk: { systemLevel: "unknown" } }
    } });
    expect((await readCanvasNodeDetail(root, generationId, 1, "api")).detail?.relationDiagnostics).toEqual([]);
    await expect(readCanvasNodeDetail(root, generationId, 0, "data")).rejects.toThrow("revision changed");
    expect((await readProjectProtocolCanvas(root))?.nodes.find((node) => node.id === "data")?.risk).toBe("unknown");
  });
  it("loads module and relation evidence from the matching committed generation", async () => {
    const root = await createDetailProject("flowweave-detail-");
    const generatedAt = "2026-10-03T00:00:00.000Z";
    const project: CodeflowProject = { version: 2, projectName: "Fixture", rootPath: root, generatedAt,
      git: { isRepo: false }, summary: { totalFiles: 1, totalFolders: 0, languages: {} }, files: [], scanFingerprint: "scan" };
    const canvas: CodeflowCanvas = { id: "main", title: "Main", projectPath: root, generatedAt, scanFingerprint: "scan",
      nodes: [{ id: "api", title: "API", subtitle: "", kind: "module", nodeType: "api", risk: "unknown", description: "API",
        files: ["src/api.ts"], guidanceDraft: "", status: "mapped", x: 0, y: 0, origin: "generated" }],
      edges: [{ id: "call", source: "api", target: "api", relation: "calls", confidence: "confirmed", origin: "generated" }] };
    const architecture: ArchitectureMap = { version: 3, source: "local", generatedAt, modules: [{
      id: "api", title: "API", category: "api-boundary", nodeType: "api", role: "API", description: "API", files: ["src/api.ts"],
      fileRoles: [{ path: "src/api.ts", role: "entry" }], symbols: [{ name: "serve", kind: "function", filePath: "src/api.ts" }],
      evidence: [{ filePath: "src/api.ts", line: 2, detail: "Route entry" }], risk: "medium",
      assessment: { version: 1, generatorVersion: "test", confidence: { score: 60, level: "medium", factors: [] },
        risk: { systemScore: 50, systemLevel: "medium", effectiveLevel: "medium", factors: [] },
        fingerprint: "scan", assessedAt: generatedAt }
    }], relationships: [{ id: "call", source: "api", target: "api", relation: "calls", confidence: "confirmed", description: "Call",
      evidence: [{ filePath: "src/api.ts", line: 7, detail: "Invokes serve" }] }] };
    const written = await writeArchitectureProtocolFixture(root, project, canvas, architecture);
    const generationId = written.canvas.generation?.requestId;
    if (!generationId) throw new Error("Fixture generation is missing");

    const concurrent = await Promise.all(Array.from({ length: 10 }, () => readCanvasNodeDetail(root, generationId, 0, "api")));
    expect(concurrent.every((response) => response.generationId === generationId && response.userRevision === 0 &&
      response.detail?.symbols?.[0]?.name === "serve")).toBe(true);
    expect(await readCanvasNodeDetail(root, generationId, 0, "api")).toMatchObject({ detail: {
      symbols: [{ name: "serve" }], fileRoles: [{ path: "src/api.ts" }], evidence: [{ line: 2 }]
    } });
    expect(await readCanvasEdgeDetail(root, generationId, 0, "call")).toMatchObject({ detail: { evidence: [{ filePath: "src/api.ts", line: 7 }] } });
    await saveProjectProtocolCanvas(root, { ...written.canvas,
      nodes: written.canvas.nodes.map((node) => ({ ...node, risk: "low", assessment: {
        version: 1, generatorVersion: "old", confidence: { score: 95, level: "high", factors: [] },
        risk: { systemScore: 90, systemLevel: "high", effectiveLevel: "low", factors: [],
          override: { level: "low", reason: "Reviewed", createdAt: generatedAt } }, fingerprint: "old", assessedAt: generatedAt
      } }))
    });
    expect(await readCanvasNodeDetail(root, generationId, 1, "api")).toMatchObject({ detail: { assessment: {
      risk: { systemLevel: "medium", effectiveLevel: "low", previousSystemLevel: "high", systemLevelChanged: true,
        override: { reason: "Reviewed" } }
    } } });
    const current = await readProjectProtocolCanvas(root);
    if (!current) throw new Error("Saved Canvas is missing");
    await saveProjectProtocolCanvas(root, { ...current,
      nodes: current.nodes.map((node) => ({ ...node, files: [] })), edges: []
    });
    expect(await readCanvasNodeDetail(root, generationId, 2, "api")).toMatchObject({ detail: { symbols: [], fileRoles: [], evidence: [],
      assessment: { risk: { systemLevel: "unknown", effectiveLevel: "low" } } } });
    expect(await readGeneratedCanvasGraph(root, generationId)).toMatchObject({
      nodes: [{ id: "api", files: ["src/api.ts"] }], edges: [{ id: "call" }]
    });
    await expect(readCanvasNodeDetail(root, "stale-generation", 2, "api")).rejects.toThrow("generation changed");
    await expect(readGeneratedCanvasGraph(root, "stale-generation")).rejects.toThrow("generation changed");
    await writeFile(join(root, ".flowweave", "static-snapshot.json"), "corrupted snapshot", "utf8");
    await expect(readCanvasNodeDetail(root, generationId, 2, "api")).rejects.toThrow("hash mismatch");
  });
});

async function createDetailProject(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function writeDetailProtocolFixture(projectPath: string, scanFingerprint: string, symbolName: string): Promise<CodeflowCanvas> {
  const generatedAt = "2026-10-03T00:00:00.000Z";
  const project: CodeflowProject = { version: 2, projectName: "Detail fixture", rootPath: projectPath, generatedAt,
    git: { isRepo: false }, summary: { totalFiles: 1, totalFolders: 1, languages: { TypeScript: 1 } }, files: [], scanFingerprint };
  const canvas: CodeflowCanvas = { id: "main", title: "Detail fixture", projectPath, generatedAt, scanFingerprint,
    nodes: [{ id: "api", title: "API", subtitle: "", kind: "module", nodeType: "api", risk: "unknown", description: "API",
      files: ["src/api.ts"], guidanceDraft: "", status: "mapped", x: 0, y: 0, origin: "generated" }],
    edges: [{ id: "call", source: "api", target: "api", relation: "calls", confidence: "confirmed", origin: "generated" }] };
  const architecture: ArchitectureMap = { version: 3, source: "local", generatedAt,
    modules: [{ id: "api", title: "API", category: "api-boundary", nodeType: "api", role: "API", description: "API",
      files: ["src/api.ts"], symbols: [{ name: symbolName, kind: "function", filePath: "src/api.ts" }],
      risk: "unknown", fileRoles: [] }],
    relationships: [{ id: "call", source: "api", target: "api", relation: "calls", confidence: "confirmed",
      description: "Call", evidence: [{ filePath: "src/api.ts", line: 1, detail: "Calls the API" }] }] };
  return (await writeArchitectureProtocolFixture(projectPath, project, canvas, architecture)).canvas;
}

async function pauseSnapshotRead(projectPath: string): Promise<{ started: Promise<void>; release: () => void; restore: () => void }> {
  const canonicalRoot = await realpath(projectPath);
  const readSnapshot = protocolSnapshotReader.getMockImplementation();
  if (!readSnapshot) throw new Error("Protocol snapshot reader implementation is missing");
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let pending = true;
  protocolSnapshotReader.mockImplementation(async (root, onMeasurement) => {
    if (root !== canonicalRoot || !pending) return readSnapshot(root, onMeasurement);
    pending = false;
    const snapshot = await readSnapshot(root, onMeasurement);
    markStarted();
    await gate;
    return snapshot;
  });
  return { started, release, restore: () => protocolSnapshotReader.mockImplementation(readSnapshot) };
}

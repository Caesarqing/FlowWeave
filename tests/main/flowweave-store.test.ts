import fsPromises, { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertCanvasCanStartGeneration, prepareFlowWeaveProject, readCanvasForGeneration, readProjectProtocolCanvas, readProjectProtocolSnapshot, recordCanvasMigrationFailure, saveProjectProtocolCanvas, writeBatchAtomic } from "../../src/main/storage/flowweave-store";
import { generateProject, generateRegisteredProject, registerGenerationRequest } from "../../src/main/services/project-generation.service";
import { readArchitectureReviewStatus } from "../../src/main/services/architecture-review.service";
import { readSequenceReviewStatus } from "../../src/main/services/sequence-review.service";
import type { ArchitectureReviewStatus, CodeflowCanvas, SequenceReviewStatus } from "../../src/types";
import { writeCanvasProtocolFixture } from "./protocol.fixture";

describe("flowweave-store", () => {
  it("retains generated module membership and corrected relation after saving and reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-corrections-"));
    const canvas = await writeCanvasProtocolFixture(root, correctionCanvas(root));
    const changed = {
      ...canvas,
      nodes: canvas.nodes.map((node) => node.id === "api" ? { ...node, files: ["src/data.ts"] } : { ...node, files: [] }),
      edges: canvas.edges.map((edge) => ({ ...edge, source: "data", target: "api", relation: "imports" as const }))
    };

    await saveProjectProtocolCanvas(root, changed);
    const reopened = await readProjectProtocolCanvas(root);
    expect(reopened?.nodes.find((node) => node.id === "api")?.files).toEqual(["src/data.ts"]);
    expect(reopened?.edges.find((edge) => edge.id === "api-data")).toMatchObject({ source: "data", target: "api", relation: "imports" });
  });

  it("preserves handle topology fingerprints when normalizing a legacy Canvas layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-handle-fingerprint-"));
    const canvasDir = join(root, ".flowweave", "canvas");
    await mkdir(canvasDir, { recursive: true });
    await writeFile(join(canvasDir, "main.canvas.json"), JSON.stringify({
      version: 4,
      nodes: [{ id: "api" }],
      edges: [],
      layout: {
        autoConnectionHandles: {
          execution: {
            positions: { api: { x: 10, y: 20 } },
            handles: { api: { source: [], target: [] } },
            topologyFingerprint: "handle-topology-fixture"
          }
        }
      }
    }), "utf8");

    const reopened = await readCanvasForGeneration(root);

    expect(reopened?.layout?.autoConnectionHandles?.execution?.topologyFingerprint).toBe("handle-topology-fixture");
  });

  it("retains ELK handle topology fingerprints through protocol save and reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-protocol-handle-fingerprint-"));
    const handleLayout = {
      positions: { api: { x: 10, y: 20 }, data: { x: 300, y: 20 } },
      handles: { api: { source: [{ id: "api-source-edge", edgeId: "api-data", position: "right" as const, offsetPercent: 50, count: 1 }], target: [] } },
      topologyFingerprint: "handle-topology-fixture"
    };
    const canvas = {
      ...correctionCanvas(root),
      layout: {
        activeMode: "execution" as const,
        viewMode: "execution" as const,
        manualPositions: handleLayout.positions,
        autoLayouts: { execution: handleLayout.positions },
        autoConnectionHandles: { execution: handleLayout },
        collapsedGroups: []
      }
    };
    await writeCanvasProtocolFixture(root, canvas);

    const opened = await readProjectProtocolCanvas(root);
    if (!opened) throw new Error("Expected protocol Canvas to reopen");
    await saveProjectProtocolCanvas(root, opened);
    const reopened = await readProjectProtocolCanvas(root);

    expect(reopened?.layout?.autoConnectionHandles?.execution?.topologyFingerprint).toBe("handle-topology-fixture");
  });

  it("keeps deleted generated nodes and relations absent after reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-deletions-"));
    const canvas = await writeCanvasProtocolFixture(root, correctionCanvas(root));
    await saveProjectProtocolCanvas(root, { ...canvas, nodes: canvas.nodes.filter((node) => node.id !== "api"), edges: [] });

    const reopened = await readProjectProtocolCanvas(root);
    expect(reopened?.nodes.map((node) => node.id)).toEqual(["data"]);
    expect(reopened?.edges).toEqual([]);
  });
  it("retains a redirected generated relation after deleting its original source", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-redirect-delete-"));
    const generated = correctionCanvas(root);
    const canvas = await writeCanvasProtocolFixture(root, { ...generated,
      nodes: [...generated.nodes, { ...generated.nodes[0], id: "worker", title: "worker", files: ["src/worker.ts"] }]
    });
    await saveProjectProtocolCanvas(root, { ...canvas,
      nodes: canvas.nodes.filter((node) => node.id !== "api"),
      edges: canvas.edges.map((edge) => ({ ...edge, source: "data", target: "worker", relation: "imports" }))
    });
    const reopened = await readProjectProtocolCanvas(root);
    expect(reopened?.edges).toMatchObject([{ id: "api-data", source: "data", target: "worker", relation: "imports" }]);
  });
  it("rejects a corrected relation whose endpoint is absent without changing saved state", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-invalid-endpoint-"));
    const canvas = await writeCanvasProtocolFixture(root, correctionCanvas(root));
    await expect(saveProjectProtocolCanvas(root, { ...canvas,
      edges: [{ ...canvas.edges[0], target: "missing", relation: "imports" }]
    })).rejects.toThrow("missing endpoint");
    expect((await readProjectProtocolCanvas(root))?.edges[0].target).toBe("data");
  });
  it("rejects an unknown file and duplicate generated file ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-invalid-membership-"));
    const canvas = await writeCanvasProtocolFixture(root, correctionCanvas(root));
    await expect(saveProjectProtocolCanvas(root, { ...canvas,
      nodes: canvas.nodes.map((node) => node.id === "api" ? { ...node, files: ["src/missing.ts"] } : node)
    })).rejects.toThrow("unknown source file");
    await expect(saveProjectProtocolCanvas(root, { ...canvas,
      nodes: canvas.nodes.map((node) => node.id === "api" ? { ...node, files: ["src/data.ts"] } : node)
    })).rejects.toThrow("multiple generated modules");
    expect((await readProjectProtocolCanvas(root))?.nodes.find((node) => node.id === "api")?.files).toEqual(["src/api.ts"]);
  });
  it("rejects duplicate node and relation IDs before changing user state", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-duplicate-ids-"));
    const canvas = await writeCanvasProtocolFixture(root, correctionCanvas(root));
    await expect(saveProjectProtocolCanvas(root, { ...canvas,
      nodes: [...canvas.nodes, { ...canvas.nodes[0], origin: "manual" }]
    })).rejects.toThrow("duplicate node ID");
    await expect(saveProjectProtocolCanvas(root, { ...canvas,
      edges: [...canvas.edges, { ...canvas.edges[0], origin: "manual" }]
    })).rejects.toThrow("duplicate relation ID");
    expect((await readProjectProtocolCanvas(root))?.userRevision).toBe(0);
  });
  it("preserves the entire old batch when an artifact target is a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-invalid-batch-"));
    await mkdir(join(root, ".flowweave"));
    const artifact = join(root, ".flowweave", "valid.json");
    const directory = join(root, ".flowweave", "invalid.json");
    await writeFile(artifact, "old valid artifact", "utf8");
    await mkdir(directory);
    await writeFile(join(directory, "user-data.txt"), "retained user data", "utf8");

    await expect(writeBatchAtomic(root, [
      { path: artifact, content: "new artifact" },
      { path: directory, content: "invalid replacement" }
    ])).rejects.toThrow("not a regular file");
    expect(await readFile(artifact, "utf8")).toBe("old valid artifact");
    expect(await readFile(join(directory, "user-data.txt"), "utf8")).toBe("retained user data");
    expect((await readdir(join(root, ".flowweave"))).sort()).toEqual(["invalid.json", "valid.json"]);
  });

  it("does not generate task or file-tree artifacts during the static commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-"));
    await writeFile(join(root, "main.py"), "def main():\n    return 1\n", "utf8");
    const result = await generateProject(root, {});
    expect(result.status).toBe("committed");
    await expect(readdir(join(root, ".flowweave", "tasks"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(readFile(join(root, ".flowweave", "context", "file-tree.md"), "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });

  it.each([1, 2, 3, 4])("archives and migrates Canvas v%s before publishing a new graph", async (version) => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-canvas-v" + version + "-"));
    const canvasPath = join(root, ".flowweave", "canvas", "main.canvas.json");
    await mkdir(join(root, ".flowweave", "canvas"), { recursive: true });
    const legacyCanvas = JSON.stringify({
      version,
      id: "legacy-v" + version,
      nodes: [{ id: "legacy-note", title: "Keep this edit", customField: "preserve" }],
      edges: [{ id: "legacy-edge", source: "legacy-note", target: "gone", description: "Keep this relation" }],
      layout: { manualPositions: { "legacy-note": { x: 1, y: 2 } }, collapsedGroups: ["legacy-area"] }
    });
    await writeFile(canvasPath, legacyCanvas, "utf8");

    await writeFile(join(root, "main.py"), "def main():\n    return 1\n", "utf8");
    const result = await generateProject(root, {});
    if (result.status !== "committed") throw new Error("Expected migrated project generation.");

    const migratedCanvas = await readProjectProtocolCanvas(root);
    expect(migratedCanvas).not.toHaveProperty("version");
    expect(migratedCanvas?.migrationPendingItems).toEqual([
      { kind: "node", sourceVersion: version, sourceId: "legacy-note", raw: { id: "legacy-note", title: "Keep this edit", customField: "preserve" }, reason: "Canvas versions 1–4 do not identify generated and user-created nodes." },
      { kind: "edge", sourceVersion: version, sourceId: "legacy-edge", raw: { id: "legacy-edge", source: "legacy-note", target: "gone", description: "Keep this relation" }, reason: "Canvas versions 1–4 do not identify generated and user-created edges." }
    ]);
    const record = JSON.parse(await readFile(join(root, ".flowweave", "migration", "record.json"), "utf8")) as { status: string; pendingItemCount: number; backupPath: string };
    expect(record).toMatchObject({ status: "complete", pendingItemCount: 2 });
    expect(await readFile(join(root, record.backupPath, "artifacts", "canvas", "main.canvas.json"), "utf8")).toBe(legacyCanvas);
    await expect(readFile(canvasPath, "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });

  it("archives review sidecars byte-for-byte and exposes their old generation as stale after migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-review-sidecars-"));
    const flowweavePath = join(root, ".flowweave");
    const canvasPath = join(flowweavePath, "canvas", "main.canvas.json");
    const architectureReviewPath = join(flowweavePath, "architecture-review.json");
    const sequenceReviewPath = join(flowweavePath, "sequence-review.json");
    await mkdir(join(flowweavePath, "canvas"), { recursive: true });
    await writeFile(canvasPath, JSON.stringify({ version: 4, nodes: [{ id: "legacy" }], edges: [] }), "utf8");
    const architectureReview: ArchitectureReviewStatus = {
      state: "reviewed",
      reviewId: "legacy-architecture-review",
      scanFingerprint: "legacy-scan",
      inputFingerprint: "legacy-input",
      agentId: "codex-local",
      runId: "legacy-architecture-run",
      completedAt: "2026-10-01T00:00:00.000Z"
    };
    const sequenceReview: SequenceReviewStatus = {
      state: "reviewed",
      generation: { requestId: "legacy-generation", inputFingerprint: "legacy-input" },
      reviewId: "legacy-sequence-review",
      scanFingerprint: "legacy-scan",
      agentId: "codex-local",
      runId: "legacy-sequence-run",
      completedAt: "2026-10-01T00:00:00.000Z"
    };
    const architectureReviewBytes = `${JSON.stringify(architectureReview)}\n`;
    const sequenceReviewBytes = `${JSON.stringify(sequenceReview)}\n`;
    await writeFile(architectureReviewPath, architectureReviewBytes, "utf8");
    await writeFile(sequenceReviewPath, sequenceReviewBytes, "utf8");
    await writeFile(join(root, "main.py"), "def main():\n    return 1\n", "utf8");

    const result = await generateProject(root, {});
    if (result.status !== "committed") throw new Error("Expected committed migration.");

    const snapshot = await readProjectProtocolSnapshot(root);
    if (!snapshot) throw new Error("Expected the committed snapshot after migration.");
    const record = JSON.parse(await readFile(join(flowweavePath, "migration", "record.json"), "utf8")) as { backupPath: string };
    const archivedArtifacts = join(root, record.backupPath, "artifacts");
    expect(await readFile(join(archivedArtifacts, "architecture-review.json"), "utf8")).toBe(architectureReviewBytes);
    expect(await readFile(join(archivedArtifacts, "sequence-review.json"), "utf8")).toBe(sequenceReviewBytes);
    expect(await readFile(architectureReviewPath, "utf8")).toBe(architectureReviewBytes);
    expect(await readFile(sequenceReviewPath, "utf8")).toBe(sequenceReviewBytes);

    const currentArchitectureInput = snapshot.localArchitecture.metadata?.inputFingerprint ?? snapshot.inputFingerprint;
    expect(await readArchitectureReviewStatus(root, {
      scanFingerprint: snapshot.project.scanFingerprint,
      inputFingerprint: currentArchitectureInput
    })).toMatchObject({ state: "stale", reviewId: architectureReview.reviewId, runId: architectureReview.runId });
    expect(await readSequenceReviewStatus(root, snapshot.project.scanFingerprint)).toMatchObject({
      state: "stale", reviewId: sequenceReview.reviewId, runId: sequenceReview.runId
    });
  });

  it("keeps preserved migration data when a lightweight graph save omits review payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-preserved-review-"));
    const canvasDir = join(root, ".flowweave", "canvas");
    await mkdir(canvasDir, { recursive: true });
    await writeFile(join(canvasDir, "main.canvas.json"), JSON.stringify({
      version: 4, nodes: [{ id: "legacy-note", title: "Keep me" }], edges: []
    }));
    await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
    const result = await generateProject(root, {});
    if (result.status !== "committed") throw new Error("Expected committed migration");
    const current = await readProjectProtocolCanvas(root);
    if (!current) throw new Error("Expected migrated graph");

    await saveProjectProtocolCanvas(root, {
      ...current, orphanedEdges: [], orphanedNodeEdits: [], migrationPendingItems: []
    });

    const firstReopen = await readProjectProtocolCanvas(root);
    expect(firstReopen?.migrationPendingItems).toEqual(current.migrationPendingItems);
    if (!firstReopen) throw new Error("Expected the graph after the first save and reopen");

    await saveProjectProtocolCanvas(root, {
      ...firstReopen, orphanedEdges: [], orphanedNodeEdits: [], migrationPendingItems: []
    });

    const secondReopen = await readProjectProtocolCanvas(root);
    expect(secondReopen?.migrationPendingItems).toEqual(current.migrationPendingItems);
    expect(secondReopen?.userRevision).toBe(2);
  });

  it.each([
    { label: "an unknown version", raw: JSON.stringify({ version: 99, nodes: [], edges: [] }) },
    { label: "malformed JSON", raw: "{" }
  ])("preserves Canvas data with $label", async ({ raw }) => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-unknown-canvas-"));
    const canvasPath = join(root, ".flowweave", "canvas", "main.canvas.json");
    await mkdir(join(root, ".flowweave", "canvas"), { recursive: true });
    await writeFile(canvasPath, raw, "utf8");

    await expect(generateProject(root, {})).rejects.toThrow("was preserved");

    expect(await readFile(canvasPath, "utf8")).toBe(raw);
  });

  it("archives JSON null Canvas and blocks registration before generation writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-null-canvas-"));
    const path = join(root, ".flowweave", "canvas", "main.canvas.json");
    await mkdir(join(root, ".flowweave", "canvas"), { recursive: true });
    await writeFile(path, "null");
    await expect(registerGenerationRequest(root, "null-canvas")).rejects.toThrow("was preserved");
    const record = JSON.parse(await readFile(join(root, ".flowweave", "migration", "record.json"), "utf8")) as { status: string; backupPath: string };
    expect(record.status).toBe("failed");
    expect(await readFile(join(root, record.backupPath, "artifacts", "canvas", "main.canvas.json"), "utf8")).toBe("null");
    expect(await readFile(path, "utf8")).toBe("null");
    await expect(readFile(join(root, ".flowweave", "generation-request.json"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it.each([
    { label: "fractional version", value: { version: 1.5, nodes: [], edges: [] } },
    { label: "missing nodes", value: { version: 4, edges: [] } },
    { label: "invalid nodes", value: { version: 6, nodes: [null], edges: [] } },
    { label: "invalid edges", value: { version: 5, nodes: [], edges: [null] } }
  ])("archives and blocks a Canvas with $label during preflight", async ({ value }) => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-invalid-preflight-"));
    const path = join(root, ".flowweave", "canvas", "main.canvas.json");
    await mkdir(join(root, ".flowweave", "canvas"), { recursive: true });
    const bytes = JSON.stringify(value);
    await writeFile(path, bytes);
    await expect(registerGenerationRequest(root, "invalid-canvas")).rejects.toThrow("was preserved");
    const record = JSON.parse(await readFile(join(root, ".flowweave", "migration", "record.json"), "utf8")) as { status: string; backupPath: string };
    expect(record.status).toBe("failed");
    expect(await readFile(join(root, record.backupPath, "artifacts", "canvas", "main.canvas.json"), "utf8")).toBe(bytes);
    expect(await readFile(path, "utf8")).toBe(bytes);
    await expect(readFile(join(root, ".flowweave", "generation-request.json"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("archives and rejects malformed typed v6 node and relation fields before registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-malformed-typed-canvas-"));
    const path = join(root, ".flowweave", "canvas", "main.canvas.json");
    await mkdir(join(root, ".flowweave", "canvas"), { recursive: true });
    const bytes = JSON.stringify({ ...correctionCanvas(root), version: 6,
      nodes: correctionCanvas(root).nodes.map((node) => ({ ...node, nodeType: "unknown-node-type" })),
      edges: [{ id: "relation", source: "api", target: "data" }]
    });
    await writeFile(path, bytes);
    await expect(registerGenerationRequest(root, "typed-invalid")).rejects.toThrow("was preserved");
    const record = JSON.parse(await readFile(join(root, ".flowweave", "migration", "record.json"), "utf8")) as { status: string; backupPath: string };
    expect(record.status).toBe("failed");
    expect(await readFile(join(root, record.backupPath, "artifacts", "canvas", "main.canvas.json"), "utf8")).toBe(bytes);
    await expect(readFile(join(root, ".flowweave", "generation-request.json"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it.each(["{", "null", JSON.stringify({ storageProtocol: 99 }), JSON.stringify({ requestId: 3 })])(
    "archives an invalid generation marker %s before rejecting registration", async (bytes) => {
      const root = await mkdtemp(join(tmpdir(), "flowweave-invalid-marker-"));
      const path = join(root, ".flowweave", "generation.json");
      await mkdir(join(root, ".flowweave"));
      await writeFile(path, bytes);
      await expect(registerGenerationRequest(root, "invalid-marker")).rejects.toThrow("was preserved");
      const record = JSON.parse(await readFile(join(root, ".flowweave", "migration", "record.json"), "utf8")) as { status: string; backupPath: string };
      expect(record.status).toBe("failed");
      expect(await readFile(join(root, record.backupPath, "artifacts", "generation.json"), "utf8")).toBe(bytes);
      expect(await readFile(path, "utf8")).toBe(bytes);
      await expect(readFile(join(root, ".flowweave", "generation-request.json"))).rejects.toHaveProperty("code", "ENOENT");
    }
  );

  it("backs up and blocks unknown legacy project artifacts when no Canvas exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-project-only-migration-"));
    const flowweaveRoot = join(root, ".flowweave");
    const projectBytes = JSON.stringify({ version: 2, custom: "user metadata" });
    await mkdir(flowweaveRoot, { recursive: true });
    await writeFile(join(flowweaveRoot, "project.json"), projectBytes, "utf8");

    await expect(registerGenerationRequest(root, "request-project-only")).rejects.toThrow("unknown legacy artifacts");

    const record = JSON.parse(await readFile(join(flowweaveRoot, "migration/record.json"), "utf8")) as { status: string; backupPath: string };
    expect(record.status).toBe("failed");
    expect(await readFile(join(flowweaveRoot, "project.json"), "utf8")).toBe(projectBytes);
    await expect(readFile(join(flowweaveRoot, "generation-request.json"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(readFile(join(root, record.backupPath, "artifacts/project.json"), "utf8")).resolves.toBe(projectBytes);
  });

  it.each([1, 2, 3, 4, 5, 6] as const)(
    "archives and blocks legacy Canvas v%s when an unrecognized protocol graph sidecar would be overwritten",
    async (version) => {
      const root = await mkdtemp(join(tmpdir(), `flowweave-mixed-legacy-v${version}-`));
      const flowweaveRoot = join(root, ".flowweave");
      const canvasPath = join(flowweaveRoot, "canvas", "main.canvas.json");
      const overviewPath = join(flowweaveRoot, "graph-overview.json");
      const canvasBytes = version <= 4
        ? JSON.stringify({ version, nodes: [{ id: "legacy-node", title: "Preserve this node" }], edges: [] })
        : JSON.stringify({ ...correctionCanvas(root), version });
      const overviewBytes = '{"schemaVersion":99,"nodes":[{"id":"unknown-graph"}],"edges":[]}\n';
      await mkdir(join(flowweaveRoot, "canvas"), { recursive: true });
      await writeFile(canvasPath, canvasBytes, "utf8");
      await writeFile(overviewPath, overviewBytes, "utf8");

      await expect(registerGenerationRequest(root, `mixed-legacy-v${version}`))
        .rejects.toThrow("unrecognized protocol artifact");

      const record = JSON.parse(await readFile(join(flowweaveRoot, "migration", "record.json"), "utf8")) as {
        status: string;
        backupPath: string;
      };
      expect(record.status).toBe("failed");
      expect(await readFile(canvasPath, "utf8")).toBe(canvasBytes);
      expect(await readFile(overviewPath, "utf8")).toBe(overviewBytes);
      expect(await readFile(join(root, record.backupPath, "artifacts", "canvas", "main.canvas.json"), "utf8")).toBe(canvasBytes);
      expect(await readFile(join(root, record.backupPath, "artifacts", "graph-overview.json"), "utf8")).toBe(overviewBytes);
      await expect(readFile(join(flowweaveRoot, "generation-request.json"))).rejects.toHaveProperty("code", "ENOENT");
    }
  );

  it.each([
    ["project.json", '{"version":99,"projectName":"unknown"}'],
    ["project.json", '{"version":2,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","git":{"isRepo":false},"summary":{"totalFiles":0,"totalFolders":0,"languages":{}},"files":[],"unknownField":true}'],
    ["project.json", '{"version":2,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","git":{"isRepo":false},"summary":{"totalFiles":0,"totalFolders":0,"languages":{}},"files":[{"id":"src","name":"src","path":"src","type":"folder","depth":0,"unknownField":true}]}'],
    ["project.json", '{"version":2,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","git":{"isRepo":false,"unknownField":true},"summary":{"totalFiles":0,"totalFolders":0,"languages":{}},"files":[]}'],
    ["project.json", '{"version":2,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","git":{"isRepo":false},"summary":{"totalFiles":1,"totalFolders":0,"languages":{}},"files":[null]}'],
    ["project.json", '{"version":2,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","git":{"isRepo":false},"summary":{"totalFiles":0,"totalFolders":0,"languages":{}},"files":[],"scanDelta":{"added":[7],"modified":[],"deleted":[],"unchanged":[]}}'],
    ["architecture-local.json", '{"version":99,"source":"local"}'],
    ["architecture-local.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"local","modules":[],"relationships":[],"files":[],"symbols":[],"unknownField":true}'],
    ["architecture-map.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"agent","modules":[{"id":"m","title":"M","category":"domain-service","nodeType":"module","role":"domain","description":"","files":[],"fileRoles":[],"symbols":[],"evidence":[],"risk":"unknown","unknownField":true}],"relationships":[],"files":[],"symbols":[]}'],
    ["architecture-map.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"agent","modules":[],"relationships":[{"id":"r","source":"a","target":"b","relation":"calls","description":"evidence","evidence":[{"detail":"known","unknownField":true}]}],"files":[],"symbols":[]}'],
    ["architecture-map.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"agent","modules":[{"id":"m","title":"M","category":"domain-service","nodeType":"module","role":"domain","description":"","files":[],"fileRoles":[],"symbols":[],"evidence":[],"risk":"unknown","assessment":{"version":1,"generatorVersion":"legacy","fingerprint":"f","assessedAt":"2026-10-07T00:00:00.000Z","confidence":{"level":"unknown","factors":[{"id":"f","label":"factor","score":0,"maxScore":1,"reason":"test","evidence":[],"unknownField":true}]},"risk":{"systemLevel":"unknown","effectiveLevel":"unknown","factors":[]}}}],"relationships":[],"files":[],"symbols":[]}'],
    ["architecture-local.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"agent","modules":[],"relationships":[],"files":[],"symbols":[]}'],
    ["architecture-local.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"local","modules":[null],"relationships":[],"files":[],"symbols":[]}'],
    ["architecture-local.json", '{"version":2,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"local","modules":[],"relationships":[],"files":[],"symbols":[],"groups":[]}'],
    ["architecture-local.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"local","modules":[{"id":"m","title":"M","category":"domain-service","nodeType":"module","role":"domain","description":"","files":[],"fileRoles":[],"symbols":[],"evidence":[],"risk":"unknown","assessment":null}],"relationships":[],"files":[],"symbols":[]}'],
    ["architecture-map.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"agent","modules":[],"relationships":[null],"files":[],"symbols":[]}'],
    ["architecture-map.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"agent","modules":[],"relationships":[],"files":[null],"symbols":[]}'],
    ["architecture-map.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"agent","modules":[],"relationships":[],"files":[],"symbols":[null]}'],
    ["architecture-map.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"agent","modules":[],"relationships":[],"files":[],"symbols":[{"name":"f","kind":"function","filePath":"src/f.ts","range":null}]}'],
    ["architecture-map.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"agent","modules":[],"relationships":[],"files":[],"symbols":[{"name":"f","kind":"function","filePath":"src/f.ts","range":{"start":{"line":0,"column":1},"end":{"line":1,"column":1}}}]}'],
    ["architecture-map.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"agent","modules":[],"relationships":[],"files":[],"symbols":[{"name":"f","kind":"function","filePath":"src/f.ts","line":0}]}'],
    ["architecture-map.json", '{"version":3,"projectName":"Legacy fixture","rootPath":"/fixture","generatedAt":"2026-10-07T00:00:00.000Z","source":"agent","modules":[],"relationships":[{"id":"r","source":"a","target":"b","relation":"calls","description":"bad evidence","evidence":[{"detail":"bad","line":0}]}],"files":[],"symbols":[]}'],
    ["architecture-map.json", '{"version":99,"source":"agent"}'],
    ["architecture-map.json", "{"]
  ])("archives and blocks a legacy migration with an unsupported %s format", async (artifact, bytes) => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-unknown-legacy-format-"));
    const flowweaveRoot = join(root, ".flowweave");
    const canvasPath = join(flowweaveRoot, "canvas", "main.canvas.json");
    const artifactPath = join(flowweaveRoot, artifact);
    const canvasBytes = JSON.stringify({ version: 4, nodes: [], edges: [] });
    await mkdir(join(flowweaveRoot, "canvas"), { recursive: true });
    await writeFile(canvasPath, canvasBytes, "utf8");
    await writeFile(artifactPath, bytes, "utf8");

    await expect(registerGenerationRequest(root, `unknown-${artifact}`)).rejects.toThrow("unrecognized legacy artifact");

    const record = JSON.parse(await readFile(join(flowweaveRoot, "migration", "record.json"), "utf8")) as {
      status: string;
      backupPath: string;
      failure?: { code: string };
    };
    expect(record).toMatchObject({ status: "failed", failure: { code: "unrecognized-legacy-artifact" } });
    expect(await readFile(artifactPath, "utf8")).toBe(bytes);
    expect(await readFile(join(root, record.backupPath, "artifacts", artifact), "utf8")).toBe(bytes);
    await expect(readFile(join(flowweaveRoot, "generation-request.json"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("archives a legacy project before request registration and records an in-progress migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-migration-backup-"));
    const flowweaveRoot = join(root, ".flowweave");
    const canvasPath = join(flowweaveRoot, "canvas", "main.canvas.json");
    const projectPath = join(flowweaveRoot, "project.json");
    const indexPath = join(flowweaveRoot, "index", "semantic-index.json");
    const manifestPath = join(flowweaveRoot, "index", "manifest.json");
    const canvasBytes = JSON.stringify({ version: 4, nodes: [{ id: "manual", title: "Preserve" }], edges: [] });
    const projectBytes = JSON.stringify({
      version: 2,
      projectName: "Legacy fixture",
      rootPath: root,
      generatedAt: "2026-10-07T00:00:00.000Z",
      git: { isRepo: false },
      summary: { totalFiles: 0, totalFolders: 0, languages: { TypeScript: 0 } },
      files: []
    });
    const architectureBytes = JSON.stringify({
      version: 2,
      projectName: "Legacy fixture",
      rootPath: root,
      generatedAt: "2026-10-07T00:00:00.000Z",
      source: "local",
      modules: [{
        id: "legacy-module", title: "Legacy module", category: "domain-service", nodeType: "module",
        role: "domain", description: "Legacy assessment fixture", files: [], fileRoles: [], symbols: [], evidence: [], risk: "unknown",
        assessment: {
          version: 1, generatorVersion: "legacy", fingerprint: "assessment", assessedAt: "2026-10-07T00:00:00.000Z",
          confidence: { level: "unknown", factors: [] },
          risk: { systemLevel: "unknown", effectiveLevel: "unknown", factors: [] }
        }
      }],
      relationships: [],
      files: [],
      symbols: []
    });
    const architectureMapBytes = JSON.stringify({
      version: 3, projectName: "Legacy fixture", rootPath: root, generatedAt: "2026-10-07T00:00:00.000Z", source: "agent",
      groups: [], modules: [], relationships: [], files: [], symbols: []
    });
    const oldRequestBytes = JSON.stringify({ requestId: "old-request", custom: "prior state" });
    const indexBytes = JSON.stringify({ version: 5, custom: "old index" });
    const manifestBytes = JSON.stringify({ version: 5, custom: "old manifest" });
    await mkdir(join(flowweaveRoot, "canvas"), { recursive: true });
    await mkdir(join(flowweaveRoot, "index"), { recursive: true });
    await writeFile(canvasPath, canvasBytes, "utf8");
    await writeFile(projectPath, projectBytes, "utf8");
    await writeFile(join(flowweaveRoot, "architecture-local.json"), architectureBytes, "utf8");
    await writeFile(join(flowweaveRoot, "architecture-map.json"), architectureMapBytes, "utf8");
    await writeFile(join(flowweaveRoot, "generation-request.json"), oldRequestBytes, "utf8");
    await writeFile(indexPath, indexBytes, "utf8");
    await writeFile(manifestPath, manifestBytes, "utf8");

    await registerGenerationRequest(root, "request-before-migration");
    const recordPath = join(flowweaveRoot, "migration", "record.json");
    const firstRecord = JSON.parse(await readFile(recordPath, "utf8")) as {
      status: string;
      attemptCount: number;
      sourceCanvasVersion: number;
      backupPath: string;
    };
    const backupRoot = join(root, firstRecord.backupPath);
    expect(firstRecord).toMatchObject({ status: "in-progress", attemptCount: 1, sourceCanvasVersion: 4 });
    expect(await readFile(join(backupRoot, "artifacts", "canvas", "main.canvas.json"), "utf8")).toBe(canvasBytes);
    expect(await readFile(join(backupRoot, "artifacts", "project.json"), "utf8")).toBe(projectBytes);
    expect(await readFile(join(backupRoot, "artifacts", "architecture-local.json"), "utf8")).toBe(architectureBytes);
    expect(await readFile(join(backupRoot, "artifacts", "architecture-map.json"), "utf8")).toBe(architectureMapBytes);
    expect(await readFile(join(backupRoot, "artifacts", "index", "semantic-index.json"), "utf8")).toBe(indexBytes);
    expect(await readFile(join(backupRoot, "artifacts", "index", "manifest.json"), "utf8")).toBe(manifestBytes);
    expect(await readFile(join(flowweaveRoot, "generation-request.json"), "utf8")).toContain("request-before-migration");

    await registerGenerationRequest(root, "second-attempt");
    const secondRecord = JSON.parse(await readFile(recordPath, "utf8")) as typeof firstRecord;
    expect(secondRecord.status).toBe("in-progress");
    expect(secondRecord.attemptCount).toBe(2);
    expect(secondRecord.backupPath).toBe(firstRecord.backupPath);
  });

  it("rejects migration when archived legacy bytes change before commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-changed-"));
    const canvasPath = join(root, ".flowweave", "canvas", "main.canvas.json");
    await mkdir(join(root, ".flowweave", "canvas"), { recursive: true });
    const original = JSON.stringify({ version: 4, nodes: [], edges: [] });
    const changed = JSON.stringify({ version: 4, nodes: [{ id: "new-edit" }], edges: [] });
    await writeFile(canvasPath, original);
    await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
    const request = await registerGenerationRequest(root, "change-before-commit");
    const recordPath = join(root, ".flowweave", "migration", "record.json");
    const archived = JSON.parse(await readFile(recordPath, "utf8")) as { backupPath: string };

    await expect(generateRegisteredProject(request, { onProgress: (progress) => {
      if (progress.stage === "persisting") writeFileSync(canvasPath, changed);
    } })).rejects.toThrow("migration input changed");

    expect(await readFile(canvasPath, "utf8")).toBe(changed);
    expect(await readFile(join(root, archived.backupPath, "artifacts", "canvas", "main.canvas.json"), "utf8")).toBe(original);
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({ status: "failed" });
    await expect(readFile(join(root, ".flowweave", "generation.json"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it.each(["add", "delete"])("rejects migration when legacy inventory files %s after backup", async (change) => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-inventory-"));
    const storage = join(root, ".flowweave");
    const canvasPath = join(storage, "canvas", "main.canvas.json");
    await mkdir(join(storage, "canvas"), { recursive: true });
    const original = JSON.stringify({ version: 4, nodes: [], edges: [] });
    await writeFile(canvasPath, original);
    await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
    const request = await registerGenerationRequest(root, "inventory-change");
    const recordPath = join(storage, "migration", "record.json");
    const archived = JSON.parse(await readFile(recordPath, "utf8")) as { backupPath: string };
    let changed = false;
    await expect(generateRegisteredProject(request, { onProgress: (progress) => {
      if (progress.stage !== "persisting" || changed) return;
      changed = true;
      if (change === "add") writeFileSync(join(storage, "project.json"), "new user metadata");
      else unlinkSync(canvasPath);
    } })).rejects.toThrow("migration input changed");
    expect(await readFile(join(root, archived.backupPath, "artifacts", "canvas", "main.canvas.json"), "utf8")).toBe(original);
    if (change === "add") expect(await readFile(join(storage, "project.json"), "utf8")).toBe("new user metadata");
    else await expect(readFile(canvasPath)).rejects.toHaveProperty("code", "ENOENT");
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({ status: "failed" });
    await expect(readFile(join(storage, "generation.json"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects migration if its archived backup disappears after registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-lost-backup-"));
    const storage = join(root, ".flowweave");
    const canvasPath = join(storage, "canvas", "main.canvas.json");
    await mkdir(join(storage, "canvas"), { recursive: true });
    const original = JSON.stringify({ version: 4, nodes: [], edges: [] });
    await writeFile(canvasPath, original);
    await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
    const request = await registerGenerationRequest(root, "lost-backup");
    const recordPath = join(storage, "migration", "record.json");
    const archived = JSON.parse(await readFile(recordPath, "utf8")) as { backupPath: string };
    await rm(join(root, archived.backupPath), { recursive: true });
    await expect(generateRegisteredProject(request, {})).rejects.toThrow("Migration backup is missing");
    expect(await readFile(canvasPath, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({ status: "failed" });
    await expect(readFile(join(storage, "generation.json"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it.each(["canvas", "record"])("rechecks archived migration %s after staging and before any replacement", async (changedArtifact) => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-final-boundary-"));
    await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
    const generated = await generateProject(root, {});
    if (generated.status !== "committed") throw new Error("Expected a generated test graph");
    const storage = join(root, ".flowweave");
    await rm(storage, { recursive: true });
    await mkdir(join(storage, "canvas"), { recursive: true });
    const path = join(storage, "canvas", "main.canvas.json");
    const original = JSON.stringify({ ...generated.canvas, version: 6 });
    const edited = JSON.stringify({ ...generated.canvas, version: 6, title: "Concurrent edit" });
    await writeFile(path, original);
    await registerGenerationRequest(root, "final-boundary");
    const artifacts = await prepareFlowWeaveProject(root, generated.project, generated.canvas, {
      local: generated.localArchitecture, current: generated.architectureMap,
      generation: generated.generation, requestId: "final-boundary", semanticIndex: generated.index
    });
    const updates = artifacts.updates.map((update, index) => index === 0 ? {
      ...update, validate: () => {
        if (changedArtifact === "canvas") writeFileSync(path, edited);
        else unlinkSync(join(storage, "migration", "record.json"));
      }
    } : update);
    await expect(writeBatchAtomic(root, updates, artifacts.removedPaths, artifacts.validateMigration))
      .rejects.toThrow("migration input changed");
    expect(await readFile(path, "utf8")).toBe(changedArtifact === "canvas" ? edited : original);
    const record = JSON.parse(await readFile(join(storage, "migration", "record.json"), "utf8")) as { status: string; backupPath: string };
    expect(record.status).toBe("failed");
    expect(await readFile(join(root, record.backupPath, "artifacts", "canvas", "main.canvas.json"), "utf8")).toBe(original);
    await expect(readFile(join(storage, "static-snapshot.json"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(readFile(join(storage, "transaction.json"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("preserves concurrent input and the original error when final commit validation rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-final-validation-"));
    const path = join(root, ".flowweave", "project.json");
    await mkdir(join(root, ".flowweave"));
    await writeFile(path, "original legacy bytes");
    await expect(writeBatchAtomic(root, [{ path, content: "replacement" }], [], async () => {
      await writeFile(path, "concurrent legacy edit");
      throw new Error("migration input changed during staging");
    })).rejects.toThrow(/^migration input changed during staging$/);
    expect(await readFile(path, "utf8")).toBe("concurrent legacy edit");
    expect(await readdir(join(root, ".flowweave"))).toEqual(["project.json"]);
  });

  it.each(["file", "directory"])("rejects inventory when a listed %s disappears during traversal", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-disappearing-inventory-"));
    const storage = join(root, ".flowweave");
    await mkdir(join(storage, "canvas"), { recursive: true });
    const bytes = JSON.stringify({ version: 4, nodes: [], edges: [] });
    await writeFile(join(storage, "canvas", "main.canvas.json"), bytes);
    await writeFile(join(storage, "project.json"), "legacy metadata");
    const canonicalStorage = join(await fsPromises.realpath(root), ".flowweave");
    const originalReaddir = fsPromises.readdir;
    const target = join(canonicalStorage, kind === "file" ? "project.json" : "canvas");
    const intercepted = vi.spyOn(fsPromises, "readdir").mockImplementation(async (...args) => {
      const entries = await originalReaddir(...args);
      if (args[0] === canonicalStorage) await rm(target, { recursive: true });
      return entries;
    });
    syncBuiltinESMExports();
    try {
      await expect(assertCanvasCanStartGeneration(root, "disappearing-input")).rejects.toHaveProperty("code", "ENOENT");
      await expect(readFile(join(storage, "generation-request.json"))).rejects.toHaveProperty("code", "ENOENT");
      await expect(readFile(join(storage, "generation.json"))).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      intercepted.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("allows an initially missing inventory root without creating migration artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-missing-inventory-root-"));
    await assertCanvasCanStartGeneration(root, "new-project");
    expect(await readdir(root)).toEqual([]);
  });

  it("records a migration failure only for the request that owns the in-progress attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-migration-failure-"));
    const flowweaveRoot = join(root, ".flowweave");
    await mkdir(join(flowweaveRoot, "canvas"), { recursive: true });
    await writeFile(join(flowweaveRoot, "canvas", "main.canvas.json"), JSON.stringify({ version: 4, nodes: [], edges: [] }), "utf8");
    await registerGenerationRequest(root, "active-request");

    await recordCanvasMigrationFailure(root, "superseded-request", new Error("old worker failed"));
    const recordPath = join(flowweaveRoot, "migration", "record.json");
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({ status: "in-progress", requestId: "active-request" });

    await recordCanvasMigrationFailure(root, "active-request", new Error("analysis failed"));
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({
      status: "failed",
      requestId: "active-request",
      failure: { code: "migration-generation-failed", stage: "analysis", message: "analysis failed" }
    });
  });

  it("rejects a linked FlowWeave root instead of writing artifacts outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-store-linked-root-"));
    const outside = await mkdtemp(join(tmpdir(), "flowweave-store-linked-outside-"));
    await symlink(outside, join(root, ".flowweave"), "dir");

    await expect(registerGenerationRequest(root, "request-link"))
      .rejects.toThrow("symbolic link");
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});

function correctionCanvas(root: string): CodeflowCanvas {
  return {
    id: "main", title: "Correction fixture", projectPath: root, generatedAt: "2026-10-03T00:00:00.000Z",
    scanFingerprint: "fixture-scan", artifactState: "current",
    nodes: ["api", "data"].map((id) => ({
      id, title: id, subtitle: id, kind: "module" as const, nodeType: "module" as const,
      risk: "unknown" as const, description: id, files: [`src/${id}.ts`], guidanceDraft: "",
      status: "mapped" as const, x: 0, y: 0, origin: "generated" as const
    })),
    edges: [{ id: "api-data", source: "api", target: "data", relation: "calls", origin: "generated" }]
  };
}

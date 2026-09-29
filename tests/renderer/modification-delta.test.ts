import { describe, expect, it } from "vitest";
import type {
  CodeflowCanvas,
  GraphEdge,
  GraphNode,
  ModificationBaseline
} from "../../src/types";
import {
  acknowledgeModificationDelta,
  buildModificationDelta,
  hasModificationDelta,
  migrateModificationBaseline,
  normalizeModificationSnapshot
} from "../../src/utils/modification-delta";
import { buildModificationDeltaGuidanceMarkdown } from "../../src/utils/export-artifacts";

describe("modification delta", () => {
  it.each(["Pending note", "", undefined])("keeps edge guidance %j pending while migrating independently confirmed relation IDs", (guidanceNote) => {
    const previous = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "old" })], edges: [edgeFixture({ id: "old-link", source: "old", target: "old", guidanceNote: "Already sent" })] }), "");
    const generated = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "new" })], edges: [edgeFixture({ id: "new-link", source: "new", target: "new", guidanceNote: "Fresh fact" })] }), "");
    const current = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "new" })], edges: [edgeFixture({ id: "new-link", source: "new", target: "new", guidanceNote })] }), "");
    const baseline = baselineFrom(previous);
    const original = JSON.stringify({ baseline, generated, current });
    const migrated = migrateModificationBaseline(baseline, current, generated);
    expect(migrated.acknowledgedAt).toBe(baseline.acknowledgedAt);
    expect(migrated.canvas.relations).toEqual([{ id: "new-link", source: "new", target: "new", relation: "depends_on", guidanceNote: "Already sent" }]);
    expect(buildModificationDelta(migrated, current).relations.updated).toEqual([{ id: "new-link", changes: { guidanceNote } }]);
    expect(JSON.stringify({ baseline, generated, current })).toBe(original);
  });

  it("refreshes generated edge notes without treating scan wording as unsent guidance", () => {
    const previous = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "old" })], edges: [edgeFixture({ id: "old-link", source: "old", target: "old", guidanceNote: "Old fact" })] }), "");
    const generated = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "new" })], edges: [edgeFixture({ id: "new-link", source: "new", target: "new", guidanceNote: "Fresh fact" })] }), "");
    const migrated = migrateModificationBaseline(baselineFrom(previous), generated, generated);
    expect(migrated.canvas.relations[0].guidanceNote).toBe("Fresh fact");
    expect(hasModificationDelta(buildModificationDelta(migrated, generated))).toBe(false);
  });

  it("uses mutually unique relation identity instead of merging multiple acknowledgements", () => {
    const previous = normalizeModificationSnapshot(canvasFixture({
      nodes: [nodeFixture({ id: "old" })],
      edges: [edgeFixture({ id: "old-1", source: "old", target: "old", guidanceNote: "Sent first" }), edgeFixture({ id: "old-2", source: "old", target: "old", guidanceNote: "Sent second" })]
    }), "");
    const generated = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "new" })], edges: [edgeFixture({ id: "new-link", source: "new", target: "new", guidanceNote: "Fresh fact" })] }), "");
    const migrated = migrateModificationBaseline(baselineFrom(previous), generated, generated);
    expect(migrated.canvas.relations).toEqual([
      { id: "new-link", source: "new", target: "new", relation: "depends_on", guidanceNote: "Fresh fact" },
      { id: "old-1", source: "old", target: "old", relation: "depends_on", guidanceNote: "Sent first" },
      { id: "old-2", source: "old", target: "old", relation: "depends_on", guidanceNote: "Sent second" }
    ]);
  });

  it("normalizes orphaned edge edits as pending and exports their original endpoints", () => {
    const factual = edgeFixture({ source: "api", target: "api", guidanceNote: "Fact" });
    const orphaned = { ...factual, target: "removed", guidanceNote: "Keep pending instruction" };
    const baseline = baselineFrom(normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({})], edges: [factual] }), ""));
    const current = normalizeModificationSnapshot({ ...canvasFixture({ nodes: [nodeFixture({})], edges: [factual] }), orphanedEdges: [orphaned] }, "");
    const delta = buildModificationDelta(baseline, current);
    expect(current.canvas.relations).toEqual([{ id: "api-service", source: "api", target: "removed", relation: "depends_on", guidanceNote: "Keep pending instruction", pending: true }]);
    expect(delta.relations.updated).toEqual([{ id: "api-service", changes: { target: "removed", guidanceNote: "Keep pending instruction", pending: true } }]);
    const markdown = buildModificationDeltaGuidanceMarkdown({
      schemaVersion: 2,
      source: "FlowWeave",
      project: { label: "Project", path: "/tmp/project" },
      generatedAt: "2026-09-29T00:00:00.000Z",
      delta,
      hasChanges: true,
      artifactReferences: []
    });
    expect(markdown).toContain("Pending relation edit");
    expect(markdown).toContain("Keep pending instruction");
  });

  it("keeps resource identity distinct from modules sharing its evidence file", () => {
    const resource = { ...nodeFixture({ id: "resource:db", files: ["src/api.ts"] }), resource: { id: "resource:db", kind: "database" as const, scopeId: "scope", key: "db", title: "DB", detail: "DB", evidence: [] } };
    const previous = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "old" }), resource], edges: [edgeFixture({ id: "old-link", source: "old", target: "resource:db", guidanceNote: "Sent" })] }), "");
    const generated = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "new" }), resource], edges: [edgeFixture({ id: "new-link", source: "new", target: "resource:db", guidanceNote: "Fresh" })] }), "");
    const migrated = migrateModificationBaseline(baselineFrom(previous), generated, generated);
    expect(migrated.canvas.modules.map(({ id }) => id)).toEqual(["new", "resource:db"]);
    expect(migrated.canvas.relations).toEqual([{ id: "new-link", source: "new", target: "resource:db", relation: "depends_on", guidanceNote: "Fresh" }]);
  });

  it("does not match an ordinary module to a coincidental resource ID", () => {
    const resource = { ...nodeFixture({ id: "collision", files: [] }), resource: { id: "collision", kind: "database" as const, scopeId: "scope", key: "db", title: "DB", detail: "DB", evidence: [] } };
    const previous = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "collision" })], edges: [edgeFixture({ id: "old-link", source: "collision", target: "collision", guidanceNote: "Sent" })] }), "");
    const generated = normalizeModificationSnapshot(canvasFixture({ nodes: [resource], edges: [edgeFixture({ id: "new-link", source: "collision", target: "collision", guidanceNote: "Fact" })] }), "");
    const current = { ...generated, canvas: { ...generated.canvas, relations: [{ ...generated.canvas.relations[0], guidanceNote: "Pending" }] } };
    const migrated = migrateModificationBaseline(baselineFrom(previous), current, generated);
    expect(migrated.canvas.relations.map(({ id, guidanceNote }) => ({ id, guidanceNote }))).toEqual([{ id: "new-link", guidanceNote: "Fact" }, { id: "old-link", guidanceNote: "Sent" }]);
  });

  it("labels edits to already acknowledged orphaned relations as pending on export", () => {
    const edge = edgeFixture({ guidanceNote: "Already sent" });
    const baseline = baselineFrom(normalizeModificationSnapshot({ ...canvasFixture({ edges: [] }), orphanedEdges: [edge] }, ""));
    const current = normalizeModificationSnapshot({ ...canvasFixture({ edges: [] }), orphanedEdges: [{ ...edge, guidanceNote: "New pending instruction" }] }, "");
    const delta = buildModificationDelta(baseline, current);
    const markdown = buildModificationDeltaGuidanceMarkdown({ schemaVersion: 2, source: "FlowWeave", project: { label: "Project", path: "/tmp/project" }, generatedAt: "2026-09-29T00:00:00.000Z", delta, hasChanges: true, artifactReferences: [] });
    expect(delta.relations.updated).toEqual([{ id: "api-service", changes: { guidanceNote: "New pending instruction", pending: true } }]);
    expect(markdown).toContain("Pending relation edit");
  });

  it("uses generated wording during an identity upgrade while leaving new user guidance pending", () => {
    const previous = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "legacy", title: "Legacy API", guidanceDraft: "Already sent." })], edges: [] }), "");
    const generated = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "renamed", title: "Generated API", guidanceDraft: "Generated instruction." })], edges: [] }), "");
    const current = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "renamed", title: "My API", guidanceDraft: "Pending user instruction." })], edges: [] }), "");
    const migrated = migrateModificationBaseline(baselineFrom(previous), current, generated);
    const delta = buildModificationDelta(migrated, current);
    expect(migrated.acknowledgedAt).toBe(baselineFrom(previous).acknowledgedAt);
    expect(migrated.canvas.modules[0]).toMatchObject({ id: "renamed", title: "Generated API", guidanceDraft: "Already sent." });
    expect(delta.modules.updated[0].changes).toMatchObject({ title: "My API", guidanceDraft: "Pending user instruction." });
  });

  it("does not report regenerated instructions as pending user edits during an identity upgrade", () => {
    const old = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "legacy" })], edges: [] }), "");
    const generated = normalizeModificationSnapshot(canvasFixture({ nodes: [nodeFixture({ id: "renamed", guidanceDraft: "Generated instruction." })], edges: [] }), "");
    const migrated = migrateModificationBaseline(baselineFrom(old), generated, generated);
    expect(hasModificationDelta(buildModificationDelta(migrated, generated))).toBe(false);
  });

  it("returns no delta for unchanged user-editable state", () => {
    const snapshot = normalizeModificationSnapshot(canvasFixture(), "");
    const baseline = baselineFrom(snapshot);

    expect(hasModificationDelta(buildModificationDelta(baseline, snapshot))).toBe(false);
  });

  it("reports only the final changed module fields", () => {
    const baselineSnapshot = normalizeModificationSnapshot(canvasFixture(), "");
    const current = normalizeModificationSnapshot(canvasFixture({
      nodes: [nodeFixture({ title: "Public API", guidanceDraft: "Keep handlers thin.", x: 999 })]
    }), "");

    const delta = buildModificationDelta(baselineFrom(baselineSnapshot), current);

    expect(delta.modules.updated).toEqual([{
      id: "api",
      title: "Public API",
      changes: {
        title: "Public API",
        guidanceDraft: "Keep handlers thin."
      }
    }]);
  });

  it("ignores layout, status, evidence, and automatic assessment changes", () => {
    const original = canvasFixture();
    const changed = canvasFixture({
      nodes: [nodeFixture({
        x: 900,
        y: 700,
        status: "needs-review",
        evidence: [{ filePath: "src/api.ts", detail: "New evidence" }],
        assessment: {
          version: 1,
          generatorVersion: "test",
          confidence: { level: "low", factors: [] },
          risk: { systemLevel: "high", effectiveLevel: "high", factors: [] },
          fingerprint: "changed",
          assessedAt: "2026-06-25T00:00:00.000Z"
        }
      })]
    });

    const delta = buildModificationDelta(
      baselineFrom(normalizeModificationSnapshot(original, "")),
      normalizeModificationSnapshot(changed, "")
    );

    expect(hasModificationDelta(delta)).toBe(false);
  });

  it("does not report a module that was added and then removed", () => {
    const baseline = baselineFrom(normalizeModificationSnapshot(canvasFixture(), ""));
    const current = normalizeModificationSnapshot(canvasFixture(), "");

    expect(buildModificationDelta(baseline, current).modules.added).toEqual([]);
  });

  it("reports retained additions and baseline deletions", () => {
    const baselineCanvas = canvasFixture({
      nodes: [nodeFixture(), nodeFixture({ id: "worker", title: "Worker" })]
    });
    const currentCanvas = canvasFixture({
      nodes: [nodeFixture(), nodeFixture({ id: "new-module", title: "New Module", guidanceDraft: "Add queue handling." })]
    });

    const delta = buildModificationDelta(
      baselineFrom(normalizeModificationSnapshot(baselineCanvas, "")),
      normalizeModificationSnapshot(currentCanvas, "")
    );

    expect(delta.modules.added.map((module) => module.id)).toEqual(["new-module"]);
    expect(delta.modules.deleted).toEqual([{ id: "worker", title: "Worker" }]);
  });

  it("normalizes file order and reports relation additions, updates, and deletions", () => {
    const baselineCanvas = canvasFixture({
      nodes: [nodeFixture({ files: ["src/z.ts", "src/a.ts"] })],
      edges: [
        edgeFixture(),
        edgeFixture({ id: "old", source: "api", target: "worker" })
      ]
    });
    const currentCanvas = canvasFixture({
      nodes: [nodeFixture({ files: ["src/a.ts", "src/z.ts"] })],
      edges: [
        edgeFixture({ relation: "calls", guidanceNote: "Use public contract." }),
        edgeFixture({ id: "new", source: "api", target: "repo" })
      ]
    });

    const delta = buildModificationDelta(
      baselineFrom(normalizeModificationSnapshot(baselineCanvas, "")),
      normalizeModificationSnapshot(currentCanvas, "")
    );

    expect(delta.modules.updated).toEqual([]);
    expect(delta.relations.added.map((edge) => edge.id)).toEqual(["new"]);
    expect(delta.relations.updated).toEqual([{
      id: "api-service",
      changes: { relation: "calls", guidanceNote: "Use public contract." }
    }]);
    expect(delta.relations.deleted).toEqual([{ id: "old", source: "api", target: "worker" }]);
  });

  it("tracks only a non-empty sequence instruction that differs from the baseline", () => {
    const snapshot = normalizeModificationSnapshot(canvasFixture(), "Split authorize and capture.");
    const delta = buildModificationDelta(
      baselineFrom(normalizeModificationSnapshot(canvasFixture(), "")),
      snapshot
    );

    expect(delta.sequenceInstruction).toBe("Split authorize and capture.");
    expect(buildModificationDelta(baselineFrom(snapshot), normalizeModificationSnapshot(canvasFixture(), "")).sequenceInstruction).toBeUndefined();
  });

  it("acknowledges only the requested scope using the sent snapshot", () => {
    const baseline = baselineFrom(normalizeModificationSnapshot(canvasFixture(), ""));
    const sent = normalizeModificationSnapshot(canvasFixture({
      nodes: [nodeFixture({ title: "Public API", guidanceDraft: "Keep handlers thin." })]
    }), "Split authorize and capture.");

    const moduleAcknowledged = acknowledgeModificationDelta(
      baseline,
      sent,
      { kind: "module-guidance", moduleId: "api" },
      "2026-06-25T01:00:00.000Z"
    );
    const sequenceAcknowledged = acknowledgeModificationDelta(
      moduleAcknowledged,
      sent,
      { kind: "sequence" },
      "2026-06-25T02:00:00.000Z"
    );

    expect(moduleAcknowledged.canvas.modules[0].guidanceDraft).toBe("Keep handlers thin.");
    expect(moduleAcknowledged.canvas.modules[0].title).toBe("API");
    expect(moduleAcknowledged.sequenceInstruction).toBeUndefined();
    expect(sequenceAcknowledged.sequenceInstruction).toBe("Split authorize and capture.");
  });

  it("acknowledges guidance for a newly added module without hiding the module addition", () => {
    const baseline = baselineFrom(normalizeModificationSnapshot(canvasFixture(), ""));
    const sent = normalizeModificationSnapshot(canvasFixture({
      nodes: [
        nodeFixture(),
        nodeFixture({ id: "module-1", title: "New Module", guidanceDraft: "Add queue handling." })
      ]
    }), "");

    const acknowledged = acknowledgeModificationDelta(
      baseline,
      sent,
      { kind: "module-guidance", moduleId: "module-1" },
      "2026-06-25T03:00:00.000Z"
    );
    const delta = buildModificationDelta(acknowledged, sent);

    expect(delta.modules.added).toEqual([expect.objectContaining({
      id: "module-1",
      guidanceDraft: ""
    })]);
  });
});

function baselineFrom(snapshot: ReturnType<typeof normalizeModificationSnapshot>): ModificationBaseline {
  return {
    version: 1,
    acknowledgedAt: "2026-06-25T00:00:00.000Z",
    scanFingerprint: snapshot.scanFingerprint,
    canvas: snapshot.canvas,
    sequenceInstruction: snapshot.sequenceInstruction
  };
}

function canvasFixture(input: { nodes?: GraphNode[]; edges?: GraphEdge[] } = {}): CodeflowCanvas {
  return {
    version: 3,
    id: "main",
    title: "Main Canvas",
    projectPath: "/tmp/project",
    generatedAt: "2026-06-25T00:00:00.000Z",
    scanFingerprint: "scan-1",
    artifactState: "current",
    nodes: input.nodes ?? [nodeFixture()],
    edges: input.edges ?? [edgeFixture()]
  };
}

function nodeFixture(patch: Partial<GraphNode> = {}): GraphNode {
  return {
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
  };
}

function edgeFixture(patch: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: "api-service",
    source: "api",
    target: "service",
    relation: "depends_on",
    ...patch
  };
}

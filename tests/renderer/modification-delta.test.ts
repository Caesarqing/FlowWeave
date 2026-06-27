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
  normalizeModificationSnapshot
} from "../../src/utils/modification-delta";

describe("modification delta", () => {
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

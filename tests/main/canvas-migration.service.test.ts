import { describe, expect, it } from "vitest";
import { createCanvasUserState, reconcileGeneratedCanvas, type LegacyCanvasV1To4, type LegacyCanvasV5, type LegacyCanvasV6 } from "../../src/main/services/canvas-migration.service";
import { clusterArchitectureModules } from "../../src/main/services/module-clustering.service";
import { unknownAssessment } from "../../src/utils/module-assessment";
import type { ArchitectureModule, CodeflowCanvas, FileInsight, GraphEdge, GraphNode } from "../../src/types";

describe("project graph state migration and reconciliation", () => {
  it("keeps visible module edits and manual links when its anchored duty gains a file", () => {
    const before = { ...node("api", "module", ["src/api.ts"], "generated"), role: "Declares serve.",
      category: "api-boundary" as const,
      identity: { id: "api", anchor: "api", clusterFingerprint: "before", predecessorIds: [] } };
    const edited = { ...before, title: "My API", guidanceDraft: "Keep this review note." };
    const after = { ...before, files: ["src/api.ts", "src/router.ts"], role: "Declares serve, route.",
      identity: { ...before.identity, clusterFingerprint: "after" } };
    const note = node("note", "doc", [], "manual");
    const manualLink: GraphEdge = { id: "manual", source: "note", target: "api", relation: "depends_on", origin: "manual" };

    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [after] }),
      graphView({ nodes: [edited, note], edges: [manualLink] }), { nodes: [before], edges: [] });

    expect(migrated.nodes.find((item) => item.id === "api")).toMatchObject({
      title: "My API", guidanceDraft: "Keep this review note.", files: ["src/api.ts", "src/router.ts"]
    });
    expect(migrated.edges).toContainEqual(manualLink);
    expect(migrated.orphanedEdges).toEqual([]);
    expect(migrated.orphanedNodeEdits).toEqual([]);
  });
  it("keeps module identity and user edits when its responsibility loses a generated file", () => {
    const sourceFiles = ["src/features/billing/billing.service.ts", "src/features/billing/receipt.presenter.ts"];
    const initial = clusterArchitectureModules(sourceFiles.map(fileInsight), [], [], []);
    const previousModules = initial.modules.map(toArchitectureModule);
    const updated = clusterArchitectureModules([fileInsight(sourceFiles[0])], [], previousModules, []);
    expect(initial.modules).toHaveLength(1);
    expect(updated.modules).toHaveLength(1);
    const beforeCluster = initial.modules[0];
    const afterCluster = updated.modules[0];
    expect(afterCluster.id).toBe(beforeCluster.id);
    const before = { ...node(beforeCluster.id, "module", beforeCluster.files, "generated"),
      title: beforeCluster.title, role: previousModules[0].role, category: beforeCluster.category,
      identity: beforeCluster.identity };
    const edited = { ...before, title: "Reviewed API", guidanceDraft: "Keep this boundary note." };
    const after = { ...before, files: afterCluster.files, role: previousModules[0].role,
      identity: afterCluster.identity };

    const reconciled = reconcileGeneratedCanvas(graphView({ nodes: [after] }),
      graphView({ nodes: [edited] }), { nodes: [before], edges: [] });

    expect(reconciled.nodes).toMatchObject([{ id: beforeCluster.id, title: "Reviewed API", guidanceDraft: "Keep this boundary note.", files: [sourceFiles[0]] }]);
    expect(reconciled.orphanedNodeEdits).toEqual([]);
  });
  it("keeps edits when a new boundary file changes the anchor but names a unique predecessor", () => {
    const before = { ...node("old-api", "module", ["src/controller.ts"], "generated"),
      category: "api-boundary" as const,
      identity: { id: "old-api", anchor: "file:src/controller.ts", clusterFingerprint: "before", predecessorIds: [] } };
    const after = { ...before, id: "new-api", files: ["src/controller.ts", "src/router.ts"],
      identity: { id: "new-api", anchor: "file:src/router.ts", clusterFingerprint: "after", predecessorIds: ["old-api"] } };
    const note = node("note", "doc", [], "manual");
    const link: GraphEdge = { id: "manual", source: "note", target: "old-api", relation: "depends_on", origin: "manual" };

    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [after] }),
      graphView({ nodes: [{ ...before, title: "My API" }, note], edges: [link] }),
      { nodes: [before], edges: [] });

    expect(migrated.nodes.find((item) => item.id === "new-api")?.title).toBe("My API");
    expect(migrated.edges).toContainEqual({ ...link, target: "new-api" });
  });
  it("rebases a user's file removal onto new files found in the same module", () => {
    const before = { ...node("api", "module", ["src/api.ts", "src/legacy.ts"], "generated"),
      category: "api-boundary" as const,
      identity: { id: "api", anchor: "api", clusterFingerprint: "before", predecessorIds: [] } };
    const after = { ...before, files: ["src/api.ts", "src/legacy.ts", "src/router.ts"],
      identity: { ...before.identity, clusterFingerprint: "after" } };
    const edited = { ...before, files: ["src/api.ts"] };

    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [after] }),
      graphView({ nodes: [edited] }), { nodes: [before], edges: [] },
      new Set(["src/api.ts", "src/legacy.ts", "src/router.ts"]));

    expect(migrated.nodes[0].files).toEqual(["src/api.ts", "src/router.ts"]);
    expect(migrated.orphanedNodeEdits).toEqual([]);
  });
  it("keeps a vanished user-added file correction for review without putting it on the new graph", () => {
    const before = { ...node("api", "module", ["src/api.ts"], "generated"),
      category: "api-boundary" as const,
      identity: { id: "api", anchor: "api", clusterFingerprint: "before", predecessorIds: [] } };
    const after = { ...before, files: ["src/api.ts", "src/router.ts"],
      identity: { ...before.identity, clusterFingerprint: "after" } };
    const edited = { ...before, files: ["src/api.ts", "src/deleted.ts"], title: "My API" };

    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [after] }),
      graphView({ nodes: [edited] }), { nodes: [before], edges: [] },
      new Set(["src/api.ts", "src/router.ts"]));

    expect(migrated.nodes[0]).toMatchObject({ title: "My API", files: ["src/api.ts", "src/router.ts"] });
    expect(migrated.migrationPendingItems).toMatchObject([{ kind: "node", sourceId: "api", reason: "file-correction-conflict" }]);
    expect(migrated.migrationPendingItems?.[0].raw).toMatchObject({ title: "My API", files: ["src/api.ts", "src/deleted.ts"] });
  });
  it("does not give a reused module ID a previous duty's edits or manual link", () => {
    const before = { ...node("api", "module", ["src/api.ts"], "generated"), role: "API",
      category: "api-boundary" as const,
      identity: { id: "api", anchor: "api", clusterFingerprint: "old", predecessorIds: [] } };
    const after = { ...before, files: ["src/api.ts", "src/job.ts"], role: "Job",
      category: "domain-service" as const,
      identity: { ...before.identity, anchor: "job", clusterFingerprint: "new" } };
    const note = node("note", "doc", [], "manual");
    const link: GraphEdge = { id: "manual", source: "note", target: "api", relation: "depends_on", origin: "manual" };
    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [after] }),
      graphView({ nodes: [{ ...before, title: "My API" }, note], edges: [link] }),
      { nodes: [before], edges: [] });

    expect(migrated.nodes.find((item) => item.id === "api")?.title).toBe("api");
    expect(migrated.edges).toEqual([]);
    expect(migrated.orphanedEdges).toContainEqual(link);
    expect(migrated.orphanedNodeEdits).toMatchObject([{ node: { title: "My API" } }]);
  });
  it("does not transfer a visible edit to a new duty that only shares one file and its anchor", () => {
    const before = { ...node("main", "module", ["src/main.ts", "src/legacy.ts"], "generated"),
      role: "Command entrypoint", category: "api-boundary" as const,
      identity: { id: "main", anchor: "src/main.ts", clusterFingerprint: "old-duty", predecessorIds: [] } };
    const after = { ...before, files: ["src/main.ts", "src/worker.ts"], role: "Background scheduler",
      identity: { ...before.identity, clusterFingerprint: "new-duty" } };

    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [after] }),
      graphView({ nodes: [{ ...before, title: "Reviewed command entrypoint" }] }),
      { nodes: [before], edges: [] });

    expect(migrated.nodes[0].title).toBe(after.title);
    expect(migrated.orphanedNodeEdits).toMatchObject([{ node: { title: "Reviewed command entrypoint" } }]);
  });
  it("does not transfer responsibility edits when a changed role keeps all old files and adds another", () => {
    const before = { ...node("api", "module", ["src/api.ts"], "generated"), role: "API boundary",
      category: "api-boundary" as const,
      identity: { id: "api", anchor: "api", clusterFingerprint: "old-duty", predecessorIds: [] } };
    const after = { ...before, files: ["src/api.ts", "src/worker.ts"], role: "Background worker",
      identity: { ...before.identity, clusterFingerprint: "new-duty" } };

    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [after] }),
      graphView({ nodes: [{ ...before, title: "Reviewed API boundary" }] }),
      { nodes: [before], edges: [] });

    expect(migrated.nodes[0]).toMatchObject({ title: after.title, role: "Background worker" });
    expect(migrated.orphanedNodeEdits).toMatchObject([{ node: { title: "Reviewed API boundary" } }]);
  });
  it("leaves a renamed module pending when its claimed predecessor shares only one unchanged file", () => {
    const before = { ...node("old-api", "module", ["src/api/controller.ts", "src/api/helper.ts"], "generated"),
      role: "API boundary", category: "api-boundary" as const,
      identity: { id: "old-api", anchor: "file:src/api/controller.ts", clusterFingerprint: "old", predecessorIds: [] } };
    const after = { ...node("new-api", "module", ["src/api/helper.ts", "src/api/router.ts"], "generated"),
      role: before.role, category: before.category,
      identity: { id: "new-api", anchor: "file:src/api/router.ts", clusterFingerprint: "new", predecessorIds: ["old-api"] } };

    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [after] }),
      graphView({ nodes: [{ ...before, title: "Reviewed API" }] }),
      { nodes: [before], edges: [] });

    expect(migrated.nodes[0].title).toBe(after.title);
    expect(migrated.orphanedNodeEdits).toMatchObject([{ node: { title: "Reviewed API" } }]);
  });
  it("does not infer identity from a cross-directory move without shared files", () => {
    const before = { ...node("old-api", "module", ["src/legacy/api.ts", "src/legacy/controller.ts"], "generated"),
      role: "API boundary", category: "api-boundary" as const,
      identity: { id: "old-api", anchor: "directory:src/legacy", clusterFingerprint: "old", predecessorIds: [] } };
    const after = { ...node("new-api", "module", ["src/current/api.ts", "src/current/controller.ts"], "generated"),
      role: before.role, category: before.category,
      identity: { id: "new-api", anchor: "directory:src/current", clusterFingerprint: "new", predecessorIds: ["old-api"] } };

    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [after] }),
      graphView({ nodes: [{ ...before, title: "Reviewed legacy API" }] }), { nodes: [before], edges: [] });

    expect(migrated.nodes[0].title).toBe(after.title);
    expect(migrated.orphanedNodeEdits).toMatchObject([{
      node: { title: "Reviewed legacy API", files: ["src/legacy/api.ts", "src/legacy/controller.ts"] },
      reason: "removed"
    }]);
  });
  it("leaves a visible module's edits pending when one duty splits into two", () => {
    const before = { ...node("api", "module", ["src/api.ts", "src/worker.ts"], "generated"),
      category: "api-boundary" as const,
      identity: { id: "api", anchor: "api", clusterFingerprint: "before", predecessorIds: [] } };
    const api = { ...before, files: ["src/api.ts"], identity: { ...before.identity, clusterFingerprint: "after" } };
    const worker = { ...node("worker", "module", ["src/worker.ts"], "generated"),
      identity: { id: "worker", anchor: "worker", clusterFingerprint: "worker", predecessorIds: ["api"] } };
    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [api, worker] }),
      graphView({ nodes: [{ ...before, title: "My API" }] }), { nodes: [before], edges: [] });

    expect(migrated.nodes.find((item) => item.id === "api")?.title).toBe("api");
    expect(migrated.orphanedNodeEdits).toMatchObject([{ node: { title: "My API" } }]);
  });
  it("keeps edits unresolved when two successors claim the same predecessor", () => {
    const before = { ...node("combined", "module", ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], "generated"),
      role: "Application service", category: "domain-service" as const,
      identity: { id: "combined", anchor: "directory:app", clusterFingerprint: "before", predecessorIds: [] } };
    const next = [
      { ...node("left", "module", ["src/a.ts", "src/b.ts", "src/left.ts"], "generated"), role: before.role, category: before.category,
        identity: { id: "left", anchor: "file:src/left.ts", clusterFingerprint: "left", predecessorIds: [before.id] } },
      { ...node("right", "module", ["src/c.ts", "src/d.ts", "src/right.ts"], "generated"), role: before.role, category: before.category,
        identity: { id: "right", anchor: "file:src/right.ts", clusterFingerprint: "right", predecessorIds: [before.id] } }
    ];

    const migrated = reconcileGeneratedCanvas(graphView({ nodes: next }),
      graphView({ nodes: [{ ...before, title: "Reviewed boundary" }] }),
      { nodes: [before], edges: [] });

    expect(migrated.nodes.map((item) => item.title)).toEqual(["left", "right"]);
    expect(migrated.orphanedNodeEdits).toMatchObject([{ node: { title: "Reviewed boundary" }, reason: "split-or-merge" }]);
  });
  it("keeps edits from every predecessor unresolved after a module merge", () => {
    const before = [
      { ...node("old-api", "module", ["src/api.ts", "src/shared-a.ts"], "generated"), role: "API", category: "api-boundary" as const,
        identity: { id: "old-api", anchor: "api", clusterFingerprint: "api", predecessorIds: [] } },
      { ...node("old-worker", "module", ["src/worker.ts", "src/shared-b.ts"], "generated"), role: "Worker", category: "domain-service" as const,
        identity: { id: "old-worker", anchor: "worker", clusterFingerprint: "worker", predecessorIds: [] } }
    ];
    const merged = { ...node("merged", "module", ["src/api.ts", "src/shared-a.ts", "src/worker.ts", "src/shared-b.ts"], "generated"),
      role: "Combined service", category: "domain-service" as const,
      identity: { id: "merged", anchor: "combined", clusterFingerprint: "merged", predecessorIds: ["old-api", "old-worker"] } };
    const edited = before.map((item, index) => ({ ...item, title: `Reviewed ${index}` }));

    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [merged] }),
      graphView({ nodes: edited }), { nodes: before, edges: [] });

    expect(migrated.nodes[0].title).toBe(merged.title);
    expect(migrated.orphanedNodeEdits.map((item) => item.node.title).sort()).toEqual(["Reviewed 0", "Reviewed 1"]);
  });
  it("preserves a transferred file only when its previous generated owner also releases it", () => {
    const beforeApi = { ...node("api", "module", ["src/api.ts"], "generated"),
      identity: { id: "api", anchor: "api", clusterFingerprint: "before-api", predecessorIds: [] } };
    const beforeData = { ...node("data", "module", ["src/data.ts", "src/shared.ts"], "generated"),
      identity: { id: "data", anchor: "data", clusterFingerprint: "before-data", predecessorIds: [] } };
    const afterApi = { ...beforeApi, files: ["src/api.ts", "src/router.ts"],
      identity: { ...beforeApi.identity, clusterFingerprint: "after-api" } };
    const afterData = { ...beforeData, identity: { ...beforeData.identity, clusterFingerprint: "after-data" } };
    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [afterApi, afterData] }),
      graphView({ nodes: [{ ...beforeApi, files: ["src/api.ts", "src/shared.ts"] },
        { ...beforeData, files: ["src/data.ts"] }] }),
      { nodes: [beforeApi, beforeData], edges: [] },
      new Set(["src/api.ts", "src/router.ts", "src/data.ts", "src/shared.ts"]));

    expect(migrated.nodes.find((item) => item.id === "api")?.files).toEqual(["src/api.ts", "src/router.ts", "src/shared.ts"]);
    expect(migrated.nodes.find((item) => item.id === "data")?.files).toEqual(["src/data.ts"]);
    expect(migrated.migrationPendingItems).toEqual([]);
  });
  it("keeps hidden generated objects hidden when their stable identities are renamed", () => {
    const oldNodes = [
      { ...node("old-api", "module", ["src/api.ts"], "generated"), identity: { id: "old-api", anchor: "api", clusterFingerprint: "api-facts", predecessorIds: [] } },
      { ...node("data", "module", ["src/data.ts"], "generated"), identity: { id: "data", anchor: "data", clusterFingerprint: "data-facts", predecessorIds: [] } }
    ];
    const oldEdge: GraphEdge = { id: "old-link", source: "old-api", target: "data", relation: "calls", sourceRelationIds: ["call-fact"], origin: "generated" };
    const existing = graphView({ nodes: [oldNodes[1]], edges: [], hiddenGeneratedNodeIds: ["old-api"], hiddenGeneratedEdgeIds: ["old-link"] });
    const generated = graphView({
      nodes: [{ ...node("new-api", "module", ["src/api.ts"], "generated"), identity: { id: "new-api", anchor: "api", clusterFingerprint: "api-facts", predecessorIds: ["old-api"] } }, oldNodes[1]],
      edges: [{ ...oldEdge, id: "new-link", source: "new-api" }]
    });

    const reconciled = reconcileGeneratedCanvas(generated, existing, { nodes: oldNodes, edges: [oldEdge] });

    expect(reconciled.nodes.map((item) => item.id)).toEqual(["data"]);
    expect(reconciled.edges).toEqual([]);
    expect(reconciled.hiddenGeneratedNodeIds).toEqual(["new-api"]);
    expect(reconciled.hiddenGeneratedEdgeIds).toEqual(["new-link"]);
  });
  it("keeps conflicting hidden tombstones pending without duplication across three rescans", () => {
    const oldNodes = [
      { ...node("api", "module", ["src/api.ts"], "generated"), identity: { id: "api", anchor: "api", clusterFingerprint: "old", predecessorIds: [] } },
      { ...node("data", "module", ["src/data.ts"], "generated"), identity: { id: "data", anchor: "data", clusterFingerprint: "data", predecessorIds: [] } }
    ];
    const oldEdge: GraphEdge = { id: "link", source: "api", target: "data", relation: "calls", sourceRelationIds: ["old-call"], origin: "generated" };
    const existing = graphView({ nodes: [oldNodes[1]], edges: [], hiddenGeneratedNodeIds: ["api"], hiddenGeneratedEdgeIds: ["link"] });
    const generated = graphView({ nodes: [
      { ...node("api", "module", ["src/job.ts"], "generated"), identity: { id: "api", anchor: "job", clusterFingerprint: "new", predecessorIds: [] } }, oldNodes[1]
    ], edges: [{ ...oldEdge, sourceRelationIds: ["new-call"] }] });

    const reconciled = reconcileGeneratedCanvas(generated, existing, { nodes: oldNodes, edges: [oldEdge] });

    expect(reconciled.nodes.map((item) => item.id)).toContain("api");
    expect(reconciled.edges.map((item) => item.id)).toContain("link");
    expect(reconciled.migrationPendingItems).toMatchObject([
      { kind: "node", sourceId: "api" }, { kind: "edge", sourceId: "link" }
    ]);
    const second = reconcileGeneratedCanvas(generated, reconciled, { nodes: generated.nodes, edges: generated.edges });
    const third = reconcileGeneratedCanvas(generated, second, { nodes: generated.nodes, edges: generated.edges });
    expect(second.migrationPendingItems).toEqual(reconciled.migrationPendingItems);
    expect(third.migrationPendingItems).toEqual(reconciled.migrationPendingItems);
  });
  it("shows a relation when its aggregate gains a new source fact", () => {
    const modules = [node("api", "module", ["src/api.ts"], "generated"),
      node("data", "module", ["src/data.ts"], "generated")];
    const previous: GraphEdge = { id: "link", source: "api", target: "data", relation: "calls",
      sourceRelationIds: ["call-a"], origin: "generated" };
    const existing = graphView({ nodes: modules, edges: [], hiddenGeneratedEdgeIds: [previous.id] });
    const generated = graphView({ nodes: modules, edges: [{ ...previous, sourceRelationIds: ["call-a", "call-b"] }] });

    const migrated = reconcileGeneratedCanvas(generated, existing, { nodes: modules, edges: [previous] });

    expect(migrated.edges).toEqual(generated.edges);
    expect(migrated.hiddenGeneratedEdgeIds).toEqual([]);
    expect(migrated.migrationPendingItems).toMatchObject([{ kind: "edge", sourceId: "link" }]);
  });
  it("keeps a hidden module hidden when its anchored duty gains a file", () => {
    const previous = { ...node("api", "module", ["src/api.ts"], "generated"), role: "API", category: "api-boundary" as const,
      identity: { id: "api", anchor: "api", clusterFingerprint: "before", predecessorIds: [] } };
    const next = { ...previous, files: ["src/api.ts", "src/router.ts"],
      identity: { id: "api", anchor: "api", clusterFingerprint: "after", predecessorIds: [] } };
    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [next] }),
      graphView({ nodes: [], hiddenGeneratedNodeIds: ["api"] }), { nodes: [previous], edges: [] });

    expect(migrated.nodes).toEqual([]);
    expect(migrated.hiddenGeneratedNodeIds).toEqual(["api"]);
    expect(migrated.migrationPendingItems).toEqual([]);
  });
  it("shows a new duty even when the anchor and cluster fingerprint are reused", () => {
    const previous = { ...node("api", "module", ["src/api.ts"], "generated"), role: "API", category: "api-boundary" as const,
      identity: { id: "api", anchor: "api", clusterFingerprint: "same-cluster", predecessorIds: [] } };
    const next = { ...previous, role: "Background job" };
    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [next] }),
      graphView({ nodes: [], hiddenGeneratedNodeIds: ["api"] }), { nodes: [previous], edges: [] });

    expect(migrated.nodes).toEqual([next]);
    expect(migrated.hiddenGeneratedNodeIds).toEqual([]);
    expect(migrated.migrationPendingItems).toMatchObject([{ kind: "node", sourceId: "api" }]);
  });
  it("keeps a hidden generated resource hidden when its semantic identity is unchanged", () => {
    const resource = { id: "resource:database", kind: "database" as const, scopeId: "service", key: "primary",
      title: "Primary database", detail: "Database endpoint", evidence: [] };
    const previous = { ...node(resource.id, "module", [], "generated"), resource };
    const next = { ...previous, resource: { ...resource, detail: "Updated evidence" } };
    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [next] }),
      graphView({ nodes: [], hiddenGeneratedNodeIds: [previous.id] }), { nodes: [previous], edges: [] });

    expect(migrated.nodes).toEqual([]);
    expect(migrated.hiddenGeneratedNodeIds).toEqual([next.id]);
    expect(migrated.migrationPendingItems).toEqual([]);
  });
  it("does not carry a hidden module through a split with two successor duties", () => {
    const previous = { ...node("api", "module", ["src/api.ts", "src/worker.ts"], "generated"), role: "API",
      category: "api-boundary" as const,
      identity: { id: "api", anchor: "api", clusterFingerprint: "before", predecessorIds: [] } };
    const first = { ...previous, files: ["src/api.ts"], identity: { ...previous.identity, clusterFingerprint: "after" } };
    const second = { ...node("worker", "module", ["src/worker.ts"], "generated"), role: "Worker",
      identity: { id: "worker", anchor: "worker", clusterFingerprint: "worker", predecessorIds: [] } };
    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [first, second] }),
      graphView({ nodes: [], hiddenGeneratedNodeIds: [previous.id] }), { nodes: [previous], edges: [] });

    expect(migrated.nodes).toEqual([first, second]);
    expect(migrated.hiddenGeneratedNodeIds).toEqual([]);
    expect(migrated.migrationPendingItems).toMatchObject([{ kind: "node", sourceId: "api" }]);
  });
  it("invalidates only assessment inputs, including relations but excluding layout and guidance", () => {
    const nodes = [node("api", "module", ["src/api.ts"], "generated"), node("data", "module", ["src/data.ts"], "generated")];
    const relation: GraphEdge = { id: "call", source: "api", target: "data", relation: "calls", origin: "generated" };
    const generated = graphView({ nodes, edges: [relation] });
    const corrected = graphView({ nodes, edges: [{ ...relation, relation: "imports" }] });
    const correctedFiles = graphView({ nodes: [{ ...nodes[0], files: ["src/api.ts", "src/new.ts"] }, nodes[1]], edges: [relation] });
    const changedDuty = graphView({ nodes: [{ ...nodes[0], role: "Background worker" }, nodes[1]], edges: [relation] });
    const presentationOnly = graphView({ nodes: [{ ...nodes[0], x: 100 }, nodes[1]], edges: [{ ...relation, guidanceNote: "Review" }] });

    expect(Object.keys(createCanvasUserState(generated, corrected, "generation", 1).assessmentInvalidations ?? {})).toEqual(["api", "data"]);
    expect(Object.keys(createCanvasUserState(generated, correctedFiles, "generation", 1).assessmentInvalidations ?? {})).toEqual(["api"]);
    expect(Object.keys(createCanvasUserState(generated, changedDuty, "generation", 1).assessmentInvalidations ?? {})).toEqual(["api"]);
    expect(createCanvasUserState(generated, presentationOnly, "generation", 1).assessmentInvalidations).toEqual({});
    expect(createCanvasUserState(generated, graphView({ nodes, edges: [{ ...relation, id: "renamed-call" }] }), "generation", 1).assessmentInvalidations).toEqual({});
  });
  it("does not save a pending unknown risk as a manual edit across a new assessment", () => {
    const baseline = { ...node("api", "module", ["src/api.ts"], "generated"), risk: "high" as const };
    const pending = { ...baseline, risk: "unknown" as const, assessmentPending: true };
    const generated = graphView({ nodes: [baseline] });
    const existing = graphView({ nodes: [pending] });
    expect(createCanvasUserState(generated, existing, "generation", 1).nodeEdits.api).toBeUndefined();
    expect(reconcileGeneratedCanvas(generated, existing, { nodes: [baseline], edges: [] }).nodes[0].risk).toBe("high");
  });
  it("keeps an override while using the new generation's system assessment", () => {
    const high = { ...unknownAssessment("old", "2026-10-03"),
      risk: { systemScore: 90, systemLevel: "high" as const, effectiveLevel: "low" as const, factors: [],
        override: { level: "low" as const, reason: "Reviewed", createdAt: "2026-10-03" } } };
    const medium = { ...unknownAssessment("new", "2026-10-03"),
      risk: { systemScore: 50, systemLevel: "medium" as const, effectiveLevel: "medium" as const, factors: [] } };
    const oldNode = { ...node("api", "module", ["src/api.ts"], "generated"), assessment: high, risk: "low" as const };
    const nextNode = { ...node("api", "module", ["src/api.ts"], "generated"), assessment: medium, risk: "medium" as const };

    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [nextNode] }), graphView({ nodes: [oldNode] }),
      { nodes: [oldNode], edges: [] });

    expect(migrated.nodes[0].assessment?.risk).toMatchObject({ systemLevel: "medium", effectiveLevel: "low",
      override: { level: "low", reason: "Reviewed" } });
  });
  it("retains the system level at an override through rescan reconciliation", () => {
    const previous = { ...node("api", "module", ["src/api.ts"], "generated"), risk: "high" as const,
      assessment: { ...unknownAssessment("before", "2026-10-03"), risk: { systemLevel: "low" as const,
        effectiveLevel: "high" as const, factors: [], override: { level: "high" as const, reason: "Reviewed",
          createdAt: "2026-10-03", systemLevelAtOverride: "low" as const } } } };
    const next = { ...previous, risk: "high" as const, assessment: { ...unknownAssessment("after", "2026-10-03"),
      risk: { systemLevel: "high" as const, effectiveLevel: "high" as const, factors: [] } } };
    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [next] }), graphView({ nodes: [previous] }),
      { nodes: [previous], edges: [] });
    expect(migrated.nodes[0].assessment?.risk).toMatchObject({ systemLevel: "high", previousSystemLevel: "low",
      systemLevelChanged: true, override: { level: "high", systemLevelAtOverride: "low" } });
    expect(createCanvasUserState(graphView({ nodes: [next] }), migrated, "after", 1).riskOverrides?.api)
      .toMatchObject({ level: "high", systemLevelAtOverride: "low" });
  });
  it("leaves an ambiguous hidden module visible for review instead of hiding a coincidental successor", () => {
    const oldNodes = [node("old-a", "module", ["src/shared.ts"], "generated"), node("old-b", "module", ["src/shared.ts"], "generated")];
    const existing = graphView({ nodes: [], edges: [], hiddenGeneratedNodeIds: oldNodes.map((item) => item.id) });
    const generated = graphView({ nodes: [node("new-a", "module", ["src/shared.ts"], "generated")] });

    const reconciled = reconcileGeneratedCanvas(generated, existing, { nodes: oldNodes, edges: [] });

    expect(reconciled.nodes.map((item) => item.id)).toEqual(["new-a"]);
    expect(reconciled.hiddenGeneratedNodeIds).toEqual([]);
    expect(reconciled.orphanedNodeEdits).toHaveLength(2);
  });

  it("maps a user's file correction by the original generated membership", () => {
    const before = node("old-api", "module", ["src/api.ts"], "generated");
    const existing = graphView({ nodes: [{ ...before, files: ["src/corrected.ts"] }] });
    const generated = graphView({ nodes: [node("new-api", "module", ["src/api.ts"], "generated")] });

    const reconciled = reconcileGeneratedCanvas(generated, existing, { nodes: [before], edges: [] });

    expect(reconciled.nodes[0]).toMatchObject({ id: "new-api", files: ["src/corrected.ts"] });
  });
  it("keeps a corrected generated relation across unique relation and module ID changes", () => {
    const oldNodes = [node("old-api", "module", ["src/api.ts"], "generated"), node("data", "module", ["src/data.ts"], "generated")];
    const baseline: GraphEdge = { id: "old-call", source: "old-api", target: "data", relation: "calls", confidence: "confirmed", origin: "generated" };
    const existing = graphView({ nodes: oldNodes, edges: [{ ...baseline, source: "data", target: "old-api", relation: "imports", confidence: "inferred", evidence: [] }] });
    const generated = graphView({ nodes: [node("new-api", "module", ["src/api.ts"], "generated"), oldNodes[1]],
      edges: [{ ...baseline, id: "new-call", source: "new-api" }] });

    const reconciled = reconcileGeneratedCanvas(generated, existing, { nodes: oldNodes, edges: [baseline] });

    expect(reconciled.edges).toMatchObject([{ id: "new-call", source: "data", target: "new-api", relation: "imports", confidence: "inferred", evidence: [] }]);
    expect(reconciled.orphanedEdges).toEqual([]);
  });
  it("preserves ambiguous v1-v4 nodes and edges while transferring only exact module positions", () => {
    const oldNode = { ...node("old", "module", ["src/one.ts"], undefined), x: 70, y: 90 };
    const legacy: LegacyCanvasV1To4 = {
      version: 4,
      nodes: [],
      edges: [],
      rawNodes: [oldNode],
      rawEdges: [{ id: "old-edge", source: "old", target: "missing", relation: "calls" }],
      layout: { activeMode: "manual", manualPositions: { old: { x: 70, y: 90 } }, autoLayouts: {}, collapsedGroups: [] }
    };
    const generated = graphView({ nodes: [node("new", "module", ["src/one.ts"], "generated")] });

    const migrated = reconcileGeneratedCanvas(generated, legacy);

    expect(migrated.layout).toMatchObject({
      activeMode: "manual",
      viewMode: "execution",
      manualPositions: { new: { x: 70, y: 90 } }
    });
    expect(migrated.migrationPendingItems).toMatchObject([
      { kind: "node", sourceVersion: 4, sourceId: "old", raw: oldNode },
      { kind: "edge", sourceVersion: 4, sourceId: "old-edge", raw: legacy.rawEdges[0] }
    ]);
  });

  it("keeps v1-v4 migration payloads through subsequent v7 rescans", () => {
    const legacy: LegacyCanvasV1To4 = {
      version: 4,
      nodes: [],
      edges: [],
      rawNodes: [{ id: "legacy", title: "Preserved" }],
      rawEdges: []
    };
    const generated = graphView({ nodes: [node("current", "module", ["src/current.ts"], "generated")] });
    const first = reconcileGeneratedCanvas(generated, legacy);

    const second = reconcileGeneratedCanvas(generated, first);

    expect(second.migrationPendingItems).toEqual(first.migrationPendingItems);
  });

  it.each(["Keep this unsent instruction.", "", undefined])("preserves edge guidance %j across unique endpoint and edge ID renames", (guidanceNote) => {
    const oldNode = node("old", "module", ["src/one.ts"], "generated");
    const before: GraphEdge = { id: "old-link", source: "old", target: "old", relation: "calls", guidanceNote: "Old generated instruction.", origin: "generated" };
    const existing = graphView({ nodes: [oldNode], edges: [{ ...before, guidanceNote }] });
    const generated = graphView({
      nodes: [node("new", "module", ["src/one.ts"], "generated")],
      edges: [{ ...before, id: "new-link", source: "new", target: "new", guidanceNote: "New generated instruction.", evidence: [{ filePath: "src/one.ts", detail: "Fresh fact" }] }]
    });
    const original = JSON.stringify({ existing, generated });

    const reconciled = reconcileGeneratedCanvas(generated, existing, { nodes: [oldNode], edges: [before] });

    expect(reconciled.edges[0]).toMatchObject({ id: "new-link", source: "new", target: "new", evidence: generated.edges[0].evidence });
    expect(reconciled.edges[0].guidanceNote).toBe(guidanceNote);
    expect(reconciled.orphanedEdges).toEqual([]);
    expect(JSON.stringify({ existing, generated })).toBe(original);
  });

  it("refreshes generated edge wording when the old generated baseline shows no user edit", () => {
    const oldNode = node("old", "module", ["src/one.ts"], "generated");
    const before: GraphEdge = { id: "link", source: "old", target: "old", relation: "calls", guidanceNote: "Old fact", origin: "generated" };
    const generated = graphView({ nodes: [node("new", "module", ["src/one.ts"], "generated")], edges: [{ ...before, source: "new", target: "new", guidanceNote: "New fact" }] });
    const reconciled = reconcileGeneratedCanvas(generated, graphView({ nodes: [oldNode], edges: [before] }), { nodes: [oldNode], edges: [before] });
    expect(reconciled.edges[0].guidanceNote).toBe("New fact");
  });

  it("preserves generated v5 edge notes and uses a supplied generated baseline", () => {
    const oldNode = legacyGeneratedNode("old", ["src/one.ts"]);
    const before: GraphEdge = { id: "old-link", source: "old", target: "old", relation: "calls", guidanceNote: "Old fact", origin: "generated" };
    const generated = graphView({ nodes: [node("new", "module", ["src/one.ts"], "generated")], edges: [{ ...before, id: "new-link", source: "new", target: "new", guidanceNote: "New fact" }] });
    const existing: LegacyCanvasV5 = { ...canvasBase(), version: 5, nodes: [oldNode], edges: [{ ...before, guidanceNote: "" }] };
    expect(reconcileGeneratedCanvas(generated, existing).edges[0].guidanceNote).toBe("");
    expect(reconcileGeneratedCanvas(generated, { ...existing, edges: [before] }, { nodes: [oldNode], edges: [before] }).edges[0].guidanceNote).toBe("New fact");
  });

  it.each([
    { source: "other" },
    { target: "other" },
    { relation: "depends_on" as const }
  ])("preserves generated-edge correction %j without presenting old evidence as confirmation", (edit) => {
    const oldNodes = [node("one", "module", ["src/one.ts"], "generated"), node("other", "module", ["src/other.ts"], "generated")];
    const before: GraphEdge = { id: "link", source: "one", target: "one", relation: "calls", guidanceNote: "Generated fact", origin: "generated" };
    const edited: GraphEdge = { ...before, ...edit, guidanceNote: "Unsent instruction", evidence: [{ filePath: "src/one.ts", detail: "Old evidence" }] };
    const generated = graphView({ nodes: oldNodes, edges: [{ ...before, guidanceNote: "Fresh fact" }] });
    const reconciled = reconcileGeneratedCanvas(generated, graphView({ nodes: oldNodes, edges: [edited] }), { nodes: oldNodes, edges: [before] });
    expect(reconciled.edges[0]).toMatchObject({ ...edit, guidanceNote: "Unsent instruction", confidence: "inferred", evidence: [] });
    expect(reconciled.orphanedEdges).toEqual([]);
  });

  it.each(["split", "merge", "duplicate-relations", "removed-resource"])("orphanizes unsent guidance for %s without assigning it to a coincidental ID", (scenario) => {
    const old = node("one", "module", ["src/one.ts", "src/two.ts"], "generated");
    const resource = { ...node("resource", "module", [], "generated"), resource: { id: "resource", kind: "database" as const, scopeId: "scope", key: "db", title: "DB", detail: "Database", evidence: [] } };
    const oldNodes = scenario === "removed-resource" ? [old, resource] : scenario === "merge" ? [old, node("two", "module", ["src/two.ts"], "generated")] : [old];
    const before: GraphEdge = { id: "link", source: "one", target: scenario === "removed-resource" ? "resource" : "one", relation: "calls", origin: "generated" };
    const edited = { ...before, guidanceNote: "Do not lose me.", evidence: [{ filePath: "src/one.ts", detail: "Original evidence" }] };
    const newNodes = scenario === "split" ? [node("one", "module", ["src/one.ts"], "generated"), node("two", "module", ["src/two.ts"], "generated")] : [old];
    const edges = scenario === "duplicate-relations" ? [{ ...before, id: "new-1" }, { ...before, id: "new-2" }] : [{ ...before, target: "one" }];
    const reconciled = reconcileGeneratedCanvas(graphView({ nodes: newNodes, edges }), graphView({ nodes: oldNodes, edges: [edited] }), { nodes: oldNodes, edges: [before] });
    expect(reconciled.edges.every((edge) => edge.guidanceNote === undefined)).toBe(true);
    expect(reconciled.orphanedEdges).toEqual([edited]);
  });

  it("reserves stable edge IDs before matching the remaining unique relation", () => {
    const module = node("one", "module", ["src/one.ts"], "generated");
    const before: GraphEdge = { id: "stable", source: "one", target: "one", relation: "calls", origin: "generated" };
    const oldEdges = [before, { ...before, id: "old" }];
    const generated = graphView({ nodes: [module], edges: [before, { ...before, id: "new" }] });
    const existing = graphView({ nodes: [module], edges: [{ ...before, guidanceNote: "Stable note" }, { ...before, id: "old", guidanceNote: "Renamed note" }] });
    const reconciled = reconcileGeneratedCanvas(generated, existing, { nodes: [module], edges: oldEdges });
    expect(reconciled.edges.map(({ id, guidanceNote }) => ({ id, guidanceNote }))).toEqual([{ id: "stable", guidanceNote: "Stable note" }, { id: "new", guidanceNote: "Renamed note" }]);
  });

  it.each([5, 6] as const)("preserves a manual edge in legacy Canvas v%s when a generated edge reuses its ID", (version) => {
    const module = node("one", "module", ["src/one.ts"], "generated");
    const fact: GraphEdge = { id: "collision", source: "one", target: "one", relation: "calls", origin: "generated" };
    const manual: GraphEdge = { ...fact, relation: "depends_on", guidanceNote: "Manual intent", origin: "manual" };
    const generated = graphView({ nodes: [module], edges: [fact] });
    const existing = legacyCanvas(version, { nodes: [module], edges: [manual] });
    const reconciled = reconcileGeneratedCanvas(generated, existing, undefined);
    expect(reconciled.edges).toEqual([fact]);
    expect(reconciled.orphanedEdges).toEqual([manual]);
  });

  it("replaces generated directory nodes, keeps manual nodes, and remaps edges only by file identity", () => {
    const note = node("note", "doc", [], "manual");
    const existing: LegacyCanvasV5 = {
      ...canvasBase(),
      version: 5,
      layout: {
        activeMode: "manual",
        manualPositions: { note: { x: 5, y: 6 }, "old-accounts": { x: 100, y: 200 } },
        autoLayouts: { execution: { "old-accounts": { x: 90, y: 90 } } },
        collapsedGroups: ["old-accounts"]
      },
      nodes: [
        legacyGeneratedNode("old-accounts", ["src/features/accounts/account.service.ts"]),
        legacyGeneratedNode("coincidental", ["src/legacy/index.ts"]),
        note
      ],
      edges: [
        { id: "account-link", source: "note", target: "old-accounts", relation: "depends_on", origin: "manual" },
        { id: "coincidental-link", source: "note", target: "coincidental", relation: "calls", origin: "manual" },
        { id: "dangling-link", source: "note", target: "gone", relation: "calls", origin: "manual" }
      ],
      orphanedEdges: [{ id: "already-orphaned", source: "note", target: "old-missing", relation: "calls", origin: "manual" }]
    };
    const generated = graphView({
      layout: { activeMode: "execution", viewMode: "execution", manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
      nodes: [{ ...node("accounts", "module", ["src/features/accounts/account.service.ts"], "generated"), title: "Accounts", description: "New functional module." }],
      edges: [{ id: "runtime", source: "accounts", target: "accounts", relation: "calls", origin: "generated" }]
    });

    const migrated = reconcileGeneratedCanvas(generated, existing);

    expect(migrated).not.toHaveProperty("version");
    expect(migrated.nodes.map((item) => item.id)).toEqual(["accounts", "note"]);
    expect(migrated.nodes.find((item) => item.id === "accounts")).toMatchObject({
      title: "Accounts",
      description: "New functional module."
    });
    expect(migrated.nodes.find((item) => item.id === "note")?.guidanceDraft).toBe("keep note");
    expect(migrated.edges).toEqual([
      expect.objectContaining({ id: "runtime" }),
      expect.objectContaining({ id: "account-link", target: "accounts" })
    ]);
    expect(migrated.orphanedEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "already-orphaned" }),
      expect.objectContaining({ id: "coincidental-link" }),
      expect.objectContaining({ id: "dangling-link" })
    ]));
    expect(migrated.layout).toMatchObject({
      activeMode: "manual",
      viewMode: "execution",
      manualPositions: { note: { x: 5, y: 6 }, accounts: { x: 100, y: 200 } },
      autoLayouts: {},
      collapsedGroups: []
    });
  });

  it("retains saved view preference, manual content, user edits, and layouts on rescan", () => {
    const generated = graphView({
      nodes: [node("accounts", "module", ["src/features/accounts/account.service.ts"], "generated")],
      edges: []
    });
    const existing = graphView({
      layout: {
        activeMode: "dependency",
        viewMode: "dependency",
        manualPositions: { accounts: { x: 8, y: 9 } },
        autoLayouts: { dependency: { accounts: { x: 40, y: 50 } } },
        collapsedGroups: []
      },
      nodes: [
        { ...node("accounts", "module", ["src/features/accounts/account.service.ts"], "generated"), title: "My Accounts", description: "User wording.", guidanceDraft: "Keep this note." },
        node("note", "doc", [], "manual")
      ],
      edges: [{ id: "manual-link", source: "note", target: "accounts", relation: "depends_on", origin: "manual" }]
    });

    const reconciled = reconcileGeneratedCanvas(generated, existing);

    expect(reconciled.layout?.viewMode).toBe("dependency");
    expect(reconciled.layout?.manualPositions.accounts).toEqual({ x: 8, y: 9 });
    expect(reconciled.layout?.autoLayouts.dependency?.accounts).toEqual({ x: 40, y: 50 });
    expect(reconciled.nodes.find((item) => item.id === "accounts")).toMatchObject({
      title: "My Accounts",
      description: "User wording.",
      guidanceDraft: "Keep this note."
    });
    expect(reconciled.nodes.map((item) => item.id)).toContain("note");
    expect(reconciled.edges).toContainEqual(expect.objectContaining({ id: "manual-link" }));
  });

  it("keeps generated module positions when a manual layout is rescanned without topology changes", () => {
    const existing = graphView({
      layout: {
        activeMode: "manual",
        viewMode: "execution",
        manualPositions: { accounts: { x: 100, y: 120 } },
        autoLayouts: {},
        collapsedGroups: []
      },
      nodes: [
        { ...node("accounts", "module", ["src/accounts.ts"], "generated"), x: 300, y: 240 },
        node("note", "doc", [], "manual")
      ]
    });
    const generated = graphView({ nodes: [node("accounts", "module", ["src/accounts.ts"], "generated")] });

    const reconciled = reconcileGeneratedCanvas(generated, existing);

    expect(reconciled.layout?.activeMode).toBe("manual");
    expect(reconciled.nodes.find((item) => item.id === "accounts")).toMatchObject({ x: 300, y: 240 });
    expect(reconciled.nodes.map((item) => item.id)).toContain("note");
  });

  it("remaps manual edge endpoints when a module ID changes but file identity stays unique", () => {
    const existing = graphView({
      nodes: [
        node("old-accounts", "module", ["src/features/accounts/account.service.ts"], "generated"),
        node("note", "doc", [], "manual")
      ],
      edges: [{ id: "manual-link", source: "note", target: "old-accounts", relation: "calls", origin: "manual" }]
    });
    const generated = graphView({
      nodes: [node("new-accounts", "module", ["src/features/accounts/account.service.ts"], "generated")]
    });

    const reconciled = reconcileGeneratedCanvas(generated, existing);

    expect(reconciled.edges).toContainEqual(expect.objectContaining({
      id: "manual-link",
      source: "note",
      target: "new-accounts",
      origin: "manual"
    }));
    expect(reconciled.orphanedEdges).not.toContainEqual(expect.objectContaining({ id: "manual-link" }));
  });

  it("returns a manual layout to automatic layout when a rescan adds a generated module", () => {
    const existing = graphView({
      layout: {
        activeMode: "manual",
        viewMode: "execution",
        manualPositions: { accounts: { x: 100, y: 120 } },
        autoLayouts: {},
        collapsedGroups: []
      },
      nodes: [{ ...node("accounts", "module", ["src/accounts.ts"], "generated"), x: 300, y: 240 }]
    });
    const generated = graphView({
      nodes: [
        node("accounts", "module", ["src/accounts.ts"], "generated"),
        node("billing", "module", ["src/billing.ts"], "generated")
      ]
    });

    const reconciled = reconcileGeneratedCanvas(generated, existing);

    expect(reconciled.layout?.activeMode).toBe("execution");
    expect(reconciled.layout?.viewMode).toBe("execution");
  });

  it("orphanizes a manual edge when v5 module identity maps to multiple v6 modules", () => {
    const existing: LegacyCanvasV5 = {
      ...canvasBase(),
      version: 5,
      nodes: [node("old-feature", "module", ["src/one.ts", "src/two.ts"], "generated")],
      edges: [{ id: "ambiguous-link", source: "old-feature", target: "external", relation: "calls", origin: "manual" }]
    };
    const generated = graphView({
      nodes: [
        node("one", "module", ["src/one.ts"], "generated"),
        node("two", "module", ["src/two.ts"], "generated")
      ]
    });

    const migrated = reconcileGeneratedCanvas(generated, existing);

    expect(migrated.edges).not.toContainEqual(expect.objectContaining({ id: "ambiguous-link" }));
    expect(migrated.orphanedEdges).toContainEqual(expect.objectContaining({ id: "ambiguous-link" }));
    expect(migrated.layout?.collapsedGroups).toEqual([]);
  });

  it("adds a newly available overview group once and keeps a later user expansion", () => {
    const previous = node("one", "module", ["src/one.ts"], "generated");
    const generated = graphView({
      nodes: [{ ...previous, overviewGroup: { id: "view:unlinked", title: "No confirmed calls", rootPath: "" } }],
      layout: { activeMode: "execution", viewMode: "execution", manualPositions: {}, autoLayouts: {}, collapsedGroups: ["view:unlinked"] }
    });
    const migrated = reconcileGeneratedCanvas(generated, graphView({ nodes: [previous] }));
    expect(migrated.layout?.collapsedGroups).toEqual(["view:unlinked"]);
    const expanded = reconcileGeneratedCanvas(generated, { ...migrated, layout: { ...migrated.layout!, collapsedGroups: [] } });
    expect(expanded.layout?.collapsedGroups).toEqual([]);
  });

  it("preserves split and merge user edits as unresolved instead of assigning them to an arbitrary successor", () => {
    const before = node("combined", "module", ["src/one.ts", "src/two.ts"], "generated");
    const edited = { ...before, title: "My boundary", guidanceDraft: "Keep this pending note." };
    const existing = graphView({ nodes: [edited] });
    const generated = graphView({ nodes: [
      node("combined", "module", ["src/one.ts"], "generated"),
      node("two", "module", ["src/two.ts"], "generated")
    ] });
    const reconciled = reconcileGeneratedCanvas(generated, existing, { nodes: [before], edges: [] });
    expect(reconciled.nodes.every((node) => node.guidanceDraft === "")).toBe(true);
    expect(reconciled.orphanedNodeEdits).toEqual([{
      node: edited,
      edits: { title: "My boundary", guidanceDraft: "Keep this pending note." },
      reason: "split-or-merge"
    }]);
  });

  it("does not transfer v5 edits across modules that only share one file", () => {
    const previous = legacyGeneratedNode("old-api-user", ["src/api/user.ts", "src/shared.ts"]);
    const edited = { ...previous, title: "Edited API responsibility", guidanceDraft: "Keep this with the API." };
    const existing: LegacyCanvasV5 = { ...canvasBase(), version: 5, nodes: [edited], edges: [] };
    const current = node("storage-user", "module", ["src/storage/user.ts", "src/shared.ts"], "generated");

    const migrated = reconcileGeneratedCanvas(graphView({ nodes: [current] }), existing);

    expect(migrated.nodes[0]).toMatchObject({ id: "storage-user", title: "storage-user", guidanceDraft: "" });
    expect(migrated.orphanedNodeEdits).toContainEqual({ node: edited, reason: "split-or-merge" });
  });

  it.each([5, 6] as const)("preserves an unmatched v%s manual position for migration review", (version) => {
    const oldNode = version === 5
      ? legacyGeneratedNode("old-api-user", ["src/api/user.ts"])
      : node("old-api-user", "module", ["src/api/user.ts"], "generated");
    const existing = legacyCanvas(version, {
      layout: { activeMode: "manual", viewMode: "execution", manualPositions: { "old-api-user": { x: 120, y: 240 } }, autoLayouts: {}, collapsedGroups: [] },
      nodes: [oldNode]
    });
    const generated = graphView({ nodes: [node("new-storage-user", "module", ["src/storage/user.ts"], "generated")] });

    const migrated = reconcileGeneratedCanvas(generated, existing);

    expect(migrated.orphanedNodeEdits).toContainEqual({
      node: { ...oldNode, x: 120, y: 240 },
      edits: { x: 120, y: 240 },
      reason: "removed"
    });
  });

  it("remaps manual coordinates and preserves override risk on a unique identity rename", () => {
    const before = node("old", "module", ["src/one.ts"], "generated");
    const existing = graphView({
      nodes: [{ ...before, risk: "high", x: 75, y: 90 }],
      layout: { activeMode: "manual", viewMode: "dependency", manualPositions: { old: { x: 75, y: 90 } }, autoLayouts: {}, collapsedGroups: [] }
    });
    const reconciled = reconcileGeneratedCanvas(graphView({ nodes: [node("new", "module", ["src/one.ts"], "generated")] }), existing, { nodes: [before], edges: [] });
    expect(reconciled.nodes[0]).toMatchObject({ id: "new", risk: "high", x: 75, y: 90 });
    expect(reconciled.layout?.manualPositions).toEqual({ new: { x: 75, y: 90 } });
  });

  it("retains the user risk override while refreshing generated assessment evidence", () => {
    const previous = node("one", "module", ["src/one.ts"], "generated");
    const oldAssessment = unknownAssessment("old-scan", "2026-09-01T00:00:00.000Z");
    const newAssessment = unknownAssessment("new-scan", "2026-09-28T00:00:00.000Z");
    const override = { level: "high" as const, reason: "User reviewed boundary.", createdAt: "2026-09-02T00:00:00.000Z" };
    const existing = graphView({ nodes: [{ ...previous, risk: "high", assessment: { ...oldAssessment, risk: { ...oldAssessment.risk, override, effectiveLevel: "high" } } }] });
    const generated = graphView({ nodes: [{ ...previous, assessment: newAssessment }] });
    const reconciled = reconcileGeneratedCanvas(generated, existing, { nodes: [{ ...previous, assessment: oldAssessment }], edges: [] });
    expect(reconciled.nodes[0].assessment).toMatchObject({ fingerprint: "new-scan", risk: { override, effectiveLevel: "high" } });
  });

  it("keeps only customized v5 module text when its file identity maps uniquely", () => {
    const legacy = legacyGeneratedNode("old-billing", ["src/billing/service.ts"]);
    const existing: LegacyCanvasV5 = {
      ...canvasBase(),
      version: 5,
      nodes: [{ ...legacy, title: "Payments", description: "Owns payment orchestration.", guidanceDraft: "Keep changes inside payment workflows." }],
      edges: []
    };
    const generated = graphView({
      nodes: [{
        ...node("billing-v6", "module", ["src/billing/service.ts"], "generated"),
        title: "Billing Domain",
        description: "Billing owns invoices, plans, and payment state.",
        guidanceDraft: "Use the semantic evidence for Billing Domain."
      }]
    });

    const migrated = reconcileGeneratedCanvas(generated, existing);

    expect(migrated.nodes[0]).toMatchObject({
      title: "Payments",
      description: "Owns payment orchestration.",
      guidanceDraft: "Keep changes inside payment workflows."
    });
  });
});

function node(id: string, kind: GraphNode["kind"], files: string[], origin: GraphNode["origin"]): GraphNode {
  return {
    id,
    title: id,
    subtitle: "",
    kind,
    nodeType: kind === "doc" ? "module" : "service",
    risk: "unknown",
    description: "",
    files,
    guidanceDraft: kind === "doc" ? "keep note" : "",
    status: "mapped",
    x: 0,
    y: 0,
    origin
  };
}

function legacyGeneratedNode(id: string, files: string[]): GraphNode {
  const group = id.replace(/-/g, " ");
  const title = group.split(/[\s_/]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  return {
    ...node(id, "module", files, "generated"),
    title,
    subtitle: "Backend business module",
    description: `${title} was generated from the project scan with ${files.length} key files. Connections define the scope used for Agent planning.`,
    guidanceDraft: `Review the responsibility boundaries of these files around ${title}, and expand the modification scope only when required by its connections.`
  };
}

function canvasBase() {
  return {
    id: "main",
    title: "Main",
    projectPath: "/project",
    generatedAt: "2026-09-22T00:00:00.000Z",
    nodes: [],
    edges: []
  };
}

function fileInsight(path: string): FileInsight {
  return { path, imports: [], exports: [], symbols: [], calls: [], externalCalls: [] };
}

function toArchitectureModule(module: {
  id: string;
  title: string;
  category: ArchitectureModule["category"];
  files: string[];
  identity: ArchitectureModule["identity"];
}): ArchitectureModule {
  if (!module.identity) throw new Error(`Module ${module.id} has no identity.`);
  return {
    id: module.id,
    title: module.title,
    category: module.category,
    nodeType: "service",
    role: "Billing responsibility",
    description: "Fixture module.",
    files: module.files,
    fileRoles: [],
    symbols: [],
    evidence: [],
    risk: "unknown",
    identity: module.identity
  };
}

function graphView(overrides: Partial<CodeflowCanvas>): CodeflowCanvas {
  return {
    ...canvasBase(),
    layout: { activeMode: "execution", viewMode: "execution", manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
    nodes: [],
    edges: [],
    ...overrides
  };
}

function legacyCanvas(version: 5 | 6, overrides: Partial<CodeflowCanvas>): LegacyCanvasV5 | LegacyCanvasV6 {
  const graph = graphView(overrides);
  return version === 5 ? { ...graph, version: 5 } : { ...graph, version: 6 };
}

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProjectProtocolCanvas, resolveCanvasMigrationItem, saveProjectProtocolCanvas } from "../../src/main/storage/flowweave-store";
import { reconcileGeneratedCanvas } from "../../src/main/services/canvas-migration.service";
import { canvasMigrationPendingItemId } from "../../src/utils/canvas-migration";
import type { CanvasMigrationPendingItem, CodeflowCanvas, GraphEdge, GraphNode } from "../../src/types";
import { writeCanvasProtocolFixture } from "./protocol.fixture";

describe("canvas migration review actions", () => {
  it("uses a stable pending-record identity independent of object key order", () => {
    expect(canvasMigrationPendingItemId(pendingItem({ first: 1, nested: { alpha: true, beta: false } })))
      .toBe(canvasMigrationPendingItemId(pendingItem({ nested: { beta: false, alpha: true }, first: 1 })));
    expect(canvasMigrationPendingItemId(pendingItem({ first: 1 })))
      .not.toBe(canvasMigrationPendingItemId(pendingItem({ first: 2 })));
  });

  it("records keep against the current generation and revision without changing the raw orphan", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-review-keep-"));
    const orphan = { node: moduleNode("old-api", "Reviewed API"), reason: "split-or-merge" as const,
      edits: { title: "Reviewed API", guidanceDraft: "Keep this note." } };
    const canvas = await writeCanvasProtocolFixture(root, canvasWith({ orphanedNodeEdits: [orphan] }));

    const receipt = await resolveCanvasMigrationItem(root, {
      generationId: canvas.generation!.requestId,
      userRevision: 0,
      item: { kind: "node-edit", id: orphan.node.id },
      action: "keep"
    });

    const reopened = await readCanvas(root);
    expect(receipt).toMatchObject({ generationId: canvas.generation!.requestId, userRevision: 1 });
    expect(reopened.orphanedNodeEdits).toEqual([orphan]);
    expect(reopened.migrationReviewActions).toEqual([expect.objectContaining({
      kind: "node-edit", itemId: "old-api", action: "keep", generationId: receipt.generationId, revision: 1
    })]);
    await saveProjectProtocolCanvas(root, reopened);
    const savedAgain = await readCanvas(root);
    expect(savedAgain.orphanedNodeEdits).toEqual([orphan]);
    expect(savedAgain.migrationReviewActions).toEqual(reopened.migrationReviewActions);
  });

  it("rebinds only the recorded user fields and retains the target generation's other facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-review-node-"));
    const target = moduleNode("api", "Generated API", "New system description");
    const orphan = { node: moduleNode("old-api", "Reviewed API"), reason: "split-or-merge" as const,
      edits: { title: "Reviewed API", guidanceDraft: "Keep this note." } };
    const canvas = await writeCanvasProtocolFixture(root, canvasWith({ nodes: [target], orphanedNodeEdits: [orphan] }));

    const receipt = await resolveCanvasMigrationItem(root, {
      generationId: canvas.generation!.requestId,
      userRevision: 0,
      item: { kind: "node-edit", id: orphan.node.id },
      action: "rebind",
      targetNodeId: target.id
    });

    const reopened = await readCanvas(root);
    expect(receipt.userRevision).toBe(1);
    expect(reopened.nodes.find(({ id }) => id === target.id)).toMatchObject({
      title: "Reviewed API", description: "New system description", guidanceDraft: "Keep this note."
    });
    expect(reopened.orphanedNodeEdits).toEqual([]);
    expect(reopened.migrationReviewActions).toEqual([expect.objectContaining({
      kind: "node-edit", itemId: "old-api", action: "rebind", targetNodeId: "api", revision: 1
    })]);
  });

  it("rebinds a risk-only edit preserved from a v6 canvas after explicit user selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-review-risk-"));
    const oldNode = { ...moduleNode("old-api", "Old API"), risk: "high" as const };
    const baselineNode = { ...oldNode, risk: "low" as const };
    const target = moduleNode("api", "Current API");
    const migratedV6 = reconcileGeneratedCanvas(
      canvasWith({ nodes: [target] }),
      { ...canvasWith({ nodes: [oldNode] }), version: 6 },
      { nodes: [baselineNode], edges: [] }
    );
    const orphan = migratedV6.orphanedNodeEdits?.find((item) => item.node.id === oldNode.id);
    expect(orphan?.edits).toEqual({ risk: "high" });

    const canvas = await writeCanvasProtocolFixture(root, canvasWith({
      nodes: [target],
      orphanedNodeEdits: migratedV6.orphanedNodeEdits
    }));
    await resolveCanvasMigrationItem(root, {
      generationId: canvas.generation!.requestId,
      userRevision: 0,
      item: { kind: "node-edit", id: oldNode.id },
      action: "rebind",
      targetNodeId: target.id
    });

    const reopened = await readCanvas(root);
    expect(reopened.nodes.find(({ id }) => id === target.id)).toMatchObject({ risk: "high" });
    expect(reopened.orphanedNodeEdits).toEqual([]);
  });

  it("does not guess user edits when an orphan has no captured field delta", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-review-no-delta-"));
    const orphan = { node: moduleNode("old-api", "Previous API"), reason: "removed" as const };
    const canvas = await writeCanvasProtocolFixture(root, canvasWith({ orphanedNodeEdits: [orphan] }));

    await expect(resolveCanvasMigrationItem(root, {
      generationId: canvas.generation!.requestId,
      userRevision: 0,
      item: { kind: "node-edit", id: orphan.node.id },
      action: "rebind",
      targetNodeId: "api"
    })).rejects.toThrow("no verified user-field delta");

    const reopened = await readCanvas(root);
    expect(reopened.orphanedNodeEdits).toEqual([orphan]);
    expect(reopened.userRevision).toBe(0);
  });

  it("rebinds a relationship only to two existing target nodes and preserves its user guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-review-edge-"));
    const orphan: GraphEdge = { id: "old-link", source: "removed-api", target: "removed-data", relation: "calls",
      guidanceNote: "Reviewed relationship." };
    const canvas = await writeCanvasProtocolFixture(root, canvasWith({
      nodes: [moduleNode("api", "API"), moduleNode("data", "Data")], orphanedEdges: [orphan]
    }));

    await resolveCanvasMigrationItem(root, {
      generationId: canvas.generation!.requestId,
      userRevision: 0,
      item: { kind: "edge", id: orphan.id },
      action: "rebind",
      sourceNodeId: "api",
      targetNodeId: "data"
    });

    const reopened = await readCanvas(root);
    expect(reopened.edges).toContainEqual(expect.objectContaining({
      id: "old-link", source: "api", target: "data", relation: "calls", guidanceNote: "Reviewed relationship.", origin: "manual"
    }));
    expect(reopened.orphanedEdges).toEqual([]);
    expect(reopened.migrationReviewActions).toEqual([expect.objectContaining({
      kind: "edge", itemId: "old-link", action: "rebind", sourceNodeId: "api", targetNodeId: "data", revision: 1
    })]);
  });

  it("discards only the explicitly selected pending item and records the action", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-review-discard-"));
    const first: GraphEdge = { id: "old-link-1", source: "gone-a", target: "gone-b", relation: "calls" };
    const second: GraphEdge = { id: "old-link-2", source: "gone-c", target: "gone-d", relation: "reads" };
    const canvas = await writeCanvasProtocolFixture(root, canvasWith({ orphanedEdges: [first, second] }));

    await resolveCanvasMigrationItem(root, {
      generationId: canvas.generation!.requestId,
      userRevision: 0,
      item: { kind: "edge", id: first.id },
      action: "discard"
    });

    const reopened = await readCanvas(root);
    expect(reopened.orphanedEdges).toEqual([second]);
    expect(reopened.migrationReviewActions).toEqual([expect.objectContaining({
      kind: "edge", itemId: first.id, action: "discard", revision: 1
    })]);
  });

  it("keeps a raw pending legacy record unchanged and records its stable identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-review-pending-keep-"));
    const pending = pendingItem({ id: "old-node", nested: { tags: ["a", "b"] } });
    const canvas = await writeCanvasProtocolFixture(root, canvasWith({ migrationPendingItems: [pending] }));
    const itemId = canvasMigrationPendingItemId(pending);

    await resolveCanvasMigrationItem(root, {
      generationId: canvas.generation!.requestId,
      userRevision: 0,
      item: { kind: "migration-pending", id: itemId },
      action: "keep"
    });

    const reopened = await readCanvas(root);
    expect(reopened.migrationPendingItems).toEqual([pending]);
    expect(reopened.migrationReviewActions).toEqual([expect.objectContaining({
      kind: "migration-pending", itemId, action: "keep", generationId: canvas.generation!.requestId, revision: 1
    })]);
  });

  it("discards only the selected raw pending legacy record", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-review-pending-discard-"));
    const first = pendingItem({ id: "old-node-a", title: "ambiguous A" });
    const second = pendingItem({ id: "old-node-b", title: "ambiguous B" });
    const canvas = await writeCanvasProtocolFixture(root, canvasWith({ migrationPendingItems: [first, second] }));
    const firstId = canvasMigrationPendingItemId(first);

    await resolveCanvasMigrationItem(root, {
      generationId: canvas.generation!.requestId,
      userRevision: 0,
      item: { kind: "migration-pending", id: firstId },
      action: "discard"
    });

    const reopened = await readCanvas(root);
    expect(reopened.migrationPendingItems).toEqual([second]);
    expect(reopened.migrationReviewActions).toEqual([expect.objectContaining({
      kind: "migration-pending", itemId: firstId, action: "discard", revision: 1
    })]);
  });

  it("rejects stale raw pending identities without changing either payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-review-pending-stale-"));
    const pending = pendingItem({ id: "old-node", title: "before" });
    const changed = pendingItem({ id: "old-node", title: "after" });
    const canvas = await writeCanvasProtocolFixture(root, canvasWith({ migrationPendingItems: [changed] }));

    await expect(resolveCanvasMigrationItem(root, {
      generationId: canvas.generation!.requestId,
      userRevision: 0,
      item: { kind: "migration-pending", id: canvasMigrationPendingItemId(pending) },
      action: "discard"
    })).rejects.toThrow("missing or ambiguous");

    const reopened = await readCanvas(root);
    expect(reopened.migrationPendingItems).toEqual([changed]);
    expect(reopened.userRevision).toBe(0);
  });

  it("refuses to rebind raw legacy records without a verified mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-review-pending-rebind-"));
    const pending = pendingItem({ id: "api", title: "API" });
    const canvas = await writeCanvasProtocolFixture(root, canvasWith({ migrationPendingItems: [pending] }));

    await expect(resolveCanvasMigrationItem(root, {
      generationId: canvas.generation!.requestId,
      userRevision: 0,
      item: { kind: "migration-pending", id: canvasMigrationPendingItemId(pending) },
      action: "rebind",
      targetNodeId: "api"
    })).rejects.toThrow("no verified mapping");

    const reopened = await readCanvas(root);
    expect(reopened.migrationPendingItems).toEqual([pending]);
    expect(reopened.userRevision).toBe(0);
  });

  it("rejects stale generation and user revision without changing pending payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-migration-review-stale-"));
    const orphan: GraphEdge = { id: "old-link", source: "gone-a", target: "gone-b", relation: "calls" };
    const canvas = await writeCanvasProtocolFixture(root, canvasWith({ orphanedEdges: [orphan] }));
    const request = {
      generationId: canvas.generation!.requestId,
      userRevision: 0,
      item: { kind: "edge" as const, id: orphan.id },
      action: "discard" as const
    };

    await expect(resolveCanvasMigrationItem(root, { ...request, generationId: "stale-generation" })).rejects.toThrow("generation changed");
    await expect(resolveCanvasMigrationItem(root, { ...request, userRevision: 1 })).rejects.toThrow("revision changed");
    const reopened = await readCanvas(root);
    expect(reopened.orphanedEdges).toEqual([orphan]);
    expect(reopened.userRevision).toBe(0);
  });
});

function canvasWith(overrides: Partial<CodeflowCanvas>): CodeflowCanvas {
  const generatedAt = "2026-10-05T00:00:00.000Z";
  return {
    id: "main", title: "Migration review fixture", projectPath: "", generatedAt,
    scanFingerprint: "migration-review-fixture", artifactState: "current",
    nodes: [moduleNode("api", "Generated API"), moduleNode("data", "Generated data")], edges: [],
    ...overrides
  };
}

function moduleNode(id: string, title: string, description: string = "System description"): GraphNode {
  return {
    id, title, subtitle: "Service", kind: "module", nodeType: "service", risk: "low", description,
    files: [`src/${id}.ts`], guidanceDraft: "", status: "mapped", x: 0, y: 0, origin: "generated"
  };
}

function pendingItem(raw: unknown): CanvasMigrationPendingItem {
  return { kind: "node", sourceVersion: 4, sourceId: "legacy-node", raw, reason: "ambiguous-legacy-node" };
}

async function readCanvas(root: string): Promise<CodeflowCanvas> {
  const result = await readProjectProtocolCanvas(root);
  if (!result) throw new Error("Expected committed protocol Canvas");
  return result;
}

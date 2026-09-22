import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildModuleDisplaySummary,
  formatModuleRelation
} from "../../src/components/ModulePanel";
import { buildConnectionDisplayDetails } from "../../src/components/ConnectionPanel";
import { executionCoverageSummary } from "../../src/components/CanvasWorkspace";
import type { GraphEdge, GraphNode } from "../../src/types";

describe("module panel display data", () => {
  it("localizes Canvas node categories instead of rendering raw category enums", () => {
    const nodeSource = readFileSync(new URL("../../src/components/nodes/BaseCanvasNode.tsx", import.meta.url), "utf8");

    expect(nodeSource).toContain("localizedArchitectureCategory(data.category, data.nodeType, t)");
    expect(nodeSource).not.toContain("data.category ??");
  });

  it("keeps the relation legend in the Canvas view alongside execution diagnostics", () => {
    const canvasSource = readFileSync(new URL("../../src/components/CanvasWorkspace.tsx", import.meta.url), "utf8");

    expect(canvasSource).toContain('t("canvas.relationLegend")');
    expect(canvasSource).toContain("relationOptions.map");
  });

  it("summarizes entry symbols, relationship counts, and source evidence", () => {
    const node = moduleFixture({
      id: "orders",
      title: "Orders API with a deliberately long title that must remain readable",
      symbols: [
        { name: "createOrder", kind: "function", filePath: "src/orders.ts", exported: true },
        { name: "internalHelper", kind: "function", filePath: "src/orders.ts", exported: false }
      ]
    });
    const edges = [
      edgeFixture("api-orders", "api", "orders", "calls", [{ filePath: "src/api.ts", detail: "Calls createOrder." }]),
      edgeFixture("orders-store", "orders", "store", "reads_writes", [{ filePath: "src/orders.ts", detail: "Writes orders." }])
    ];

    expect(buildModuleDisplaySummary(node, edges)).toEqual({
      entrySymbol: "createOrder",
      upstreamCount: 1,
      downstreamCount: 1,
      evidenceStatus: "supported"
    });
  });

  it("reports missing source support for a disconnected module with no symbols", () => {
    expect(buildModuleDisplaySummary(moduleFixture(), [])).toEqual({
      entrySymbol: undefined,
      upstreamCount: 0,
      downstreamCount: 0,
      evidenceStatus: "missing"
    });
  });

  it("uses module titles for relation rows and falls back to an unknown endpoint id", () => {
    const modules = [
      moduleFixture({ id: "api", title: "Public API with a deliberately long title" }),
      moduleFixture({ id: "orders", title: "Orders" })
    ];

    expect(formatModuleRelation(edgeFixture("api-orders", "api", "orders", "calls"), modules)).toBe("Public API with a deliberately long title -> Orders");
    expect(formatModuleRelation(edgeFixture("orders-queue", "orders", "queue", "publishes_event"), modules)).toBe("Orders -> queue");
  });

  it("keeps one representative source and counts remaining evidence for an aggregate edge", () => {
    const edge = edgeFixture("aggregate", "api", "orders", "calls", [
      { filePath: "src/api.ts", detail: "First call." },
      { filePath: "src/api.ts", detail: "Second call." },
      { filePath: "src/api.ts", detail: "Third call." }
    ]);

    expect(buildConnectionDisplayDetails(edge)).toMatchObject({
      confidence: "confirmed",
      representativeEvidence: { detail: "First call." },
      additionalEvidenceCount: 2
    });
  });

  it("reports low execution coverage without restoring hidden dependency edges", () => {
    expect(executionCoverageSummary({
      executableModuleCount: 4,
      connectedExecutableModuleCount: 1,
      isolatedModuleIds: ["orphan"],
      unresolvedEventCount: 1,
      hiddenDependencyEdgeCount: 2,
      inferredOverlayEdgeCount: 0
    })).toEqual({ percent: 25, hasLimitedEvidence: true });
  });
});

function moduleFixture(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "orphan",
    title: "Orphan module",
    subtitle: "Module",
    kind: "module",
    nodeType: "service",
    risk: "unknown",
    description: "Fixture module.",
    files: ["src/module.ts"],
    guidanceDraft: "",
    status: "mapped",
    x: 0,
    y: 0,
    ...overrides
  };
}

function edgeFixture(
  id: string,
  source: string,
  target: string,
  relation: GraphEdge["relation"],
  evidence?: GraphEdge["evidence"]
): GraphEdge {
  return { id, source, target, relation, evidence };
}

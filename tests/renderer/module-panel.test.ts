import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildModuleDisplaySummary,
  formatModuleRelation,
  relationDisplayTitle
} from "../../src/components/ModulePanel";
import { buildConnectionDisplayDetails } from "../../src/components/ConnectionPanel";
import { CanvasWorkspace, executionCoverageSummary } from "../../src/components/CanvasWorkspace";
import { usePreferencesStore } from "../../src/stores/preferences.store";
import { createFlowEdge, createFlowNode } from "../../src/utils/graph-converters";
import { translate } from "../../src/utils/i18n";
import type { GraphEdge, GraphNode } from "../../src/types";

const previousLocale = usePreferencesStore.getState().locale;

describe("module panel display data", () => {
  afterEach(() => usePreferencesStore.setState({ locale: previousLocale }));

  it("localizes Canvas node categories instead of rendering raw category enums", () => {
    const nodeSource = readFileSync(new URL("../../src/components/nodes/BaseCanvasNode.tsx", import.meta.url), "utf8");

    expect(nodeSource).toContain("localizedArchitectureCategory(data.category, data.nodeType, t)");
    expect(nodeSource).not.toContain("data.category ??");
  });

  it("shows only detected relationship kinds in the Canvas legend", () => {
    usePreferencesStore.setState({ locale: "en" });
    const html = renderToStaticMarkup(createElement(CanvasWorkspace, {
      readOnly: true,
      hiddenGeneratedCount: 0,
      canvasLayout: { activeMode: "execution", manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
      edges: [createFlowEdge({ id: "api-call", source: "api", target: "service", relation: "calls", confidence: "confirmed", evidence: [] })],
      nodes: [createFlowNode(moduleFixture({ id: "api" })), createFlowNode(moduleFixture({ id: "service" }))],
      relationDiagnostics: [],
      generatedAt: "2026-10-11T00:00:00.000Z",
      isProjectLoading: false,
      onApplyAutoLayout: () => undefined,
      onConnect: () => undefined,
      onEdgesChange: () => undefined,
      onOpenProject: () => undefined,
      onNodesChange: () => undefined,
      onPaneClick: () => undefined,
      onSelectEdge: () => undefined,
      onSelectNode: () => undefined,
      onRestoreManualLayout: () => undefined,
      onRestoreGeneratedItems: async () => undefined,
      onResolveMigrationItem: async () => { throw new Error("Not used by legend rendering."); },
      onSetCollapsedGroups: () => undefined,
      onSetViewMode: () => undefined
    }));
    const legendStart = html.indexOf('<details class="canvas-relation-legend">');
    const legendEnd = html.indexOf("</details>", legendStart);
    const legend = html.slice(legendStart, legendEnd);

    expect(legend).toContain(translate("en", "relation.callsAccent"));
    expect(legend).not.toContain(translate("en", "relation.http_contractAccent"));
  });

  it("summarizes entry symbols, relationship counts, and source evidence", () => {
    const node = moduleFixture({
      id: "orders",
      title: "Orders API with a deliberately long title that must remain readable",
      symbols: [
        { name: "createOrder", kind: "function", filePath: "src/orders.ts", exported: true, role: "entry" },
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
      evidenceState: "confirmed"
    });
  });

  it("reports missing source support for a disconnected module with no symbols", () => {
    expect(buildModuleDisplaySummary(moduleFixture(), [])).toEqual({
      entrySymbol: undefined,
      upstreamCount: 0,
      downstreamCount: 0,
      evidenceState: "unavailable"
    });
  });

  it("uses module titles for relation rows and falls back to an unknown endpoint id", () => {
    const modules = [
      moduleFixture({ id: "api", title: "Public API with a deliberately long title" }),
      moduleFixture({ id: "orders", title: "Orders" })
    ];

    expect(formatModuleRelation(edgeFixture("api-orders", "api", "orders", "calls"), modules)).toBe("Public API with a deliberately long title -> Orders");
    expect(formatModuleRelation(edgeFixture("orders-queue", "orders", "queue", "publishes_event"), modules)).toBe("Orders -> queue");
    expect(relationDisplayTitle(edgeFixture("api-orders", "api", "orders", "calls"), new Map(modules.map((module) => [module.id, module.title])))).toBe("Public API with a deliberately long title -> Orders");
  });

  it("keeps one representative source and counts remaining evidence for an aggregate edge", () => {
    const edge = edgeFixture("aggregate", "api", "orders", "calls", [
      { filePath: "src/api.ts", detail: "First call." },
      { filePath: "src/api.ts", detail: "Second call." },
      { filePath: "src/api.ts", detail: "Third call." }
    ]);

    expect(buildConnectionDisplayDetails({ ...edge, confidence: "confirmed" })).toMatchObject({
      confidence: "confirmed",
      representativeEvidence: { detail: "First call." },
      additionalEvidenceCount: 2
    });
  });

  it("retains inferred confidence even when source evidence is available", () => {
    const edge = edgeFixture("inferred", "api", "orders", "calls", [{ filePath: "src/api.ts", detail: "Dynamic receiver." }]);
    expect(buildConnectionDisplayDetails({ ...edge, confidence: "inferred" }).confidence).toBe("inferred");
  });

  it("reports low execution coverage without restoring hidden dependency edges", () => {
    expect(executionCoverageSummary({
      executableModuleCount: 4,
      connectedExecutableModuleCount: 1,
      isolatedModuleIds: ["orphan"],
      unresolvedEventCount: 1,
      hiddenDependencyEdgeCount: 2
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

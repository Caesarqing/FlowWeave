import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CanvasWorkspace, filterCanvasToModuleGroups } from "../../src/components/CanvasWorkspace";
import { ModulePanel } from "../../src/components/ModulePanel";
import { usePreferencesStore } from "../../src/stores/preferences.store";
import { createFlowNode } from "../../src/utils/graph-converters";
import type { GraphNode } from "../../src/types";

const previousLocale = usePreferencesStore.getState().locale;
const node: GraphNode = {
  id: "orders", title: "Orders", subtitle: "", kind: "module", nodeType: "service", risk: "unknown",
  description: "Orders boundary", files: ["src/orders.ts"], guidanceDraft: "Preserved user instructions", status: "mapped", x: 0, y: 0
};

function unexpectedInteraction(): never {
  throw new Error("Rendering diagnostics must not perform a user action.");
}

describe("rendered canvas diagnostics", () => {
  afterEach(() => usePreferencesStore.setState({ locale: previousLocale }));

  it("labels a cached graph as the previous analysis while verification runs", () => {
    usePreferencesStore.setState({ locale: "en" });
    const html = renderToStaticMarkup(createElement(CanvasWorkspace, {
      canvasLayout: { activeMode: "execution", viewMode: "execution", manualPositions: {}, autoLayouts: { execution: { orders: { x: 0, y: 0 } } }, collapsedGroups: [] },
      graphStatus: "stale", isProjectLoading: true,
      edges: [], nodes: [createFlowNode({ ...node, origin: "generated" })], relationDiagnostics: [],
      onApplyAutoLayout: unexpectedInteraction, onConnect: unexpectedInteraction, onEdgesChange: unexpectedInteraction,
      onNodesChange: unexpectedInteraction, onPaneClick: unexpectedInteraction, onSelectEdge: unexpectedInteraction,
      onSelectNode: unexpectedInteraction, onRestoreManualLayout: unexpectedInteraction, onSetCollapsedGroups: unexpectedInteraction,
      onSetViewMode: unexpectedInteraction, onOpenProject: unexpectedInteraction
    }));
    expect(html).toContain("Previous analysis result · checking project changes");
  });

  it("does not expose an undiagnosed legacy-result runtime state", () => {
    usePreferencesStore.setState({ locale: "en" });
    const props = {
      canvasLayout: { activeMode: "execution" as const, viewMode: "execution" as const, manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
      edges: [], nodes: [createFlowNode({ ...node, origin: "generated" })], relationDiagnostics: [],
      onApplyAutoLayout: unexpectedInteraction, onConnect: unexpectedInteraction, onEdgesChange: unexpectedInteraction,
      onNodesChange: unexpectedInteraction, onPaneClick: unexpectedInteraction, onSelectEdge: unexpectedInteraction,
      onSelectNode: unexpectedInteraction, onRestoreManualLayout: unexpectedInteraction, onSetCollapsedGroups: unexpectedInteraction,
      onSetViewMode: unexpectedInteraction, onOpenProject: unexpectedInteraction
    };
    const html = renderToStaticMarkup(createElement(CanvasWorkspace, props));
    expect(html).toContain("Preparing module layout...");
    expect(html).toContain('class="react-flow flow-canvas layout-pending');
    expect(html).not.toContain("Legacy generated result");
    expect(html).not.toContain("Binding diagnostics were not provided");
    expect(html).not.toContain("File parsing complete:");
    expect(html).not.toContain("Failed files:");

  });

  it("uses saved base coordinates immediately when only the visible projection changed", () => {
    const html = renderToStaticMarkup(createElement(CanvasWorkspace, {
      canvasLayout: {
        activeMode: "execution", viewMode: "execution", manualPositions: {},
        autoLayouts: { execution: { orders: { x: 120, y: 80 } } },
        autoLayoutTopologyFingerprints: { execution: "previous projection" },
        collapsedGroups: []
      },
      edges: [], nodes: [createFlowNode({ ...node, origin: "generated" })], relationDiagnostics: [],
      onApplyAutoLayout: unexpectedInteraction, onConnect: unexpectedInteraction, onEdgesChange: unexpectedInteraction,
      onNodesChange: unexpectedInteraction, onPaneClick: unexpectedInteraction, onSelectEdge: unexpectedInteraction,
      onSelectNode: unexpectedInteraction, onRestoreManualLayout: unexpectedInteraction, onSetCollapsedGroups: unexpectedInteraction,
      onSetViewMode: unexpectedInteraction, onOpenProject: unexpectedInteraction
    }));

    expect(html).not.toContain("Preparing module layout...");
    expect(html).not.toContain('class="react-flow flow-canvas layout-pending');
  });

  it("shows fact outcomes and preserved unresolved edits in the quality panel", () => {
    usePreferencesStore.setState({ locale: "en" });
    const html = renderToStaticMarkup(createElement(CanvasWorkspace, {
      canvasLayout: { activeMode: "execution", viewMode: "execution", manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
      edges: [], nodes: [], relationDiagnostics: [],
      quality: { eligibleFiles: 4, parsedFiles: 3, failedFiles: 1, unsupportedFiles: 0, internalImports: 2, resolvedInternalImports: 1, unresolvedInternalImports: 1, calls: 4, resolvedCalls: 1, ambiguousCalls: 2, complete: false,
        factOutcomes: [{ kind: "call", outcome: "ambiguous", count: 2, relationIds: ["call-1", "call-2"] }] },
      orphanedNodeEdits: [{ node, reason: "split-or-merge" }],
      onApplyAutoLayout: unexpectedInteraction, onConnect: unexpectedInteraction, onEdgesChange: unexpectedInteraction,
      onNodesChange: unexpectedInteraction, onPaneClick: unexpectedInteraction, onSelectEdge: unexpectedInteraction,
      onSelectNode: unexpectedInteraction, onRestoreManualLayout: unexpectedInteraction, onSetCollapsedGroups: unexpectedInteraction,
      onSetViewMode: unexpectedInteraction, onOpenProject: unexpectedInteraction
    }));
    expect(html).toContain("File parsing incomplete: 3/4 files");
    expect(html).toContain("Internal imports located: 1/2");
    expect(html).toContain("Call targets located: 1/4");
    expect(html).toContain("Ambiguous target");
    expect(html).toContain("call-1 · call-2");
    expect(html).toContain("Module boundaries changed");
    expect(html).toContain("Preserved user instructions");
  });

  it("exposes legacy migration data for review and export without rendering it into the initial canvas", () => {
    usePreferencesStore.setState({ locale: "en" });
    const rawLegacyNode = { id: "old-node", title: "Legacy secret title", files: ["src/old.ts"] };
    const html = renderToStaticMarkup(createElement(CanvasWorkspace, {
      hiddenGeneratedCount: 0,
      canvasLayout: { activeMode: "execution", viewMode: "execution", manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
      edges: [], nodes: [], relationDiagnostics: [],
      migrationPendingItems: [{ kind: "node", sourceVersion: 4, sourceId: "old-node", raw: rawLegacyNode, reason: "Generated/user origin is unknown." }],
      orphanedEdges: [{ id: "old-edge", source: "old-source", target: "old-target", relation: "calls", guidanceNote: "Preserve this note" }],
      onApplyAutoLayout: unexpectedInteraction, onConnect: unexpectedInteraction, onEdgesChange: unexpectedInteraction,
      onNodesChange: unexpectedInteraction, onPaneClick: unexpectedInteraction, onSelectEdge: unexpectedInteraction,
      onSelectNode: unexpectedInteraction, onRestoreManualLayout: unexpectedInteraction, onSetCollapsedGroups: unexpectedInteraction,
      onSetViewMode: unexpectedInteraction, onOpenProject: unexpectedInteraction
    }));

    expect(html).toContain("Review 2 preserved items");
    expect(html).toContain("View preserved data");
    expect(html).toContain("Export preserved data");
    expect(html).not.toContain("Legacy secret title");
    expect(html).not.toContain("Preserve this note");
  });

  it("shows preserved review counts when the initial graph omits their payloads", () => {
    usePreferencesStore.setState({ locale: "en" });
    const html = renderToStaticMarkup(createElement(CanvasWorkspace, {
      hiddenGeneratedCount: 0,
      canvasLayout: { activeMode: "execution", viewMode: "execution", manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
      edges: [], nodes: [], relationDiagnostics: [], preservedCounts: { pending: 2, nodeEdits: 3, edges: 4 },
      onApplyAutoLayout: unexpectedInteraction, onConnect: unexpectedInteraction, onEdgesChange: unexpectedInteraction,
      onNodesChange: unexpectedInteraction, onPaneClick: unexpectedInteraction, onSelectEdge: unexpectedInteraction,
      onSelectNode: unexpectedInteraction, onRestoreManualLayout: unexpectedInteraction, onSetCollapsedGroups: unexpectedInteraction,
      onSetViewMode: unexpectedInteraction, onOpenProject: unexpectedInteraction
    }));
    expect(html).toContain("Review 9 preserved items");
    expect(html).toContain("3 preserved edits need review");
  });

  it("shows an unresolved target's source location and candidate targets", () => {
    usePreferencesStore.setState({ locale: "en" });
    const selected = { ...node,
      relationSummary: { dependencies: 0, internalRelations: 0, unresolvedRelations: 1, externalRelations: 0 },
      relationDiagnostics: [{ code: "dynamic-call", severity: "warning" as const, message: "Receiver cannot be resolved.", filePath: "src/orders.ts", relationId: "call-1", range: { start: { line: 8, column: 12 }, end: { line: 8, column: 20 } }, candidates: ["src/worker.ts", "src/other.ts"] }]
    };
    const html = renderToStaticMarkup(createElement(ModulePanel, {
      node: selected, modules: [selected], edges: [], guidanceOperation: "", sendGuidanceDisabled: true,
      onDeleteNode: unexpectedInteraction, onGuidanceChange: unexpectedInteraction, onModuleChange: unexpectedInteraction,
      onSaveGuidance: unexpectedInteraction, onSendGuidance: unexpectedInteraction
    }));
    expect(html).toContain(`data-detail-node-id="${selected.id}"`);
    expect(html).toContain("Relationships were found but their targets could not be located.");
    expect(html).toContain("src/orders.ts:8:12");
    expect(html).toContain("Receiver cannot be resolved.");
    expect(html).toContain("src/worker.ts · src/other.ts");
  });

  it("does not show a previous file owner's diagnostic after an unsaved file correction", () => {
    usePreferencesStore.setState({ locale: "en" });
    const selected = { ...node, files: ["src/new.ts"],
      relationDiagnostics: [{ code: "dynamic-call", severity: "warning" as const,
        message: "Old owner diagnostic", filePath: "src/orders.ts" }] };
    const html = renderToStaticMarkup(createElement(ModulePanel, {
      node: selected, modules: [selected], edges: [], guidanceOperation: "", sendGuidanceDisabled: true,
      onDeleteNode: unexpectedInteraction, onGuidanceChange: unexpectedInteraction, onModuleChange: unexpectedInteraction,
      onSaveGuidance: unexpectedInteraction, onSendGuidance: unexpectedInteraction
    }));

    expect(html).not.toContain("Old owner diagnostic");
  });

  it("filters by selected module groups without deleting manual nodes or their source graph", () => {
    const groupPath = [{ id: "group:accounts", title: "Accounts", rootPath: "src/accounts" }];
    const accounts = createFlowNode({ ...node, id: "accounts", title: "Accounts", groupPath });
    const orders = createFlowNode({ ...node, id: "orders", title: "Orders", groupPath: [{ id: "group:orders", title: "Orders", rootPath: "src/orders" }] });
    const manual = createFlowNode({ ...node, id: "manual-note", title: "Note", origin: "manual" });
    const edges = [
      { id: "accounts-orders", source: "accounts", target: "orders" },
      { id: "manual-accounts", source: "manual-note", target: "accounts" }
    ];

    const filtered = filterCanvasToModuleGroups([accounts, orders, manual], edges, ["group:accounts"]);

    expect(filtered.nodes.map((item) => item.id)).toEqual(["accounts", "manual-note"]);
    expect(filtered.edges).toEqual([edges[1]]);
    expect(accounts.position).toEqual({ x: 0, y: 0 });
    expect(filterCanvasToModuleGroups([accounts, orders, manual], edges, []).nodes).toHaveLength(3);
  });
});

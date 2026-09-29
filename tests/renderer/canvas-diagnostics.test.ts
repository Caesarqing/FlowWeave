import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CanvasWorkspace } from "../../src/components/CanvasWorkspace";
import { ModulePanel } from "../../src/components/ModulePanel";
import { usePreferencesStore } from "../../src/stores/preferences.store";
import { createFlowNode } from "../../src/utils/graph-converters";
import { translate } from "../../src/utils/i18n";
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

  it("labels a generated result without quality metadata", () => {
    usePreferencesStore.setState({ locale: "en" });
    const props = {
      canvasLayout: { activeMode: "architecture" as const, viewMode: "architecture" as const, manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
      edges: [], nodes: [createFlowNode({ ...node, origin: "generated" })], relationDiagnostics: [],
      readOnly: false,
      onApplyAutoLayout: unexpectedInteraction, onConnect: unexpectedInteraction, onEdgesChange: unexpectedInteraction,
      onNodesChange: unexpectedInteraction, onPaneClick: unexpectedInteraction, onSelectEdge: unexpectedInteraction,
      onSelectNode: unexpectedInteraction, onRestoreManualLayout: unexpectedInteraction, onSetCollapsedGroups: unexpectedInteraction,
      onSetViewMode: unexpectedInteraction, onOpenProject: unexpectedInteraction
    };
    const html = renderToStaticMarkup(createElement(CanvasWorkspace, props));
    expect(html).toContain("Legacy generated result");
    expect(html).toContain("Binding diagnostics were not provided");
    expect(html).not.toContain("File parsing complete:");
    expect(html).not.toContain("Failed files:");
    expect(translate("zh-CN", "canvas.legacyGeneratedResult")).toBe("旧生成结果");
    expect(translate("zh-CN", "canvas.legacyGeneratedDiagnostics")).toContain("未提供绑定诊断");

    const manualHtml = renderToStaticMarkup(createElement(CanvasWorkspace, { ...props, nodes: [createFlowNode({ ...node, origin: "manual" })] }));
    expect(manualHtml).not.toContain("Legacy generated result");
  });

  it("shows fact outcomes and preserved unresolved edits in the quality panel", () => {
    usePreferencesStore.setState({ locale: "en" });
    const html = renderToStaticMarkup(createElement(CanvasWorkspace, {
      canvasLayout: { activeMode: "architecture", viewMode: "architecture", manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
      edges: [], nodes: [], relationDiagnostics: [],
      readOnly: false,
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

  it("shows an unresolved target's source location and candidate targets", () => {
    usePreferencesStore.setState({ locale: "en" });
    const selected = { ...node,
      relationSummary: { dependencies: 0, internalRelations: 0, unresolvedRelations: 1, externalRelations: 0 },
      relationDiagnostics: [{ code: "dynamic-call", severity: "warning" as const, message: "Receiver cannot be resolved.", filePath: "src/orders.ts", relationId: "call-1", range: { start: { line: 8, column: 12 }, end: { line: 8, column: 20 } }, candidates: ["src/worker.ts", "src/other.ts"] }]
    };
    const html = renderToStaticMarkup(createElement(ModulePanel, {
      node: selected, modules: [selected], edges: [], guidanceOperation: "", sendGuidanceDisabled: true,
      readOnly: false,
      onDeleteNode: unexpectedInteraction, onGuidanceChange: unexpectedInteraction, onModuleChange: unexpectedInteraction,
      onSaveGuidance: unexpectedInteraction, onSendGuidance: unexpectedInteraction
    }));
    expect(html).toContain("Relationships were found but their targets could not be located.");
    expect(html).toContain("src/orders.ts:8:12");
    expect(html).toContain("Receiver cannot be resolved.");
    expect(html).toContain("src/worker.ts · src/other.ts");
  });
});

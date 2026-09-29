import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionPanel } from "../../src/components/ConnectionPanel";
import { ModulePanel } from "../../src/components/ModulePanel";
import type { GraphNode } from "../../src/types";

const moduleNode: GraphNode = {
  id: "orders",
  title: "Orders",
  subtitle: "",
  kind: "module",
  nodeType: "service",
  risk: "unknown",
  description: "Order handling",
  files: ["src/orders.ts"],
  guidanceDraft: "Keep the existing guidance",
  status: "mapped",
  x: 0,
  y: 0
};

function unexpectedInteraction(): never {
  throw new Error("Rendering a legacy read-only view must not invoke edits.");
}

describe("legacy canvas read-only view", () => {
  it("disables module edits, risk controls, guidance, and deletion while keeping details visible", () => {
    const markup = renderToStaticMarkup(createElement(ModulePanel, {
      edges: [],
      modules: [moduleNode],
      guidanceOperation: "",
      node: moduleNode,
      onDeleteNode: unexpectedInteraction,
      onGuidanceChange: unexpectedInteraction,
      onModuleChange: unexpectedInteraction,
      onSaveGuidance: unexpectedInteraction,
      onSendGuidance: unexpectedInteraction,
      sendGuidanceDisabled: true,
      readOnly: true
    }));

    expect(markup).toContain("Order handling");
    expect(markup).toContain('<fieldset class="module-edit-form" disabled="">');
    expect(markup).toContain('class="ghost-button danger-button sequence-wide-button" disabled=""');
    expect(markup).toMatch(/<textarea[^>]*disabled=""/);
  });

  it("keeps relationship evidence visible and prevents connection edits", () => {
    const target: GraphNode = { ...moduleNode, id: "billing", title: "Billing", files: ["src/billing.ts"] };
    const markup = renderToStaticMarkup(createElement(ConnectionPanel, {
      defaultRelation: "calls",
      mode: "edit",
      modules: [moduleNode, target],
      onClose: unexpectedInteraction,
      onCreateConnection: unexpectedInteraction,
      onDeleteEdge: unexpectedInteraction,
      onUpdateEdgeEndpoints: unexpectedInteraction,
      onUpdateEdgeGuidance: unexpectedInteraction,
      onUpdateEdgeRelation: unexpectedInteraction,
      selectedEdge: {
        id: "orders-billing",
        source: "orders",
        target: "billing",
        relation: "calls",
        origin: "generated",
        evidence: [{ filePath: "src/orders.ts", line: 18, detail: "calls billing" }]
      },
      readOnly: true
    }));

    expect(markup).toContain("src/orders.ts:18");
    expect(markup).toContain('<fieldset disabled="">');
    expect(markup).toContain('class="ghost-button danger-button" disabled=""');
  });
});

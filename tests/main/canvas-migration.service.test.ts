import { describe, expect, it } from "vitest";
import { reconcileGeneratedCanvas, type LegacyCanvasV5 } from "../../src/main/services/canvas-migration.service";
import { unknownAssessment } from "../../src/utils/module-assessment";
import type { CodeflowCanvas, GraphEdge, GraphNode } from "../../src/types";

describe("canvas v5 to v6 migration", () => {
  it.each(["Keep this unsent instruction.", "", undefined])("preserves edge guidance %j across unique endpoint and edge ID renames", (guidanceNote) => {
    const oldNode = node("old", "module", ["src/one.ts"], "generated");
    const before: GraphEdge = { id: "old-link", source: "old", target: "old", relation: "calls", guidanceNote: "Old generated instruction.", origin: "generated" };
    const existing = canvasV6({ nodes: [oldNode], edges: [{ ...before, guidanceNote }] });
    const generated = canvasV6({
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
    const generated = canvasV6({ nodes: [node("new", "module", ["src/one.ts"], "generated")], edges: [{ ...before, source: "new", target: "new", guidanceNote: "New fact" }] });
    const reconciled = reconcileGeneratedCanvas(generated, canvasV6({ nodes: [oldNode], edges: [before] }), { nodes: [oldNode], edges: [before] });
    expect(reconciled.edges[0].guidanceNote).toBe("New fact");
  });

  it("preserves generated v5 edge notes and uses a supplied generated baseline", () => {
    const oldNode = legacyGeneratedNode("old", ["src/one.ts"]);
    const before: GraphEdge = { id: "old-link", source: "old", target: "old", relation: "calls", guidanceNote: "Old fact", origin: "generated" };
    const generated = canvasV6({ nodes: [node("new", "module", ["src/one.ts"], "generated")], edges: [{ ...before, id: "new-link", source: "new", target: "new", guidanceNote: "New fact" }] });
    const existing: LegacyCanvasV5 = { ...canvasBase(), version: 5, nodes: [oldNode], edges: [{ ...before, guidanceNote: "" }] };
    expect(reconcileGeneratedCanvas(generated, existing).edges[0].guidanceNote).toBe("");
    expect(reconcileGeneratedCanvas(generated, { ...existing, edges: [before] }, { nodes: [oldNode], edges: [before] }).edges[0].guidanceNote).toBe("New fact");
  });

  it.each([
    { source: "other" },
    { target: "other" },
    { relation: "depends_on" as const }
  ])("keeps generated-edge fact edits %j pending with their original endpoints and evidence", (edit) => {
    const oldNodes = [node("one", "module", ["src/one.ts"], "generated"), node("other", "module", ["src/other.ts"], "generated")];
    const before: GraphEdge = { id: "link", source: "one", target: "one", relation: "calls", guidanceNote: "Generated fact", origin: "generated" };
    const edited: GraphEdge = { ...before, ...edit, guidanceNote: "Unsent instruction", evidence: [{ filePath: "src/one.ts", detail: "Old evidence" }] };
    const generated = canvasV6({ nodes: oldNodes, edges: [{ ...before, guidanceNote: "Fresh fact" }] });
    const reconciled = reconcileGeneratedCanvas(generated, canvasV6({ nodes: oldNodes, edges: [edited] }), { nodes: oldNodes, edges: [before] });
    expect(reconciled.edges).toEqual(generated.edges);
    expect(reconciled.orphanedEdges).toEqual([edited]);
  });

  it.each(["split", "merge", "duplicate-relations", "removed-resource"])("orphanizes unsent guidance for %s without assigning it to a coincidental ID", (scenario) => {
    const old = node("one", "module", ["src/one.ts", "src/two.ts"], "generated");
    const resource = { ...node("resource", "module", [], "generated"), resource: { id: "resource", kind: "database" as const, scopeId: "scope", key: "db", title: "DB", detail: "Database", evidence: [] } };
    const oldNodes = scenario === "removed-resource" ? [old, resource] : scenario === "merge" ? [old, node("two", "module", ["src/two.ts"], "generated")] : [old];
    const before: GraphEdge = { id: "link", source: "one", target: scenario === "removed-resource" ? "resource" : "one", relation: "calls", origin: "generated" };
    const edited = { ...before, guidanceNote: "Do not lose me.", evidence: [{ filePath: "src/one.ts", detail: "Original evidence" }] };
    const newNodes = scenario === "split" ? [node("one", "module", ["src/one.ts"], "generated"), node("two", "module", ["src/two.ts"], "generated")] : [old];
    const edges = scenario === "duplicate-relations" ? [{ ...before, id: "new-1" }, { ...before, id: "new-2" }] : [{ ...before, target: "one" }];
    const reconciled = reconcileGeneratedCanvas(canvasV6({ nodes: newNodes, edges }), canvasV6({ nodes: oldNodes, edges: [edited] }), { nodes: oldNodes, edges: [before] });
    expect(reconciled.edges.every((edge) => edge.guidanceNote === undefined)).toBe(true);
    expect(reconciled.orphanedEdges).toEqual([edited]);
  });

  it("reserves stable edge IDs before matching the remaining unique relation", () => {
    const module = node("one", "module", ["src/one.ts"], "generated");
    const before: GraphEdge = { id: "stable", source: "one", target: "one", relation: "calls", origin: "generated" };
    const oldEdges = [before, { ...before, id: "old" }];
    const generated = canvasV6({ nodes: [module], edges: [before, { ...before, id: "new" }] });
    const existing = canvasV6({ nodes: [module], edges: [{ ...before, guidanceNote: "Stable note" }, { ...before, id: "old", guidanceNote: "Renamed note" }] });
    const reconciled = reconcileGeneratedCanvas(generated, existing, { nodes: [module], edges: oldEdges });
    expect(reconciled.edges.map(({ id, guidanceNote }) => ({ id, guidanceNote }))).toEqual([{ id: "stable", guidanceNote: "Stable note" }, { id: "new", guidanceNote: "Renamed note" }]);
  });

  it.each([5, 6] as const)("preserves a manual edge when a generated v%s edge reuses its ID", (version) => {
    const module = node("one", "module", ["src/one.ts"], "generated");
    const fact: GraphEdge = { id: "collision", source: "one", target: "one", relation: "calls", origin: "generated" };
    const manual: GraphEdge = { ...fact, relation: "depends_on", guidanceNote: "Manual intent", origin: "manual" };
    const generated = canvasV6({ nodes: [module], edges: [fact] });
    const existing = { ...canvasV6({ nodes: [module], edges: [manual] }), version };
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
    const generated = canvasV6({
      layout: { activeMode: "execution", viewMode: "execution", manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
      nodes: [{ ...node("accounts", "module", ["src/features/accounts/account.service.ts"], "generated"), title: "Accounts", description: "New functional module." }],
      edges: [{ id: "runtime", source: "accounts", target: "accounts", relation: "calls", origin: "generated" }]
    });

    const migrated = reconcileGeneratedCanvas(generated, existing);

    expect(migrated.version).toBe(6);
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

  it("retains v6 view preference, manual content, user edits, and layouts on rescan", () => {
    const generated = canvasV6({
      nodes: [node("accounts", "module", ["src/features/accounts/account.service.ts"], "generated")],
      edges: []
    });
    const existing = canvasV6({
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

  it("keeps generated module positions when a v6 manual layout is rescanned without topology changes", () => {
    const existing = canvasV6({
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
    const generated = canvasV6({ nodes: [node("accounts", "module", ["src/accounts.ts"], "generated")] });

    const reconciled = reconcileGeneratedCanvas(generated, existing);

    expect(reconciled.layout?.activeMode).toBe("manual");
    expect(reconciled.nodes.find((item) => item.id === "accounts")).toMatchObject({ x: 300, y: 240 });
    expect(reconciled.nodes.map((item) => item.id)).toContain("note");
  });

  it("remaps v6 manual edge endpoints when a module ID changes but file identity stays unique", () => {
    const existing = canvasV6({
      nodes: [
        node("old-accounts", "module", ["src/features/accounts/account.service.ts"], "generated"),
        node("note", "doc", [], "manual")
      ],
      edges: [{ id: "manual-link", source: "note", target: "old-accounts", relation: "calls", origin: "manual" }]
    });
    const generated = canvasV6({
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

  it("returns a manual v6 layout to automatic layout when a rescan adds a generated module", () => {
    const existing = canvasV6({
      layout: {
        activeMode: "manual",
        viewMode: "execution",
        manualPositions: { accounts: { x: 100, y: 120 } },
        autoLayouts: {},
        collapsedGroups: []
      },
      nodes: [{ ...node("accounts", "module", ["src/accounts.ts"], "generated"), x: 300, y: 240 }]
    });
    const generated = canvasV6({
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
    const generated = canvasV6({
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

  it("preserves split and merge user edits as unresolved instead of assigning them to an arbitrary successor", () => {
    const before = node("combined", "module", ["src/one.ts", "src/two.ts"], "generated");
    const edited = { ...before, title: "My boundary", guidanceDraft: "Keep this pending note." };
    const existing = canvasV6({ nodes: [edited] });
    const generated = canvasV6({ nodes: [
      node("combined", "module", ["src/one.ts"], "generated"),
      node("two", "module", ["src/two.ts"], "generated")
    ] });
    const reconciled = reconcileGeneratedCanvas(generated, existing, { nodes: [before], edges: [] });
    expect(reconciled.nodes.every((node) => node.guidanceDraft === "")).toBe(true);
    expect(reconciled.orphanedNodeEdits).toEqual([{ node: edited, reason: "split-or-merge" }]);
  });

  it("remaps manual coordinates and preserves override risk on a unique identity rename", () => {
    const before = node("old", "module", ["src/one.ts"], "generated");
    const existing = canvasV6({
      nodes: [{ ...before, risk: "high", x: 75, y: 90 }],
      layout: { activeMode: "manual", viewMode: "dependency", manualPositions: { old: { x: 75, y: 90 } }, autoLayouts: {}, collapsedGroups: [] }
    });
    const reconciled = reconcileGeneratedCanvas(canvasV6({ nodes: [node("new", "module", ["src/one.ts"], "generated")] }), existing, { nodes: [before], edges: [] });
    expect(reconciled.nodes[0]).toMatchObject({ id: "new", risk: "high", x: 75, y: 90 });
    expect(reconciled.layout?.manualPositions).toEqual({ new: { x: 75, y: 90 } });
  });

  it("retains the user risk override while refreshing generated assessment evidence", () => {
    const previous = node("one", "module", ["src/one.ts"], "generated");
    const oldAssessment = unknownAssessment("old-scan", "2026-09-01T00:00:00.000Z");
    const newAssessment = unknownAssessment("new-scan", "2026-09-28T00:00:00.000Z");
    const override = { level: "high" as const, reason: "User reviewed boundary.", createdAt: "2026-09-02T00:00:00.000Z" };
    const existing = canvasV6({ nodes: [{ ...previous, risk: "high", assessment: { ...oldAssessment, risk: { ...oldAssessment.risk, override, effectiveLevel: "high" } } }] });
    const generated = canvasV6({ nodes: [{ ...previous, assessment: newAssessment }] });
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
    const generated = canvasV6({
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

function canvasV6(overrides: Partial<CodeflowCanvas>): CodeflowCanvas {
  return {
    ...canvasBase(),
    version: 6,
    layout: { activeMode: "architecture", viewMode: "architecture", manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
    nodes: [],
    edges: [],
    ...overrides
  };
}

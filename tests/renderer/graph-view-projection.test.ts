import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../src/types";
import { chooseInitialGraphView, matchesOverviewIdentity, nodeConnectionExplanation, projectGraphForView, selectOverviewFrontier } from "../../src/utils/graph-view-projection";

describe("graph view projection", () => {
  it.each([
    ["calls", "runtime"],
    ["reads_writes", "data"],
    ["external_api", "external"],
    ["publishes_event", "event"],
    ["subscribes_event", "event"],
    ["depends_on", "dependency"],
    ["tests", "test"]
  ] as const)("classifies %s as %s", (relation, edgeClass) => {
    const edge = graphEdge("edge", "api", "service", relation);
    const { edges } = projectGraphForView(nodes, [edge], "execution", { additionalRelations: [relation] });

    expect(edges[0].edgeClass).toBe(edgeClass);
  });

  it("hides dependencies by default and shows them when selected as an additional relation", () => {
    const original = [
      graphEdge("call", "api", "service", "calls", evidence),
      graphEdge("import", "service", "data", "depends_on", evidence),
      graphEdge("test", "tests", "service", "tests", evidence)
    ];

    const base = projectGraphForView(nodes, original, "execution", {});
    const withDependencies = projectGraphForView(nodes, original, "execution", { additionalRelations: ["depends_on"] });

    expect(base.edges.map((edge) => edge.id)).toEqual(["call"]);
    expect(withDependencies.edges.map((edge) => edge.id)).toEqual(["call", "import"]);
    expect(withDependencies.edges[1]).toMatchObject({ confidence: "inferred", participatesInLayering: false });
    expect(base.diagnostics.hiddenDependencyEdgeCount).toBe(1);
    expect(withDependencies.diagnostics.hiddenDependencyEdgeCount).toBe(0);
    expect(original).toHaveLength(3);
  });

  it("keeps every edge in dependency projection without mutating the facts", () => {
    const original = [
      graphEdge("call", "api", "service", "calls", evidence),
      graphEdge("import", "service", "data", "depends_on", evidence),
      graphEdge("test", "tests", "service", "tests", evidence)
    ];
    const snapshot = structuredClone(original);

    const { edges } = projectGraphForView(nodes, original, "dependency", {});

    expect(edges.map((edge) => edge.id)).toEqual(["import"]);
    expect(original).toEqual(snapshot);
  });

  it("keeps test-only calls out of the functional view and its coverage", () => {
    const edges = [graphEdge("runtime", "api", "service", "calls"), graphEdge("test-call", "tests", "data", "calls")];
    const execution = projectGraphForView(nodes, edges, "execution", {});
    expect(execution.edges.map((edge) => edge.id)).toEqual(["runtime"]);
    expect(execution.diagnostics.connectedExecutableModuleCount).toBe(2);
    expect(execution.diagnostics.isolatedModuleIds).toEqual(["data"]);
    expect(projectGraphForView(nodes, edges, "execution", { additionalRelations: ["calls"] }).edges).toHaveLength(1);
  });

  it("keeps unrelated resources and tests off the default module graph", () => {
    const resource: GraphNode = {
      ...nodes[0], id: "external-api", files: [],
      resource: { id: "external-api", kind: "api", scopeId: "app", key: "remote", title: "Remote", detail: "", evidence: [] }
    };
    const graphNodes = [...nodes, resource];
    const call = graphEdge("call", "api", "service", "calls");
    const api = graphEdge("api-contract", "api", resource.id, "external_api");
    const base = projectGraphForView(graphNodes, [call, api], "execution", {});
    const withContract = projectGraphForView(graphNodes, [call, api], "execution", { additionalRelations: ["external_api"] });
    expect(base.nodes.map((node) => node.id)).toEqual(["api", "service", "data"]);
    expect(withContract.nodes.map((node) => node.id)).toEqual(["api", "service", "data", "external-api"]);
  });

  it("keeps a test-only project's confirmed calls visible", () => {
    const testNodes = [
      { ...nodes[3], id: "integration-tests" },
      { ...nodes[3], id: "unit-tests" }
    ];
    const graph = projectGraphForView(testNodes, [graphEdge("test-call", "integration-tests", "unit-tests", "calls")], "execution", {});
    expect(graph.nodes.map((node) => node.id)).toEqual(["integration-tests", "unit-tests"]);
    expect(graph.edges.map((edge) => edge.id)).toEqual(["test-call"]);
  });

  it("preserves semantic confidence instead of treating evidence as confirmation", () => {
    const inferred = { ...graphEdge("inferred", "api", "service", "calls", evidence), confidence: "inferred" as const };
    const projected = projectGraphForView(nodes, [inferred], "execution", {});

    expect(projected.edges).toEqual([]);
  });

  it("chooses a visible initial view for runtime, dependency-only, and empty graphs", () => {
    expect(chooseInitialGraphView([graphEdge("call", "api", "service", "calls", evidence)])).toBe("execution");
    expect(chooseInitialGraphView([graphEdge("import", "api", "service", "depends_on")])).toBe("execution");
    expect(chooseInitialGraphView([])).toBe("execution");
  });

  it("shows only confirmed calls by default and adds other relation types only when selected", () => {
    const edges = [
      { ...graphEdge("confirmed-call", "api", "service", "calls", evidence), confidence: "confirmed" as const },
      { ...graphEdge("inferred-call", "api", "data", "calls", evidence), confidence: "inferred" as const },
      graphEdge("import", "service", "data", "depends_on", evidence),
      graphEdge("read-write", "service", "data", "reads_writes", evidence)
    ];
    const base = projectGraphForView(nodes, edges, "execution", {});
    const extended = projectGraphForView(nodes, edges, "execution", {
      additionalRelations: ["reads_writes"]
    });

    expect(base.edges.map((edge) => edge.id)).toEqual(["confirmed-call"]);
    expect(extended.edges.map((edge) => edge.id)).toEqual(["confirmed-call", "read-write"]);
  });

  it("keeps user-declared calls separate from confirmed source calls", () => {
    const declared = { ...graphEdge("declared", "api", "data", "calls"), origin: "manual" as const };
    const confirmed = graphEdge("confirmed", "api", "service", "calls", evidence);

    const defaultGraph = projectGraphForView(nodes, [declared, confirmed], "execution", {});
    const withManual = projectGraphForView(nodes, [declared, confirmed], "execution", {
      additionalRelations: ["manual"]
    });

    expect(defaultGraph.edges.map((edge) => edge.id)).toEqual(["confirmed"]);
    expect(withManual.edges.map((edge) => edge.id)).toEqual(["confirmed", "declared"]);
    expect(withManual.edges.find((edge) => edge.id === "declared")?.participatesInLayering).toBe(false);
    expect(withManual.diagnostics.connectedExecutableModuleCount).toBe(2);
  });

  it("opens mixed graphs in the confirmed-call view and keeps dependencies in their own view", () => {
    const edges = [graphEdge("http", "api", "service", "calls"), graphEdge("import", "service", "data", "depends_on")];
    const view = chooseInitialGraphView(edges);
    expect(view).toBe("execution");
    expect(projectGraphForView(nodes, edges, view, {}).edges.map((edge) => edge.id)).toEqual(["http"]);
    expect(projectGraphForView(nodes, edges, "dependency", {}).edges.map((edge) => edge.id)).toEqual(["import"]);
  });

  it("projects event publishers and subscribers through a verifiable boundary", () => {
    const eventEdges = [
      graphEdge("publish", "api", "service", "publishes_event", [{ ...evidence[0], eventId: "user.created" }]),
      graphEdge("subscribe", "service", "data", "subscribes_event", [{ ...evidence[0], eventId: "user.created" }])
    ];

    const projected = projectGraphForView(nodes, eventEdges, "execution", {
      additionalRelations: ["publishes_event", "subscribes_event"]
    });

    expect(projected.edges.map(({ source, target }) => [source, target])).toEqual([
      ["api", "event-boundary:user.created"],
      ["event-boundary:user.created", "data"]
    ]);
    expect(projected.nodes.filter((node) => node.syntheticKind === "event-boundary")).toHaveLength(1);
    expect(projected.edges.map((edge) => edge.sourceEdgeIds)).toEqual([["publish"], ["subscribe"]]);
  });

  it("keeps event endpoints unresolved when no event identity is available", () => {
    const edge = graphEdge("publish", "api", "service", "publishes_event", evidence);

    const projected = projectGraphForView(nodes, [edge], "execution", {
      additionalRelations: ["publishes_event"]
    });

    expect(projected.edges[0]).toMatchObject({
      source: "api",
      target: "unresolved-event:publish",
      sourceEdgeIds: ["publish"]
    });
    expect(projected.edges[0].target).not.toBe("service");
    expect(projected.diagnostics.unresolvedEventCount).toBe(1);
  });

  it("uses canonical resource event endpoints without adding a second boundary or counting resources as modules", () => {
    const resource: GraphNode = {
      ...nodes[1], id: "event:created", files: [],
      resource: { id: "event:created", kind: "event", scopeId: "app", key: "created", title: "Created", detail: "", evidence: [] }
    };
    const edges = [graphEdge("publish", "api", resource.id, "publishes_event", [{ ...evidence[0], eventId: "created" }])];
    const projection = projectGraphForView([nodes[0], resource], edges, "execution", { additionalRelations: ["publishes_event"] });
    expect(projection.nodes.map((node) => node.id)).toEqual(["api", "event:created"]);
    expect(projection.edges[0].target).toBe(resource.id);
    expect(projection.diagnostics.executableModuleCount).toBe(1);
    expect(projection.diagnostics.connectedExecutableModuleCount).toBe(1);
  });

  it("distinguishes dependency-only, internal, unresolved, and absent module relationships", () => {
    const node = nodes[0];
    const dependency = graphEdge("import", node.id, nodes[1].id, "depends_on");
    expect(nodeConnectionExplanation(node, [dependency])).toBe("dependency");
    expect(nodeConnectionExplanation(node, [graphEdge("call", node.id, nodes[1].id, "calls")])).toBeUndefined();
    expect(nodeConnectionExplanation({ ...node, relationSummary: { dependencies: 0, internalRelations: 2, unresolvedRelations: 0, externalRelations: 0 } }, [])).toBe("internal");
    expect(nodeConnectionExplanation({ ...node, relationSummary: { dependencies: 0, internalRelations: 0, unresolvedRelations: 2, externalRelations: 0 } }, [])).toBe("unresolved");
    expect(nodeConnectionExplanation({ ...node, relationSummary: { dependencies: 0, internalRelations: 0, unresolvedRelations: 0, externalRelations: 2 } }, [])).toBe("external");
    expect(nodeConnectionExplanation(node, [])).toBe("none");
  });

  it("throws an actionable error for an unknown endpoint", () => {
    expect(() => projectGraphForView(nodes, [graphEdge("broken", "api", "missing", "calls")], "dependency", {}))
      .toThrow("edgeId=broken source=api target=missing");
  });

  it("selects a readable frontier from actual viewport area and preserves every module identity", () => {
    const modules = Array.from({ length: 16 }, (_, index) => {
      const area = Math.floor(index / 4);
      return {
        ...nodes[0],
        id: `module:${index}`,
        areaId: `area:${area}`,
        groupPath: [{ id: `area:${area}`, title: `Area ${area}`, rootPath: `src/area-${area}` }]
      };
    });
    const input = {
      nodes: modules,
      cardSize: { width: 280, height: 150 },
      expandedGroupIds: [],
      collapsedGroupIds: [],
      identity: { generationId: "generation-1", userRevision: 7, viewRequestId: "generation-1:7:3" }
    };
    const compact = selectOverviewFrontier({ ...input, viewport: { width: 960, height: 640 } });
    const detailsPanel = selectOverviewFrontier({ ...input, viewport: { width: 720, height: 640 } });
    const medium = selectOverviewFrontier({ ...input, viewport: { width: 1440, height: 900 } });
    const wide = selectOverviewFrontier({ ...input, viewport: { width: 1920, height: 1080 } });

    expect(compact.collapsedGroupIds).toHaveLength(4);
    expect(medium.collapsedGroupIds).toHaveLength(1);
    expect(wide.collapsedGroupIds).toEqual([]);
    expect(compact.readability.isReadable).toBe(true);
    expect(detailsPanel.readability.isReadable).toBe(true);
    expect(detailsPanel.visibleNodeIds.length).toBeLessThanOrEqual(compact.visibleNodeIds.length);
    expect(medium.readability.isReadable).toBe(true);
    expect(wide.readability.isReadable).toBe(true);
    expect(Object.values(compact.aggregationMap).flat().sort()).toEqual(modules.map((node) => node.id).sort());
    expect(compact.identity).toEqual(input.identity);
  });

  it("keeps user-expanded groups open across a smaller viewport and reports readability limits", () => {
    const modules = Array.from({ length: 16 }, (_, index) => {
      const area = Math.floor(index / 4);
      return {
        ...nodes[0],
        id: `module:${index}`,
        areaId: `area:${area}`,
        groupPath: [{ id: `area:${area}`, title: `Area ${area}`, rootPath: `src/area-${area}` }]
      };
    });

    const frontier = selectOverviewFrontier({
      nodes: modules,
      viewport: { width: 280, height: 150 },
      cardSize: { width: 280, height: 150 },
      collapsedGroupIds: [],
      expandedGroupIds: ["area:0"],
      identity: { generationId: "generation-2", userRevision: 9, viewRequestId: "generation-2:9:4" }
    });

    expect(frontier.collapsedGroupIds).not.toContain("area:0");
    expect(frontier.readability.isReadable).toBe(false);
    expect(frontier.readability.reason).toMatch(/expanded groups|available area/i);
    expect(frontier.pendingExpansionCounts["area:0"]).toBeUndefined();
    expect(frontier.identity).toMatchObject({ generationId: "generation-2", userRevision: 9, viewRequestId: "generation-2:9:4" });
  });

  it("rejects a derived view when generation, saved revision, or viewport request has changed", () => {
    const request = { generationId: "generation-3", userRevision: 12, viewRequestId: "view:960x640" };
    expect(matchesOverviewIdentity(request, request)).toBe(true);
    expect(matchesOverviewIdentity(request, { ...request, generationId: "generation-4" })).toBe(false);
    expect(matchesOverviewIdentity(request, { ...request, userRevision: 13 })).toBe(false);
    expect(matchesOverviewIdentity(request, { ...request, viewRequestId: "view:1440x900" })).toBe(false);
  });
});

const evidence = [{ filePath: "src/api.ts", symbol: "handle", detail: "Confirmed call." }];

const nodes: GraphNode[] = ["api", "service", "data", "tests"].map((id) => ({
  id,
  title: id,
  subtitle: id,
  kind: "module",
  nodeType: id === "tests" ? "test" : "service",
  risk: "unknown",
  description: id,
  files: [`src/${id}.ts`],
  guidanceDraft: "",
  status: "mapped",
  x: 0,
  y: 0
}));

function graphEdge(
  id: string,
  source: string,
  target: string,
  relation: GraphEdge["relation"],
  edgeEvidence?: GraphEdge["evidence"]
): GraphEdge {
  return { id, source, target, relation, confidence: relation === "calls" ? "confirmed" : undefined, evidence: edgeEvidence };
}

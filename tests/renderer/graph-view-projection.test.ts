import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../src/types";
import { chooseInitialGraphView, nodeConnectionExplanation, projectGraphForView } from "../../src/utils/graph-view-projection";

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
    const { edges } = projectGraphForView(nodes, [edge], "dependency", {
      includeInferredDependencyOverlay: false
    });

    expect(edges[0].edgeClass).toBe(edgeClass);
  });

  it("hides tests and import dependencies in execution unless the inferred overlay is enabled", () => {
    const original = [
      graphEdge("call", "api", "service", "calls", evidence),
      graphEdge("import", "service", "data", "depends_on", evidence),
      graphEdge("test", "tests", "service", "tests", evidence)
    ];

    const base = projectGraphForView(nodes, original, "execution", {
      includeInferredDependencyOverlay: false
    });
    const overlaid = projectGraphForView(nodes, original, "execution", {
      includeInferredDependencyOverlay: true
    });

    expect(base.edges.map((edge) => edge.id)).toEqual(["call"]);
    expect(overlaid.edges.map((edge) => edge.id)).toEqual(["call", "import"]);
    expect(overlaid.edges[1]).toMatchObject({ confidence: "inferred", participatesInLayering: false });
    expect(base.diagnostics.hiddenDependencyEdgeCount).toBe(1);
    expect(overlaid.diagnostics.inferredOverlayEdgeCount).toBe(1);
    expect(original).toHaveLength(3);
  });

  it("keeps every edge in dependency projection without mutating the facts", () => {
    const original = [
      graphEdge("call", "api", "service", "calls", evidence),
      graphEdge("import", "service", "data", "depends_on", evidence),
      graphEdge("test", "tests", "service", "tests", evidence)
    ];
    const snapshot = structuredClone(original);

    const { edges } = projectGraphForView(nodes, original, "dependency", {
      includeInferredDependencyOverlay: false
    });

    expect(edges.map((edge) => edge.id)).toEqual(["call", "import", "test"]);
    expect(original).toEqual(snapshot);
  });

  it("keeps test-only calls out of execution coverage while preserving them in the overview", () => {
    const edges = [graphEdge("runtime", "api", "service", "calls"), graphEdge("test-call", "tests", "data", "calls")];
    const execution = projectGraphForView(nodes, edges, "execution", { includeInferredDependencyOverlay: false });
    expect(execution.edges.map((edge) => edge.id)).toEqual(["runtime"]);
    expect(execution.diagnostics.connectedExecutableModuleCount).toBe(2);
    expect(execution.diagnostics.isolatedModuleIds).toEqual(["data"]);
    expect(projectGraphForView(nodes, edges, "architecture", { includeInferredDependencyOverlay: false }).edges).toHaveLength(2);
  });

  it("preserves semantic confidence instead of treating evidence as confirmation", () => {
    const inferred = { ...graphEdge("inferred", "api", "service", "calls", evidence), confidence: "inferred" as const };
    const projected = projectGraphForView(nodes, [inferred], "execution", {
      includeInferredDependencyOverlay: false
    });

    expect(projected.edges[0]).toMatchObject({ confidence: "inferred", evidence });
  });

  it("chooses a visible initial view for runtime, dependency-only, and empty graphs", () => {
    expect(chooseInitialGraphView([graphEdge("call", "api", "service", "calls")])).toBe("architecture");
    expect(chooseInitialGraphView([graphEdge("import", "api", "service", "depends_on")])).toBe("architecture");
    expect(chooseInitialGraphView([])).toBe("architecture");
  });

  it("opens mixed graphs in an overview that preserves dependencies alongside runtime relations", () => {
    const edges = [graphEdge("http", "api", "service", "calls"), graphEdge("import", "service", "data", "depends_on")];
    const view = chooseInitialGraphView(edges);
    expect(view).toBe("architecture");
    expect(projectGraphForView(nodes, edges, view, { includeInferredDependencyOverlay: false }).edges).toHaveLength(2);
  });

  it("projects event publishers and subscribers through a verifiable boundary", () => {
    const eventEdges = [
      graphEdge("publish", "api", "service", "publishes_event", [{ ...evidence[0], eventId: "user.created" }]),
      graphEdge("subscribe", "service", "data", "subscribes_event", [{ ...evidence[0], eventId: "user.created" }])
    ];

    const projected = projectGraphForView(nodes, eventEdges, "execution", {
      includeInferredDependencyOverlay: false
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
      includeInferredDependencyOverlay: false
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
    const projection = projectGraphForView([nodes[0], resource], edges, "execution", { includeInferredDependencyOverlay: false });
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
    expect(() => projectGraphForView(nodes, [graphEdge("broken", "api", "missing", "calls")], "dependency", {
      includeInferredDependencyOverlay: false
    })).toThrow("edgeId=broken source=api target=missing");
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
  return { id, source, target, relation, evidence: edgeEvidence };
}

import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../src/types";
import { projectGraphForView } from "../../src/utils/graph-view-projection";

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

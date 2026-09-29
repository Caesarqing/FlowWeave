import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../src/types";
import { chooseInitialCollapsedGroups, createFlowEdge, createFlowNode, expandedGroupsForGroup, expandedGroupsForNode, graphEdgeFromFlow, projectCollapsedFlowGraph, traceDisplayNodeIds } from "../../src/utils/graph-converters";

const packageGroup = { id: "scope:app", title: "App", rootPath: "app" };
const featureGroup = { id: "group:orders", title: "Orders", rootPath: "app/orders", parentId: packageGroup.id };
const nodes: GraphNode[] = ["first", "second"].map((id) => ({
  id, title: id, subtitle: "", kind: "module", nodeType: "service", risk: "unknown", description: id,
  files: [`app/orders/${id}.ts`], guidanceDraft: "", status: "mapped", x: 0, y: 0, groupPath: [packageGroup, featureGroup]
}));
const outside: GraphNode = { ...nodes[0], id: "outside", groupPath: [{ id: "scope:worker", title: "Worker", rootPath: "worker" }] };

describe("canvas hierarchy projection", () => {
  it("creates a real group card and retains all evidence and semantic distinctions when folding", () => {
    const edges: GraphEdge[] = [
      { id: "render", source: "first", target: "outside", relation: "calls", semanticKinds: ["render"], sourceRelationIds: ["semantic-render"], evidence: [{ filePath: "app/orders/first.ts", detail: "renders child" }] },
      { id: "call", source: "second", target: "outside", relation: "calls", semanticKinds: ["call"], sourceRelationIds: ["semantic-call"], evidence: [{ filePath: "app/orders/second.ts", detail: "calls child" }] },
      { id: "read", source: "first", target: "outside", relation: "reads_writes", operations: ["read"] },
      { id: "write", source: "second", target: "outside", relation: "reads_writes", operations: ["write"] }
    ];
    const sourceNodes = [...nodes, outside].map(createFlowNode);
    const sourceEdges = edges.map(createFlowEdge);
    const original = structuredClone({ sourceNodes, sourceEdges });
    const folded = projectCollapsedFlowGraph(sourceNodes, sourceEdges, "architecture", [packageGroup.id, featureGroup.id]);
    expect(folded.nodes.map((node) => node.id)).toEqual(["outside", `group:${packageGroup.id}`]);
    expect(folded.nodes[1].data).toMatchObject({ title: "App", syntheticKind: "group", memberNodeIds: ["first", "second"], groupId: packageGroup.id });
    const call = folded.edges.find((edge) => edge.data?.relation === "calls");
    expect(graphEdgeFromFlow(call!)).toMatchObject({ semanticKinds: ["call", "render"], sourceRelationIds: ["semantic-call", "semantic-render"], aggregatedEdgeIds: ["call", "render"], evidence: expect.arrayContaining(edges.slice(0, 2).flatMap((edge) => edge.evidence ?? [])) });
    expect(graphEdgeFromFlow(folded.edges.find((edge) => edge.data?.relation === "reads_writes")!)).toMatchObject({ operations: ["read", "write"] });
    expect({ sourceNodes, sourceEdges }).toEqual(original);
  });

  it("expands only a search result's ancestors and restores original source facts", () => {
    const collapsed = [packageGroup.id, featureGroup.id, "scope:worker"];
    const expanded = expandedGroupsForNode(nodes[1], "architecture", collapsed);
    expect(expanded).toEqual(["scope:worker"]);
    const unfolded = projectCollapsedFlowGraph([...nodes, outside].map(createFlowNode), [], "architecture", expanded);
    expect(unfolded.nodes.map((node) => node.id)).toEqual(["first", "second", "group:scope:worker"]);
    expect(collapsed).toEqual([packageGroup.id, featureGroup.id, "scope:worker"]);
  });

  it("opens a package one level at a time and keeps unrelated packages folded", () => {
    const packages = [packageGroup.id, "scope:worker"];
    const expandedPackage = expandedGroupsForGroup([...nodes, outside], "architecture", packageGroup.id, packages);
    expect(expandedPackage).toEqual([featureGroup.id, "scope:worker"]);
    expect(expandedGroupsForGroup([...nodes, outside], "architecture", featureGroup.id, expandedPackage)).toEqual(["scope:worker"]);
  });

  it("keeps a selected module's trace on source facts across folding and expansion", () => {
    const sourceNodes = [...nodes, outside, { ...outside, id: "unrelated" }].map(createFlowNode);
    const sourceEdges = [
      createFlowEdge({ id: "first-outside", source: "first", target: "outside", relation: "calls" }),
      createFlowEdge({ id: "second-unrelated", source: "second", target: "unrelated", relation: "calls" })
    ];
    const collapsed = projectCollapsedFlowGraph(sourceNodes, sourceEdges, "architecture", [packageGroup.id]);
    expect([...traceDisplayNodeIds("first", sourceNodes, sourceEdges, collapsed.nodes, "architecture", "downstream")].sort()).toEqual(["group:scope:app", "outside"]);
    expect([...traceDisplayNodeIds("first", sourceNodes, sourceEdges, sourceNodes, "architecture", "downstream")].sort()).toEqual(["first", "outside"]);
    expect([...traceDisplayNodeIds("group:scope:app", sourceNodes, sourceEdges, sourceNodes, "architecture", "downstream")].sort()).toEqual(["first", "outside", "second", "unrelated"]);
  });

  it("starts multiple packages collapsed and opens a single package to functional groups", () => {
    expect(chooseInitialCollapsedGroups([...nodes, outside])).toEqual(["scope:app", "scope:worker"]);
    expect(chooseInitialCollapsedGroups(nodes)).toEqual(["group:orders"]);
    const resource: GraphNode = { ...nodes[0], id: "event", files: [], resource: { id: "event", kind: "event", scopeId: "app", key: "event", title: "Event", detail: "", evidence: [] }, groupPath: [packageGroup, { id: "group:resources", title: "Resources", rootPath: "app", parentId: packageGroup.id }] };
    expect(chooseInitialCollapsedGroups([...nodes, resource])).toEqual(["group:orders", "group:resources"]);
  });
});

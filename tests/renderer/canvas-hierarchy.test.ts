import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../src/types";
import { createFlowEdge, createFlowNode, decorateFlowGraph, expandedGroupsForNode, graphEdgeFromFlow, projectCollapsedFlowGraph, traceDisplayNodeIds } from "../../src/utils/graph-converters";
import { nodeGroupKey } from "../../src/utils/canvas-layout";
import { filterCanvasToModuleGroups } from "../../src/components/CanvasWorkspace";
import { CANVAS_NODE_SIZE } from "../../src/common/canvas-geometry";

const packageGroup = { id: "group:package:app", title: "App", rootPath: "app" };
const featureGroup = { id: "group:directory:app/orders", title: "Orders", rootPath: "app/orders", parentId: packageGroup.id };
const nodes: GraphNode[] = ["first", "second"].map((id) => ({
  id, title: id, subtitle: "", kind: "module", nodeType: "service", risk: "unknown", description: id,
  files: [`app/orders/${id}.ts`], guidanceDraft: "", status: "mapped", x: 0, y: 0, groupPath: [packageGroup, featureGroup]
}));
const outside: GraphNode = { ...nodes[0], id: "outside", groupPath: [
  { id: "group:package:worker", title: "Worker package", rootPath: "worker" },
  { id: "group:directory:worker", title: "Worker", rootPath: "worker" }
] };

describe("canvas hierarchy projection", () => {
  it("gives collapsed cards measured endpoints for their visible relations", () => {
    const collapsed = projectCollapsedFlowGraph([...nodes, outside].map(createFlowNode), [
      createFlowEdge({ id: "call", source: "first", target: "outside", relation: "calls" })
    ], "execution", [featureGroup.id]);
    const decorated = decorateFlowGraph(collapsed.nodes, collapsed.edges);
    const group = decorated.nodes.find((node) => node.id === `group:${featureGroup.id}`)!;
    expect(group.initialWidth).toBe(CANVAS_NODE_SIZE.width);
    expect(group.initialHeight).toBe(CANVAS_NODE_SIZE.height);
    expect(group.handles?.every((handle) => (handle.x === 0 || handle.x === CANVAS_NODE_SIZE.width) && handle.y >= 0 && handle.y <= CANVAS_NODE_SIZE.height)).toBe(true);
    expect(group.handles?.some((handle) => handle.id === decorated.edges[0].sourceHandle)).toBe(true);
  });

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
    const folded = projectCollapsedFlowGraph(sourceNodes, sourceEdges, "execution", [featureGroup.id]);
    expect(folded.nodes.map((node) => node.id)).toEqual(["outside", `group:${featureGroup.id}`]);
    expect(folded.nodes[1].data).toMatchObject({ title: "Orders", syntheticKind: "group", memberNodeIds: ["first", "second"], groupId: featureGroup.id });
    const call = folded.edges.find((edge) => edge.data?.relation === "calls");
    expect(graphEdgeFromFlow(call!)).toMatchObject({ semanticKinds: ["call", "render"], sourceRelationIds: ["semantic-call", "semantic-render"], aggregatedEdgeIds: ["call", "render"], evidence: expect.arrayContaining(edges.slice(0, 2).flatMap((edge) => edge.evidence ?? [])) });
    expect(graphEdgeFromFlow(folded.edges.find((edge) => edge.data?.relation === "reads_writes")!)).toMatchObject({ operations: ["read", "write"] });
    expect({ sourceNodes, sourceEdges }).toEqual(original);
  });

  it("expands only a search result's ancestors and restores original source facts", () => {
    const collapsed = [featureGroup.id, "group:directory:worker"];
    const expanded = expandedGroupsForNode(nodes[1], "execution", collapsed);
    expect(expanded).toEqual(["group:directory:worker"]);
    const unfolded = projectCollapsedFlowGraph([...nodes, outside].map(createFlowNode), [], "execution", expanded);
    expect(unfolded.nodes.map((node) => node.id)).toEqual(["first", "second", "group:group:directory:worker"]);
    expect(collapsed).toEqual([featureGroup.id, "group:directory:worker"]);
  });

  it("shows real modules until a functional area is explicitly collapsed", () => {
    const expanded = projectCollapsedFlowGraph([...nodes, outside].map(createFlowNode), [], "execution", []);
    expect(expanded.nodes.map((node) => node.id)).toEqual(["first", "second", "outside"]);
  });

  it("uses the same persisted area identity for filtering and collapsing", () => {
    const sharedArea = "area:orders";
    const first = { ...nodes[0], areaId: sharedArea };
    const second = { ...nodes[1], areaId: sharedArea, groupPath: [packageGroup] };
    const unrelated = { ...outside, areaId: "area:worker" };
    const graphNodes = [first, second, unrelated].map(createFlowNode);

    expect(nodeGroupKey(first)).toBe(sharedArea);
    expect(nodeGroupKey(second)).toBe(sharedArea);
    expect(filterCanvasToModuleGroups(graphNodes, [], [sharedArea]).nodes.map((node) => node.id)).toEqual(["first", "second"]);
    expect(projectCollapsedFlowGraph(graphNodes, [], "execution", [sharedArea]).nodes.map((node) => node.id))
      .toEqual(["outside", `group:${sharedArea}`]);
  });

  it("keeps a selected module's trace on source facts across folding and expansion", () => {
    const sourceNodes = [...nodes, outside, { ...outside, id: "unrelated" }].map(createFlowNode);
    const sourceEdges = [
      createFlowEdge({ id: "first-outside", source: "first", target: "outside", relation: "calls" }),
      createFlowEdge({ id: "second-unrelated", source: "second", target: "unrelated", relation: "calls" })
    ];
    const collapsed = projectCollapsedFlowGraph(sourceNodes, sourceEdges, "execution", [featureGroup.id]);
    expect([...traceDisplayNodeIds("first", sourceNodes, sourceEdges, collapsed.nodes, "execution", "downstream")].sort()).toEqual([`group:${featureGroup.id}`, "outside"]);
    expect([...traceDisplayNodeIds("first", sourceNodes, sourceEdges, sourceNodes, "execution", "downstream")].sort()).toEqual(["first", "outside"]);
    expect([...traceDisplayNodeIds(`group:${featureGroup.id}`, sourceNodes, sourceEdges, sourceNodes, "execution", "downstream")].sort()).toEqual(["first", "outside", "second", "unrelated"]);
  });
});

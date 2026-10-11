import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import type { CanvasLayoutMode } from "../../src/types";
import { autoLayoutIsCurrent, canvasTopologyFingerprint, layoutCanvasNodesWithEngine, layoutExpandedCanvasNodes } from "../../src/utils/canvas-layout";
import { createFlowNode, expandedGroupsForGroup, projectCollapsedFlowGraph, type FlowWeaveNode } from "../../src/utils/graph-converters";

type LayoutScenario = {
  name: string;
  nodeCount: number;
  connections: [number, number][];
  cardSize: { width: number; height: number };
};

const scenarios: LayoutScenario[] = [
  { name: "chain", nodeCount: 6, connections: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]], cardSize: { width: 280, height: 150 } },
  { name: "star", nodeCount: 6, connections: [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5]], cardSize: { width: 280, height: 150 } },
  { name: "dense", nodeCount: 6, connections: [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [2, 5], [3, 4], [3, 5], [4, 5]], cardSize: { width: 280, height: 150 } },
  { name: "cyclic", nodeCount: 6, connections: [[0, 1], [1, 2], [2, 0], [2, 3], [3, 4], [4, 3], [4, 5]], cardSize: { width: 280, height: 150 } },
  { name: "disconnected", nodeCount: 8, connections: [[0, 1], [2, 3], [3, 4]], cardSize: { width: 280, height: 150 } },
  { name: "long-title", nodeCount: 6, connections: [[0, 1], [0, 2], [1, 3], [2, 4], [4, 5]], cardSize: { width: 480, height: 310 } }
];
const modes: CanvasLayoutMode[] = ["execution", "dependency"];
const elk = new ELK();

describe("layout stability with real ELK", () => {
  it("lays out weakly disconnected execution regions independently and keeps earlier regions fixed", async () => {
    const nodes = ["a-entry", "a-service", "b-entry", "b-service"].map((id) => flowNode(id, { width: 280, height: 150 }));
    const edges: Edge[] = [
      { id: "a-call", source: "a-entry", target: "a-service", data: { relation: "calls" } },
      { id: "b-call", source: "b-entry", target: "b-service", data: { relation: "calls" } }
    ];
    const layoutPasses: ElkNode[] = [];
    const base = await layoutCanvasNodesWithEngine(nodes, edges, "execution", async (graph) => {
      layoutPasses.push(graph);
      return elk.layout(graph);
    });
    const withExtraRegion = await layoutCanvasNodesWithEngine(
      [...nodes, flowNode("z-entry", { width: 280, height: 150 }), flowNode("z-service", { width: 280, height: 150 })],
      [...edges, { id: "z-call", source: "z-entry", target: "z-service", data: { relation: "calls" } }],
      "execution",
      async (graph) => {
        layoutPasses.push(graph);
        return elk.layout(graph);
      }
    );

    expect(layoutPasses).toHaveLength(5);
    expect(Object.fromEntries(base.map((node) => [node.id, node.position]))).toMatchObject(
      Object.fromEntries(withExtraRegion.filter((node) => node.id.startsWith("a-") || node.id.startsWith("b-"))
        .map((node) => [node.id, node.position]))
    );
  });

  it.each(scenarios.flatMap((scenario) => modes.map((mode) => ({ ...scenario, mode }))))(
    "$mode $name remains non-overlapping and deterministic until card dimensions change",
    async ({ name, nodeCount, connections, cardSize, mode }) => {
      const nodes = Array.from({ length: nodeCount }, (_, index) => flowNode(`module:${index}`, cardSize));
      if (name === "long-title") {
        nodes[0] = { ...nodes[0], data: { ...nodes[0].data, title: "跨目录工作流模块职责与输入输出边界的完整说明 ".repeat(16) } };
      }
      const edges: Edge[] = connections.map(([source, target], index) => ({
        id: `relation:${index}`, source: `module:${source}`, target: `module:${target}`,
        data: { relation: mode === "execution" ? "calls" : "depends_on" }
      }));
      const original = structuredClone({ nodes, edges });
      const first = await layoutCanvasNodesWithEngine(nodes, edges, mode, (graph) => elk.layout(graph));
      const repeated = await layoutCanvasNodesWithEngine(nodes, edges, mode, (graph) => elk.layout(graph));
      const reordered = await layoutCanvasNodesWithEngine([...nodes].reverse(), [...edges].reverse(), mode, (graph) => elk.layout(graph));

      expect({ nodes, edges }).toEqual(original);
      expect(first.map((item) => item.id).sort()).toEqual(nodes.map((item) => item.id).sort());
      expect(first.every((item) => Number.isFinite(item.position.x) && Number.isFinite(item.position.y))).toBe(true);
      expect(positionsById(repeated)).toEqual(positionsById(first));
      expect(positionsById(reordered)).toEqual(positionsById(first));
      expectNoOverlap(first);
      if (name === "chain" || name === "star" || name === "dense" || name === "long-title") {
        const byId = new Map(first.map((item) => [item.id, item]));
        for (const edge of edges) {
          const source = byId.get(edge.source)!;
          expect(source.position.x + cardSize.width).toBeLessThanOrEqual(byId.get(edge.target)!.position.x);
        }
      }
      if (name === "cyclic" && mode === "execution") {
        expect(first.filter((item) => item.data.cycleGroupId).map((item) => item.id).sort())
          .toEqual(["module:0", "module:1", "module:2", "module:3", "module:4"]);
      }
      const topologyFingerprint = canvasTopologyFingerprint(nodes, edges);
      const savedLayout = {
        activeMode: mode, manualPositions: {}, autoLayouts: { [mode]: positionsById(first) },
        autoLayoutTopologyFingerprints: { [mode]: topologyFingerprint }, collapsedGroups: []
      };
      const enlarged = nodes.map((item, index) => index === 0
        ? { ...item, measured: { width: cardSize.width + 160, height: cardSize.height + 100 } } : item);

      expect(autoLayoutIsCurrent(savedLayout, mode, canvasTopologyFingerprint(enlarged, edges))).toBe(false);
      const resized = await layoutCanvasNodesWithEngine(enlarged, edges, mode, (graph) => elk.layout(graph));
      expectNoOverlap(resized);
    }
  );

  it("reuses module and user positions through repeated group expansion and collapse regardless of input order", async () => {
    const entry = flowNode("entry", { width: 280, height: 150 });
    const nodes = [
      { ...entry, data: { ...entry.data, areaId: "area:entry" } },
      ...["service:a", "service:b"].map((id) => {
        const item = flowNode(id, { width: 280, height: 150 });
        return { ...item, data: { ...item.data, areaId: "area:services", groupPath: [{ id: "area:services", title: "Services", rootPath: "src/services" }] } };
      })
    ];
    const edges: Edge[] = [
      { id: "entry:a", source: "entry", target: "service:a", data: { relation: "calls" } },
      { id: "a:b", source: "service:a", target: "service:b", data: { relation: "calls" } }
    ];
    const positioned = await layoutCanvasNodesWithEngine(nodes, edges, "execution", (graph) => elk.layout(graph));
    const user = flowNode("user:note", { width: 280, height: 150 });
    const base = [...positioned, { ...user, position: { x: 1900, y: 700 }, data: { ...user.data, origin: "manual" as const, x: 1900, y: 700 } }];
    const original = structuredClone(base);
    const collapsed = projectCollapsedFlowGraph(base, edges, "execution", ["area:services"]);
    const collapsedPositions = positionsById(collapsed.nodes);
    const basePositions = positionsById(base);
    for (let round = 0; round < 3; round += 1) {
      const input = round % 2 === 0 ? [...base].reverse() : base;
      const openGroups = expandedGroupsForGroup(input.map((item) => item.data), "execution", "area:services", ["area:services"]);
      const expanded = projectCollapsedFlowGraph(input, edges, "execution", openGroups);
      expect(positionsById(expanded.nodes)).toEqual(basePositions);
      expect(expanded.nodes.find((item) => item.id === "user:note")?.position).toEqual({ x: 1900, y: 700 });
      const closed = projectCollapsedFlowGraph(input, edges, "execution", ["area:services"]);
      expect(closed.nodes.find((item) => item.id === "entry")?.position).toEqual(basePositions.entry);
      expect(closed.nodes.find((item) => item.id === "user:note")?.position).toEqual({ x: 1900, y: 700 });
      expect(positionsById(closed.nodes)).toEqual(collapsedPositions);
    }
    expect(base).toEqual(original);
  });

  it("lays out only an expanded group near its prior card and preserves fixed neighbors", async () => {
    const memberA = flowNode("service:a", { width: 280, height: 150 });
    const memberB = flowNode("service:b", { width: 280, height: 150 });
    const outside = flowNode("outside", { width: 280, height: 150 });
    const manual = {
      ...flowNode("user:note", { width: 280, height: 150 }),
      position: { x: 1450, y: 680 },
      data: { ...flowNode("user:note", { width: 280, height: 150 }).data, origin: "manual" as const }
    };
    const anchor = {
      ...flowNode("group:services", { width: 280, height: 172 }),
      position: { x: 500, y: 300 },
      data: { ...flowNode("group:services", { width: 280, height: 172 }).data, syntheticKind: "group" as const, memberNodeIds: [memberA.id, memberB.id] }
    };
    const edges: Edge[] = [{ id: "a-to-b", source: memberA.id, target: memberB.id, data: { relation: "calls" } }];
    const fixed = [{ ...outside, position: { x: 500, y: 120 } }, manual];
    const originalFixedPositions = positionsById(fixed);
    const originalInputs = structuredClone({ nodes: [memberA, memberB, outside], edges, fixed, anchor });
    const result = await layoutExpandedCanvasNodes(
      [memberA, memberB, outside], edges, "execution", new Set([anchor.id, outside.id]), [anchor], fixed,
      (regionNodes, regionEdges, mode) => layoutCanvasNodesWithEngine(regionNodes, regionEdges, mode, (graph) => elk.layout(graph))
    );

    expect(result?.map((node) => node.id).sort()).toEqual([memberA.id, memberB.id].sort());
    expectNoOverlap([...(result ?? []), ...fixed]);
    expect(positionsById(fixed)).toEqual(originalFixedPositions);
    expect({ nodes: [memberA, memberB, outside], edges, fixed, anchor }).toEqual(originalInputs);
  });

  it("signals the global arrange path when the bounded local neighborhood is full", async () => {
    const member = flowNode("service:member", { width: 280, height: 150 });
    const anchor = {
      ...flowNode("group:services", { width: 280, height: 172 }),
      position: { x: 500, y: 300 },
      data: { ...flowNode("group:services", { width: 280, height: 172 }).data, syntheticKind: "group" as const, memberNodeIds: [member.id] }
    };
    const blocker = {
      ...flowNode("blocker", { width: 100000, height: 100000 }),
      position: { x: -50000, y: -50000 }
    };
    const result = await layoutExpandedCanvasNodes(
      [member], [], "execution", new Set([anchor.id]), [anchor], [blocker],
      (regionNodes, regionEdges, mode) => layoutCanvasNodesWithEngine(regionNodes, regionEdges, mode, (graph) => elk.layout(graph))
    );

    expect(result).toBeUndefined();
  });
});

function flowNode(id: string, cardSize: { width: number; height: number }): FlowWeaveNode {
  return {
    ...createFlowNode({
      id, title: id, subtitle: id, kind: "module", nodeType: "service", risk: "unknown", description: id,
      files: [`src/${id}.ts`], guidanceDraft: "", status: "mapped", x: 0, y: 0
    }),
    measured: cardSize
  };
}

function positionsById(nodes: FlowWeaveNode[]): Record<string, { x: number; y: number }> {
  return Object.fromEntries(nodes.map((item) => [item.id, item.position]));
}

function expectNoOverlap(nodes: FlowWeaveNode[]): void {
  for (const [index, left] of nodes.entries()) {
    for (const right of nodes.slice(index + 1)) {
      const leftSize = left.measured!;
      const rightSize = right.measured!;
      const separated = left.position.x + leftSize.width <= right.position.x ||
        right.position.x + rightSize.width <= left.position.x ||
        left.position.y + leftSize.height <= right.position.y ||
        right.position.y + rightSize.height <= left.position.y;
      expect(separated, `${left.id} overlaps ${right.id}`).toBe(true);
    }
  }
}

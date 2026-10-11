import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import {
  autoLayoutIsCurrent,
  canvasTopologyFingerprint,
  canvasLayoutTopologyFingerprint,
  handleLayoutIsCurrent,
  layoutCanvasNodesWithPortsWithEngine,
  layoutCanvasNodesWithEngine,
  nodeArchitectureLayer,
  nodeClassification,
  nodeFunctionalModule,
  nodeGroupKey,
  nodeTechnologyStack,
  nodeTechnologyStacks,
  traceNodeIds
} from "../../src/utils/canvas-layout";
import { createFlowNode, decorateFlowGraph } from "../../src/utils/graph-converters";
import type { ArchitectureLayer, ConnectionHandleSlot, GraphNode } from "../../src/types";

describe("canvas layout and tracing", () => {
  it("finishes real ELK dependency layout for dense parallel relations", async () => {
    const topology = JSON.parse(readFileSync(new URL("../fixtures/architecture-dense-layout-topology.json", import.meta.url), "utf8")) as {
      roles: ArchitectureLayer[]; edges: [number, number][];
    };
    const nodes = topology.roles.map((role, index) => createFlowNode({ ...node(String(index), []), architectureLayer: role }));
    const edges = topology.edges.map(([source, target], index) => ({ id: String(index), source: String(source), target: String(target) }));
    const snapshot = structuredClone({ nodes, edges });
    const result = await layoutCanvasNodesWithEngine(nodes, edges, "dependency", realElkLayout);
    expect({ nodes, edges }).toEqual(snapshot);
    expect(result).toHaveLength(topology.roles.length);
    expect(result.every((item) => Number.isFinite(item.position.x) && Number.isFinite(item.position.y))).toBe(true);
    expect(new Set(result.map((item) => `${item.position.x},${item.position.y}`)).size).toBe(topology.roles.length);
  });

  it("finishes real ELK dependency layout for a mixed graph with backward dependencies", async () => {
    const topology = JSON.parse(readFileSync(new URL("../fixtures/architecture-layout-topology.json", import.meta.url), "utf8")) as {
      roles: ArchitectureLayer[]; edges: [number, number][];
    };
    const nodes = topology.roles.map((role, index) => createFlowNode({ ...node(String(index), []), architectureLayer: role }));
    const edges = topology.edges.map(([source, target], index) => ({ id: String(index), source: String(source), target: String(target) }));
    const result = await layoutCanvasNodesWithEngine(nodes, edges, "dependency", realElkLayout);
    expect(result).toHaveLength(63);
    expect(result.every((item) => Number.isFinite(item.position.x) && Number.isFinite(item.position.y))).toBe(true);
    expect(new Set(result.map((item) => `${item.position.x},${item.position.y}`)).size).toBe(63);
  });

  it("packs large cycles and disconnected modules without overlap or a long single column", async () => {
    const cycle = Array.from({ length: 16 }, (_, index) => createFlowNode(node(`cycle-${index}`, [])));
    const support = Array.from({ length: 82 }, (_, index) => ({
      ...createFlowNode(node(`support-${index}`, [])),
      measured: { width: 280 + index % 3 * 20, height: 150 + index % 4 * 30 }
    }));
    const nodes = [createFlowNode(node("entry", ["src/main.ts"])), ...cycle, ...support];
    const snapshot = structuredClone(nodes);
    const edges: Edge[] = [
      { id: "entry-cycle", source: "entry", target: cycle[0].id, data: { relation: "calls" } },
      ...cycle.map((item, index) => ({
        id: `call-${index}`, source: item.id, target: cycle[(index + 1) % cycle.length].id, data: { relation: "calls" }
      }))
    ];
    const result = await layoutCanvasNodesWithEngine(nodes, edges, "execution", realElkLayout);
    expect(nodes).toEqual(snapshot);
    expect(result).toHaveLength(99);
    expect(result.filter((item) => item.data.isSupportNode)).toHaveLength(82);
    const maxX = Math.max(...result.map((item) => item.position.x + (item.measured?.width ?? 280)));
    const maxY = Math.max(...result.map((item) => item.position.y + (item.measured?.height ?? 150)));
    expect(maxX).toBeLessThan(4000);
    expect(maxY).toBeLessThan(5000);
    expect(result.find((item) => item.id === "entry")?.position.x).toBeLessThan(result.find((item) => item.id === cycle[0].id)?.position.x ?? 0);
    for (const [index, left] of result.entries()) {
      for (const right of result.slice(index + 1)) {
        const overlaps = left.position.x < right.position.x + (right.measured?.width ?? 280) &&
          right.position.x < left.position.x + (left.measured?.width ?? 280) &&
          left.position.y < right.position.y + (right.measured?.height ?? 150) &&
          right.position.y < left.position.y + (left.measured?.height ?? 150);
        expect(overlaps, `${left.id} overlaps ${right.id}`).toBe(false);
      }
    }
    const fanEdges: Edge[] = cycle.map((item, index) => ({
      id: `fan-${index}`, source: item.id, target: "entry", data: { relation: "calls" }
    }));
    const fan = await layoutCanvasNodesWithEngine(nodes, fanEdges, "execution", realElkLayout);
    const flowRight = Math.max(...fan.filter((item) => !item.data.isSupportNode).map((item) => item.position.x + 280));
    expect(fan.filter((item) => item.data.isSupportNode).every((item) => item.position.x > flowRight)).toBe(true);
  });
  it("invalidates a cached layout when the graph topology changes", () => {
    const nodes = [createFlowNode(node("api", [])), createFlowNode(node("service", []))];
    const edges: Edge[] = [{ id: "api-service", source: "api", target: "service" }];
    const fingerprint = canvasTopologyFingerprint(nodes, edges);
    const layout = {
      activeMode: "execution" as const,
      manualPositions: {},
      autoLayouts: { execution: { api: { x: 0, y: 0 }, service: { x: 400, y: 0 } } },
      autoLayoutTopologyFingerprints: { execution: fingerprint },
      collapsedGroups: []
    };

    expect(autoLayoutIsCurrent(layout, "execution", fingerprint)).toBe(true);
    expect(autoLayoutIsCurrent(layout, "execution", canvasTopologyFingerprint(nodes, []))).toBe(false);
    expect(canvasTopologyFingerprint(nodes, [{ ...edges[0], id: "replacement-edge" }])).not.toBe(fingerprint);
    expect(canvasTopologyFingerprint(nodes, [{ ...edges[0], source: "service", target: "api" }])).not.toBe(fingerprint);
    expect(canvasTopologyFingerprint(nodes, [{ ...edges[0], data: { relation: "calls" } }])).not.toBe(fingerprint);
    const handles = {
      positions: Object.fromEntries(nodes.map((item) => [item.id, item.position])),
      handles: {},
      topologyFingerprint: canvasLayoutTopologyFingerprint(nodes, edges)
    };
    expect(handleLayoutIsCurrent(nodes, edges, handles)).toBe(true);
    expect(handleLayoutIsCurrent(nodes, [{ ...edges[0], id: "manual-parallel-edge" }], handles)).toBe(false);
  });

  it("recomputes static handles when the renderer topology includes additional visible edges", async () => {
    const nodes = [createFlowNode(node("api", [])), createFlowNode(node("service", []))];
    const layoutEdge: Edge = { id: "api-service", source: "api", target: "service", data: { relation: "calls" } };
    const visibleEdges: Edge[] = [layoutEdge, {
      id: "manual-api-service", source: "api", target: "service", data: { relation: "calls", origin: "manual" }
    }];
    const staticFingerprint = canvasLayoutTopologyFingerprint(nodes, [layoutEdge]);
    const staticCache = {
      positions: Object.fromEntries(nodes.map((item) => [item.id, item.position])),
      handles: {},
      topologyFingerprint: staticFingerprint
    };
    const staticPositionCache = {
      activeMode: "execution" as const,
      manualPositions: {},
      autoLayouts: { execution: staticCache.positions },
      autoLayoutTopologyFingerprints: { execution: staticFingerprint },
      collapsedGroups: []
    };
    const rendererFingerprint = canvasTopologyFingerprint(nodes, [layoutEdge], {
      projectId: "project",
      generationId: "generation",
      viewport: { width: 1024, height: 768 },
      manualPositionRevision: "[]"
    });

    expect(handleLayoutIsCurrent(nodes, visibleEdges, staticCache)).toBe(false);
    expect(autoLayoutIsCurrent(staticPositionCache, "execution", rendererFingerprint)).toBe(false);

    const refreshed = await layoutCanvasNodesWithPortsWithEngine(
      nodes, [layoutEdge], "execution", realElkLayout, visibleEdges
    );
    expect(handleLayoutIsCurrent(refreshed.nodes, visibleEdges, refreshed.handleLayout)).toBe(true);
  });

  it("returns handles matching final constrained ELK sections for directions, loops, parallel edges, and measured nodes", async () => {
    const nodes = [
      { ...createFlowNode(node("large", [])), measured: { width: 360, height: 220 } },
      createFlowNode(node("peer", []))
    ];
    const edges: Edge[] = [
      { id: "forward-a", source: "large", target: "peer", data: { relation: "calls" } },
      { id: "forward-b", source: "large", target: "peer", data: { relation: "calls" } },
      { id: "reverse", source: "peer", target: "large", data: { relation: "calls" } },
      { id: "loop", source: "large", target: "large", data: { relation: "calls" } }
    ];
    let finalGraph: ElkNode | undefined;
    const result = await layoutCanvasNodesWithPortsWithEngine(nodes, edges, "execution", async (graph) => {
      const output = await realElkLayout(graph);
      if (graph.layoutOptions?.["elk.algorithm"] === "org.eclipse.elk.fixed") finalGraph = output;
      return output;
    }, edges);

    expect(finalGraph).toBeDefined();
    const finalNodeById = new Map(finalGraph?.children?.map((item) => [item.id, item]) ?? []);
    for (const edge of edges) {
      const section = finalGraph?.edges?.find((item) => item.id === edge.id)?.sections?.[0];
      expect(section?.startPoint).toBeDefined();
      expect(section?.endPoint).toBeDefined();
      const sourceSlot = result.handleLayout.handles[edge.source]?.source.find((slot) => slot.edgeId === edge.id);
      const targetSlot = result.handleLayout.handles[edge.target]?.target.find((slot) => slot.edgeId === edge.id);
      expect(sourceSlot?.id).toBe(`${edge.source}-source-${edge.id}`);
      expect(targetSlot?.id).toBe(`${edge.target}-target-${edge.id}`);
      expect(sourceSlot?.position).toBeDefined();
      expect(targetSlot?.position).toBeDefined();
      const sourceNode = finalNodeById.get(edge.source);
      const targetNode = finalNodeById.get(edge.target);
      if (!section?.startPoint || !section.endPoint || !sourceNode || !targetNode || !sourceSlot || !targetSlot) {
        throw new Error(`ELK final endpoint evidence is incomplete: edgeId=${edge.id}`);
      }
      expectHandleAtPoint(sourceSlot, section.startPoint, sourceNode);
      expectHandleAtPoint(targetSlot, section.endPoint, targetNode);
    }

    const large = finalGraph?.children?.find((item) => item.id === "large");
    expect(large?.width).toBe(360);
    expect(large?.height).toBe(220);
  });

  it("places collapsed-group ELK handles against the measured card dimensions", () => {
    const group = {
      ...createFlowNode(node("group:billing", [])),
      measured: { width: 360, height: 220 },
      data: { ...createFlowNode(node("group:billing", [])).data, syntheticKind: "group" as const }
    };
    const peer = createFlowNode(node("peer", []));
    const edge: Edge = { id: "group-peer", source: group.id, target: peer.id };
    const decorated = decorateFlowGraph([group, peer], [edge], undefined, {
      [group.id]: {
        source: [{ id: "group-source", edgeId: edge.id, position: "bottom", offsetPercent: 75, count: 1 }],
        target: []
      },
      [peer.id]: { source: [], target: [{ id: "peer-target", edgeId: edge.id, position: "top", offsetPercent: 25, count: 1 }] }
    });
    const groupHandle = decorated.nodes.find((item) => item.id === group.id)?.handles?.find((item) => item.id === "group-source");

    expect(groupHandle).toMatchObject({ x: 270, y: 220 });
  });

  it("keys view layouts by project generation, viewport, and manual positions", () => {
    const nodes = [createFlowNode(node("api", [])), createFlowNode(node("service", []))];
    const edges: Edge[] = [{ id: "api-service", source: "api", target: "service" }];
    const context = {
      projectId: "/workspace/sample",
      generationId: "generation-1",
      viewport: { width: 960, height: 640 },
      manualPositionRevision: "positions-1"
    };
    const fingerprint = canvasTopologyFingerprint(nodes, edges, context);

    expect(canvasTopologyFingerprint(nodes, edges, { ...context, generationId: "generation-2" })).not.toBe(fingerprint);
    expect(canvasTopologyFingerprint(nodes, edges, { ...context, viewport: { width: 1440, height: 900 } })).not.toBe(fingerprint);
    expect(canvasTopologyFingerprint(nodes, edges, { ...context, manualPositionRevision: "positions-2" })).not.toBe(fingerprint);
  });

  it("keeps React Flow controlled by application state without a duplicate store sync loop", () => {
    const source = readFileSync(new URL("../../src/components/CanvasWorkspace.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("useStoreApi");
    expect(source).not.toContain("state.setNodes");
    expect(source).not.toContain("state.setEdges");
    expect(source).toContain("nodes={visibleNodes}");
    expect(source).toContain("edges={localizedEdges}");
  });

  it("lays dependencies into deterministic left-to-right layers", async () => {
    const nodes = ["api", "service", "data"].map((id) => createFlowNode(node(id, [])));
    const edges: Edge[] = [
      { id: "api-service", source: "api", target: "service" },
      { id: "service-data", source: "service", target: "data" }
    ];
    const layout = await layoutCanvasNodesWithEngine(nodes, edges, "dependency", deterministicLayout);
    const repeated = await layoutCanvasNodesWithEngine(nodes, edges, "dependency", deterministicLayout);
    const positions = new Map(layout.map((item) => [item.id, item.position.x]));

    expect(positions.get("api")).toBeLessThan(positions.get("service") ?? 0);
    expect(positions.get("service")).toBeLessThan(positions.get("data") ?? 0);
    expect(repeated.map((item) => item.position)).toEqual(layout.map((item) => item.position));
  });

  it("layers execution nodes from an entry through services to data and external systems", async () => {
    const nodes = [
      createFlowNode({ ...node("api", []), nodeType: "api" }),
      createFlowNode(node("service", [])),
      createFlowNode({ ...node("data", []), nodeType: "data" }),
      createFlowNode({ ...node("external", []), nodeType: "external" })
    ];
    const edges: Edge[] = [
      { id: "api-service", source: "api", target: "service", data: { relation: "calls", participatesInLayering: true } },
      { id: "service-data", source: "service", target: "data", data: { relation: "reads_writes", participatesInLayering: true } },
      { id: "service-external", source: "service", target: "external", data: { relation: "external_api", participatesInLayering: true } }
    ];

    const layout = await layoutCanvasNodesWithEngine(nodes, edges, "execution", deterministicLayout);
    const positions = new Map(layout.map((item) => [item.id, item.position.x]));
    const nodesById = new Map(layout.map((item) => [item.id, item]));

    expect(positions.get("api")).toBeLessThan(positions.get("service") ?? 0);
    expect(positions.get("service")).toBeLessThan(positions.get("data") ?? 0);
    expect(positions.get("service")).toBeLessThan(positions.get("external") ?? 0);
    expect(nodesById.get("api")?.data.isExecutionEntry).toBe(true);
    expect(nodesById.get("data")?.data.isExecutionSink).toBe(true);
    expect(nodesById.get("external")?.data.isExecutionSink).toBe(true);
  });

  it("compresses cycles for layout and marks every cycle member", async () => {
    const nodes = [createFlowNode(node("service-a", [])), createFlowNode(node("service-b", []))];
    const edges: Edge[] = [
      { id: "a-b", source: "service-a", target: "service-b", data: { relation: "calls", participatesInLayering: true } },
      { id: "b-a", source: "service-b", target: "service-a", data: { relation: "calls", participatesInLayering: true } }
    ];

    const layout = await layoutCanvasNodesWithEngine(nodes, edges, "execution", deterministicLayout);

    expect(layout.every((item) => item.data.cycleGroupId === "cycle:service-a,service-b")).toBe(true);
    expect(layout[0].position).not.toEqual(layout[1].position);
  });

  it("places test and unconnected support nodes outside the execution path", async () => {
    const nodes = [
      createFlowNode({ ...node("api", []), nodeType: "api" }),
      createFlowNode(node("service", [])),
      createFlowNode({ ...node("tests", []), nodeType: "test" }),
      createFlowNode(node("helper", []))
    ];
    const edges: Edge[] = [
      { id: "api-service", source: "api", target: "service", data: { relation: "calls", participatesInLayering: true } },
      { id: "tests-service", source: "tests", target: "service", data: { relation: "tests", participatesInLayering: false } }
    ];

    const layout = await layoutCanvasNodesWithEngine(nodes, edges, "execution", deterministicLayout);
    const positioned = new Map(layout.map((item) => [item.id, item]));

    expect(positioned.get("tests")?.data.isSupportNode).toBe(true);
    expect(positioned.get("helper")?.data.isSupportNode).toBe(true);
    expect(positioned.get("tests")?.position.y).toBeGreaterThan((positioned.get("service")?.position.y ?? 0) + 150);
    expect(positioned.get("helper")?.position.y).toBeGreaterThan((positioned.get("service")?.position.y ?? 0) + 150);
  });

  it("traces upstream and downstream nodes without mutating the graph", () => {
    const edges: Edge[] = [
      { id: "api-service", source: "api", target: "service" },
      { id: "service-data", source: "service", target: "data" }
    ];

    expect([...traceNodeIds("service", edges, "upstream")].sort()).toEqual(["api", "service"]);
    expect([...traceNodeIds("service", edges, "downstream")].sort()).toEqual(["data", "service"]);
  });

  it("classifies nodes for technology and architecture views", () => {
    expect(nodeTechnologyStack(node("frontend", ["src/App.tsx"]))).toBe("frontend");
    expect(nodeTechnologyStack(node("backend", ["app/service.py"]))).toBe("backend");
    expect(nodeArchitectureLayer({ ...node("api", []), category: "api-boundary" })).toBe("api");
    expect(nodeArchitectureLayer({ ...node("data", []), category: "data-access" })).toBe("data");
  });

  it("keeps every detected technology tag so mixed modules remain filterable", () => {
    expect(nodeTechnologyStacks(node("full-stack", ["src/App.tsx", "server/app.py"]))).toEqual(["frontend", "backend"]);
  });

  it("derives a stable role, runtime tags, and domain from legacy module data", () => {
    const classification = nodeClassification(node("account", ["src/features/account/view.tsx", "server/account.py"]));

    expect(classification).toEqual({
      role: "presentation",
      runtimeTags: ["frontend", "backend"],
      domain: "account"
    });
  });

  it("groups nodes by stable functional module names", async () => {
    const accountApi = node("account-api", ["src/features/account/api.ts"]);
    const accountView = node("account-view", ["src/features/account/view.tsx"]);
    const billing = node("billing", ["src/features/billing/service.ts"]);

    expect(nodeFunctionalModule(accountApi)).toBe("account");
    expect(nodeGroupKey(accountApi)).toBe("area:account");
    expect(nodeGroupKey(accountView)).toBe("area:account");
    expect(nodeFunctionalModule(billing)).toBe("billing");
    expect(nodeGroupKey(billing)).toBe("area:billing");
  });
});

async function realElkLayout(graph: ElkNode): Promise<ElkNode> {
  // The child timeout can stop an ELK loop without blocking the test runner's event loop.
  const stdout = execFileSync(process.execPath, ["-e",
    'const ELK = require("elkjs/lib/elk.bundled.js"); new ELK().layout(JSON.parse(require("node:fs").readFileSync(0, "utf8"))).then(graph => process.stdout.write(JSON.stringify(graph)));'
  ], { input: JSON.stringify(graph), encoding: "utf8", timeout: 5000, maxBuffer: 1_000_000 });
  return JSON.parse(stdout) as ElkNode;
}

function expectHandleAtPoint(
  handle: ConnectionHandleSlot,
  point: { x: number; y: number },
  node: NonNullable<ElkNode["children"]>[number]
) {
  const width = node.width ?? 280;
  const height = node.height ?? 150;
  const candidates = [
    { side: "left", distance: Math.abs(point.x - (node.x ?? 0)), offset: point.y - (node.y ?? 0), size: height },
    { side: "right", distance: Math.abs(point.x - ((node.x ?? 0) + width)), offset: point.y - (node.y ?? 0), size: height },
    { side: "top", distance: Math.abs(point.y - (node.y ?? 0)), offset: point.x - (node.x ?? 0), size: width },
    { side: "bottom", distance: Math.abs(point.y - ((node.y ?? 0) + height)), offset: point.x - (node.x ?? 0), size: width }
  ];
  const expected = candidates.sort((left, right) => left.distance - right.distance)[0];
  expect(handle.position).toBe(expected.side);
  expect(handle.offsetPercent).toBeCloseTo(expected.offset / expected.size * 100, 5);
}

function node(id: string, files: string[]): GraphNode {
  return {
    id,
    title: id,
    subtitle: id,
    kind: "module",
    nodeType: "module",
    risk: "normal",
    description: id,
    files,
    guidanceDraft: "",
    status: "mapped",
    x: 0,
    y: 0
  };
}

async function deterministicLayout(graph: ElkNode): Promise<ElkNode> {
  const partitionByNode = new Map(
    graph.children?.map((node) => [
      node.id,
      Number(node.layoutOptions?.["elk.partitioning.partition"] ?? 0)
    ]) ?? []
  );
  const incoming = new Map(graph.children?.map((node) => [node.id, 0]) ?? []);
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges ?? []) {
    const source = edge.sources?.[0];
    const target = edge.targets?.[0];
    if (!source || !target) continue;
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
    outgoing.set(source, [...(outgoing.get(source) ?? []), target]);
  }
  const queue = [...incoming.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const depth = new Map([...incoming.keys()].map((id) => [id, partitionByNode.get(id) ?? 0]));
  while (queue.length > 0) {
    const source = queue.shift();
    if (!source) continue;
    for (const target of outgoing.get(source) ?? []) {
      depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(source) ?? 0) + 1));
      const count = (incoming.get(target) ?? 1) - 1;
      incoming.set(target, count);
      if (count === 0) queue.push(target);
    }
  }
  return {
    ...graph,
    children: graph.children?.map((node, index) => ({
      ...node,
      x: (depth.get(node.id) ?? 0) * 400,
      y: index * 200
    }))
  };
}

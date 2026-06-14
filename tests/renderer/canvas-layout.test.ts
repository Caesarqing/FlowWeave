import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import {
  layoutCanvasNodesWithEngine,
  nodeArchitectureLayer,
  nodeFunctionalModule,
  nodeGroupKey,
  nodeTechnologyStack,
  traceNodeIds
} from "../../src/utils/canvas-layout";
import { createFlowNode } from "../../src/utils/graph-converters";
import type { GraphNode } from "../../src/types";

describe("canvas layout and tracing", () => {
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

  it("orders technology partitions from frontend through backend to data", async () => {
    const nodes = [
      createFlowNode(node("data", ["schema.prisma"])),
      createFlowNode(node("backend", ["server/app.py"])),
      createFlowNode(node("frontend", ["src/App.tsx"]))
    ];
    const layout = await layoutCanvasNodesWithEngine(nodes, [], "technology", deterministicLayout);
    const positions = new Map(layout.map((item) => [item.id, item.position.x]));

    expect(positions.get("frontend")).toBeLessThan(positions.get("backend") ?? 0);
    expect(positions.get("backend")).toBeLessThan(positions.get("data") ?? 0);
  });

  it("groups nodes by stable functional module names", async () => {
    const accountApi = node("account-api", ["src/features/account/api.ts"]);
    const accountView = node("account-view", ["src/features/account/view.tsx"]);
    const billing = node("billing", ["src/features/billing/service.ts"]);
    const nodes = [accountApi, accountView, billing].map(createFlowNode);

    expect(nodeFunctionalModule(accountApi)).toBe("account");
    expect(nodeGroupKey(accountView, "functional")).toBe("functional:account");
    expect(nodeFunctionalModule(billing)).toBe("billing");

    const layout = await layoutCanvasNodesWithEngine(nodes, [], "functional", deterministicLayout);
    const positions = new Map(layout.map((item) => [item.id, item.position.x]));
    expect(positions.get("account-api")).toBe(positions.get("account-view"));
    expect(positions.get("account-api")).not.toBe(positions.get("billing"));
  });
});

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

import ELK from "elkjs/lib/main.js";
import { CANVAS_NODE_SIZE } from "../../common/canvas-geometry";
import type { CanvasLayoutMode, ConnectionHandleLayout, GraphEdge, GraphNode } from "../../types";
import type { ElkNode } from "elkjs/lib/elk-api";
import { layoutElkGraphWithEdgePorts } from "../../common/elk-edge-ports";

const NODE_WIDTH = CANVAS_NODE_SIZE.width;
const NODE_HEIGHT = CANVAS_NODE_SIZE.height;
const LAYOUT_VERSION = 14;
const UNLINKED_GROUP_ID = "view:unlinked";
const UNLINKED_GROUP = { id: UNLINKED_GROUP_ID, title: "No confirmed calls", rootPath: "Expand to inspect these modules" };
let elk: InstanceType<typeof ELK> | undefined;

export async function layoutStaticGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  mode: CanvasLayoutMode
): Promise<{ nodes: GraphNode[]; positions: Record<string, { x: number; y: number }>; connectionHandles: Record<string, ConnectionHandleLayout>; topologyFingerprint: string; collapsedGroups: string[] }> {
  const hasPrimaryModules = nodes.some((node) => node.kind === "module" && !node.resource && node.nodeType !== "test");
  const primaryNodes = hasPrimaryModules ? nodes.filter((node) => !node.resource && node.nodeType !== "test") : nodes;
  const nodeById = new Map(primaryNodes.map((node) => [node.id, node]));
  const layoutEdges = edges.filter((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return false;
    return mode === "execution"
      ? edge.relation === "calls" && (edge.confidence === "confirmed" || edge.origin === "manual") && source?.nodeType !== "test" && target?.nodeType !== "test"
      : edge.relation === "depends_on";
  });
  const linkedNodeIds = new Set(layoutEdges.flatMap((edge) => [edge.source, edge.target]));
  const unlinkedIds = mode === "execution"
    ? primaryNodes.filter((node) => !linkedNodeIds.has(node.id)).map((node) => node.id)
    : [];
  const groupUnlinked = unlinkedIds.length >= 2;
  const unlinkedSet = new Set(unlinkedIds);
  const layoutNodes = primaryNodes.map((node) => groupUnlinked && unlinkedSet.has(node.id)
    ? { ...node, overviewGroup: UNLINKED_GROUP }
    : node);
  const nodeIds = nodes
    .map((node) => [node.id, node.areaId ?? null, node.groupPath?.map((group) => group.id) ?? [], [], NODE_WIDTH, NODE_HEIGHT] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const edgeKeys = layoutEdges
    .map((edge) => `${edge.id}\u0000${edge.source}\u0000${edge.target}\u0000${edge.relation}`)
    .sort();
  const topologyFingerprint = JSON.stringify({ layoutVersion: LAYOUT_VERSION, nodeIds, edgeKeys });
  if (nodes.length === 0) return { nodes: [], positions: {}, connectionHandles: {}, topologyFingerprint, collapsedGroups: [] };
  elk ??= new ELK();
  const layoutInput: ElkNode = {
    id: "flowweave-static-overview",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.layering.strategy": "LONGEST_PATH",
      "elk.spacing.nodeNode": "70",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.padding": "[top=60,left=60,bottom=60,right=60]"
    },
    children: [...layoutNodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => ({ id: node.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: layoutEdges
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] }))
  };
  const initialGraph = await elk.layout(layoutInput);
  const portLayout = await layoutElkGraphWithEdgePorts(
    layoutInput,
    initialGraph,
    layoutEdges.map(({ id, source, target, relation }) => ({ id, source, target, relation })),
    (graph) => elk!.layout(graph)
  );
  const graph = portLayout.graph;
  const positions = Object.fromEntries((graph.children ?? []).map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
  const connectionHandles = portLayout.connectionHandles;
  const hiddenNodes = nodes.filter((node) => !nodeById.has(node.id)).sort((left, right) => left.id.localeCompare(right.id));
  const firstHiddenY = Math.max(...layoutNodes.map((node) => positions[node.id].y), 0) + NODE_HEIGHT + 110;
  hiddenNodes.forEach((node, index) => {
    positions[node.id] = { x: 60 + (index % 4) * (NODE_WIDTH + 70), y: firstHiddenY + Math.floor(index / 4) * (NODE_HEIGHT + 70) };
  });
  return {
    nodes: nodes.map((node) => ({ ...node,
      ...(groupUnlinked && unlinkedSet.has(node.id) ? { overviewGroup: UNLINKED_GROUP } : {}),
      ...(positions[node.id] ?? { x: node.x, y: node.y }) })),
    positions,
    connectionHandles,
    topologyFingerprint,
    collapsedGroups: []
  };
}

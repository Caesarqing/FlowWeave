import type { Edge } from "@xyflow/react";
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { FlowWeaveNode } from "./graph-converters";
import type { ArchitectureLayer, CanvasClassification, CanvasLayoutMode, CanvasLayoutState, GraphNode, TechnologyStack } from "../types";

let elk: InstanceType<typeof ELK> | undefined;
const NODE_WIDTH = 280;
const NODE_HEIGHT = 150;

export type TraceDirection = "all" | "upstream" | "downstream";
export type { CanvasLayoutMode } from "../types";

export function canvasTopologyFingerprint(nodes: FlowWeaveNode[], edges: Edge[]): string {
  const nodeIds = nodes.map((node) => [node.id, node.data.groupPath?.map((group) => group.id) ?? [], node.data.memberNodeIds ?? []]).sort(([left], [right]) => String(left).localeCompare(String(right)));
  const edgeKeys = edges
    .map((edge) => `${edge.source}\u0000${edge.target}\u0000${String(edge.data?.relation ?? "depends_on")}`)
    .sort();
  return JSON.stringify({ layoutVersion: 4, nodeIds, edgeKeys });
}

export function autoLayoutIsCurrent(
  layout: CanvasLayoutState,
  mode: CanvasLayoutMode,
  topologyFingerprint: string
): boolean {
  return Boolean(layout.autoLayouts[mode]) &&
    layout.autoLayoutTopologyFingerprints?.[mode] === topologyFingerprint;
}

export async function layoutCanvasNodes(
  nodes: FlowWeaveNode[],
  edges: Edge[],
  mode: CanvasLayoutMode
): Promise<FlowWeaveNode[]> {
  elk ??= new ELK({ workerUrl: elkWorkerUrl });
  return layoutCanvasNodesWithEngine(nodes, edges, mode, (graph) => elk!.layout(graph));
}

export async function layoutCanvasNodesWithEngine(
  nodes: FlowWeaveNode[],
  edges: Edge[],
  mode: CanvasLayoutMode,
  layout: (graph: ElkNode) => Promise<ElkNode>
): Promise<FlowWeaveNode[]> {
  if (mode === "execution") {
    return layoutExecutionNodesWithEngine(nodes, edges, layout);
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const partitions = mode === "dependency" ? undefined : groupDepths(nodes, mode);
  const graph = await layout({
    id: "flowweave-canvas",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.partitioning.activate": partitions ? "true" : "false",
      "elk.spacing.nodeNode": "70",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.padding": "[top=60,left=60,bottom=60,right=60]"
    },
    children: [...nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => ({
        id: node.id,
        width: node.measured?.width ?? node.width ?? NODE_WIDTH,
        height: node.measured?.height ?? node.height ?? NODE_HEIGHT,
        layoutOptions: partitions
          ? { "elk.partitioning.partition": String(partitions.get(node.id) ?? 0) }
          : undefined
      })),
    edges: edges
        .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((edge) => ({
          id: edge.id,
          sources: [edge.source],
          targets: [edge.target]
        }))
  });
  const positions = new Map(graph.children?.map((node) => [
    node.id,
    { x: node.x ?? 0, y: node.y ?? 0 }
  ]) ?? []);
  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? node.position
  }));
}

async function layoutExecutionNodesWithEngine(
  nodes: FlowWeaveNode[],
  edges: Edge[],
  layout: (graph: ElkNode) => Promise<ElkNode>
): Promise<FlowWeaveNode[]> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const executionEdges = edges.filter((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const relation = edge.data?.relation;
    const participatesInLayering = edge.data?.participatesInLayering ??
      (relation === "calls" || relation === "reads_writes" || relation === "external_api" ||
        relation === "publishes_event" || relation === "subscribes_event");
    return participatesInLayering && source?.data.nodeType !== "test" && target?.data.nodeType !== "test";
  });
  const connectedNodeIds = new Set(executionEdges.flatMap((edge) => [edge.source, edge.target]));
  const executionNodes = nodes.filter((node) => connectedNodeIds.has(node.id));
  const supportNodes = nodes.filter((node) => !connectedNodeIds.has(node.id));
  const incomingNodeIds = new Set(executionEdges.map((edge) => edge.target));
  const outgoingNodeIds = new Set(executionEdges.map((edge) => edge.source));
  const evidencedEntries = executionNodes.filter(isExplicitExecutionEntry);
  const secondaryEntries = evidencedEntries.length > 0
    ? []
    : executionNodes.filter((node) => !incomingNodeIds.has(node.id) && (node.data.symbols?.length ?? 0) > 0);
  const entryNodeIds = new Set([...evidencedEntries, ...secondaryEntries].map((node) => node.id));
  const sinkNodeIds = new Set(executionNodes.filter((node) =>
    node.data.nodeType === "data" ||
    node.data.nodeType === "external" ||
    (!outgoingNodeIds.has(node.id) && node.data.files.some((file) => /(^|\/)(storage|database|db|repository|external|integrations?)(\/|\.|$)/i.test(file)))
  ).map((node) => node.id));
  const components = stronglyConnectedComponents(executionNodes.map((node) => node.id), executionEdges);
  const componentByNodeId = new Map<string, StrongComponent>();
  for (const component of components) {
    for (const nodeId of component.nodeIds) componentByNodeId.set(nodeId, component);
  }
  const componentEdges = projectComponentEdges(executionEdges, componentByNodeId);
  const componentDepths = longestPathDepths(components, componentEdges);
  const componentGrids = new Map(components.map((component) => {
    const members = component.nodeIds.map((id) => nodeById.get(id)).filter((node): node is FlowWeaveNode => Boolean(node));
    return [component.id, layoutNodeGrid(members)] as const;
  }));
  const componentNodes = components.map((component) => ({
    id: component.id,
    width: componentGrids.get(component.id)!.width,
    height: componentGrids.get(component.id)!.height,
    layoutOptions: { "elk.partitioning.partition": String(componentDepths.get(component.id) ?? 0) }
  }));
  const graph = await layout({
    id: "flowweave-execution-canvas",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.layering.strategy": "LONGEST_PATH",
      "elk.partitioning.activate": "true",
      "elk.spacing.nodeNode": "70",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.padding": "[top=60,left=60,bottom=60,right=60]"
    },
    children: componentNodes,
    edges: componentEdges.map(({ id, source, target }) => ({ id, sources: [source], targets: [target] })) as ElkExtendedEdge[]
  });
  const positions = new Map(graph.children?.map((node) => [node.id, {
    x: node.x ?? 0,
    y: node.y ?? 0,
    width: node.width ?? NODE_WIDTH,
    height: node.height ?? NODE_HEIGHT
  }]) ?? []);
  const maxX = Math.max(0, ...[...positions.values()].map((position) => position.x + position.width));
  const maxY = Math.max(0, ...[...positions.values()].map((position) => position.y + position.height));
  const supportGrid = layoutNodeGrid(supportNodes);
  const supportOnRight = components.length > 0 &&
    Math.max(maxX + 110 + supportGrid.width, maxY, supportGrid.height) <
    Math.max(maxX, supportGrid.width, maxY + 110 + supportGrid.height);

  return nodes.map((node) => {
    const component = componentByNodeId.get(node.id);
    if (!component) {
      return {
        ...node,
        position: {
          x: (supportOnRight ? maxX + 110 : 60) + supportGrid.positions.get(node.id)!.x,
          y: (supportOnRight || components.length === 0 ? 60 : maxY + 110) + supportGrid.positions.get(node.id)!.y
        },
        data: {
          ...node.data,
          cycleGroupId: undefined,
          isSupportNode: true,
          isExecutionEntry: false,
          isExecutionSink: false
        }
      };
    }
    const componentPosition = positions.get(component.id);
    const memberPosition = componentGrids.get(component.id)!.positions.get(node.id)!;
    return {
      ...node,
      position: componentPosition ? {
        x: componentPosition.x + memberPosition.x,
        y: componentPosition.y + memberPosition.y
      } : node.position,
      data: {
        ...node.data,
        cycleGroupId: component.cycleGroupId,
        isSupportNode: false,
        isExecutionEntry: entryNodeIds.has(node.id),
        isExecutionSink: sinkNodeIds.has(node.id)
      }
    };
  });
}

function layoutNodeGrid(nodes: FlowWeaveNode[]): {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
} {
  if (nodes.length === 0) return { positions: new Map(), width: 0, height: 0 };
  const cellWidth = Math.max(...nodes.map((node) => node.measured?.width ?? node.width ?? NODE_WIDTH)) + 40;
  const cellHeight = Math.max(...nodes.map((node) => node.measured?.height ?? node.height ?? NODE_HEIGHT)) + 40;
  const columns = Math.ceil(Math.sqrt(nodes.length * cellHeight / cellWidth));
  return {
    positions: new Map([...nodes].sort((left, right) => left.id.localeCompare(right.id)).map((node, index) => [node.id, {
      x: index % columns * cellWidth,
      y: Math.floor(index / columns) * cellHeight
    }])),
    width: Math.min(columns, nodes.length) * cellWidth - 40,
    height: Math.ceil(nodes.length / columns) * cellHeight - 40
  };
}

function isExplicitExecutionEntry(node: FlowWeaveNode): boolean {
  return node.data.nodeType === "entrypoint" ||
    node.data.nodeType === "api" ||
    node.data.category === "api-boundary" ||
    node.data.files.some((file) => /(^|\/)(app|main|cli|ipc|routes?|pages?|views?|screens?|controllers?)(\/|\.|$)/i.test(file));
}

type StrongComponent = {
  id: string;
  nodeIds: string[];
  cycleGroupId?: string;
};

type LayoutRelationEdge = { id: string; source: string; target: string };

function stronglyConnectedComponents(nodeIds: string[], edges: Edge[]): StrongComponent[] {
  const adjacency = new Map(nodeIds.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
  }
  for (const targets of adjacency.values()) targets.sort();

  let nextIndex = 0;
  const indexByNode = new Map<string, number>();
  const lowLinkByNode = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: StrongComponent[] = [];

  function visit(nodeId: string) {
    indexByNode.set(nodeId, nextIndex);
    lowLinkByNode.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const targetId of adjacency.get(nodeId) ?? []) {
      if (!indexByNode.has(targetId)) {
        visit(targetId);
        lowLinkByNode.set(nodeId, Math.min(lowLinkByNode.get(nodeId) ?? 0, lowLinkByNode.get(targetId) ?? 0));
      } else if (onStack.has(targetId)) {
        lowLinkByNode.set(nodeId, Math.min(lowLinkByNode.get(nodeId) ?? 0, indexByNode.get(targetId) ?? 0));
      }
    }

    if (lowLinkByNode.get(nodeId) !== indexByNode.get(nodeId)) return;
    const members: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      members.push(member);
      if (member === nodeId) break;
    }
    members.sort();
    const selfLoop = (adjacency.get(members[0]) ?? []).includes(members[0]);
    const isCycle = members.length > 1 || selfLoop;
    components.push({
      id: `scc:${members.join("|")}`,
      nodeIds: members,
      cycleGroupId: isCycle ? `cycle:${members.join(",")}` : undefined
    });
  }

  for (const nodeId of [...nodeIds].sort()) {
    if (!indexByNode.has(nodeId)) visit(nodeId);
  }
  return components.sort((left, right) => left.nodeIds[0].localeCompare(right.nodeIds[0]));
}

function projectComponentEdges(
  edges: Edge[],
  componentByNodeId: Map<string, StrongComponent>
): LayoutRelationEdge[] {
  const unique = new Map<string, LayoutRelationEdge>();
  for (const edge of edges) {
    const source = componentByNodeId.get(edge.source)?.id;
    const target = componentByNodeId.get(edge.target)?.id;
    if (!source || !target || source === target) continue;
    const key = `${source}\u0000${target}`;
    unique.set(key, { id: `flow:${key}`, source, target });
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function longestPathDepths(components: StrongComponent[], edges: LayoutRelationEdge[]): Map<string, number> {
  const outgoing = new Map(components.map((component) => [component.id, [] as string[]]));
  const incomingCount = new Map(components.map((component) => [component.id, 0]));
  for (const edge of edges) {
    outgoing.get(edge.source)?.push(edge.target);
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  }
  for (const targets of outgoing.values()) targets.sort();
  const ready = [...incomingCount.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const depths = new Map(components.map((component) => [component.id, 0]));
  while (ready.length > 0) {
    const source = ready.shift();
    if (!source) continue;
    for (const target of outgoing.get(source) ?? []) {
      depths.set(target, Math.max(depths.get(target) ?? 0, (depths.get(source) ?? 0) + 1));
      const remaining = (incomingCount.get(target) ?? 1) - 1;
      incomingCount.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  return depths;
}

export function nodeTechnologyStack(node: GraphNode): TechnologyStack {
  return nodeTechnologyStacks(node)[0] ?? "unknown";
}

export function nodeTechnologyStacks(node: GraphNode): TechnologyStack[] {
  if (node.classification) return node.classification.runtimeTags;
  const detected = detectedTechnologyStacks(node.files);
  const candidates = [...(node.technologyTags ?? []), ...detected, ...(node.technologyStack ? [node.technologyStack] : [])];
  const tags = TECHNOLOGY_ORDER.filter((technology) => candidates.includes(technology));
  return tags.length > 0 ? tags : ["unknown"];
}

const TECHNOLOGY_ORDER: TechnologyStack[] = ["frontend", "mobile", "backend", "data", "infrastructure", "shared", "unknown"];

function detectedTechnologyStacks(files: string[]): TechnologyStack[] {
  const paths = files.map((file) => file.toLowerCase());
  const detected: TechnologyStack[] = [];
  if (paths.some((file) => /\.(tsx|jsx|vue|svelte|css|scss|html)$/.test(file) || /(^|\/)(components|pages|views|frontend|client)\//.test(file))) detected.push("frontend");
  if (paths.some((file) => /\.(swift|kt|kts|dart)$/.test(file) || /(^|\/)(ios|android|mobile)\//.test(file))) detected.push("mobile");
  if (paths.some((file) => /\.(py|java|go|rs|php|cs|rb)$/.test(file) || /(^|\/)(server|backend|api)\//.test(file))) detected.push("backend");
  if (paths.some((file) => /\.(sql|prisma)$/.test(file) || /(^|\/)(database|db|migrations|schema)\//.test(file))) detected.push("data");
  if (paths.some((file) => /(^|\/)(infra|infrastructure|deploy|docker|k8s|terraform)\//.test(file))) detected.push("infrastructure");
  if (detected.length === 0 && paths.some((file) => /\.(ts|js|mjs|cjs)$/.test(file))) detected.push("shared");
  return detected;
}

export function nodeArchitectureLayer(node: GraphNode): ArchitectureLayer {
  if (node.classification) return node.classification.role;
  if (node.architectureLayer) return node.architectureLayer;
  if (node.category === "api-boundary") return "api";
  if (node.category === "domain-service") return "domain";
  if (node.category === "data-access") return "data";
  if (node.category === "external-integration") return "integration";
  if (node.category === "job-worker" || node.category === "shared-utility") return "infrastructure";
  if (node.category === "test-surface" || node.nodeType === "test") return "test";
  if (nodeTechnologyStack(node) === "frontend") return "presentation";
  return "unknown";
}

export function nodeClassification(node: GraphNode): CanvasClassification {
  if (node.classification) {
    return {
      role: node.classification.role,
      runtimeTags: [...node.classification.runtimeTags],
      domain: node.classification.domain
    };
  }
  return {
    role: nodeArchitectureLayer(node),
    runtimeTags: nodeTechnologyStacks(node),
    domain: nodeFunctionalModule(node)
  };
}

export function nodeFunctionalModule(node: GraphNode): string {
  if (node.classification?.domain) return node.classification.domain;
  for (const file of node.files) {
    const segments = file.split("/").filter(Boolean);
    const markerIndex = segments.findIndex((segment) =>
      ["features", "feature", "modules", "module", "domains", "domain"].includes(segment.toLowerCase())
    );
    const candidate = markerIndex >= 0 ? segments[markerIndex + 1] : undefined;
    if (candidate) return normalizeFunctionalModule(candidate);
  }
  return normalizeFunctionalModule(node.role ?? node.title ?? node.id);
}

export function nodeGroupKey(node: GraphNode, mode: Exclude<CanvasLayoutMode, "dependency">): string {
  if (mode === "technology") return `technology:${nodeTechnologyStack(node)}`;
  if (mode === "architecture") return node.groupPath?.at(-1)?.id ?? `architecture:${nodeArchitectureLayer(node)}`;
  return `domain:${nodeFunctionalModule(node)}`;
}

export function traceNodeIds(rootId: string, edges: Edge[], direction: TraceDirection): Set<string> {
  const visited = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const edge of edges) {
      const next = direction === "upstream"
        ? edge.target === current ? edge.source : undefined
        : direction === "downstream"
          ? edge.source === current ? edge.target : undefined
          : edge.source === current ? edge.target : edge.target === current ? edge.source : undefined;
      if (next && !visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

function groupDepths(nodes: FlowWeaveNode[], mode: Exclude<CanvasLayoutMode, "dependency">): Map<string, number> {
  const order = mode === "technology"
    ? ["frontend", "backend", "mobile", "data", "infrastructure", "shared", "unknown"]
    : mode === "architecture"
      ? ["presentation", "api", "domain", "data", "integration", "infrastructure", "test", "unknown"]
      : [...new Set(nodes.map((node) => nodeFunctionalModule(node.data)))].sort();
  return new Map(nodes.map((node) => {
    const group = mode === "technology"
      ? nodeTechnologyStack(node.data)
      : mode === "architecture"
        ? nodeArchitectureLayer(node.data)
        : nodeFunctionalModule(node.data);
    const index = order.indexOf(group);
    return [node.id, index < 0 ? order.length - 1 : index];
  }));
}

function normalizeFunctionalModule(value: string): string {
  const normalized = value
    .replace(/\.[^.]+$/, "")
    .replace(/(?:[-_\s]+)?(?:api|view|page|service|controller|repository|store|module)$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "shared";
}

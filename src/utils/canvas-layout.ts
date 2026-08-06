import type { Edge } from "@xyflow/react";
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { FlowWeaveNode } from "./graph-converters";
import type { ArchitectureLayer, CanvasClassification, CanvasLayoutMode, GraphNode, TechnologyStack } from "../types";

let elk: InstanceType<typeof ELK> | undefined;
const NODE_WIDTH = 280;
const NODE_HEIGHT = 150;

export type TraceDirection = "all" | "upstream" | "downstream";
export type { CanvasLayoutMode } from "../types";

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
  const nodeIds = new Set(nodes.map((node) => node.id));
  const partitions = mode === "dependency" ? undefined : groupDepths(nodes, mode);
  const graph = await layout({
    id: "flowweave-canvas",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
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
    edges: [
      ...edges
        .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((edge) => ({
          id: edge.id,
          sources: [edge.source],
          targets: [edge.target]
        })),
      ...buildPartitionConstraintEdges(nodes, partitions)
    ] as ElkExtendedEdge[]
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

function buildPartitionConstraintEdges(
  nodes: FlowWeaveNode[],
  partitions: Map<string, number> | undefined
): Array<{ id: string; sources: string[]; targets: string[] }> {
  if (!partitions) return [];
  const groups = new Map<number, string[]>();
  for (const node of nodes) {
    const partition = partitions.get(node.id) ?? 0;
    groups.set(partition, [...(groups.get(partition) ?? []), node.id]);
  }
  const orderedGroups = [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, ids]) => ids.sort());
  const edges: Array<{ id: string; sources: string[]; targets: string[] }> = [];
  for (let index = 0; index < orderedGroups.length - 1; index += 1) {
    const sources = orderedGroups[index];
    const targets = orderedGroups[index + 1];
    for (const source of sources) {
      for (const target of targets) {
        edges.push({
          id: `partition:${index}:${source}:${target}`,
          sources: [source],
          targets: [target]
        });
      }
    }
  }
  return edges;
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
  if (mode === "runtime" || mode === "technology") return `runtime:${nodeTechnologyStack(node)}`;
  if (mode === "role" || mode === "architecture") return `role:${nodeArchitectureLayer(node)}`;
  return `${mode === "functional" ? "functional" : "domain"}:${nodeFunctionalModule(node)}`;
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
  const order = mode === "runtime" || mode === "technology"
    ? ["frontend", "backend", "mobile", "data", "infrastructure", "shared", "unknown"]
    : mode === "role" || mode === "architecture"
      ? ["presentation", "api", "domain", "data", "integration", "infrastructure", "test", "unknown"]
      : [...new Set(nodes.map((node) => nodeFunctionalModule(node.data)))].sort();
  return new Map(nodes.map((node) => {
    const group = mode === "runtime" || mode === "technology"
      ? nodeTechnologyStack(node.data)
      : mode === "role" || mode === "architecture"
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

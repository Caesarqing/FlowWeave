import type { CanvasLayoutState, CodeflowCanvas, GraphEdge, GraphNode, GraphViewMode } from "../../types";
import { chooseInitialGraphView } from "../../utils/graph-view-projection";
import { matchRelationIds } from "../../utils/modification-delta";

export type LegacyCanvasV5 = Omit<CodeflowCanvas, "version"> & { version: 5 };
export type StoredCanvas = CodeflowCanvas | LegacyCanvasV5;

export function reconcileGeneratedCanvas(
  generated: CodeflowCanvas,
  existing: StoredCanvas | undefined,
  baseline?: Pick<CodeflowCanvas, "nodes" | "edges">
): CodeflowCanvas {
  if (!existing) return generated;
  if (existing.version === 5) return migrateCanvasV5(generated, existing, baseline);
  return reconcileCanvasV6(generated, existing, baseline);
}

function migrateCanvasV5(generated: CodeflowCanvas, existing: LegacyCanvasV5, baseline: Pick<CodeflowCanvas, "nodes" | "edges"> | undefined): CodeflowCanvas {
  const baselineById = new Map(baseline?.nodes.map((node) => [node.id, node]) ?? []);
  const oldGeneratedById = new Map(existing.nodes
    .filter((node) => node.origin !== "manual")
    .map((node) => [node.id, node]));
  const manualNodes = existing.nodes.filter((node) => node.origin === "manual");
  const manualIds = new Set(manualNodes.map((node) => node.id));
  const migratedNodes = generated.nodes.filter((node) => !manualIds.has(node.id));
  const generatedById = new Map(migratedNodes.map((node) => [node.id, node]));
  const matchesByOldId = new Map<string, GraphNode[]>();
  const oldMatchCountByNewId = new Map<string, number>();
  for (const oldNode of oldGeneratedById.values()) {
    const matches = [...generatedById.values()].filter((candidate) => sameModuleIdentity(oldNode, candidate));
    matchesByOldId.set(oldNode.id, matches);
    for (const match of matches) oldMatchCountByNewId.set(match.id, (oldMatchCountByNewId.get(match.id) ?? 0) + 1);
  }
  const oldToNewGeneratedId = new Map<string, string>();
  const customizedFieldsByNewId = new Map<string, Partial<GraphNode>>();
  for (const oldNode of oldGeneratedById.values()) {
    const matches = matchesByOldId.get(oldNode.id) ?? [];
    if (matches.length !== 1 || oldMatchCountByNewId.get(matches[0].id) !== 1) continue;
    const nextNode = matches[0];
    oldToNewGeneratedId.set(oldNode.id, nextNode.id);
    customizedFieldsByNewId.set(nextNode.id, baselineById.has(oldNode.id) ? customizedV6Fields(oldNode, baselineById.get(oldNode.id)) : customizedV5Fields(oldNode));
  }
  const migratedNodesWithUserEdits = migratedNodes.map((node) => applyCustomizedFields(node, {
    ...customizedFieldsByNewId.get(node.id),
    ...(existing.layout?.activeMode === "manual" && manualPositionsForNode(existing, oldToNewGeneratedId, node.id))
  }));
  const nodes = [...migratedNodesWithUserEdits, ...manualNodes];
  const manualEdges = existing.edges.filter((edge) => edge.origin === "manual");
  const retainedEdgeIds = new Set(generated.edges.map((edge) => edge.id));
  const eligibleManualEdges = manualEdges.filter((edge) => !retainedEdgeIds.has(edge.id));
  const migratedManualEdges = eligibleManualEdges.map((edge) => ({
    edge,
    source: migratedEndpoint(edge.source, manualIds, oldGeneratedById, oldToNewGeneratedId),
    target: migratedEndpoint(edge.target, manualIds, oldGeneratedById, oldToNewGeneratedId)
  }));
  const validManualEdges = migratedManualEdges
    .filter(({ source, target }) => source !== undefined && target !== undefined)
    .map(({ edge, source, target }) => ({ ...edge, source: source!, target: target! }));
  const validEdgeIds = new Set(validManualEdges.map((edge) => edge.id));
  const generatedEdgeMigration = reconcileGeneratedEdges(generated, existing, baseline, oldToNewGeneratedId);
  const orphanedEdges = deduplicateEdges([
    ...(existing.orphanedEdges ?? []),
    ...generatedEdgeMigration.orphanedEdges,
    ...manualEdges.filter((edge) => retainedEdgeIds.has(edge.id)),
    ...eligibleManualEdges.filter((edge) => !validEdgeIds.has(edge.id))
  ]);
  const initialView = generated.layout?.viewMode ?? chooseInitialGraphView(generated.edges);
  const viewMode = existing.layout?.viewMode ?? viewModeFromLegacyLayout(existing.layout, initialView);
  const manualPositions = remapManualPositions(existing.layout?.manualPositions ?? {}, oldToNewGeneratedId, manualIds);
  const layout: CanvasLayoutState = {
    activeMode: existing.layout?.activeMode === "manual" && migratedNodes.every((node) => [...oldToNewGeneratedId.values()].includes(node.id)) ? "manual" : viewMode,
    viewMode,
    manualPositions,
    autoLayouts: {},
    collapsedGroups: generated.layout?.collapsedGroups ?? []
  };

  return {
    ...generated,
    layout,
    nodes,
    edges: [...generatedEdgeMigration.edges, ...validManualEdges],
    orphanedEdges,
    orphanedNodeEdits: deduplicateNodeEdits([
      ...(existing.orphanedNodeEdits ?? []),
      ...[...oldGeneratedById.values()].filter((node) => !oldToNewGeneratedId.has(node.id) && Object.keys(customizedV5Fields(node)).length > 0)
        .map((node) => ({ node, reason: (matchesByOldId.get(node.id)?.length ? "split-or-merge" : "removed") as "split-or-merge" | "removed" }))
    ])
  };
}

function reconcileCanvasV6(generated: CodeflowCanvas, existing: CodeflowCanvas, baseline: Pick<CodeflowCanvas, "nodes" | "edges"> | undefined): CodeflowCanvas {
  const generatedNodeIds = new Set(generated.nodes.map((node) => node.id));
  const baselineById = new Map(baseline?.nodes.map((node) => [node.id, node]) ?? []);
  const existingGeneratedModules = existing.nodes.filter((node) => node.origin !== "manual" && node.kind === "module");
  const matchesByNewId = new Map<string, GraphNode[]>();
  const existingMatchCount = new Map<string, number>();
  for (const node of generated.nodes.filter((candidate) => candidate.origin !== "manual" && candidate.kind === "module")) {
    const matches = existingGeneratedModules.filter((candidate) => sameModuleIdentity(candidate, node));
    matchesByNewId.set(node.id, matches);
    for (const match of matches) existingMatchCount.set(match.id, (existingMatchCount.get(match.id) ?? 0) + 1);
  }
  const previousByNewId = new Map<string, GraphNode>();
  for (const [newId, matches] of matchesByNewId) {
    if (matches.length === 1 && existingMatchCount.get(matches[0].id) === 1) previousByNewId.set(newId, matches[0]);
  }
  const newIdByPreviousId = new Map([...previousByNewId.entries()].map(([newId, previous]) => [previous.id, newId]));
  const nodes = generated.nodes.map((node) => {
    const matchedPrevious = previousByNewId.get(node.id);
    if (!matchedPrevious) return node;
    return applyCustomizedFields(node, {
      ...(existing.layout?.activeMode === "manual" ? { x: matchedPrevious.x, y: matchedPrevious.y } : {}),
      ...customizedV6Fields(matchedPrevious, baselineById.get(matchedPrevious.id))
    });
  });
  const generatedModuleIds = nodes.filter((node) => node.origin !== "manual" && node.kind === "module").map((node) => node.id);
  const hasPositionsForEveryGeneratedModule = generatedModuleIds.every((id) => previousByNewId.has(id));
  const manualNodes = existing.nodes.filter((node) => node.origin === "manual" && !generatedNodeIds.has(node.id));
  nodes.push(...manualNodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const generatedEdgeMigration = reconcileGeneratedEdges(generated, existing, baseline, newIdByPreviousId);
  const generatedEdgeIds = new Set(generated.edges.map((edge) => edge.id));
  const manualEdges = existing.edges.filter((edge) => edge.origin === "manual" && !generatedEdgeIds.has(edge.id));
  const manualNodeIds = new Set(manualNodes.map((node) => node.id));
  const previousGeneratedModuleIds = new Set(existingGeneratedModules.map((node) => node.id));
  const migratedManualEdges = manualEdges.map((edge) => ({
    edge,
    source: migrateV6Endpoint(edge.source, manualNodeIds, previousGeneratedModuleIds, newIdByPreviousId),
    target: migrateV6Endpoint(edge.target, manualNodeIds, previousGeneratedModuleIds, newIdByPreviousId)
  }));
  const preservedEdges = migratedManualEdges.flatMap(({ edge, source, target }) => {
    if (source === undefined || target === undefined || !nodeIds.has(source) || !nodeIds.has(target)) return [];
    return [{ ...edge, source, target }];
  });
  const preservedEdgeIds = new Set(preservedEdges.map((edge) => edge.id));
  const orphanedEdges = deduplicateEdges([
    ...(existing.orphanedEdges ?? []),
    ...generatedEdgeMigration.orphanedEdges,
    ...existing.edges.filter((edge) => edge.origin === "manual" && generatedEdgeIds.has(edge.id)),
    ...migratedManualEdges.filter(({ edge }) => !preservedEdgeIds.has(edge.id)).map(({ edge }) => edge)
  ]);
  const viewMode = existing.layout?.viewMode ?? generated.layout?.viewMode ?? chooseInitialGraphView(generated.edges);
  const activeMode = existing.layout?.activeMode === "manual" && !hasPositionsForEveryGeneratedModule
    ? viewMode
    : existing.layout?.activeMode ?? viewMode;
  return {
    ...generated,
    layout: existing.layout ? {
      ...existing.layout, activeMode, viewMode,
      manualPositions: remapManualPositions(existing.layout.manualPositions, newIdByPreviousId, manualNodeIds)
    } : generated.layout,
    nodes,
    edges: [...generatedEdgeMigration.edges, ...preservedEdges],
    orphanedEdges,
    orphanedNodeEdits: deduplicateNodeEdits([
      ...(existing.orphanedNodeEdits ?? []),
      ...existingGeneratedModules.filter((node) => !newIdByPreviousId.has(node.id) && Object.keys(customizedV6Fields(node, baselineById.get(node.id))).length > 0)
        .map((node) => ({ node, reason: (existingMatchCount.has(node.id) ? "split-or-merge" : "removed") as "split-or-merge" | "removed" }))
    ])
  };
}

function reconcileGeneratedEdges(
  generated: CodeflowCanvas,
  existing: StoredCanvas,
  baseline: Pick<CodeflowCanvas, "nodes" | "edges"> | undefined,
  nodeIdMap: ReadonlyMap<string, string>
): { edges: GraphEdge[]; orphanedEdges: GraphEdge[] } {
  const previousEdges = existing.edges.filter((edge) => edge.origin !== "manual");
  const baselineById = new Map(baseline?.edges.map((edge) => [edge.id, edge]) ?? []);
  const relationIdMap = matchRelationIds(previousEdges.map((edge) => baselineById.get(edge.id) ?? edge), generated.edges, nodeIdMap);
  const guidanceByNewId = new Map<string, string | undefined>();
  const orphanedEdges: GraphEdge[] = [];
  for (const edge of previousEdges) {
    const before = baselineById.get(edge.id);
    const hasGuidanceEdit = before ? edge.guidanceNote !== before.guidanceNote : edge.guidanceNote !== undefined;
    const hasFactEdit = before && (edge.source !== before.source || edge.target !== before.target || edge.relation !== before.relation);
    const nextId = relationIdMap.get(edge.id);
    if (hasFactEdit || hasGuidanceEdit && !nextId) orphanedEdges.push(edge);
    else if (hasGuidanceEdit && nextId) guidanceByNewId.set(nextId, edge.guidanceNote);
  }
  return {
    edges: generated.edges.map((edge) => guidanceByNewId.has(edge.id) ? { ...edge, guidanceNote: guidanceByNewId.get(edge.id) } : edge),
    orphanedEdges
  };
}

function applyCustomizedFields(node: GraphNode, fields: Partial<GraphNode>): GraphNode {
  const override = fields.assessment?.risk.override;
  return {
    ...node,
    ...fields,
    ...(override && node.assessment ? {
      assessment: { ...node.assessment, risk: { ...node.assessment.risk, override, effectiveLevel: override.level } }
    } : {})
  };
}

function customizedV6Fields(previous: GraphNode, baseline: GraphNode | undefined): Partial<GraphNode> {
  const fields: Partial<GraphNode> = {};
  if (!baseline || previous.title !== baseline.title) fields.title = previous.title;
  if (!baseline || previous.description !== baseline.description) fields.description = previous.description;
  if (baseline && previous.nodeType !== baseline.nodeType) fields.nodeType = previous.nodeType;
  if (baseline && previous.subtitle !== baseline.subtitle) fields.subtitle = previous.subtitle;
  if (!baseline || previous.guidanceDraft !== baseline.guidanceDraft) fields.guidanceDraft = previous.guidanceDraft;
  if ((!baseline && previous.risk !== "unknown") || (baseline && previous.risk !== baseline.risk) || previous.assessment?.risk.override) fields.risk = previous.risk;
  if (previous.assessment?.risk.override) fields.assessment = previous.assessment;
  return fields;
}

function migrateV6Endpoint(
  endpoint: string,
  manualNodeIds: Set<string>,
  previousGeneratedModuleIds: Set<string>,
  newIdByPreviousId: Map<string, string>
): string | undefined {
  if (manualNodeIds.has(endpoint)) return endpoint;
  if (previousGeneratedModuleIds.has(endpoint)) return newIdByPreviousId.get(endpoint);
  return endpoint;
}

function sameModuleIdentity(left: GraphNode, right: GraphNode): boolean {
  if (left.resource || right.resource) return left.resource?.id === right.resource?.id && left.resource !== undefined && right.resource !== undefined;
  if (left.kind !== "module" || right.kind !== "module" || left.files.length === 0 || right.files.length === 0) return false;
  const rightFiles = new Set(right.files);
  return left.files.some((file) => rightFiles.has(file));
}

function customizedV5Fields(node: GraphNode): Partial<GraphNode> {
  const legacyGroup = node.id.replace(/-/g, " ");
  const defaultTitle = legacyGroup
    .split(/[\s_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const defaultNodeType: GraphNode["nodeType"] = /test|spec/i.test(legacyGroup)
    ? "test"
    : /database|db|prisma|schema|migration/i.test(legacyGroup)
      ? "data"
      : /api|route|controller|server|app/i.test(legacyGroup)
        ? "entrypoint"
        : "module";
  const defaultSubtitle = defaultNodeType === "entrypoint"
    ? "Request entry and orchestration"
    : defaultNodeType === "data"
      ? "Data model and persistence"
      : defaultNodeType === "test"
        ? "Testing and regression validation"
        : "Backend business module";
  const fields: Partial<GraphNode> = {};
  if (node.title !== defaultTitle) fields.title = node.title;
  if (node.subtitle !== defaultSubtitle) fields.subtitle = node.subtitle;
  if (node.nodeType !== defaultNodeType) fields.nodeType = node.nodeType;
  if (node.description !== `${defaultTitle} was generated from the project scan with ${node.files.length} key files. Connections define the scope used for Agent planning.`) {
    fields.description = node.description;
  }
  if (node.guidanceDraft !== `Review the responsibility boundaries of these files around ${defaultTitle}, and expand the modification scope only when required by its connections.`) {
    fields.guidanceDraft = node.guidanceDraft;
  }
  const override = node.assessment?.risk.override;
  if (override && node.assessment) {
    fields.risk = override.level;
    fields.assessment = {
      ...node.assessment,
      risk: {
        ...node.assessment.risk,
        effectiveLevel: override.level,
        override
      }
    };
  }
  return fields;
}

function migratedEndpoint(
  endpoint: string,
  manualNodeIds: Set<string>,
  oldGeneratedById: Map<string, GraphNode>,
  oldToNewGeneratedId: Map<string, string>
): string | undefined {
  if (manualNodeIds.has(endpoint)) return endpoint;
  if (!oldGeneratedById.has(endpoint)) return undefined;
  return oldToNewGeneratedId.get(endpoint);
}

function viewModeFromLegacyLayout(layout: CanvasLayoutState | undefined, fallback: GraphViewMode): GraphViewMode {
  const candidate = layout?.activeMode;
  if (candidate && candidate !== "manual" && isGraphViewMode(candidate)) return candidate;
  return fallback;
}

function isGraphViewMode(value: string): value is GraphViewMode {
  return ["execution", "dependency", "architecture", "technology", "domain"].includes(value);
}

function deduplicateEdges(edges: GraphEdge[]): GraphEdge[] {
  return [...new Map(edges.map((edge) => [edge.id, edge])).values()];
}

function remapManualPositions(
  positions: CanvasLayoutState["manualPositions"],
  generatedIdMap: Map<string, string>,
  manualIds: Set<string>
): CanvasLayoutState["manualPositions"] {
  return Object.fromEntries(Object.entries(positions).flatMap(([id, position]) => {
    const nextId = manualIds.has(id) ? id : generatedIdMap.get(id);
    return nextId ? [[nextId, position]] : [];
  }));
}

function manualPositionsForNode(existing: StoredCanvas, generatedIdMap: Map<string, string>, nodeId: string): Partial<GraphNode> | undefined {
  const previousId = [...generatedIdMap.entries()].find(([, nextId]) => nextId === nodeId)?.[0];
  const previous = existing.nodes.find((node) => node.id === previousId);
  return previous ? { x: previous.x, y: previous.y } : undefined;
}

function deduplicateNodeEdits(edits: NonNullable<CodeflowCanvas["orphanedNodeEdits"]>): NonNullable<CodeflowCanvas["orphanedNodeEdits"]> {
  return [...new Map(edits.map((edit) => [edit.node.id, edit])).values()];
}

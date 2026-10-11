import { createHash } from "node:crypto";
import type { CanvasLayoutState, CanvasMigrationPendingItem, CanvasUserStateV1, CodeflowCanvas, GraphEdge, GraphNode, GraphOverviewV1, GraphViewMode, GenerationIdentity } from "../../types";
import { chooseInitialGraphView } from "../../utils/graph-view-projection";
import { matchRelationIds } from "../../utils/modification-delta";
import { applyAssessmentOverride, invalidateModuleAssessment, unknownAssessment } from "../../utils/module-assessment";

export type LegacyCanvasV5 = CodeflowCanvas & { version: 5 };
export type LegacyCanvasV6 = CodeflowCanvas & { version: 6 };
export type LegacyCanvasV1To4 = {
  version: 1 | 2 | 3 | 4;
  nodes: GraphNode[];
  edges: GraphEdge[];
  rawNodes: unknown[];
  rawEdges: unknown[];
  layout?: CanvasLayoutState;
};
export type StoredCanvas = LegacyCanvasV5 | LegacyCanvasV6;
export type CanvasForGeneration = CodeflowCanvas | StoredCanvas | LegacyCanvasV1To4;

export function isLegacyCanvasV1To4(canvas: CanvasForGeneration): canvas is LegacyCanvasV1To4 {
  return "version" in canvas && (canvas.version === 1 || canvas.version === 2 || canvas.version === 3 || canvas.version === 4);
}

export function reconcileGeneratedCanvas(
  generated: CodeflowCanvas,
  existing: CodeflowCanvas | CanvasForGeneration | undefined,
  baseline?: Pick<CodeflowCanvas, "nodes" | "edges">,
  knownFiles?: ReadonlySet<string>
): CodeflowCanvas {
  if (!existing) return generated;
  if ("version" in existing && isLegacyCanvasV1To4(existing)) return migrateCanvasV1To4(generated, existing);
  if ("version" in existing && existing.version === 5) return migrateCanvasV5(generated, existing, baseline);
  return reconcileCanvasUserState(generated, existing, baseline, knownFiles);
}

export function createGraphOverview(generated: CodeflowCanvas, generationId: string): GraphOverviewV1 {
  return {
    schemaVersion: 1,
    generationId,
    inputFingerprint: generated.inputFingerprint ?? generated.scanFingerprint ?? "",
    scanFingerprint: generated.scanFingerprint ?? "",
    generatedAt: generated.generatedAt,
    generatorVersion: generated.generatorVersion ?? "1.0.0",
    nodes: generated.nodes.filter((node) => node.origin !== "manual").map((node) => ({
      id: node.id,
      title: node.title,
      subtitle: node.subtitle,
      kind: node.kind,
      nodeType: node.nodeType,
      risk: node.risk,
      description: node.description,
      files: node.files,
      status: node.status,
      x: node.x,
      y: node.y,
      ...(node.areaId ? { areaId: node.areaId } : {}),
      ...(node.groupPath ? { groupPath: node.groupPath } : {}),
      ...(node.overviewGroup ? { overviewGroup: node.overviewGroup } : {}),
      ...(node.confidence === undefined ? {} : { confidence: node.confidence }),
      ...(node.role ? { role: node.role } : {}),
      ...(node.category ? { category: node.category } : {}),
      ...(node.resource ? { resource: node.resource } : {}),
      ...(node.relationSummary ? { relationSummary: node.relationSummary } : {}),
      ...(node.technologyStack ? { technologyStack: node.technologyStack } : {}),
      ...(node.technologyTags ? { technologyTags: node.technologyTags } : {}),
      ...(node.architectureLayer ? { architectureLayer: node.architectureLayer } : {}),
      ...(node.classification ? { classification: node.classification } : {}),
      ...(node.identity ? { identity: node.identity } : {}),
      origin: "generated"
    })),
    edges: generated.edges.filter((edge) => edge.origin !== "manual").map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      ...(edge.confidence ? { confidence: edge.confidence } : {}),
      ...(edge.aggregatedEdgeIds ? { aggregatedEdgeIds: edge.aggregatedEdgeIds } : {}),
      ...(edge.sourceRelationIds ? { sourceRelationIds: edge.sourceRelationIds } : {}),
      ...(edge.evidence?.some((item) => item.eventId) ? { evidence: edge.evidence.filter((item) => item.eventId).map(({ eventId, detail }) => ({ eventId, detail })) } : {})
    })),
    ...(generated.groups ? { groups: generated.groups } : {}),
    ...(generated.quality ? { quality: generated.quality } : {})
  };
}

export function createCanvasUserState(
  generated: CodeflowCanvas,
  reconciled: CodeflowCanvas,
  generationId: string,
  revision: number
): CanvasUserStateV1 {
  const generatedNodes = new Map(generated.nodes.map((node) => [node.id, node]));
  const nodeEdits = Object.fromEntries(reconciled.nodes.flatMap((node) => {
    if (node.origin === "manual") return [];
    const baseline = generatedNodes.get(node.id);
    if (!baseline) return [];
    const { assessment: _assessment, assessmentPending: _assessmentPending, ...candidateFields } = customizedV6Fields(node, baseline);
    const { risk: _pendingRisk, ...nonRiskFields } = candidateFields;
    const fields = node.assessmentPending && !node.assessment?.risk.override ? nonRiskFields : candidateFields;
    return Object.keys(fields).length > 0 ? [[node.id, fields]] : [];
  }));
  const riskOverrides = Object.fromEntries(reconciled.nodes.flatMap((node) => {
    const override = node.assessment?.risk.override;
    if (node.origin === "manual" || !override) return [];
    const basis = override.systemLevelAtOverride ?? node.assessment?.risk.previousSystemLevel ?? node.assessment?.risk.systemLevel;
    const { systemLevelAtOverride: _unknownBasis, ...fields } = override;
    return [[node.id, basis && basis !== "unknown" ? { ...fields, systemLevelAtOverride: basis } : fields]];
  }));
  const generatedEdges = new Map(generated.edges.map((edge) => [edge.id, edge]));
  const edgeEdits = Object.fromEntries(reconciled.edges.flatMap((edge) => {
    const baseline = generatedEdges.get(edge.id);
    if (!baseline || edge.origin === "manual") return [];
    const fields: Partial<Pick<GraphEdge, "guidanceNote" | "source" | "target" | "relation">> = {};
    if (edge.guidanceNote !== baseline.guidanceNote) fields.guidanceNote = edge.guidanceNote;
    if (edge.source !== baseline.source) fields.source = edge.source;
    if (edge.target !== baseline.target) fields.target = edge.target;
    if (edge.relation !== baseline.relation) fields.relation = edge.relation;
    return Object.keys(fields).length > 0 ? [[edge.id, fields]] : [];
  }));
  const visibleNodeIds = new Set(reconciled.nodes.map((node) => node.id));
  const visibleEdgeIds = new Set(reconciled.edges.map((edge) => edge.id));
  const hiddenGeneratedNodeIds = generated.nodes.filter((node) => !visibleNodeIds.has(node.id)).map((node) => node.id);
  const hiddenGeneratedEdgeIds = generated.edges.filter((edge) => !visibleEdgeIds.has(edge.id)).map((edge) => edge.id);
  const assessmentInvalidations = Object.fromEntries(reconciled.nodes.flatMap((node) => {
    const baseline = generatedNodes.get(node.id);
    if (!baseline || node.origin === "manual") return [];
    const basis = assessmentInputFingerprint(node, reconciled.edges);
    return basis === assessmentInputFingerprint(baseline, generated.edges) ? [] : [[node.id, basis]];
  }));
  return {
    schemaVersion: 1,
    generationId,
    revision,
    updatedAt: new Date().toISOString(),
    ...(reconciled.layout ? { layout: reconciled.layout } : {}),
    nodeEdits,
    edgeEdits,
    assessmentInvalidations,
    riskOverrides,
    hiddenGeneratedNodeIds,
    hiddenGeneratedEdgeIds,
    manualNodes: reconciled.nodes.filter((node) => node.origin === "manual"),
    manualEdges: reconciled.edges.filter((edge) => edge.origin === "manual"),
    orphanedEdges: reconciled.orphanedEdges ?? [],
    orphanedNodeEdits: reconciled.orphanedNodeEdits ?? [],
    migrationReviewActions: reconciled.migrationReviewActions ?? [],
    migrationPendingItems: reconciled.migrationPendingItems ?? []
  };
}

export function canvasFromGraphOverview(
  overview: GraphOverviewV1,
  userState: CanvasUserStateV1,
  projectPath: string,
  generation: GenerationIdentity
): CodeflowCanvas {
  const hiddenNodeIds = new Set(userState.hiddenGeneratedNodeIds ?? []);
  const hiddenEdgeIds = new Set(userState.hiddenGeneratedEdgeIds ?? []);
  const rawNodes = overview.nodes.filter((node) => !hiddenNodeIds.has(node.id)).map((node) => {
    const { assessment: legacyAssessment, assessmentPending: _legacyPending, ...edits } = userState.nodeEdits[node.id] ?? {};
    const override = userState.riskOverrides?.[node.id] ?? legacyAssessment?.risk.override;
    const effective: GraphNode = { ...node, guidanceDraft: "", ...edits, origin: "generated" };
    return override ? { ...effective, risk: override.level,
      assessment: applyAssessmentOverride(unknownAssessment(overview.scanFingerprint, userState.updatedAt), override) } : effective;
  });
  const visibleNodeIds = new Set([...rawNodes, ...userState.manualNodes].map((node) => node.id));
  const editedEdges = overview.edges.filter((edge) => !hiddenEdgeIds.has(edge.id)).map((edge) => ({
    ...edge,
    ...(userState.edgeEdits[edge.id] ?? {}),
    ...(userState.edgeEdits[edge.id]?.source || userState.edgeEdits[edge.id]?.target || userState.edgeEdits[edge.id]?.relation
      ? { confidence: "inferred" as const, evidence: [] } : {}),
    origin: "generated" as const
  })).filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
  const effectiveEdges = [...editedEdges, ...userState.manualEdges];
  const generatedById = new Map(overview.nodes.map((node) => [node.id, node]));
  const nodes = rawNodes.map((node) => {
    const baseline = generatedById.get(node.id);
    return baseline && assessmentInputFingerprint(node, effectiveEdges) !== assessmentInputFingerprint({ ...baseline, guidanceDraft: "" }, overview.edges)
      ? invalidateModuleAssessment(node, userState.updatedAt) : node;
  });
  return {
    generation,
    userRevision: userState.revision,
    hiddenGeneratedNodeIds: userState.hiddenGeneratedNodeIds ?? [],
    hiddenGeneratedEdgeIds: userState.hiddenGeneratedEdgeIds ?? [],
    generatorVersion: overview.generatorVersion,
    inputFingerprint: overview.inputFingerprint,
    id: "main",
    title: "Main Canvas",
    projectPath,
    generatedAt: overview.generatedAt,
    scanFingerprint: overview.scanFingerprint,
    artifactState: "current",
    layout: userState.layout,
    nodes: [...nodes, ...userState.manualNodes],
    edges: effectiveEdges,
    orphanedEdges: userState.orphanedEdges,
    orphanedNodeEdits: userState.orphanedNodeEdits,
    migrationReviewActions: userState.migrationReviewActions ?? [],
    migrationPendingItems: userState.migrationPendingItems,
    groups: overview.groups,
    quality: overview.quality
  };
}

function assessmentInputFingerprint(node: GraphNode, edges: GraphEdge[]): string {
  const relations = edges.filter((edge) => edge.source === node.id || edge.target === node.id)
    .map((edge) => [edge.source, edge.target, edge.relation, [...(edge.sourceRelationIds ?? [])].sort()])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const input = [node.title, node.description, node.nodeType, node.role, node.category, node.architectureLayer,
    node.classification, node.technologyStack, [...(node.technologyTags ?? [])].sort(), [...node.files].sort(), relations];
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function migrateCanvasV1To4(generated: CodeflowCanvas, existing: LegacyCanvasV1To4): CodeflowCanvas {
  const moduleMatches = new Map<string, unknown[]>();
  for (const oldNode of existing.rawNodes) {
    if (!isLegacyModule(oldNode)) continue;
    const key = fileSetKey(oldNode.files);
    moduleMatches.set(key, [...(moduleMatches.get(key) ?? []), oldNode]);
  }
  const generatedMatchCounts = new Map<string, number>();
  const oldModuleByGeneratedId = new Map<string, Record<string, unknown>>();
  for (const node of generated.nodes) {
    const matches = moduleMatches.get(fileSetKey(node.files)) ?? [];
    if (matches.length !== 1) continue;
    const oldNode = matches[0] as Record<string, unknown>;
    generatedMatchCounts.set(String(oldNode.id), (generatedMatchCounts.get(String(oldNode.id)) ?? 0) + 1);
    oldModuleByGeneratedId.set(node.id, oldNode);
  }
  const matchedPositions = Object.fromEntries(generated.nodes.flatMap((node) => {
    const oldNode = oldModuleByGeneratedId.get(node.id);
    if (!oldNode || generatedMatchCounts.get(String(oldNode.id)) !== 1 || !isLegacyPosition(oldNode)) return [];
    return [[node.id, { x: oldNode.x, y: oldNode.y }]];
  }));
  const viewMode = existing.layout?.viewMode === "dependency" || existing.layout?.activeMode === "dependency"
    ? "dependency"
    : "execution";
  const layout: CanvasLayoutState = {
    activeMode: existing.layout?.activeMode === "manual" && Object.keys(matchedPositions).length === generated.nodes.length
      ? "manual"
      : viewMode,
    viewMode,
    manualPositions: matchedPositions,
    autoLayouts: generated.layout?.autoLayouts ?? {},
    autoConnectionHandles: generated.layout?.autoConnectionHandles ?? {},
    autoLayoutTopologyFingerprints: generated.layout?.autoLayoutTopologyFingerprints,
    collapsedGroups: []
  };
  const migrationPendingItems: CanvasMigrationPendingItem[] = [
    ...existing.rawNodes.map((raw) => ({ kind: "node" as const, sourceVersion: existing.version, ...(legacyId(raw) ? { sourceId: legacyId(raw) } : {}), raw, reason: "Canvas versions 1–4 do not identify generated and user-created nodes." })),
    ...existing.rawEdges.map((raw) => ({ kind: "edge" as const, sourceVersion: existing.version, ...(legacyId(raw) ? { sourceId: legacyId(raw) } : {}), raw, reason: "Canvas versions 1–4 do not identify generated and user-created edges." }))
  ];
  return { ...generated, layout, migrationPendingItems };
}

function isLegacyModule(value: unknown): value is Record<string, unknown> & { id: string; kind: "module"; files: string[] } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "id" in value && typeof value.id === "string" && "kind" in value && value.kind === "module" &&
    "files" in value && Array.isArray(value.files) && value.files.every((file) => typeof file === "string");
}

function isLegacyPosition(value: Record<string, unknown>): value is Record<string, unknown> & { x: number; y: number } {
  return typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y);
}

function fileSetKey(files: string[]): string {
  return JSON.stringify([...files].sort());
}

function legacyId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "id" in value && typeof value.id === "string"
    ? value.id
    : undefined;
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
  const overlappingOldIds = modulesWithOverlappingFiles([...oldGeneratedById.values()]);
  const overlappingGeneratedIds = modulesWithOverlappingFiles(migratedNodes);
  const matchesByOldId = new Map<string, GraphNode[]>();
  const oldMatchCountByNewId = new Map<string, number>();
  for (const oldNode of oldGeneratedById.values()) {
    const matches = [...generatedById.values()].filter((candidate) =>
      sameModuleIdentity(oldNode, candidate) && !overlappingOldIds.has(oldNode.id) && !overlappingGeneratedIds.has(candidate.id)
    );
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
  const initialView = chooseInitialGraphView(generated.edges);
  const viewMode = viewModeFromLegacyLayout(existing.layout, initialView);
  const manualPositions = remapManualPositions(existing.layout?.manualPositions ?? {}, oldToNewGeneratedId, manualIds);
  const layout: CanvasLayoutState = {
    activeMode: existing.layout?.activeMode === "manual" && migratedNodes.every((node) => [...oldToNewGeneratedId.values()].includes(node.id)) ? "manual" : viewMode,
    viewMode,
    manualPositions,
    autoLayouts: generated.layout?.autoLayouts ?? {},
    autoConnectionHandles: generated.layout?.autoConnectionHandles ?? {},
    autoLayoutTopologyFingerprints: generated.layout?.autoLayoutTopologyFingerprints,
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
      ...[...oldGeneratedById.values()]
        .filter((node) => !oldToNewGeneratedId.has(node.id) && (
          Object.keys(baselineById.has(node.id) ? customizedV6Fields(node, baselineById.get(node.id)) : customizedV5Fields(node)).length > 0 ||
          existing.layout?.activeMode === "manual" && Boolean(existing.layout.manualPositions[node.id])
        ))
        .map((node) => {
          const manualPosition = existing.layout?.manualPositions[node.id];
          const baseline = baselineById.get(node.id);
          const customized = baseline ? customizedV6Fields(node, baseline) : undefined;
          const edits = { ...(customized ?? {}), ...(manualPosition ?? {}) };
          return {
            node: withManualPosition(node, manualPosition),
            ...(Object.keys(edits).length > 0 ? { edits } : {}),
            reason: (hasSharedModuleFile(node, migratedNodes) ? "split-or-merge" : "removed") as "split-or-merge" | "removed"
          };
        })
    ]),
    migrationReviewActions: existing.migrationReviewActions ?? [],
    migrationPendingItems: existing.migrationPendingItems ?? []
  };
}

function reconcileCanvasUserState(generated: CodeflowCanvas, existing: CodeflowCanvas, baseline: Pick<CodeflowCanvas, "nodes" | "edges"> | undefined, knownFiles: ReadonlySet<string> | undefined): CodeflowCanvas {
  const generatedNodeIds = new Set(generated.nodes.map((node) => node.id));
  const baselineById = new Map(baseline?.nodes.map((node) => [node.id, node]) ?? []);
  const hiddenNodeIds = new Set(existing.hiddenGeneratedNodeIds ?? []);
  const existingGeneratedModules = existing.nodes.filter((node) => node.origin !== "manual" && node.kind === "module");
  const generatedModules = generated.nodes.filter((node) => node.origin !== "manual" && node.kind === "module");
  const previousIdentityNodes = [
    ...existingGeneratedModules.map((node) => baselineById.get(node.id) ?? node),
    ...[...hiddenNodeIds].flatMap((id) => {
      const node = baselineById.get(id);
      return node ? [node] : [];
    })
  ];
  const overlappingExistingIds = modulesWithOverlappingFiles(existingGeneratedModules.map((node) => baselineById.get(node.id) ?? node));
  const overlappingGeneratedIds = modulesWithOverlappingFiles(generatedModules);
  const matchesByNewId = new Map<string, GraphNode[]>();
  const existingMatchCount = new Map<string, number>();
  for (const node of generatedModules) {
    const matches = existingGeneratedModules.filter((candidate) => {
      const previous = baselineById.get(candidate.id) ?? candidate;
      return sameVisibleModuleIdentity(previous, node) && !overlappingExistingIds.has(candidate.id) && !overlappingGeneratedIds.has(node.id) &&
        !generatedModules.some((other) => other.id !== node.id && sharesModuleFile(previous, other)) &&
        !previousIdentityNodes.some((other) => other.id !== previous.id && sharesModuleFile(other, node)) &&
        (node.identity?.predecessorIds.length ?? 0) <= 1;
    });
    matchesByNewId.set(node.id, matches);
    for (const match of matches) existingMatchCount.set(match.id, (existingMatchCount.get(match.id) ?? 0) + 1);
  }
  const previousByNewId = new Map<string, GraphNode>();
  for (const [newId, matches] of matchesByNewId) {
    if (matches.length === 1 && existingMatchCount.get(matches[0].id) === 1) previousByNewId.set(newId, matches[0]);
  }
  const newIdByPreviousId = new Map([...previousByNewId.entries()].map(([newId, previous]) => [previous.id, newId]));
  for (const oldId of hiddenNodeIds) {
    const previous = baselineById.get(oldId);
    if (!previous) continue;
    if (previous.resource) {
      const matches = generated.nodes.filter((candidate) => sameTombstoneResourceIdentity(previous, candidate));
      if (matches.length === 1 && !previousByNewId.has(matches[0].id) &&
        previousIdentityNodes.filter((node) => sameTombstoneResourceIdentity(node, matches[0])).length === 1) {
        newIdByPreviousId.set(oldId, matches[0].id);
      }
      continue;
    }
    const matches = generatedModules.filter((candidate) => sameTombstoneModuleIdentity(previous, candidate));
    if (matches.length === 1 && !previousByNewId.has(matches[0].id) &&
      previousIdentityNodes.filter((node) => sameTombstoneModuleIdentity(node, matches[0])).length === 1 &&
      !generatedModules.some((node) => node.id !== matches[0].id && sharesModuleFile(previous, node)) &&
      !previousIdentityNodes.some((node) => node.id !== previous.id && sharesModuleFile(node, matches[0])) &&
      matches[0].identity?.predecessorIds.length !== undefined && matches[0].identity.predecessorIds.length <= 1) {
      newIdByPreviousId.set(oldId, matches[0].id);
    }
  }
  const nextHiddenNodeIds = new Set([...hiddenNodeIds].flatMap((oldId) => {
    const nextId = newIdByPreviousId.get(oldId);
    return nextId && generatedNodeIds.has(nextId) ? [nextId] : [];
  }));
  const rebasedNodes = generated.nodes.filter((node) => !nextHiddenNodeIds.has(node.id)).map((node) => {
    const matchedPrevious = previousByNewId.get(node.id);
    if (!matchedPrevious) return node;
    const previousBaseline = baselineById.get(matchedPrevious.id);
    const requested = customizedV6Fields(matchedPrevious, previousBaseline);
    const customized = requested.files && previousBaseline
      ? { ...requested, files: rebaseModuleFiles(previousBaseline.files, matchedPrevious.files, node.files) }
      : requested;
    const { risk: _pendingRisk, ...nonRiskFields } = customized;
    const retainedFields = matchedPrevious.assessmentPending && !matchedPrevious.assessment?.risk.override ? nonRiskFields : customized;
    return applyCustomizedFields(node, {
      ...(existing.layout?.activeMode === "manual" ? { x: matchedPrevious.x, y: matchedPrevious.y } : {}),
      ...retainedFields
    });
  });
  const conflictingFileCorrections = invalidRebasedFileOwners(rebasedNodes, generated.nodes, knownFiles);
  const generatedById = new Map(generated.nodes.map((node) => [node.id, node]));
  const nodes = rebasedNodes.map((node) => conflictingFileCorrections.has(node.id)
    ? { ...node, files: generatedById.get(node.id)!.files }
    : node);
  const generatedModuleIds = nodes.filter((node) => node.origin !== "manual" && node.kind === "module").map((node) => node.id);
  const hasPositionsForEveryGeneratedModule = generatedModuleIds.every((id) => previousByNewId.has(id));
  const manualNodes = existing.nodes.filter((node) => node.origin === "manual" && !generatedNodeIds.has(node.id));
  nodes.push(...manualNodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const generatedEdgeMigration = reconcileGeneratedEdges(generated, existing, baseline, newIdByPreviousId);
  const hiddenEdgeIds = new Set(existing.hiddenGeneratedEdgeIds ?? []);
  const generatedEdgeIdsForMatch = new Set(generated.edges.map((edge) => edge.id));
  const oldHiddenEdges = baseline?.edges.filter((edge) => hiddenEdgeIds.has(edge.id)) ?? [];
  const edgeIdMap = new Map([...matchRelationIds(oldHiddenEdges, generated.edges, newIdByPreviousId)]
    .filter(([oldId, newId]) => sameTombstoneRelationFacts(
      oldHiddenEdges.find((edge) => edge.id === oldId)!, generated.edges.find((edge) => edge.id === newId)!
    )));
  const nextHiddenEdgeIds = new Set([...hiddenEdgeIds].flatMap((oldId) => {
    const nextId = edgeIdMap.get(oldId);
    return nextId ? [nextId] : [];
  }));
  const pendingTombstones: CanvasMigrationPendingItem[] = [
    ...[...conflictingFileCorrections].flatMap((id) => {
      const previous = previousByNewId.get(id);
      return previous ? [{ kind: "node" as const, sourceVersion: 7 as const,
        sourceGenerationId: existing.generation?.requestId, sourceId: previous.id, raw: previous,
        reason: "file-correction-conflict" }] : [];
    }),
    ...[...hiddenNodeIds].filter((id) => !newIdByPreviousId.has(id)).map((id) => ({
      kind: "node" as const, sourceVersion: 7 as const, sourceGenerationId: existing.generation?.requestId,
      sourceId: id, raw: baselineById.get(id) ?? { id }, reason: baselineById.has(id) ? "ambiguous-deletion-identity" : "missing-deletion-baseline"
    })),
    ...[...hiddenEdgeIds].filter((id) => !edgeIdMap.has(id)).map((id) => ({
      kind: "edge" as const, sourceVersion: 7 as const, sourceGenerationId: existing.generation?.requestId,
      sourceId: id, raw: oldHiddenEdges.find((edge) => edge.id === id) ?? { id },
      reason: oldHiddenEdges.some((edge) => edge.id === id) ? "ambiguous-deletion-facts" : "missing-deletion-baseline"
    }))
  ];
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
    ...oldHiddenEdges.filter((edge) => !edgeIdMap.has(edge.id) && !generatedEdgeIdsForMatch.has(edge.id)),
    ...existing.edges.filter((edge) => edge.origin === "manual" && generatedEdgeIds.has(edge.id)),
    ...migratedManualEdges.filter(({ edge }) => !preservedEdgeIds.has(edge.id)).map(({ edge }) => edge)
  ]);
  const initialView = chooseInitialGraphView(generated.edges);
  const viewMode = existing.layout?.viewMode === "dependency" ? "dependency" : initialView;
  const activeMode = existing.layout?.activeMode === "manual" && !hasPositionsForEveryGeneratedModule
    ? viewMode
    : existing.layout?.activeMode === "manual" ? "manual" : viewMode;
  return {
    ...generated,
    layout: existing.layout ? {
      ...existing.layout, activeMode, viewMode,
      autoLayouts: { ...existing.layout.autoLayouts, ...generated.layout?.autoLayouts },
      autoConnectionHandles: { ...existing.layout.autoConnectionHandles, ...generated.layout?.autoConnectionHandles },
      autoLayoutTopologyFingerprints: {
        ...existing.layout.autoLayoutTopologyFingerprints,
        ...generated.layout?.autoLayoutTopologyFingerprints
      },
      collapsedGroups: [...new Set([
        ...existing.layout.collapsedGroups,
        ...(generated.layout?.collapsedGroups ?? []).filter((id) => id === "view:unlinked" &&
          !existing.nodes.some((node) => node.overviewGroup?.id === id))
      ])].sort(),
      manualPositions: remapManualPositions(existing.layout.manualPositions, newIdByPreviousId, manualNodeIds)
    } : generated.layout,
    nodes,
    edges: [...generatedEdgeMigration.edges.filter((edge) => !nextHiddenEdgeIds.has(edge.id) && nodeIds.has(edge.source) && nodeIds.has(edge.target)), ...preservedEdges],
    hiddenGeneratedNodeIds: [...nextHiddenNodeIds],
    hiddenGeneratedEdgeIds: [...nextHiddenEdgeIds],
    orphanedEdges,
    orphanedNodeEdits: deduplicateNodeEdits([
      ...(existing.orphanedNodeEdits ?? []),
      ...[...hiddenNodeIds].filter((id) => !newIdByPreviousId.has(id) && baselineById.has(id)).map((id) => ({
        node: baselineById.get(id)!, edits: {}, reason: "removed" as const
      })),
      ...existingGeneratedModules
        .filter((node) => !newIdByPreviousId.has(node.id) && (
          Object.keys(customizedV6Fields(node, baselineById.get(node.id))).length > 0 ||
          existing.layout?.activeMode === "manual" && Boolean(existing.layout.manualPositions[node.id])
        ))
        .map((node) => {
          const manualPosition = existing.layout?.manualPositions[node.id];
          const baseline = baselineById.get(node.id);
          const edits = { ...(baseline ? customizedV6Fields(node, baseline) : {}), ...(manualPosition ?? {}) };
          return {
            node: withManualPosition(node, manualPosition),
            ...(Object.keys(edits).length > 0 ? { edits } : {}),
            reason: (hasSharedModuleFile(node, generatedModules) ? "split-or-merge" : "removed") as "split-or-merge" | "removed"
          };
        })
    ]),
    migrationReviewActions: existing.migrationReviewActions ?? [],
    migrationPendingItems: deduplicatePendingItems([...(existing.migrationPendingItems ?? []), ...pendingTombstones])
  };
}

function sameTombstoneModuleIdentity(previous: GraphNode, candidate: GraphNode): boolean {
  if (!previous.identity || !candidate.identity || previous.identity.anchor !== candidate.identity.anchor ||
    previous.role !== candidate.role || previous.category !== candidate.category) return false;
  if (previous.identity.clusterFingerprint === candidate.identity.clusterFingerprint) return true;
  if (candidate.identity.predecessorIds.includes(previous.id)) return true;
  return previous.files.some((file) => candidate.files.includes(file)) && previous.role === candidate.role &&
    previous.category === candidate.category;
}

function sameTombstoneResourceIdentity(previous: GraphNode, candidate: GraphNode): boolean {
  return Boolean(previous.resource && candidate.resource && previous.resource.kind === candidate.resource.kind &&
    previous.resource.scopeId === candidate.resource.scopeId && previous.resource.key === candidate.resource.key);
}

function sharesModuleFile(left: GraphNode, right: GraphNode): boolean {
  const leftFiles = new Set(left.files);
  return right.files.some((file) => leftFiles.has(file));
}

function sameTombstoneRelationFacts(previous: GraphEdge, candidate: GraphEdge): boolean {
  const previousFacts = new Set([
    ...(previous.sourceRelationIds ?? []), ...(previous.evidence ?? []).flatMap((item) => item.eventId ? [item.eventId] : [])
  ]);
  const candidateFacts = new Set([
    ...(candidate.sourceRelationIds ?? []), ...(candidate.evidence ?? []).flatMap((item) => item.eventId ? [item.eventId] : [])
  ]);
  return previousFacts.size > 0 && previousFacts.size === candidateFacts.size &&
    [...previousFacts].every((fact) => candidateFacts.has(fact));
}

function deduplicatePendingItems(items: CanvasMigrationPendingItem[]): CanvasMigrationPendingItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.sourceVersion}:${item.sourceGenerationId ?? ""}:${item.sourceId ?? ""}:${item.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reconcileGeneratedEdges(
  generated: CodeflowCanvas,
  existing: CodeflowCanvas | StoredCanvas,
  baseline: Pick<CodeflowCanvas, "nodes" | "edges"> | undefined,
  nodeIdMap: ReadonlyMap<string, string>
): { edges: GraphEdge[]; orphanedEdges: GraphEdge[] } {
  const previousEdges = existing.edges.filter((edge) => edge.origin !== "manual");
  const baselineById = new Map(baseline?.edges.map((edge) => [edge.id, edge]) ?? []);
  const relationIdMap = matchRelationIds(previousEdges.map((edge) => baselineById.get(edge.id) ?? edge), generated.edges, nodeIdMap);
  const guidanceByNewId = new Map<string, string | undefined>();
  const correctionsByNewId = new Map<string, GraphEdge>();
  const nextNodeIds = new Set([...generated.nodes, ...existing.nodes.filter((node) => node.origin === "manual")].map((node) => node.id));
  const orphanedEdges: GraphEdge[] = [];
  for (const edge of previousEdges) {
    const before = baselineById.get(edge.id);
    const hasGuidanceEdit = before ? edge.guidanceNote !== before.guidanceNote : edge.guidanceNote !== undefined;
    const hasFactEdit = before && (edge.source !== before.source || edge.target !== before.target || edge.relation !== before.relation);
    const nextId = relationIdMap.get(edge.id);
    if (hasFactEdit) {
      const source = nodeIdMap.get(edge.source) ?? edge.source;
      const target = nodeIdMap.get(edge.target) ?? edge.target;
      if (nextId && nextNodeIds.has(source) && nextNodeIds.has(target) && (source !== target || before?.source === before?.target)) {
        correctionsByNewId.set(nextId, { ...edge, id: nextId, source, target, confidence: "inferred", evidence: [],
          semanticKinds: [], operations: [], importUsages: [], sourceRelationIds: [] });
      } else orphanedEdges.push(edge);
    } else if (hasGuidanceEdit && !nextId) orphanedEdges.push(edge);
    else if (hasGuidanceEdit && nextId) guidanceByNewId.set(nextId, edge.guidanceNote);
  }
  return {
    edges: generated.edges.map((edge) => correctionsByNewId.has(edge.id)
      ? { ...edge, ...correctionsByNewId.get(edge.id) }
      : guidanceByNewId.has(edge.id) ? { ...edge, guidanceNote: guidanceByNewId.get(edge.id) } : edge),
    orphanedEdges
  };
}

function applyCustomizedFields(node: GraphNode, fields: Partial<GraphNode>): GraphNode {
  const override = fields.assessment?.risk.override;
  return {
    ...node,
    ...fields,
    ...(override && node.assessment ? {
      assessment: applyAssessmentOverride(node.assessment, override)
    } : {})
  };
}

function customizedV6Fields(previous: GraphNode, baseline: GraphNode | undefined): Partial<GraphNode> {
  const fields: Partial<GraphNode> = {};
  if (!baseline || previous.title !== baseline.title) fields.title = previous.title;
  if (!baseline || previous.description !== baseline.description) fields.description = previous.description;
  if (baseline && previous.nodeType !== baseline.nodeType) fields.nodeType = previous.nodeType;
  if (baseline && previous.subtitle !== baseline.subtitle) fields.subtitle = previous.subtitle;
  if (baseline && JSON.stringify(previous.files) !== JSON.stringify(baseline.files)) fields.files = previous.files;
  if (baseline && JSON.stringify(previous.fileRoles) !== JSON.stringify(baseline.fileRoles)) fields.fileRoles = previous.fileRoles;
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
  return fileSetKey(left.files) === fileSetKey(right.files);
}

function sameVisibleModuleIdentity(previous: GraphNode, candidate: GraphNode): boolean {
  if (!previous.identity || !candidate.identity) return sameModuleIdentity(previous, candidate) && roleExtendsPreviousDuty(previous.role, candidate.role);
  const uniquePredecessor = candidate.identity.predecessorIds.length === 1 && candidate.identity.predecessorIds[0] === previous.id;
  const sameAnchor = previous.identity.anchor === candidate.identity.anchor;
  if (previous.category !== candidate.category || !roleExtendsPreviousDuty(previous.role, candidate.role) || (!sameAnchor && !uniquePredecessor)) return false;
  if (sameModuleIdentity(previous, candidate)) return true;
  const retainsEveryPreviousFile = previous.files.length > 0 && previous.files.every((file) => candidate.files.includes(file));
  if (retainsEveryPreviousFile) return true;
  const sharedFileCount = previous.files.filter((file) => candidate.files.includes(file)).length;
  if (sameAnchor) return sharedFileCount > 0;
  return uniquePredecessor && sharedFileCount > 1;
}

function roleExtendsPreviousDuty(previousRole: string | undefined, candidateRole: string | undefined): boolean {
  const normalize = (role: string | undefined) => role?.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() ?? "";
  const previous = normalize(previousRole);
  const candidate = normalize(candidateRole);
  return previous === candidate || Boolean(previous && candidate.startsWith(`${previous} `));
}

function rebaseModuleFiles(previousBaseline: string[], previousUserFiles: string[], nextBaseline: string[]): string[] {
  const removed = new Set(previousBaseline.filter((file) => !previousUserFiles.includes(file)));
  const added = previousUserFiles.filter((file) => !previousBaseline.includes(file));
  return [...new Set([...nextBaseline.filter((file) => !removed.has(file)), ...added])];
}

function invalidRebasedFileOwners(rebased: GraphNode[], generated: GraphNode[], knownFiles: ReadonlySet<string> | undefined): Set<string> {
  const generatedById = new Map(generated.map((node) => [node.id, node]));
  const owners = new Map<string, string[]>();
  const invalid = new Set<string>();
  for (const node of rebased) {
    if (node.kind !== "module" || node.resource) continue;
    for (const file of node.files) {
      if (knownFiles && !knownFiles.has(file)) invalid.add(node.id);
      owners.set(file, [...(owners.get(file) ?? []), node.id]);
    }
  }
  for (const [file, ids] of owners) {
    if (ids.length < 2) continue;
    for (const id of ids) if (!generatedById.get(id)?.files.includes(file)) invalid.add(id);
  }
  return invalid;
}

function withManualPosition(node: GraphNode, position: { x: number; y: number } | undefined): GraphNode {
  return position ? { ...node, x: position.x, y: position.y } : node;
}

function modulesWithOverlappingFiles(modules: GraphNode[]): Set<string> {
  const modulesByFile = new Map<string, string[]>();
  for (const module of modules) {
    if (module.kind !== "module" || module.resource) continue;
    for (const file of module.files) modulesByFile.set(file, [...(modulesByFile.get(file) ?? []), module.id]);
  }
  return new Set([...modulesByFile.values()].flatMap((ids) => ids.length > 1 ? ids : []));
}

function hasSharedModuleFile(node: GraphNode, candidates: GraphNode[]): boolean {
  const files = new Set(node.files);
  return candidates.some((candidate) => candidate.kind === "module" && candidate.files.some((file) => files.has(file)));
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
  return layout?.viewMode === "dependency" || layout?.activeMode === "dependency" ? "dependency" : fallback;
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

function manualPositionsForNode(existing: CodeflowCanvas | StoredCanvas, generatedIdMap: Map<string, string>, nodeId: string): Partial<GraphNode> | undefined {
  const previousId = [...generatedIdMap.entries()].find(([, nextId]) => nextId === nodeId)?.[0];
  const previous = existing.nodes.find((node) => node.id === previousId);
  return previous ? { x: previous.x, y: previous.y } : undefined;
}

function deduplicateNodeEdits(edits: NonNullable<CodeflowCanvas["orphanedNodeEdits"]>): NonNullable<CodeflowCanvas["orphanedNodeEdits"]> {
  return [...new Map(edits.map((edit) => [edit.node.id, edit])).values()];
}

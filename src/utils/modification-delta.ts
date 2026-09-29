import type {
  CodeflowCanvas,
  ModificationAcknowledgementScope,
  ModificationBaseline,
  ModificationDelta,
  ModificationSnapshot,
  NormalizedModule,
  NormalizedRelation
} from "../types";

export function normalizeModificationSnapshot(
  canvas: CodeflowCanvas | (Omit<CodeflowCanvas, "version"> & { version: 5 }),
  sequenceInstruction: string
): ModificationSnapshot {
  return {
    generation: canvas.generation,
    scanFingerprint: canvas.scanFingerprint,
    canvas: {
      modules: canvas.nodes.map(normalizeModule).sort(compareById),
      relations: [...new Map([
        ...canvas.edges.map(normalizeRelation),
        ...(canvas.orphanedEdges ?? []).map((edge): NormalizedRelation => ({ ...normalizeRelation(edge), pending: true }))
      ].map((relation) => [relation.id, relation])).values()].sort(compareById)
    },
    sequenceInstruction: sequenceInstruction.trim() || undefined
  };
}

/** Stable IDs take priority; remapped endpoints and relation must still match uniquely. */
export function matchRelationIds(
  previous: readonly NormalizedRelation[],
  current: readonly NormalizedRelation[],
  moduleIdMap: ReadonlyMap<string, string>
): Map<string, string> {
  const idMap = new Map<string, string>();
  const currentById = new Map(current.map((relation) => [relation.id, relation]));
  const sameIdentity = (before: NormalizedRelation, after: NormalizedRelation): boolean =>
    !before.pending && !after.pending && moduleIdMap.get(before.source) === after.source &&
    moduleIdMap.get(before.target) === after.target && before.relation === after.relation;
  for (const relation of previous) {
    const candidate = currentById.get(relation.id);
    if (candidate && sameIdentity(relation, candidate)) idMap.set(relation.id, candidate.id);
  }
  const usedIds = new Set(idMap.values());
  const remainingCurrent = current.filter((relation) => !usedIds.has(relation.id));
  const candidatesByOldId = new Map<string, NormalizedRelation[]>();
  const oldCountsByNewId = new Map<string, number>();
  // ponytail: O(n²) unmatched relation scan; index endpoint/relation keys if large rescans become slow.
  for (const relation of previous.filter((candidate) => !idMap.has(candidate.id))) {
    const candidates = remainingCurrent.filter((candidate) => sameIdentity(relation, candidate));
    candidatesByOldId.set(relation.id, candidates);
    for (const candidate of candidates) oldCountsByNewId.set(candidate.id, (oldCountsByNewId.get(candidate.id) ?? 0) + 1);
  }
  for (const [oldId, candidates] of candidatesByOldId) {
    if (candidates.length === 1 && oldCountsByNewId.get(candidates[0].id) === 1) idMap.set(oldId, candidates[0].id);
  }
  return idMap;
}

export function migrateModificationBaseline(
  baseline: ModificationBaseline,
  current: ModificationSnapshot,
  generated: ModificationSnapshot | undefined
): ModificationBaseline {
  const matches = new Map(baseline.canvas.modules.map((previous) => [previous.id, current.canvas.modules.filter((module) => {
    if (previous.resourceId || module.resourceId) return previous.resourceId !== undefined && previous.resourceId === module.resourceId;
    return previous.files.length > 0 && module.files.some((file) => previous.files.includes(file)) || previous.id === module.id && previous.files.length === 0;
  })]));
  const matchCounts = new Map<string, number>();
  for (const candidates of matches.values()) {
    for (const module of candidates) matchCounts.set(module.id, (matchCounts.get(module.id) ?? 0) + 1);
  }
  const idMap = new Map<string, string>();
  const migratedById = new Map<string, NormalizedModule>();
  for (const previous of baseline.canvas.modules) {
    const candidates = matches.get(previous.id)!;
    if (candidates.length !== 1 || matchCounts.get(candidates[0].id) !== 1) {
      migratedById.set(previous.id, previous);
      continue;
    }
    const module = candidates[0];
    idMap.set(previous.id, module.id);
    const generatedModule = generated?.canvas.modules.find((node) => node.id === module.id);
    const acknowledged = generatedModule ? {
      ...generatedModule,
      guidanceDraft: module.guidanceDraft === generatedModule.guidanceDraft ? generatedModule.guidanceDraft : previous.guidanceDraft,
      riskOverride: JSON.stringify(module.riskOverride) === JSON.stringify(generatedModule.riskOverride) ? generatedModule.riskOverride : previous.riskOverride,
      ...(module.title === previous.title ? { title: previous.title } : {}),
      ...(module.description === previous.description ? { description: previous.description } : {})
    } : { ...previous, id: module.id, files: module.files };
    migratedById.set(module.id, acknowledged);
  }
  for (const module of generated?.canvas.modules ?? []) {
    if (!migratedById.has(module.id)) migratedById.set(module.id, module);
  }
  const generatedRelations = generated?.canvas.relations ?? [];
  const relationIdMap = matchRelationIds(baseline.canvas.relations, generated?.canvas.relations ?? current.canvas.relations, idMap);
  const generatedById = new Map(generatedRelations.map((relation) => [relation.id, relation]));
  const currentById = new Map(current.canvas.relations.map((relation) => [relation.id, relation]));
  const relationsById = new Map(generatedRelations.map((relation) => [relation.id, relation]));
  for (const relation of baseline.canvas.relations) {
    const id = relationIdMap.get(relation.id);
    if (!id) {
      relationsById.set(relation.id, relation);
      continue;
    }
    const generatedRelation = generatedById.get(id);
    const currentRelation = currentById.get(id);
    relationsById.set(id, {
      ...relation, id, source: idMap.get(relation.source)!, target: idMap.get(relation.target)!,
      guidanceNote: generatedRelation && currentRelation && !currentRelation.pending && currentRelation.guidanceNote === generatedRelation.guidanceNote
        ? generatedRelation.guidanceNote : relation.guidanceNote
    });
  }
  return {
    ...baseline,
    graphModelVersion: 6,
    scanFingerprint: current.scanFingerprint,
    canvas: { modules: [...migratedById.values()].sort(compareById), relations: [...relationsById.values()].sort(compareById) },
    moduleGuidanceAcknowledgements: Object.fromEntries(Object.entries(baseline.moduleGuidanceAcknowledgements ?? {}).map(([id, guidance]) => [idMap.get(id) ?? id, guidance]))
  };
}

export function buildModificationDelta(
  baseline: ModificationBaseline,
  current: ModificationSnapshot
): ModificationDelta {
  const baselineModules = new Map(baseline.canvas.modules.map((module) => [module.id, module]));
  const currentModules = new Map(current.canvas.modules.map((module) => [module.id, module]));
  const baselineRelations = new Map(baseline.canvas.relations.map((relation) => [relation.id, relation]));
  const currentRelations = new Map(current.canvas.relations.map((relation) => [relation.id, relation]));

  return {
    modules: {
      added: current.canvas.modules
        .filter((module) => !baselineModules.has(module.id))
        .map((module) =>
          baseline.moduleGuidanceAcknowledgements?.[module.id] === module.guidanceDraft
            ? { ...module, guidanceDraft: "" }
            : module
        ),
      updated: current.canvas.modules.flatMap((module) => {
        const previous = baselineModules.get(module.id);
        if (!previous) return [];
        const changes = changedFields(previous, module, ["id"]);
        return Object.keys(changes).length > 0
          ? [{ id: module.id, title: module.title, changes }]
          : [];
      }),
      deleted: baseline.canvas.modules
        .filter((module) => !currentModules.has(module.id))
        .map(({ id, title }) => ({ id, title }))
    },
    relations: {
      added: current.canvas.relations.filter((relation) => !baselineRelations.has(relation.id)),
      updated: current.canvas.relations.flatMap((relation) => {
        const previous = baselineRelations.get(relation.id);
        if (!previous) return [];
        const changes = changedFields(previous, relation, ["id"]);
        return Object.keys(changes).length > 0
          ? [{ id: relation.id, changes: { ...changes, ...(relation.pending ? { pending: true as const } : {}) } }]
          : [];
      }),
      deleted: baseline.canvas.relations
        .filter((relation) => !currentRelations.has(relation.id))
        .map(({ id, source, target }) => ({ id, source, target }))
    },
    sequenceInstruction:
      current.sequenceInstruction && current.sequenceInstruction !== baseline.sequenceInstruction
        ? current.sequenceInstruction
        : undefined
  };
}

export function hasModificationDelta(delta: ModificationDelta): boolean {
  return Boolean(
    delta.sequenceInstruction ||
    delta.modules.added.length ||
    delta.modules.updated.length ||
    delta.modules.deleted.length ||
    delta.relations.added.length ||
    delta.relations.updated.length ||
    delta.relations.deleted.length
  );
}

export function acknowledgeModificationDelta(
  baseline: ModificationBaseline,
  sentSnapshot: ModificationSnapshot,
  scope: ModificationAcknowledgementScope,
  acknowledgedAt: string
): ModificationBaseline {
  if (scope.kind === "all") {
    return {
      version: 1,
      graphModelVersion: baseline.graphModelVersion,
      acknowledgedAt,
      ...sentSnapshot,
      moduleGuidanceAcknowledgements: {}
    };
  }
  if (scope.kind === "sequence") {
    return {
      ...baseline,
      acknowledgedAt,
      sequenceInstruction: sentSnapshot.sequenceInstruction
    };
  }
  const sentModule = sentSnapshot.canvas.modules.find((module) => module.id === scope.moduleId);
  if (!sentModule) {
    throw new Error(`Cannot acknowledge guidance for missing module: ${scope.moduleId}`);
  }
  const baselineModule = baseline.canvas.modules.find((module) => module.id === scope.moduleId);
  if (!baselineModule) {
    return {
      ...baseline,
      acknowledgedAt,
      moduleGuidanceAcknowledgements: {
        ...baseline.moduleGuidanceAcknowledgements,
        [scope.moduleId]: sentModule.guidanceDraft
      }
    };
  }
  return {
    ...baseline,
    acknowledgedAt,
    canvas: {
      ...baseline.canvas,
      modules: baseline.canvas.modules.map((module) =>
        module.id === scope.moduleId
          ? { ...module, guidanceDraft: sentModule.guidanceDraft }
          : module
      )
    },
    moduleGuidanceAcknowledgements: {
      ...baseline.moduleGuidanceAcknowledgements,
      [scope.moduleId]: sentModule.guidanceDraft
    }
  };
}

function normalizeModule(module: CodeflowCanvas["nodes"][number]): NormalizedModule {
  const riskOverride = module.assessment?.risk.override;
  return {
    id: module.id,
    ...(module.resource ? { resourceId: module.resource.id } : {}),
    title: module.title,
    nodeType: module.nodeType,
    description: module.description,
    files: [...new Set(module.files.map((file) => file.trim()).filter(Boolean))].sort(),
    guidanceDraft: module.guidanceDraft.trim(),
    riskOverride: riskOverride
      ? { level: riskOverride.level, reason: riskOverride.reason.trim() }
      : undefined
  };
}

function normalizeRelation(relation: CodeflowCanvas["edges"][number]): NormalizedRelation {
  return {
    id: relation.id,
    source: relation.source,
    target: relation.target,
    relation: relation.relation,
    guidanceNote: relation.guidanceNote?.trim()
  };
}

function changedFields<T extends Record<string, unknown>>(
  previous: T,
  current: T,
  excluded: Array<keyof T>
): Partial<T> {
  const excludedFields = new Set<keyof T>(excluded);
  return Object.fromEntries(
    (Object.keys(current) as Array<keyof T>)
      .filter((key) => !excludedFields.has(key))
      .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(current[key]))
      .map((key) => [key, current[key]])
  ) as Partial<T>;
}

function compareById(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

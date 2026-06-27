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
  canvas: CodeflowCanvas,
  sequenceInstruction: string
): ModificationSnapshot {
  return {
    scanFingerprint: canvas.scanFingerprint,
    canvas: {
      modules: canvas.nodes.map(normalizeModule).sort(compareById),
      relations: canvas.edges.map(normalizeRelation).sort(compareById)
    },
    sequenceInstruction: sequenceInstruction.trim() || undefined
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
        return Object.keys(changes).length > 0 ? [{ id: relation.id, changes }] : [];
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
    guidanceNote: relation.guidanceNote?.trim() || undefined
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

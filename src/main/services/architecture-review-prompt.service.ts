import { createHash } from "node:crypto";
import type {
  ArchitectureEvidence,
  ArchitectureMap,
  ArchitectureModule,
  ArchitectureRelationship,
  SemanticIndex
} from "../../types";

export const ARCHITECTURE_REVIEW_PROMPT_TARGET_CHARS = 8_000;
export const ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS = 12_000;
export const ARCHITECTURE_PROMPT_EVIDENCE_DETAIL_MAX_CHARS = 160;

export type ArchitectureReviewPromptEvidence = ArchitectureEvidence & {
  id: string;
  moduleIds: string[];
  relationshipId?: string;
  severity: "error" | "warning" | "info";
  confidence: "confirmed" | "inferred";
};

export type ArchitectureReviewPromptInput = {
  projectName: string;
  architectureStyle?: string;
  modules: ArchitectureModule[];
  relationships: ArchitectureRelationship[];
  evidence: ArchitectureReviewPromptEvidence[];
};

export type ArchitectureReviewPrompt = {
  text: string;
  modules: ArchitectureModule[];
  evidence: ArchitectureReviewPromptEvidence[];
  moduleIds: string[];
  metrics: {
    promptChars: number;
    promptModuleCount: number;
    promptEdgeCount: number;
    promptEvidenceCount: number;
    promptCoreChars: number;
    promptEvidenceChars: number;
    promptEvidenceOmittedCount: number;
    promptEvidenceTruncatedCount: number;
    promptEvidenceCoveredModuleCount: number;
    promptModuleWithoutSourceEvidenceCount: number;
  };
};

export class ArchitecturePromptBudgetExceededError extends Error {
  readonly code = "ARCHITECTURE_PROMPT_BUDGET_EXCEEDED";

  constructor(
    moduleCount: number,
    edgeCount: number,
    actualChars: number,
    budget: number,
    largestContribution: string
  ) {
    super(
      `ARCHITECTURE_PROMPT_BUDGET_EXCEEDED: modules=${moduleCount} edges=${edgeCount} ` +
      `actualChars=${actualChars} budget=${budget} largestContribution=${largestContribution}`
    );
    this.name = "ArchitecturePromptBudgetExceededError";
  }
}

export function createArchitectureReviewPromptInput(
  architecture: ArchitectureMap,
  index: SemanticIndex
): ArchitectureReviewPromptInput {
  const warningModuleIds = new Set(
    architecture.moduleDiagnostics?.flatMap((diagnostic) => diagnostic.moduleIds) ?? []
  );
  const moduleEvidence = architecture.modules.flatMap((module) =>
    module.evidence.map((evidence) => promptEvidence(evidence, [module.id], undefined, warningModuleIds.has(module.id) ? "warning" : "info", "confirmed"))
  );
  const relationshipEvidence = architecture.relationships.flatMap((relationship) =>
    relationship.evidence.map((evidence) => {
      const semanticRelation = index.relations.find((relation) =>
        relation.sourceFile === evidence.filePath &&
        relation.symbol === evidence.symbol &&
        relation.detail === evidence.detail
      );
      return promptEvidence(
        evidence,
        [relationship.source, relationship.target],
        relationship.id,
        "info",
        semanticRelation?.confidence ?? "inferred"
      );
    })
  );

  return {
    projectName: architecture.projectName,
    architectureStyle: architecture.architectureStyle,
    modules: architecture.modules,
    relationships: architecture.relationships,
    evidence: deduplicateEvidence([...moduleEvidence, ...relationshipEvidence])
  };
}

export function buildArchitectureReviewPrompt(input: ArchitectureReviewPromptInput): ArchitectureReviewPrompt {
  const modules = [...input.modules].sort(byId);
  const relationships = [...input.relationships].sort(byId);
  validatePromptInput(modules, relationships, input.evidence);
  const evidence = compactEvidenceIds([...input.evidence].sort(compareEvidence));

  const corePrompt = renderPrompt(input, modules, relationships, []);
  if (corePrompt.length > ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS) {
    throw promptBudgetError(input, modules, relationships, corePrompt.length, []);
  }

  const mandatoryEvidence = selectRepresentativeEvidence(modules, evidence);
  const mandatoryPrompt = renderPrompt(input, modules, relationships, mandatoryEvidence);
  if (mandatoryPrompt.length > ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS) {
    throw promptBudgetError(input, modules, relationships, mandatoryPrompt.length, mandatoryEvidence);
  }

  const selected = mandatoryPrompt.length > ARCHITECTURE_REVIEW_PROMPT_TARGET_CHARS
    ? mandatoryEvidence
    : fillOptionalEvidence(
      mandatoryEvidence,
      evidence,
      input,
      modules,
      relationships,
      ARCHITECTURE_REVIEW_PROMPT_TARGET_CHARS
    );
  const text = renderPrompt(input, modules, relationships, selected);
  if (text.length > ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS) {
    throw promptBudgetError(input, modules, relationships, text.length, selected);
  }
  const sourceBackedModuleIds = collectSourceBackedModuleIds(evidence);
  const coveredModuleIds = collectSourceBackedModuleIds(selected);
  return {
    text,
    modules,
    evidence: selected,
    moduleIds: modules.map((module) => module.id),
    metrics: {
      promptChars: text.length,
      promptModuleCount: modules.length,
      promptEdgeCount: relationships.length,
      promptEvidenceCount: selected.length,
      promptCoreChars: corePrompt.length,
      promptEvidenceChars: text.length - corePrompt.length,
      promptEvidenceOmittedCount: input.evidence.length - selected.length,
      promptEvidenceTruncatedCount: selected.filter((item) => item.detail.length > ARCHITECTURE_PROMPT_EVIDENCE_DETAIL_MAX_CHARS).length,
      promptEvidenceCoveredModuleCount: coveredModuleIds.size,
      promptModuleWithoutSourceEvidenceCount: modules.length - sourceBackedModuleIds.size
    }
  };
}

function promptEvidence(
  evidence: ArchitectureEvidence,
  moduleIds: string[],
  relationshipId: string | undefined,
  severity: ArchitectureReviewPromptEvidence["severity"],
  confidence: ArchitectureReviewPromptEvidence["confidence"]
): ArchitectureReviewPromptEvidence {
  const identity = [
    relationshipId ?? "module",
    [...moduleIds].sort().join(","),
    evidence.filePath ?? "",
    evidence.symbol ?? "",
    evidence.line ?? "",
    evidence.eventId ?? "",
    evidence.detail
  ];
  const id = `evidence-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  return { ...evidence, id, moduleIds: [...moduleIds].sort(), relationshipId, severity, confidence };
}

function deduplicateEvidence(evidence: ArchitectureReviewPromptEvidence[]): ArchitectureReviewPromptEvidence[] {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  return [...byId.values()].sort(compareEvidence);
}

function compactEvidenceIds(evidence: ArchitectureReviewPromptEvidence[]): ArchitectureReviewPromptEvidence[] {
  const hashes = evidence.map((item) => createHash("sha256").update(item.id).digest("hex"));
  const lengths = hashes.map(() => 12);
  while (true) {
    const byId = new Map<string, number[]>();
    hashes.forEach((hash, index) => {
      const id = `ev-${hash.slice(0, lengths[index])}`;
      byId.set(id, [...(byId.get(id) ?? []), index]);
    });
    const collisions = [...byId.values()].filter((indexes) => indexes.length > 1);
    if (collisions.length === 0) return evidence.map((item, index) => ({ ...item, id: `ev-${hashes[index].slice(0, lengths[index])}` }));
    for (const index of collisions.flat()) {
      if (lengths[index] >= hashes[index].length) throw new Error("Could not create unique compact architecture evidence IDs.");
      lengths[index] = Math.min(hashes[index].length, lengths[index] + 4);
    }
  }
}

function validatePromptInput(
  modules: ArchitectureModule[],
  relationships: ArchitectureRelationship[],
  evidence: ArchitectureReviewPromptEvidence[]
): void {
  const moduleIds = new Set(modules.map((module) => module.id));
  const relationshipIds = new Set(relationships.map((relationship) => relationship.id));
  const evidenceIds = new Set<string>();
  for (const item of evidence) {
    if (evidenceIds.has(item.id)) throw new Error(`Duplicate architecture review evidence id: ${item.id}`);
    evidenceIds.add(item.id);
    if (item.moduleIds.some((id) => !moduleIds.has(id))) {
      throw new Error(`Architecture review evidence ${item.id} references an unknown module.`);
    }
    if (item.relationshipId && !relationshipIds.has(item.relationshipId)) {
      throw new Error(`Architecture review evidence ${item.id} references an unknown relationship.`);
    }
  }
}

function selectRepresentativeEvidence(
  modules: ArchitectureModule[],
  evidence: ArchitectureReviewPromptEvidence[]
): ArchitectureReviewPromptEvidence[] {
  const selected = new Map<string, ArchitectureReviewPromptEvidence>();
  for (const module of modules) {
    const bestCandidate = evidence.find((item) => !item.relationshipId && item.moduleIds.includes(module.id));
    if (bestCandidate) selected.set(bestCandidate.id, bestCandidate);
  }
  return [...selected.values()].sort(compareEvidence);
}

function fillOptionalEvidence(
  mandatory: ArchitectureReviewPromptEvidence[],
  evidence: ArchitectureReviewPromptEvidence[],
  input: ArchitectureReviewPromptInput,
  modules: ArchitectureModule[],
  relationships: ArchitectureRelationship[],
  targetChars: number
): ArchitectureReviewPromptEvidence[] {
  const selected = new Map(mandatory.map((item) => [item.id, item]));
  for (const candidate of evidence) {
    if (selected.has(candidate.id) || !hasEvidenceCapacity(candidate, selected)) continue;
    selected.set(candidate.id, candidate);
    if (renderPrompt(input, modules, relationships, [...selected.values()]).length > targetChars) {
      selected.delete(candidate.id);
    }
  }
  return [...selected.values()].sort((left, right) => compareStrings(left.id, right.id));
}

function collectSourceBackedModuleIds(evidence: ArchitectureReviewPromptEvidence[]): Set<string> {
  return new Set(evidence
    .filter((item) => !item.relationshipId)
    .flatMap((item) => item.moduleIds));
}

function hasEvidenceCapacity(
  candidate: ArchitectureReviewPromptEvidence,
  selected: Map<string, ArchitectureReviewPromptEvidence>
): boolean {
  const values = [...selected.values()];
  if (candidate.relationshipId) {
    return values.filter((item) => item.relationshipId === candidate.relationshipId).length < 2;
  }
  return candidate.moduleIds.every((moduleId) =>
    values.filter((item) => !item.relationshipId && item.moduleIds.includes(moduleId)).length < 5
  );
}

function renderPrompt(
  input: ArchitectureReviewPromptInput,
  modules: ArchitectureModule[],
  relationships: ArchitectureRelationship[],
  evidence: ArchitectureReviewPromptEvidence[]
): string {
  const moduleIndexes = new Map(modules.map((module, index) => [module.id, index]));
  const relationshipIndexes = new Map(relationships.map((relationship, index) => [relationship.id, index]));
  const categories = createStringDictionary(modules.map((module) => module.category));
  const roles = createStringDictionary(modules.map((module) => module.role));
  const relations = createStringDictionary(relationships.map((relationship) => relationship.relation));
  const descriptions = createStringDictionary(relationships.map((relationship) => relationship.description));
  const moduleRows = modules.map((module) => [
    module.id,
    module.title,
    categories.indexes.get(module.category),
    roles.indexes.get(module.role),
    module.files.length,
    module.symbols.length
  ]);
  const relationshipRows = relationships.map((relationship) => [
    moduleIndexes.get(relationship.source),
    moduleIndexes.get(relationship.target),
    relations.indexes.get(relationship.relation),
    descriptions.indexes.get(relationship.description)
  ]);
  const evidenceRows = renderEvidence(evidence, modules, relationships);
  return [
    "Review this local architecture graph. Return one JSON object only; enhance wording and report only evidence-backed findings. Do not change topology, ownership, risk, or confidence.",
    `Project: ${input.projectName}`,
    input.architectureStyle ? `Current architecture style: ${input.architectureStyle}` : "",
    "M=[id,title,categoryIndex,roleIndex,fileCount,symbolCount]; C/O/T/D are category/role/relation/full-description dictionaries; R=[sourceModuleIndex,targetModuleIndex,relationIndex,descriptionIndex]; V=[evidenceId,owner(m<index>|r<index>),file,symbol,line,detail]. IDs appear once; use M IDs and V evidence IDs exactly.",
    `Local module graph and representative evidence:\nM:${JSON.stringify(moduleRows)}\nC:${JSON.stringify(categories.values)}\nO:${JSON.stringify(roles.values)}\nR:${JSON.stringify(relationshipRows)}\nT:${JSON.stringify(relations.values)}\nD:${JSON.stringify(descriptions.values)}\nV:${JSON.stringify(evidenceRows)}`,
    "Review response schema:",
    JSON.stringify({
      architectureStyle: "optional short style description",
      modules: [{ moduleId: "existing-module-id", title: "optional", role: "optional", description: "optional", assessmentNotes: "optional" }],
      findings: [{ code: "stable-code", severity: "warning|error", moduleIds: ["existing-module-id"], message: "evidence-grounded finding", evidenceIds: ["supplied-evidence-id"] }]
    }),
    "Keep module IDs exact. Every finding must cite supplied evidence owned by one of its module IDs. Do not return graph edges or file ownership."
  ].filter(Boolean).join("\n\n");
}

function createStringDictionary(values: string[]): { values: string[]; indexes: Map<string, number> } {
  const dictionary = [...new Set(values)];
  return { values: dictionary, indexes: new Map(dictionary.map((value, index) => [value, index])) };
}

function renderEvidence(
  evidence: ArchitectureReviewPromptEvidence[],
  modules: ArchitectureModule[],
  relationships: ArchitectureRelationship[]
): Array<[string, string, string | undefined, string | undefined, number | undefined, string]> {
  const moduleIndexes = new Map(modules.map((module, index) => [module.id, index]));
  const relationshipIndexes = new Map(relationships.map((relationship, index) => [relationship.id, index]));
  return evidence.map((item) => [
    item.id,
    item.relationshipId
      ? `r${relationshipIndexes.get(item.relationshipId)}`
      : `m${item.moduleIds.map((id) => moduleIndexes.get(id)).join(",")}`,
    item.filePath,
    item.symbol,
    item.line,
    truncateEvidenceDetail(item.detail)
  ]);
}

function truncateEvidenceDetail(detail: string): string {
  if (detail.length <= ARCHITECTURE_PROMPT_EVIDENCE_DETAIL_MAX_CHARS) return detail;
  return `${detail.slice(0, ARCHITECTURE_PROMPT_EVIDENCE_DETAIL_MAX_CHARS - 1)}…`;
}

function compareEvidence(left: ArchitectureReviewPromptEvidence, right: ArchitectureReviewPromptEvidence): number {
  const severity = severityRank(left.severity) - severityRank(right.severity);
  if (severity !== 0) return severity;
  const confidence = confidenceRank(left.confidence) - confidenceRank(right.confidence);
  return confidence !== 0 ? confidence : compareStrings(left.id, right.id);
}

function severityRank(value: ArchitectureReviewPromptEvidence["severity"]): number {
  return value === "error" ? 0 : value === "warning" ? 1 : 2;
}

function confidenceRank(value: ArchitectureReviewPromptEvidence["confidence"]): number {
  return value === "confirmed" ? 0 : 1;
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function promptBudgetError(
  input: ArchitectureReviewPromptInput,
  modules: ArchitectureModule[],
  relationships: ArchitectureRelationship[],
  actualChars: number,
  evidence: ArchitectureReviewPromptEvidence[]
): ArchitecturePromptBudgetExceededError {
  const contributions = [
    ...modules.map((module) => ({
      label: `module:${module.id}`,
      size: JSON.stringify({
        id: module.id,
        title: module.title,
        category: module.category,
        role: module.role,
        fileCount: module.files.length,
        symbolCount: module.symbols.length,
        evidence: []
      }).length
    })),
    ...relationships.map((relationship) => ({
      label: `edge:${relationship.id}`,
      size: JSON.stringify([
        relationship.id,
        relationship.source,
        relationship.target,
        relationship.relation,
        relationship.description,
        []
      ]).length
    })),
    ...evidence.map((item) => ({
      label: `evidence:${item.id}`,
      size: JSON.stringify({ id: item.id, filePath: item.filePath, symbol: item.symbol, line: item.line, detail: truncateEvidenceDetail(item.detail) }).length
    }))
  ].sort((left, right) => right.size - left.size || compareStrings(left.label, right.label));
  return new ArchitecturePromptBudgetExceededError(
    input.modules.length,
    input.relationships.length,
    actualChars,
    ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS,
    contributions[0]?.label ?? "prompt-instructions"
  );
}

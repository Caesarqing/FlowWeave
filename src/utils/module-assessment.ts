import type {
  ArchitectureEvidence,
  AssessmentFactor,
  AssessmentLevel,
  GraphEdge,
  GraphNode,
  ModuleAssessment,
  SemanticFile,
  SemanticIndex,
  SemanticRelation
} from "../types";

const CONFIDENCE_MAX = {
  parsing: 25,
  symbols: 25,
  relations: 25,
  evidence: 15,
  freshness: 10
} as const;
const ASSESSMENT_GENERATOR_VERSION = "1.0.0";

export function assessModules(
  modules: GraphNode[],
  edges: GraphEdge[],
  index: SemanticIndex,
  scanFingerprint: string,
  assessedAt: string
): GraphNode[] {
  return modules.map((module) => {
    const assessment = assessModule(module, modules, edges, index, scanFingerprint, assessedAt);
    return {
      ...module,
      risk: assessment.risk.effectiveLevel,
      confidence: undefined,
      assessment
    };
  });
}

export function applyRiskOverride(
  module: GraphNode,
  level: Exclude<AssessmentLevel, "unknown">,
  reason: string,
  createdAt: string
): GraphNode {
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    throw new Error("A reason is required to override the system risk assessment.");
  }
  const current = module.assessment ?? unknownAssessment("", createdAt);
  const assessment: ModuleAssessment = {
    ...current,
    risk: {
      ...current.risk,
      effectiveLevel: level,
      override: { level, reason: normalizedReason, createdAt }
    }
  };
  return { ...module, risk: level, assessment, status: "needs-review" };
}

export function clearRiskOverride(module: GraphNode): GraphNode {
  if (!module.assessment?.risk.override) return module;
  const assessment: ModuleAssessment = {
    ...module.assessment,
    risk: {
      ...module.assessment.risk,
      effectiveLevel: module.assessment.risk.systemLevel,
      override: undefined
    }
  };
  return { ...module, risk: assessment.risk.effectiveLevel, assessment, status: "needs-review" };
}

export function invalidateModuleAssessment(module: GraphNode, assessedAt: string): GraphNode {
  const next = preserveOverride(
    unknownAssessment(module.assessment?.fingerprint ?? "", assessedAt),
    module.assessment
  );
  return {
    ...module,
    risk: next.risk.effectiveLevel,
    confidence: undefined,
    assessment: next,
    status: "needs-review"
  };
}

export function unknownAssessment(fingerprint: string, assessedAt: string): ModuleAssessment {
  return {
    version: 1,
    generatorVersion: ASSESSMENT_GENERATOR_VERSION,
    confidence: { level: "unknown", factors: [] },
    risk: { systemLevel: "unknown", effectiveLevel: "unknown", factors: [] },
    fingerprint,
    assessedAt
  };
}

function assessModule(
  module: GraphNode,
  modules: GraphNode[],
  edges: GraphEdge[],
  index: SemanticIndex,
  scanFingerprint: string,
  assessedAt: string
): ModuleAssessment {
  const filesByPath = new Map(index.files.map((file) => [file.path, file]));
  const semanticFiles = module.files.map((file) => filesByPath.get(file)).filter((file): file is SemanticFile => Boolean(file));
  if (semanticFiles.length === 0) {
    const unknown = unknownAssessment(scanFingerprint, assessedAt);
    return preserveOverride(unknown, module.assessment);
  }

  const moduleFiles = new Set(semanticFiles.map((file) => file.path));
  const semanticRelations = index.relations.filter((relation) => relationTouchesFiles(relation, moduleFiles));
  const graphEdges = edges.filter((edge) => edge.source === module.id || edge.target === module.id);
  const confidenceFactors = buildConfidenceFactors(module, semanticFiles, semanticRelations, graphEdges, index, scanFingerprint);
  const confidenceScore = roundedSum(confidenceFactors);
  const riskFactors = buildRiskFactors(module, modules, graphEdges, semanticFiles, semanticRelations);
  const riskScore = roundedSum(riskFactors);
  const assessment: ModuleAssessment = {
    version: 1,
    generatorVersion: ASSESSMENT_GENERATOR_VERSION,
    confidence: {
      score: confidenceScore,
      level: confidenceLevel(confidenceScore),
      factors: confidenceFactors
    },
    risk: {
      systemScore: riskScore,
      systemLevel: riskLevel(riskScore),
      effectiveLevel: riskLevel(riskScore),
      factors: riskFactors
    },
    fingerprint: scanFingerprint,
    assessedAt
  };
  return preserveOverride(assessment, module.assessment);
}

function buildConfidenceFactors(
  module: GraphNode,
  files: SemanticFile[],
  relations: SemanticRelation[],
  edges: GraphEdge[],
  index: SemanticIndex,
  scanFingerprint: string
): AssessmentFactor[] {
  const parsingRatio = average(files.map((file) => parsingQuality(file)));
  const declaredSymbols = module.symbols ?? [];
  const matchedSymbols = declaredSymbols.filter((symbol) =>
    index.symbols.some((candidate) => candidate.filePath === symbol.filePath && candidate.name === symbol.name)
  );
  const symbolRatio = declaredSymbols.length > 0
    ? matchedSymbols.length / declaredSymbols.length
    : average(files.map((file) => file.insight?.symbols.length ? 0.7 : 0.35));
  const relationRatio = relations.length > 0
    ? average(relations.map((relation) => relation.confidence === "confirmed" ? 1 : 0.5))
    : 0.4;
  const evidence = [...(module.evidence ?? []), ...edges.flatMap((edge) => edge.evidence ?? [])];
  const evidenceRatio = evidence.length > 0 ? average(evidence.map(evidenceCompleteness)) : 0;
  const isCurrent = Boolean(scanFingerprint) && index.scanFingerprint === scanFingerprint;

  return [
    factor("parsing-coverage", "Parsing coverage", parsingRatio * CONFIDENCE_MAX.parsing, CONFIDENCE_MAX.parsing,
      `${files.filter((file) => file.status === "parsed").length} of ${files.length} module files parsed successfully.`,
      fileEvidence(files)),
    factor("symbol-resolution", "Symbol resolution", symbolRatio * CONFIDENCE_MAX.symbols, CONFIDENCE_MAX.symbols,
      declaredSymbols.length > 0
        ? `${matchedSymbols.length} of ${declaredSymbols.length} declared module symbols matched the semantic index.`
        : "No curated module symbols were available; the score uses symbols discovered in mapped files.",
      declaredSymbols.length > 0 ? declaredSymbols.slice(0, 5).map(symbolEvidence) : fileEvidence(files)),
    factor("relation-confirmation", "Relation confirmation", relationRatio * CONFIDENCE_MAX.relations, CONFIDENCE_MAX.relations,
      relations.length > 0
        ? `${relations.filter((relation) => relation.confidence === "confirmed").length} of ${relations.length} semantic relations are confirmed.`
        : "No semantic relations were available for this module.",
      relationEvidence(relations, files)),
    factor("evidence-completeness", "Evidence completeness", evidenceRatio * CONFIDENCE_MAX.evidence, CONFIDENCE_MAX.evidence,
      evidence.length > 0 ? `${evidence.length} module and connection evidence records were evaluated.` : "No module or connection evidence was recorded.",
      evidence.length > 0 ? evidence.slice(0, 5) : fileEvidence(files)),
    factor("data-freshness", "Data freshness", isCurrent ? CONFIDENCE_MAX.freshness : 0, CONFIDENCE_MAX.freshness,
      isCurrent ? "The semantic index matches the current scan fingerprint." : "The semantic index does not match the current scan fingerprint.",
      fileEvidence(files))
  ];
}

function buildRiskFactors(
  module: GraphNode,
  modules: GraphNode[],
  edges: GraphEdge[],
  files: SemanticFile[],
  relations: SemanticRelation[]
): AssessmentFactor[] {
  const behavioralEvidence = [
    ...files.flatMap((file) => file.insight?.symbols.map((symbol) => `${symbol.name} ${symbol.signature ?? ""}`) ?? []),
    ...files.flatMap((file) => file.insight?.calls ?? []),
    ...files.flatMap((file) => file.insight?.externalCalls.map((call) => `${call.kind} ${call.target}`) ?? []),
    ...relations.map((relation) => `${relation.kind} ${relation.detail} ${relation.target}`)
  ].join(" ").toLowerCase();
  const descriptiveEvidence = [module.title, module.description, module.role ?? ""].join(" ").toLowerCase();
  const pathOnly = files.map((file) => file.path).join(" ").toLowerCase();
  const strongSensitiveMatches = countMatches(behavioralEvidence, [
    /\bauth(?:entication|orization)?\b/g,
    /\bpermission\b|\baccess control\b|\brbac\b/g,
    /\bpayment\b|\bbilling\b|\bcheckout\b/g,
    /\bcredential\b|\bsecret\b|\btoken\b|\bprivate key\b/g,
    /\bpersonal data\b|\bprivacy\b|\buser data\b|\bpii\b/g
  ]);
  const descriptiveMatches = countMatches(descriptiveEvidence, [/\bauth\b|\bsecurity\b|\bpayment\b|\bbilling\b|\bpermission\b|\bprivacy\b/g]);
  const pathSensitiveMatches = countMatches(pathOnly, [/\bauth\b/g, /\bsecurity\b/g, /\bpayment\b/g, /\bpermission\b/g]);
  const sensitiveScore = Math.min(30, strongSensitiveMatches * 8 + Math.min(8, descriptiveMatches * 4) + Math.min(6, pathSensitiveMatches * 3));

  const moduleIds = new Set(modules.map((candidate) => candidate.id));
  const crossModuleEdges = edges.filter((edge) => moduleIds.has(edge.source) && moduleIds.has(edge.target));
  const centralityRatio = modules.length > 1 ? Math.min(1, crossModuleEdges.length / Math.min(6, modules.length - 1)) : 0;
  const centralityScore = centralityRatio * 25;

  const sideEffectKinds = new Set(relations
    .filter((relation) => ["database", "filesystem", "process", "http", "event"].includes(relation.kind))
    .map((relation) => relation.kind));
  const externalCalls = files.flatMap((file) => file.insight?.externalCalls ?? []);
  const sideEffectScore = Math.min(20, sideEffectKinds.size * 4 + externalCalls.length * 2);

  const layers = new Set(edges.map((edge) => edge.relation));
  const fileScale = Math.min(5, Math.max(0, files.length - 1));
  const impactScore = Math.min(15, crossModuleEdges.length * 3 + layers.size * 2 + fileScale);

  const hasTestProtection = files.some((file) => /(^|\/)(test|tests|spec|specs)(\/|$)|\.(test|spec)\./i.test(file.path)) ||
    edges.some((edge) => edge.relation === "tests") ||
    relations.some((relation) => relation.kind === "test");
  const testScore = hasTestProtection ? 0 : 10;

  return [
    factor("sensitive-surface", "Sensitive business surface", sensitiveScore, 30,
      sensitiveScore > 0 ? "Sensitive business or security concepts were found in code evidence." : "No sensitive business or security behavior was identified.",
      matchingEvidence(files, relations, /auth|permission|payment|billing|credential|secret|token|privacy|user data/i)),
    factor("dependency-centrality", "Dependency centrality", centralityScore, 25,
      `${crossModuleEdges.length} cross-module connections touch this module.`,
      edgeEvidence(edges, files)),
    factor("side-effects", "Side effects", sideEffectScore, 20,
      sideEffectScore > 0 ? `${sideEffectKinds.size} side-effect categories and ${externalCalls.length} external operations were detected.` : "No database, filesystem, process, event, or external HTTP side effects were detected.",
      sideEffectEvidence(files, relations)),
    factor("change-impact", "Change impact", impactScore, 15,
      `The module spans ${files.length} files and ${layers.size} relation types.`,
      edgeEvidence(edges, files)),
    factor("test-protection", "Test protection gap", testScore, 10,
      hasTestProtection ? "A test file or test relation is associated with this module." : "No directly associated test file or test relation was found.",
      hasTestProtection ? matchingEvidence(files, relations, /test|spec/i) : fileEvidence(files))
  ];
}

function preserveOverride(next: ModuleAssessment, previous: ModuleAssessment | undefined): ModuleAssessment {
  const override = previous?.risk.override;
  if (!previous || !override?.reason.trim()) return next;
  return {
    ...next,
    risk: {
      ...next.risk,
      effectiveLevel: override.level,
      previousSystemLevel: previous.risk.systemLevel,
      systemLevelChanged: previous.risk.systemLevel !== next.risk.systemLevel,
      override
    }
  };
}

function factor(id: string, label: string, score: number, maxScore: number, reason: string, evidence: ArchitectureEvidence[]): AssessmentFactor {
  return {
    id,
    label,
    score: round(score),
    maxScore,
    reason,
    evidence: evidence.length > 0 ? evidence.slice(0, 5) : [{ detail: reason }]
  };
}

function parsingQuality(file: SemanticFile): number {
  if (file.status !== "parsed") return file.status === "unsupported" ? 0.25 : 0;
  if (file.analysisDepth === "semantic") return 1;
  if (file.analysisDepth === "syntax") return 0.8;
  return 0.55;
}

function evidenceCompleteness(evidence: ArchitectureEvidence): number {
  return (evidence.filePath ? 0.4 : 0) + (evidence.symbol ? 0.3 : 0) + (evidence.line ? 0.3 : 0);
}

function relationTouchesFiles(relation: SemanticRelation, files: Set<string>): boolean {
  return files.has(relation.sourceFile) || Boolean(relation.targetFile && files.has(relation.targetFile));
}

function fileEvidence(files: SemanticFile[]): ArchitectureEvidence[] {
  return files.slice(0, 5).map((file) => ({
    filePath: file.path,
    symbol: file.insight?.symbols[0]?.name,
    line: file.insight?.symbols[0]?.line,
    detail: `${file.analysisDepth} analysis: ${file.status}`
  }));
}

function symbolEvidence(symbol: NonNullable<GraphNode["symbols"]>[number]): ArchitectureEvidence {
  return { filePath: symbol.filePath, symbol: symbol.name, line: symbol.line, detail: symbol.signature ?? `${symbol.kind} symbol` };
}

function relationEvidence(relations: SemanticRelation[], files: SemanticFile[]): ArchitectureEvidence[] {
  if (relations.length === 0) return fileEvidence(files);
  return relations.slice(0, 5).map((relation) => ({
    filePath: relation.sourceFile,
    symbol: relation.symbol,
    detail: `${relation.confidence} ${relation.kind}: ${relation.detail}`
  }));
}

function edgeEvidence(edges: GraphEdge[], files: SemanticFile[]): ArchitectureEvidence[] {
  const evidence = edges.flatMap((edge) => edge.evidence ?? []);
  if (evidence.length > 0) return evidence.slice(0, 5);
  return edges.slice(0, 5).map((edge) => ({ detail: `${edge.source} ${edge.relation} ${edge.target}` })).concat(fileEvidence(files)).slice(0, 5);
}

function matchingEvidence(files: SemanticFile[], relations: SemanticRelation[], pattern: RegExp): ArchitectureEvidence[] {
  const relationMatches = relations.filter((relation) => pattern.test(`${relation.detail} ${relation.target}`));
  pattern.lastIndex = 0;
  const fileMatches = files.filter((file) => pattern.test(`${file.path} ${file.insight?.symbols.map((symbol) => symbol.name).join(" ") ?? ""}`));
  pattern.lastIndex = 0;
  const combined: ArchitectureEvidence[] = [
    ...relationMatches.map((relation) => ({ filePath: relation.sourceFile, symbol: relation.symbol, detail: relation.detail })),
    ...fileMatches.map((file) => ({ filePath: file.path, detail: "Matched module code evidence." }))
  ];
  return [...combined, ...fileEvidence(files)].slice(0, 5);
}

function sideEffectEvidence(files: SemanticFile[], relations: SemanticRelation[]): ArchitectureEvidence[] {
  const relevant = relations.filter((relation) => ["database", "filesystem", "process", "http", "event"].includes(relation.kind));
  if (relevant.length > 0) return relationEvidence(relevant, files);
  const calls = files.flatMap((file) => (file.insight?.externalCalls ?? []).map((call) => ({
    filePath: file.path,
    symbol: call.symbol,
    detail: `${call.kind}: ${call.target}`
  })));
  return calls.length > 0 ? calls.slice(0, 5) : fileEvidence(files);
}

function countMatches(value: string, patterns: RegExp[]): number {
  return patterns.reduce((total, pattern) => {
    const matches = value.match(pattern);
    return total + (matches?.length ?? 0);
  }, 0);
}

function confidenceLevel(score: number): AssessmentLevel {
  if (score >= 80) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function riskLevel(score: number): AssessmentLevel {
  if (score >= 70) return "high";
  if (score >= 30) return "medium";
  return "low";
}

function roundedSum(factors: AssessmentFactor[]): number {
  return round(factors.reduce((total, current) => total + current.score, 0));
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((total, current) => total + current, 0) / values.length : 0;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

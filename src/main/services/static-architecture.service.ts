import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  ArchitectureEvidence, ArchitectureLayer, ArchitectureMap, ArchitectureModule,
  ArchitectureModuleCategory, ArchitectureRelationship, CodeflowProject, FileInsight,
  GraphEdge, GraphEdgeRelation, GraphNode, GraphNodeType, ProjectStructureFacts,
  SemanticIndex, SemanticRelation, TechnologyStack, ArchitectureGroup, ArchitectureGroupReference, ArchitectureRelationDiagnostic
} from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { readJsonArtifact } from "../storage/artifact-store";
import { assessModules } from "../../utils/module-assessment";
import { createArchitectureInputFingerprint } from "./architecture-review.service";
import { clusterArchitectureModules } from "./module-clustering.service";
import { moduleClusteringRelations, semanticIndexToStructureFacts } from "./semantic-index.service";
import { generateProject } from "./project-generation.service";
import { GenerationSupersededError } from "./generation-errors";
import { readCurrentProjectScanFingerprint } from "./project-scan-fingerprint.service";

const MODULE_CLUSTERING_CONFIG_VERSION = "5";
const ARCHITECTURE_GENERATOR_VERSION = "3.0.1";
const ARCHITECTURE_REVIEW_CONTRACT_VERSION = "3";

export type StaticArchitectureBuild = {
  architectureMap: ArchitectureMap;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  scanFingerprint: string;
  inputFingerprint: string;
  quality: { valid: boolean; reasons: string[]; fileCoverage: number; evidenceCoverage: number };
};

export async function buildStaticArchitecture(
  project: CodeflowProject,
  index: SemanticIndex
): Promise<StaticArchitectureBuild> {
  const facts = semanticIndexToStructureFacts(project, index);
  const previousModules = await readPreviousLocalModules(project.rootPath);
  const scanFingerprint = project.scanFingerprint ?? await readCurrentProjectScanFingerprint(project.rootPath);
  const inputFingerprint = buildArchitectureInputFingerprint(scanFingerprint, index);
  const base = createLocalArchitectureMap(
    project,
    facts,
    "local",
    previousModules,
    moduleClusteringRelations(index)
  );
  const quality = validateArchitectureMap(base, facts);
  const architectureMap = assessArchitectureMap(
    withLocalArchitectureMetadata(base, scanFingerprint, inputFingerprint, quality),
    index,
    inputFingerprint
  );
  return {
    architectureMap,
    graph: architectureMapToGraph(architectureMap),
    scanFingerprint,
    inputFingerprint,
    quality
  };
}

async function readPreviousLocalModules(projectPath: string): Promise<ArchitectureModule[]> {
  const artifactPath = join(projectPath, FLOWWEAVE_DIR, "architecture-local.json");
  const value = await readJsonArtifact(artifactPath);
  if (value === undefined) return [];
  if (
    typeof value !== "object" || value === null ||
    !("version" in value) || (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    !("source" in value) || value.source !== "local" ||
    !("modules" in value) || !Array.isArray(value.modules)
  ) {
    throw new Error(`FlowWeave local architecture baseline is invalid: ${artifactPath}`);
  }
  return value.modules as ArchitectureModule[];
}

export function architectureMapToGraph(architectureMap: ArchitectureMap): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = architectureMap.modules.map((module): GraphNode => ({
    id: module.id,
    title: module.title,
    subtitle: categoryLabel(module.category),
    kind: "module",
    nodeType: nodeTypeFromCategory(module.category),
    risk: module.risk,
    description: module.description,
    files: module.files,
    guidanceDraft: `Modify code around ${module.title}'s functional architecture responsibility. Prioritize the Files, Functions, and Connections evidence in the details panel.`,
    status: architectureMap.source === "agent" ? "mapped" : "needs-review",
    x: 0,
    y: 0,
    groupPath: module.groupPath, relationSummary: module.relationSummary, relationDiagnostics: module.relationDiagnostics,
    category: module.category,
    role: module.role,
    fileRoles: module.fileRoles,
    symbols: module.symbols,
    evidence: module.evidence,
    assessment: module.assessment,
    technologyStack: technologyStackForModule(module),
    technologyTags: technologyStacksForModule(module),
    architectureLayer: architectureLayerForCategory(module.category),
    classification: {
      role: architectureLayerForCategory(module.category),
      runtimeTags: technologyStacksForModule(module),
      domain: domainForModule(module)
    }
  }));
  const edges = architectureMap.relationships.map((relationship): GraphEdge => ({
    id: relationship.id,
    source: relationship.source,
    target: relationship.target,
    relation: relationship.relation,
    confidence: relationship.confidence,
    guidanceNote: relationship.description,
    evidence: relationship.evidence,
    semanticKinds: relationship.semanticKinds, operations: relationship.operations,
    importUsages: relationship.importUsages, sourceRelationIds: relationship.sourceRelationIds
  }));
  const resourceNodes = (architectureMap.resources ?? []).map((resource): GraphNode => ({
    id: resource.id, kind: "module", nodeType: resource.kind === "api" ? "api" : resource.kind === "database" || resource.kind === "filesystem" ? "data" : "external",
    title: resource.title, subtitle: resource.kind, description: resource.detail, files: [], guidanceDraft: "",
    risk: "unknown", status: "mapped", x: 0, y: 0, resource, evidence: resource.evidence,
    groupPath: resourceGroupPath(resource.scopeId, architectureMap.groups ?? []), architectureLayer: "integration", technologyStack: "infrastructure"
  }));
  return { nodes: [...nodes, ...resourceNodes], edges };
}

function technologyStackForModule(module: ArchitectureModule): TechnologyStack {
  return technologyStacksForModule(module)[0] ?? "unknown";
}

function technologyStacksForModule(module: ArchitectureModule): TechnologyStack[] {
  if (module.category === "unknown") return ["unknown"];
  const paths = module.files.map((file) => file.toLowerCase());
  const detected: TechnologyStack[] = [];
  if (paths.some((file) => /\.(tsx|jsx|vue|svelte|css|scss|html)$/.test(file))) detected.push("frontend");
  if (paths.some((file) => /\.(swift|kt|kts|dart)$/.test(file))) detected.push("mobile");
  if (paths.some((file) => /\.(py|java|go|rs|php|cs|rb)$/.test(file))) detected.push("backend");
  if (module.category === "data-access" || paths.some((file) => /\.(sql|prisma)$/.test(file))) detected.push("data");
  if (module.category === "external-integration") detected.push("infrastructure");
  if (detected.length === 0) detected.push(module.category === "api-boundary" || module.category === "domain-service" ? "backend" : "shared");
  return ["frontend", "mobile", "backend", "data", "infrastructure", "shared"].filter((technology) => detected.includes(technology as TechnologyStack)) as TechnologyStack[];
}

function architectureLayerForCategory(category: ArchitectureModuleCategory): ArchitectureLayer {
  if (category === "api-boundary") return "api";
  if (category === "domain-service") return "domain";
  if (category === "data-access") return "data";
  if (category === "external-integration") return "integration";
  if (category === "test-surface") return "test";
  if (category === "unknown") return "unknown";
  return "infrastructure";
}

function domainForModule(module: ArchitectureModule): string {
  for (const file of module.files) {
    const segments = file.split("/").filter(Boolean);
    const marker = segments.findIndex((segment) => ["features", "feature", "modules", "module", "domains", "domain"].includes(segment.toLowerCase()));
    const candidate = marker >= 0 ? segments[marker + 1] : undefined;
    if (candidate) return normalizeDomain(candidate);
  }
  return normalizeDomain(module.role || module.title || module.id);
}

function normalizeDomain(value: string): string {
  const normalized = value.replace(/\.[^.]+$/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || "shared";
}

export function buildArchitectureInputFingerprint(
  scanFingerprint: string,
  index: import("../../types").SemanticIndex
): string {
  return createArchitectureInputFingerprint({
    scanFingerprint,
    semanticContentFingerprint: createHash("sha256").update(index.configurationFingerprint ?? "").update(JSON.stringify(index.files.map((file) => [file.path, file.contentHash]))).digest("hex"),
    semanticIndexSchemaVersion: index.version,
    semanticIndexGeneratorVersion: index.generatorVersion,
    moduleClusteringConfigVersion: MODULE_CLUSTERING_CONFIG_VERSION,
    architectureGeneratorVersion: ARCHITECTURE_GENERATOR_VERSION,
    reviewContractVersion: ARCHITECTURE_REVIEW_CONTRACT_VERSION
  });
}

export function validateArchitectureMap(
  architectureMap: ArchitectureMap,
  representativeFacts: ProjectStructureFacts
): { valid: boolean; reasons: string[]; fileCoverage: number; evidenceCoverage: number } {
  const factByFile = new Map(representativeFacts.files.map((file) => [file.path, file]));
  const coveredFiles = new Set(architectureMap.modules.flatMap((module) => module.files).filter((file) => factByFile.has(file)));
  const evidence = [
    ...architectureMap.modules.flatMap((module) => module.evidence),
    ...architectureMap.relationships.flatMap((relationship) => relationship.evidence)
  ];
  const validEvidence = evidence.filter((item) => typeof item.filePath === "string" && factByFile.has(item.filePath));
  const fileCoverage = representativeFacts.files.length === 0 ? 0 : coveredFiles.size / representativeFacts.files.length;
  const evidenceCoverage = evidence.length === 0 ? 0 : validEvidence.length / evidence.length;
  const moduleIds = new Set([...architectureMap.modules.map((module) => module.id), ...(architectureMap.resources ?? []).map((resource) => resource.id)]);
  const reasons: string[] = [];

  for (const module of architectureMap.modules) {
    if (module.files.some((file) => !factByFile.has(file))) reasons.push(`Module ${module.id} references an unknown file.`);
    if (module.evidence.length === 0) reasons.push(`Module ${module.id} has no evidence.`);
    for (const symbol of module.symbols) {
      const fact = factByFile.get(symbol.filePath);
      if (!fact?.symbols.some((candidate) => candidate.name === symbol.name)) {
        reasons.push(`Symbol ${symbol.name} does not belong to ${symbol.filePath}.`);
      }
    }
  }
  for (const relationship of architectureMap.relationships) {
    if (!moduleIds.has(relationship.source) || !moduleIds.has(relationship.target)) {
      reasons.push(`Relationship ${relationship.id} has an invalid endpoint.`);
    }
    if (relationship.evidence.length === 0) reasons.push(`Relationship ${relationship.id} has no evidence.`);
    if (relationship.evidence.some((item) => !item.filePath || !factByFile.has(item.filePath))) {
      reasons.push(`Relationship ${relationship.id} contains invalid evidence.`);
    }
  }
  if (architectureMap.version === 3 && coveredFiles.size !== representativeFacts.files.length) reasons.push("Every parsed source file must have module ownership.");
  if (architectureMap.version === 3 && architectureMap.modules.flatMap((module) => module.files).length !== coveredFiles.size) reasons.push("Source file ownership must be unique.");
  if (fileCoverage < 0.3) reasons.push(`Representative file coverage ${fileCoverage.toFixed(2)} is below 0.30.`);
  if (evidenceCoverage < 0.7) reasons.push(`Evidence coverage ${evidenceCoverage.toFixed(2)} is below 0.70.`);
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], fileCoverage, evidenceCoverage };
}

function withLocalArchitectureMetadata(
  architectureMap: ArchitectureMap,
  scanFingerprint: string,
  inputFingerprint: string,
  quality: { fileCoverage: number; evidenceCoverage: number }
): ArchitectureMap {
  const generatedAt = new Date().toISOString();
  return {
    ...architectureMap,
    version: 3,
    generatorVersion: ARCHITECTURE_GENERATOR_VERSION,
    source: "local",
    generatedAt,
    metadata: {
      source: "local",
      generatedAt,
      scanFingerprint,
      inputFingerprint,
      fileCoverage: quality.fileCoverage,
      evidenceCoverage: quality.evidenceCoverage
    }
  };
}

function createLocalArchitectureMap(
  project: CodeflowProject,
  facts: ProjectStructureFacts,
  source: ArchitectureMap["source"],
  previousModules: ArchitectureModule[],
  clusteringRelations: SemanticRelation[]
): ArchitectureMap {
  const clustering = clusterArchitectureModules(facts.files, clusteringRelations, previousModules, facts.scopes);
  const modules = clustering.modules.map((cluster): ArchitectureModule => {
    const files = facts.files.filter((file) => cluster.files.includes(file.path));
    const { id, identity, title, category } = cluster;
    const ownedFiles = new Set(cluster.files);
    const ownedRelations = (facts.relations ?? []).filter((relation) => ownedFiles.has(relation.sourceFile));
    const symbols = files.flatMap((file) => file.symbols);
    return {
      id,
      relationSummary: { dependencies: ownedRelations.filter((relation) => relation.kind === "import" || relation.kind === "inherit").length, internalRelations: ownedRelations.filter((relation) => relation.targetFile && ownedFiles.has(relation.targetFile)).length, unresolvedRelations: ownedRelations.filter((relation) => relation.targetRef?.kind === "unresolved").length, externalRelations: ownedRelations.filter((relation) => relation.targetRef?.kind === "external" || relation.targetRef?.kind === "resource").length },
      relationDiagnostics: (facts.diagnostics ?? []).filter((diagnostic) => diagnostic.filePath && ownedFiles.has(diagnostic.filePath)),
      identity,
      title,
      category,
      nodeType: nodeTypeFromCategory(category),
      role: fallbackRole(category, files),
      description: fallbackModuleDescription(title, category, files),
      files: files.map((file) => file.path),
      fileRoles: fallbackFileRoles(files, category),
      symbols,
      evidence: files.slice(0, 5).map((file) => ({
        filePath: file.path,
        symbol: file.symbols[0]?.name,
        line: file.symbols[0]?.line,
        detail: evidenceFromInsight(file)
      })),
      groupPath: groupPathForFiles(files.map((file) => file.path), facts),
      risk: "unknown"
    };
  });

  const { relationships, diagnostics: relationDiagnostics } = buildArchitectureRelationships(modules, facts);
  const groups = groupsFromModules(modules);
  for (const resource of facts.resources ?? []) {
    const references = resourceGroupPath(resource.scopeId, groups);
    for (const reference of references) if (!groups.some((group) => group.id === reference.id)) groups.push({ ...reference, moduleIds: [] });
  }
  return {
    version: 3,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt: new Date().toISOString(),
    source,
    architectureStyle: "inferred functional architecture",
    modules,
    groups, resources: facts.resources, quality: facts.quality ? { ...facts.quality, factOutcomes: factOutcomes(facts, relationships, relationDiagnostics) } : undefined,
    moduleDiagnostics: clustering.diagnostics,
    relationDiagnostics,
    relationships,
    files: applyModuleIds(facts.files, modules),
    symbols: modules.flatMap((module) => module.symbols)
  };
}

function buildArchitectureRelationships(modules: ArchitectureModule[], facts: ProjectStructureFacts) {
  const relationships = aggregateArchitectureRelationships(modules, facts);
  const handled = new Set(relationships.flatMap((edge) => edge.sourceRelationIds ?? []));
  const moduleByFile = new Map(modules.flatMap((module) => module.files.map((file) => [file, module.id] as const)));
  const skipped = new Map<string, ArchitectureRelationDiagnostic>();
  for (const relation of facts.relations ?? []) {
    if (handled.has(relation.id)) continue;
    const targetModule = relation.targetFile ? moduleByFile.get(relation.targetFile) : undefined;
    const reason: ArchitectureRelationDiagnostic["reason"] = targetModule && moduleByFile.get(relation.sourceFile) === targetModule ? "same-module"
      : relation.targetRef?.kind === "unresolved" && relation.targetRef.candidates.length > 1 ? "ambiguous-target"
      : relation.targetRef?.kind === "external" ? "external"
      : (relation.kind === "event" || relation.kind === "process") && !relation.operation ? "direction-unknown" : "unlocated-target";
    const key = `${relation.kind}:${reason}`;
    const current = skipped.get(key);
    skipped.set(key, { kind: relation.kind, reason, count: (current?.count ?? 0) + 1, relationIds: [...(current?.relationIds ?? []), relation.id] });
  }
  return { relationships, diagnostics: [...skipped.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.reason.localeCompare(b.reason)) };
}

function factOutcomes(facts: ProjectStructureFacts, relationships: ArchitectureRelationship[], diagnostics: ArchitectureRelationDiagnostic[]): import("../../types").SemanticFactOutcome[] {
  const edges = new Set(relationships.flatMap((edge) => edge.sourceRelationIds ?? []));
  const reasonById = new Map(diagnostics.flatMap((diagnostic) => (diagnostic.relationIds ?? []).map((id) => [id, diagnostic.reason] as const)));
  const outcomes = new Map<string, import("../../types").SemanticFactOutcome>();
  for (const relation of facts.relations ?? []) {
    const reason = reasonById.get(relation.id);
    const outcome: import("../../types").SemanticFactOutcome["outcome"] = edges.has(relation.id) ? "architecture-edge" : reason === "same-module" ? "module-internal"
      : reason === "external" ? "external" : reason === "ambiguous-target" ? "ambiguous" : reason === "unsupported" || reason === "direction-unknown" ? "unsupported" : "unresolved";
    const key = `${relation.kind}:${outcome}`;
    const previous = outcomes.get(key);
    outcomes.set(key, { kind: relation.kind, outcome, count: (previous?.count ?? 0) + 1, relationIds: [...(previous?.relationIds ?? []), relation.id] });
  }
  return [...outcomes.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.outcome.localeCompare(b.outcome));
}

function groupPathForFiles(files: string[], facts: ProjectStructureFacts): ArchitectureGroupReference[] {
  if (!facts.scopes) return [];
  const scope = facts.scopes.filter((item) => files.some((file) => item.paths.includes(file))).sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
  const root = scope?.rootPath ?? "";
  const top: ArchitectureGroupReference = { id: `group:package:${root || "."}`, title: scope?.packageName ?? root.split("/").at(-1) ?? facts.projectName, rootPath: root };
  const sharedDirectory = commonDirectory(files);
  if (!sharedDirectory || sharedDirectory === root) return [top];
  const relativeDirectory = root ? sharedDirectory.slice(root.length + 1) : sharedDirectory;
  // ponytail: one directory level groups supporting files; deeper navigation remains module/file drill-down.
  const parts = relativeDirectory.split("/");
  const source = parts[0] === "src" ? parts.slice(1) : parts;
  const directory = ["features", "modules", "domains"].includes(source[0]) && source[1] ? source.slice(0, 2) : source.slice(0, 1);
  if (!directory.length || ["main", "renderer", "app"].includes(directory[0])) return [top];
  const path = [root, parts[0] === "src" ? "src" : "", ...directory].filter(Boolean).join("/");
  return [top, { id: `group:directory:${path}`, title: titleWords(directory.at(-1)!), rootPath: path, parentId: top.id }];
}

function titleWords(value: string): string { return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function groupsFromModules(modules: ArchitectureModule[]): ArchitectureGroup[] {
  const groups = new Map<string, ArchitectureGroup>();
  for (const module of modules) for (const reference of module.groupPath ?? []) {
    const previous = groups.get(reference.id);
    groups.set(reference.id, { ...reference, moduleIds: [...(previous?.moduleIds ?? []), module.id] });
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function resourceGroupPath(scopeId: string, groups: ArchitectureGroup[]): ArchitectureGroupReference[] {
  const root = scopeId.slice(scopeId.indexOf(":") + 1).replace(/^\.$/, "");
  const top = groups.find((group) => group.rootPath === root && !group.parentId);
  return top ? [top, { id: `${top.id}:resources`, title: "Resources", rootPath: root, parentId: top.id }] : [];
}

export function aggregateArchitectureRelationships(
  modules: ArchitectureModule[],
  facts: ProjectStructureFacts,
  candidates: ArchitectureRelationship[] = []
): ArchitectureRelationship[] {
  const moduleByFile = new Map<string, string>();
  modules.forEach((module) => module.files.forEach((file) => moduleByFile.set(file, module.id)));
  const lineByFileAndSymbol = new Map<string, number | undefined>();
  facts.files.forEach((file) => file.symbols.forEach((symbol) => {
    lineByFileAndSymbol.set(`${file.path}\u0000${symbol.name}`, symbol.line);
  }));
  const allCandidates = [...candidates];

  for (const semanticRelation of facts.relations ?? []) {
    if (!semanticRelation.sourceFile) continue;
    const source = moduleByFile.get(semanticRelation.sourceFile);
    const target = semanticRelation.targetRef?.kind === "resource" ? semanticRelation.targetRef.resourceId : semanticRelation.targetFile ? moduleByFile.get(semanticRelation.targetFile) : undefined;
    if (!source || !target || source === target) continue;
    const sourceModule = modules.find((module) => module.id === source);
    const relation = sourceModule?.category === "test-surface" && (semanticRelation.kind === "call" || semanticRelation.kind === "render") ? "tests" : architectureRelationFromSemantic(semanticRelation);
    if (!relation) continue;
    allCandidates.push({
      id: `${source}-${target}-${relation}-${semanticRelation.id}`,
      source: semanticRelation.operation === "subscribe" ? target : source,
      target: semanticRelation.operation === "subscribe" ? source : target,
      relation,
      confidence: semanticRelation.confidence,
      description: semanticRelation.detail,
      semanticKinds: [semanticRelation.kind], operations: semanticRelation.operation ? [semanticRelation.operation] : [],
      importUsages: semanticRelation.importUsage ? [semanticRelation.importUsage] : [], sourceRelationIds: [semanticRelation.id],
      evidence: [{
        filePath: semanticRelation.sourceFile, relationId: semanticRelation.id, range: semanticRelation.sourceRange, operation: semanticRelation.operation, role: semanticRelation.role,
        declarationRange: semanticRelation.targetRef?.kind === "file" ? semanticRelation.targetRef.declarationRange : undefined, bindingBasis: semanticRelation.bindingBasis,
        symbol: semanticRelation.symbol,
        line: semanticRelation.sourceRange?.start.line ?? (semanticRelation.symbol
          ? lineByFileAndSymbol.get(`${semanticRelation.sourceFile}\u0000${semanticRelation.symbol}`)
          : undefined),
        detail: semanticRelation.detail
      }]
    });
  }

  const grouped = new Map<string, ArchitectureRelationship>();
  for (const candidate of allCandidates.sort(compareRelationshipCandidate)) {
    const key = `${candidate.source}:${candidate.target}:${candidate.relation}`;
    const current = grouped.get(key);
    if (current) {
      current.evidence.push(...candidate.evidence);
      current.semanticKinds = [...new Set([...(current.semanticKinds ?? []), ...(candidate.semanticKinds ?? [])])];
      current.operations = [...new Set([...(current.operations ?? []), ...(candidate.operations ?? [])])];
      current.importUsages = [...new Set([...(current.importUsages ?? []), ...(candidate.importUsages ?? [])])];
      current.sourceRelationIds = [...new Set([...(current.sourceRelationIds ?? []), ...(candidate.sourceRelationIds ?? [])])];
      if (candidate.confidence === "confirmed" || current.confidence === undefined) {
        current.confidence = candidate.confidence;
      }
      continue;
    }
    grouped.set(key, {
      ...candidate,
      id: `${candidate.source}-${candidate.target}-${candidate.relation}`,
      evidence: [...candidate.evidence]
    });
  }

  return [...grouped.values()]
    .map((relationship) => ({ ...relationship, evidence: dedupeEvidence(relationship.evidence) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function compareRelationshipCandidate(left: ArchitectureRelationship, right: ArchitectureRelationship): number {
  const leftKey = `${left.source}\u0000${left.target}\u0000${left.relation}\u0000${left.description}`;
  const rightKey = `${right.source}\u0000${right.target}\u0000${right.relation}\u0000${right.description}`;
  return leftKey.localeCompare(rightKey);
}

function dedupeEvidence(evidence: ArchitectureEvidence[]): ArchitectureEvidence[] {
  const seen = new Set<string>();
  return [...evidence].sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right))).filter((item) => {
    const key = evidenceKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceKey(item: ArchitectureEvidence): string {
  return `${item.relationId ?? ""}:${JSON.stringify(item.range ?? null)}:${item.filePath ?? ""}:${item.symbol ?? ""}:${item.line ?? ""}:${item.detail}`;
}

function applyModuleIds(files: FileInsight[], modules: ArchitectureModule[]) {
  const moduleByFile = new Map<string, string>();
  modules.forEach((module) => module.files.forEach((file) => moduleByFile.set(file, module.id)));
  return files.map((file) => ({ ...file, moduleId: moduleByFile.get(file.path), role: file.role ?? fileRoleFromInsight(file, modules.find((module) => module.id === moduleByFile.get(file.path))?.category) }));
}

function architectureRelationFromSemantic(relation: SemanticRelation): GraphEdgeRelation | undefined {
  switch (relation.kind) {
    case "import":
    case "inherit":
      return "depends_on";
    case "call":
    case "render":
      return "calls";
    case "http":
      return relation.targetFile ? "calls" : relation.targetRef?.kind === "resource" ? "external_api" : undefined;
    case "database":
    case "filesystem":
      return relation.targetFile || relation.targetRef?.kind === "resource" ? "reads_writes" : undefined;
    case "test":
      return "tests";
    case "process":
      return relation.operation === "invoke" ? "calls" : undefined;
    case "event":
      return relation.operation === "publish" ? "publishes_event" : relation.operation === "subscribe" ? "subscribes_event" : undefined;
  }
}

function nodeTypeFromCategory(category: ArchitectureModuleCategory): GraphNodeType {
  const map: Record<ArchitectureModuleCategory, GraphNodeType> = {
    "api-boundary": "api",
    "domain-service": "service",
    "data-access": "data",
    "external-integration": "external",
    "job-worker": "worker",
    "shared-utility": "utility",
    "test-surface": "test",
    "unknown": "module"
  };
  return map[category];
}

function categoryLabel(category: ArchitectureModuleCategory) {
  const labels: Record<ArchitectureModuleCategory, string> = {
    "api-boundary": "API Boundary",
    "domain-service": "Domain Service",
    "data-access": "Data Access",
    "external-integration": "External Integration",
    "job-worker": "Job / Worker",
    "shared-utility": "Shared Utility",
    "test-surface": "Test Surface",
    "unknown": "Unknown"
  };
  return labels[category];
}

function fallbackRole(category: ArchitectureModuleCategory, files: FileInsight[]) {
  const scope = commonDirectory(files.map((file) => file.path));
  const prefix = scope ? `${scope} contains` : "This module contains";
  const descriptions: Record<ArchitectureModuleCategory, string> = {
    "api-boundary": `${prefix} request entry points and interface orchestration.`,
    "domain-service": `${prefix} business logic and application workflow code.`,
    "data-access": `${prefix} persistence, project data, and storage access code.`,
    "external-integration": `${prefix} code that connects FlowWeave to external runtimes or APIs.`,
    "job-worker": `${prefix} background analysis and generated artifact workflows.`,
    "shared-utility": `${prefix} shared utilities, UI helpers, configuration, and cross-cutting support.`,
    "test-surface": `${prefix} tests that verify behavior and protect regressions.`,
    "unknown": "These files could not be assigned to a functional module from the available static evidence."
  };
  return descriptions[category];
}

function fallbackModuleDescription(title: string, category: ArchitectureModuleCategory, files: FileInsight[]) {
  const scope = commonDirectory(files.map((file) => file.path));
  const fileCount = files.length;
  const symbolNames = files.flatMap((file) => file.symbols.map((symbol) => symbol.name)).slice(0, 4);
  const evidence = symbolNames.length > 0
    ? ` Key code signals include ${symbolNames.join(", ")}.`
    : "";
  const location = scope ? ` under ${scope}` : "";
  const descriptions: Record<ArchitectureModuleCategory, string> = {
    "api-boundary": `${title} handles project entry points and routes user or process requests into the rest of the system.`,
    "domain-service": `${title} owns the main application behavior and coordinates related code paths${location}.`,
    "data-access": `${title} manages persisted project data, artifact storage, or schema-oriented access paths${location}.`,
    "external-integration": `${title} isolates calls into external tools, runtimes, or service boundaries${location}.`,
    "job-worker": `${title} runs background analysis or generated-artifact workflows across ${fileCount} files${location}.`,
    "shared-utility": `${title} provides reusable support code used across FlowWeave features${location}.`,
    "test-surface": `${title} verifies expected behavior and regression coverage for the project${location}.`,
    "unknown": `${title} contains files whose functional responsibility is not clear from the available static evidence${location}.`
  };
  return `${descriptions[category]}${evidence}`;
}

function fallbackFileRoles(files: FileInsight[], category: ArchitectureModuleCategory) {
  const fileRoles = files.map((file) => ({ path: file.path, role: fileRoleFromInsight(file, category) }));
  const folderRoles = folderRolesFromFiles(files, category);
  return [...folderRoles, ...fileRoles];
}

function folderRolesFromFiles(files: FileInsight[], category: ArchitectureModuleCategory) {
  const byFolder = new Map<string, FileInsight[]>();
  for (const file of files) {
    for (const folder of folderPathsForFile(file.path)) {
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
    }
  }

  return [...byFolder.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(([path, folderFiles]) => ({
      path,
      role: folderRoleFromInsights(path, folderFiles, category)
    }));
}

function folderRoleFromInsights(path: string, files: FileInsight[], category: ArchitectureModuleCategory) {
  const folderName = path.split("/").at(-1) ?? path;
  const categoryName = categoryLabel(category).toLowerCase();
  if (/test|spec|__tests__/i.test(path)) return `Groups regression coverage for the ${categoryName}.`;
  if (/component|view|page|panel|workspace|node/i.test(path)) return `Groups UI components and interaction surfaces for the ${categoryName}.`;
  if (/service|domain|core|workflow|analysis|analyzer/i.test(path)) return `Groups service logic and workflow orchestration for the ${categoryName}.`;
  if (/store|storage|schema|database|repo|repository|data/i.test(path)) return `Groups storage and data handling code for the ${categoryName}.`;
  if (/agent|cli|ipc|adapter|bridge/i.test(path)) return `Groups agent, command, or process-boundary integration code for the ${categoryName}.`;
  if (/util|helper|shared|common|config/i.test(path)) return `Groups shared support utilities for the ${categoryName}.`;
  return `Groups ${files.length} related files in ${folderName} for the ${categoryName}.`;
}

function fileRoleFromInsight(file: FileInsight, category?: ArchitectureModuleCategory) {
  const fileName = file.path.split("/").at(-1) ?? file.path;
  const categoryName = category ? categoryLabel(category).toLowerCase() : "module";
  const symbolSummary = file.symbols.slice(0, 3).map((symbol) => symbol.name).join(", ");
  if (/test|spec|__tests__/i.test(file.path)) {
    return symbolSummary ? `Verifies ${symbolSummary} behavior for the ${categoryName}.` : `Provides regression coverage for the ${categoryName}.`;
  }
  if (file.externalCalls.length > 0) {
    return `Handles ${file.externalCalls[0].kind} integration work used by the ${categoryName}.`;
  }
  if (/config|vite|eslint|tsconfig|package/i.test(fileName)) {
    return `Configures build, runtime, or tooling behavior for the ${categoryName}.`;
  }
  if (/store|storage|schema|database|repo|repository/i.test(file.path)) {
    return `Manages persisted data shape or storage access for the ${categoryName}.`;
  }
  if (/component|workspace|panel|view|page|node/i.test(file.path)) {
    return `Implements user-facing interface behavior for the ${categoryName}.`;
  }
  if (/hook|use[A-Z]/.test(fileName)) {
    return `Coordinates stateful UI or workflow behavior for the ${categoryName}.`;
  }
  if (/adapter|agent|cli|ipc/i.test(file.path)) {
    return `Connects commands, agents, or process boundaries for the ${categoryName}.`;
  }
  if (symbolSummary) {
    return `Implements ${symbolSummary} responsibilities for the ${categoryName}.`;
  }
  return `Supports the ${categoryName} responsibility in this project.`;
}

function commonDirectory(files: string[]) {
  const folders = files.map((file) => file.split("/").filter(Boolean).slice(0, -1));
  if (folders.length === 0) return undefined;
  const common: string[] = [];
  const shortest = Math.min(...folders.map((parts) => parts.length));
  for (let index = 0; index < shortest; index += 1) {
    const part = folders[0][index];
    if (!folders.every((folder) => folder[index] === part)) break;
    common.push(part);
  }
  return common.length > 0 ? common.join("/") : undefined;
}

function evidenceFromInsight(file: FileInsight) {
  if (file.imports.length > 0) return `Imports: ${file.imports.slice(0, 5).join(", ")}`;
  if (file.externalCalls.length > 0) return `External calls: ${file.externalCalls.map((call) => call.target).slice(0, 5).join(", ")}`;
  if (file.symbols.length > 0) return `Symbols: ${file.symbols.map((symbol) => symbol.name).slice(0, 5).join(", ")}`;
  return "File path and language contributed to module classification.";
}

function folderPathsForFile(filePath: string) {
  const parts = filePath.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function assessArchitectureMap(
  architectureMap: ArchitectureMap,
  index: import("../../types").SemanticIndex,
  scanFingerprint: string
): ArchitectureMap {
  const graph = architectureMapToGraph(architectureMap);
  const assessedNodes = assessModules(graph.nodes, graph.edges, index, scanFingerprint, architectureMap.generatedAt);
  const assessedById = new Map(assessedNodes.map((node) => [node.id, node]));
  return {
    ...architectureMap,
    modules: architectureMap.modules.map((module) => {
      const assessed = assessedById.get(module.id);
      return assessed ? {
        ...module,
        risk: assessed.risk,
        confidence: undefined,
        assessment: assessed.assessment
      } : module;
    })
  };
}

export async function persistStaticArchitecture(
  project: CodeflowProject,
  staticArchitecture: StaticArchitectureBuild
): Promise<{
  architectureMap: ArchitectureMap;
  graph: { nodes: import("../../types").GraphNode[]; edges: import("../../types").GraphEdge[] };
  written: import("../storage/schemas").CodeflowWriteResult;
}> {
  if (!staticArchitecture.quality.valid) throw new Error(`Static architecture validation failed; previous artifacts were preserved: ${staticArchitecture.quality.reasons.join("; ")}`);
  // A previously prepared graph cannot commit independently of its source/index generation.
  const result = await generateProject(project.rootPath, {});
  if (result.status === "superseded") throw new GenerationSupersededError(project.rootPath, result.requestId, "a newer registered request");
  return { architectureMap: result.architectureMap, graph: result.graph, written: result.written };
}

export function isCurrentAgentArchitecture(value: unknown, localArchitecture: ArchitectureMap): value is ArchitectureMap {
  if (!value || typeof value !== "object") return false;
  const architecture = value as Partial<ArchitectureMap>;
  const metadata = architecture.metadata;
  return architecture.version === 3 &&
    architecture.source === "agent" &&
    Array.isArray(architecture.modules) &&
    Array.isArray(architecture.relationships) &&
    metadata?.source === "agent" &&
    metadata.scanFingerprint === localArchitecture.metadata?.scanFingerprint &&
    metadata.inputFingerprint === localArchitecture.metadata?.inputFingerprint &&
    typeof metadata.agentId === "string" && metadata.agentId.length > 0 &&
    typeof metadata.runId === "string" && metadata.runId.length > 0 &&
    typeof metadata.reviewId === "string" && metadata.reviewId.length > 0;
}

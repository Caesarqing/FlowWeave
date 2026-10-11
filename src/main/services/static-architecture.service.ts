import { createHash } from "node:crypto";
import type {
  ArchitectureEvidence, ArchitectureLayer, ArchitectureMap, ArchitectureModule,
  AnalysisScope, ArchitectureModuleCategory, ArchitectureRelationship, CodeflowProject, FileInsight,
  GraphEdge, GraphEdgeRelation, GraphNode, GraphNodeType, ProjectStructureFacts,
  SemanticIndex, SemanticRelation, TechnologyStack, ArchitectureGroup, ArchitectureGroupReference, ArchitectureRelationDiagnostic
} from "../../types";
import { readProjectProtocolSnapshot } from "../storage/flowweave-store";
import { assessModules } from "../../utils/module-assessment";
import { createArchitectureInputFingerprint } from "./architecture-review.service";
import { clusterArchitectureModules } from "./module-clustering.service";
import { moduleClusteringRelations, semanticIndexToStructureFacts } from "./semantic-index.service";
import { readCurrentProjectScanFingerprint } from "./project-scan-fingerprint.service";

const MODULE_CLUSTERING_CONFIG_VERSION = "7";
const ARCHITECTURE_GENERATOR_VERSION = "3.0.2";
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

export function deriveArchitectureGroups(
  modules: readonly ArchitectureModule[],
  facts: ProjectStructureFacts
): ArchitectureGroup[] {
  const scopes = facts.scopes ?? [];
  const moduleScopes = new Map<string, AnalysisScope | undefined>();
  const moduleLabels = new Map<string, string | undefined>();
  const moduleTitleSources = new Map<string, string[]>();
  const strongModuleLabels = new Set<string>();
  const moduleByFile = new Map<string, ArchitectureModule>();

  for (const module of modules) {
    for (const path of module.files) {
      const previous = moduleByFile.get(path);
      if (previous && previous.id !== module.id) throw new Error(`Source file ${path} belongs to multiple architecture modules.`);
      moduleByFile.set(path, module);
    }
    const moduleScope = scopeForModule(module, scopes);
    moduleScopes.set(module.id, moduleScope);
    const pathLabel = functionalDirectoryLabel(module, moduleScope);
    const exportedLabels = exportedResponsibilityLabels(module, facts);
    const filenameLabels = fileResponsibilityLabels(module);
    const label = pathLabel ?? (module.category === "api-boundary" && exportedLabels.size === 1
      ? [...exportedLabels][0]
      : uniqueLabel([...filenameLabels, ...exportedLabels]));
    moduleLabels.set(module.id, label);
    moduleTitleSources.set(module.id, label ? titleSourcesForLabel(module, facts, moduleScope, label, Boolean(pathLabel)) : []);
    if (pathLabel || (module.category === "api-boundary" && exportedLabels.size === 1)) {
      strongModuleLabels.add(`${scopeKey(moduleScope)}\u0000${label}\u0000${module.id}`);
    }
  }

  const confirmedNeighbors = confirmedModuleNeighbors(facts.relations ?? [], moduleByFile, moduleScopes);
  const areaForModule = new Map<string, { id: string; title: string; rootPath: string; parentId: string; titleSources: string[] }>();
  const byScopeAndLabel = new Map<string, ArchitectureModule[]>();
  for (const module of modules) {
    if (module.category === "shared-utility" || module.category === "test-surface" || module.category === "external-integration") continue;
    const label = moduleLabels.get(module.id);
    if (!label) continue;
    const key = `${scopeKey(moduleScopes.get(module.id))}\u0000${label}`;
    byScopeAndLabel.set(key, [...(byScopeAndLabel.get(key) ?? []), module]);
  }

  for (const [key, candidates] of byScopeAndLabel) {
    const [scopeId, label] = key.split("\u0000");
    const candidateIds = new Set(candidates.map((module) => module.id));
    const components = connectedCandidateComponents(candidates, candidateIds, confirmedNeighbors);
    for (const component of components) {
      const containsStrongEvidence = component.some((module) => strongModuleLabels.has(`${scopeId}\u0000${label}\u0000${module.id}`));
      if (!containsStrongEvidence && component.length < 2) continue;
      const first = component[0];
      if (!first) continue;
      const scope = moduleScopes.get(first.id);
      const structuralId = `group:function:${scopeId}:${label}`;
      const connectedId = `group:function:${scopeId}:${label}:${createHash("sha256").update(component.map((module) => module.id).sort().join("\u0000")).digest("hex").slice(0, 12)}`;
      const groupId = containsStrongEvidence ? structuralId : connectedId;
      for (const module of component) {
        areaForModule.set(module.id, {
          id: groupId,
          title: titleWords(label),
          rootPath: scope?.rootPath ?? "",
          parentId: packageGroupId(scope),
          titleSources: moduleTitleSources.get(module.id) ?? []
        });
      }
    }
  }

  for (const module of modules) {
    if (areaForModule.has(module.id)) continue;
    const scope = moduleScopes.get(module.id);
    const supportedAreas = new Set((facts.relations ?? []).flatMap((relation) => {
      if (relation.confidence !== "confirmed" || !relation.targetFile) return [];
      const target = moduleByFile.get(relation.targetFile);
      const source = moduleByFile.get(relation.sourceFile);
      if (target?.id !== module.id || !source) return [];
      const sourceArea = areaForModule.get(source.id);
      return sourceArea ? [sourceArea.id] : [];
    }));
    const title = module.category === "shared-utility"
      ? `${supportedAreas.size > 1 ? "Shared Infrastructure" : "Shared Support"} · ${module.title}`
      : module.category === "test-surface" ? `Test Surface · ${module.title}`
      : module.category === "external-integration" ? `External Integration · ${module.title}`
      : `Needs Review · ${module.title}`;
    const prefix = module.category === "shared-utility" ? (supportedAreas.size > 1 ? "infrastructure" : "support")
      : module.category === "test-surface" ? "tests"
      : module.category === "external-integration" ? "integration" : "review";
    areaForModule.set(module.id, {
      id: `group:${prefix}:${scopeKey(scope)}:${module.id}`,
      title,
      rootPath: scope?.rootPath ?? "",
      parentId: packageGroupId(scope),
      titleSources: [
        `category:${module.category}`,
        `module:${module.id}`,
        ...[...supportedAreas].sort().map((id) => `supported-area:${id}`)
      ]
    });
  }

  const groups = new Map<string, ArchitectureGroup>();
  for (const module of modules) {
    const scope = moduleScopes.get(module.id);
    const packageReference = packageGroupReference(scope, facts.projectName);
    const area = areaForModule.get(module.id);
    if (!area) throw new Error(`Architecture module ${module.id} has no derived area.`);
    addGroupMembership(groups, packageReference, module.id);
    addGroupMembership(groups, area, module.id);
  }
  return [...groups.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function readPreviousLocalModules(projectPath: string): Promise<ArchitectureModule[]> {
  const snapshot = await readProjectProtocolSnapshot(projectPath);
  return snapshot?.localArchitecture.modules ?? [];
}

export function architectureMapToGraph(architectureMap: ArchitectureMap): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = architectureMap.modules.map((module): GraphNode => ({
    id: module.id,
    identity: module.identity,
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
    areaId: module.groupPath?.at(-1)?.id ?? `area:${module.id}`,
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
  const allNodes = [...nodes, ...resourceNodes];
  const positions = new Map([...allNodes]
    .sort((left, right) => {
      const leftGroup = left.groupPath?.map((group) => group.id).join("/") ?? left.category ?? left.nodeType;
      const rightGroup = right.groupPath?.map((group) => group.id).join("/") ?? right.category ?? right.nodeType;
      return leftGroup.localeCompare(rightGroup) || left.id.localeCompare(right.id);
    })
    .map((node, index) => [node.id, { x: (index % 4) * 320, y: Math.floor(index / 4) * 190 }]));
  return { nodes: allNodes.map((node) => ({ ...node, ...positions.get(node.id) })), edges };
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
  const clustering = clusterArchitectureModules(facts.files, clusteringRelations, previousModules, facts.scopes ?? []);
  const ungroupedModules = clustering.modules.map((cluster): ArchitectureModule => {
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
      role: fallbackRole(files),
      description: fallbackModuleDescription(title, files),
      files: files.map((file) => file.path),
      fileRoles: fallbackFileRoles(files, category),
      symbols,
      evidence: files.slice(0, 5).map((file) => ({
        filePath: file.path,
        symbol: file.symbols[0]?.name,
        line: file.symbols[0]?.line,
        detail: evidenceFromInsight(file)
      })),
      risk: "unknown"
    };
  });

  const groups = deriveArchitectureGroups(ungroupedModules, facts);
  const modules = ungroupedModules.map((module) => ({
    ...module,
    groupPath: groupPathForModule(module.id, groups)
  }));
  const { relationships, diagnostics: relationDiagnostics } = buildArchitectureRelationships(modules, facts);
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

function titleWords(value: string): string { return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

const GENERIC_AREA_DIRECTORIES = new Set([
  "api", "apis", "app", "apps", "backend", "client", "clients", "common", "components", "config",
  "data", "database", "db", "domain", "domains", "external", "feature", "features", "frontend",
  "handler", "handlers", "infra", "infrastructure", "integration", "integrations", "main", "model",
  "models", "module", "modules", "package", "packages", "repository", "repositories", "route", "routes",
  "server", "service", "services", "shared", "src", "storage", "store", "stores", "test", "tests",
  "types", "util", "utils", "view", "views", "worker", "workers"
]);
const GENERIC_RESPONSIBILITY_TOKENS = new Set([
  ...GENERIC_AREA_DIRECTORIES, "adapter", "controller", "gateway", "hook", "ipc", "page", "panel", "repo",
  "router", "schema", "workspace", "create", "delete", "fetch", "find", "get", "handle", "load", "list",
  "parse", "read", "resolve", "update", "write"
]);

function scopeForModule(module: ArchitectureModule, scopes: AnalysisScope[]): AnalysisScope | undefined {
  const scopeByFile = module.files.flatMap((path) => {
    const scope = scopes.filter((candidate) => candidate.paths.includes(path))
      .sort((left, right) => right.rootPath.length - left.rootPath.length || left.id.localeCompare(right.id))[0];
    return scope ? [scope] : [];
  });
  const scopeIds = new Set(scopeByFile.map((scope) => scope.id));
  if (scopeIds.size > 1) throw new Error(`Architecture module ${module.id} crosses package scopes: ${[...scopeIds].sort().join(", ")}.`);
  const id = [...scopeIds][0];
  return scopes.find((scope) => scope.id === id);
}

function scopeKey(scope: AnalysisScope | undefined): string {
  return scope?.id ?? ".";
}

function packageGroupId(scope: AnalysisScope | undefined): string {
  return `group:package:${scopeKey(scope)}`;
}

function packageGroupReference(scope: AnalysisScope | undefined, projectName: string): ArchitectureGroupReference {
  const rootPath = scope?.rootPath ?? "";
  const rootName = rootPath.split("/").filter(Boolean).at(-1);
  return {
    id: packageGroupId(scope),
    title: scope?.packageName ?? rootName ?? projectName,
    rootPath,
    titleSources: scope ? [`package-scope:${scope.id}`, `package-root:${rootPath}`] : [`project:${projectName}`]
  };
}

function functionalDirectoryLabel(module: ArchitectureModule, scope: AnalysisScope | undefined): string | undefined {
  const labels = module.files.flatMap((path) => {
    const relativePath = relativeToScope(path, scope);
    const directories = relativePath.split("/").slice(0, -1);
    const label = directories.filter((segment) => !isGenericAreaDirectory(segment)).at(-1);
    return label ? [normalizeAreaLabel(label)] : [];
  });
  return mostCommonLabel(labels);
}

function relativeToScope(path: string, scope: AnalysisScope | undefined): string {
  const rootPath = scope?.rootPath.replace(/\/$/, "");
  return rootPath && (path === rootPath || path.startsWith(`${rootPath}/`)) ? path.slice(rootPath.length).replace(/^\//, "") : path;
}

function isGenericAreaDirectory(segment: string): boolean {
  const normalized = normalizeAreaLabel(segment);
  return GENERIC_AREA_DIRECTORIES.has(normalized) || /^v\d+$/.test(normalized);
}

function fileResponsibilityLabels(module: ArchitectureModule): Set<string> {
  return new Set(module.files.flatMap((path) => {
    const label = responsibilityLabel(path.split("/").at(-1) ?? path);
    return label ? [label] : [];
  }));
}

function exportedResponsibilityLabels(module: ArchitectureModule, facts: ProjectStructureFacts): Set<string> {
  const ownedFiles = new Set(module.files);
  const labels = facts.files.filter((file) => ownedFiles.has(file.path)).flatMap((file) => [
    ...file.symbols.filter((symbol) => symbol.exported).map((symbol) => responsibilityLabel(symbol.name)),
    ...file.exports.map((name) => responsibilityLabel(name))
  ]);
  return new Set(labels.filter((label): label is string => Boolean(label)));
}

function titleSourcesForLabel(
  module: ArchitectureModule,
  facts: ProjectStructureFacts,
  scope: AnalysisScope | undefined,
  label: string,
  fromDirectory: boolean
): string[] {
  if (fromDirectory) {
    return module.files.filter((path) => {
      const directories = relativeToScope(path, scope).split("/").slice(0, -1);
      const directory = directories.filter((segment) => !isGenericAreaDirectory(segment)).at(-1);
      return directory ? normalizeAreaLabel(directory) === label : false;
    }).map((path) => `directory:${path}`).sort();
  }
  const ownedFiles = new Set(module.files);
  const filenameSources = module.files.filter((path) =>
    responsibilityLabel(path.split("/").at(-1) ?? path) === label
  ).map((path) => `filename:${path}`);
  const exportedSources = facts.files.filter((file) => ownedFiles.has(file.path)).flatMap((file) => [
    ...file.symbols.filter((symbol) => symbol.exported && responsibilityLabel(symbol.name) === label)
      .map((symbol) => `symbol:${file.path}#${symbol.qualifiedName ?? symbol.name}`),
    ...file.exports.filter((name) => responsibilityLabel(name) === label).map((name) => `export:${file.path}#${name}`)
  ]);
  return [...new Set([...filenameSources, ...exportedSources])].sort();
}

function responsibilityLabel(value: string): string | undefined {
  const words = value.replace(/\.(d\.)?(tsx?|jsx?|mjs|cjs|py|java|go)$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !GENERIC_RESPONSIBILITY_TOKENS.has(word));
  const label = words.join("-");
  return label && !GENERIC_AREA_DIRECTORIES.has(label) ? label : undefined;
}

function normalizeAreaLabel(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function mostCommonLabel(labels: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function uniqueLabel(labels: string[]): string | undefined {
  const unique = [...new Set(labels)].sort();
  return unique.length === 1 ? unique[0] : undefined;
}

function confirmedModuleNeighbors(
  relations: SemanticRelation[],
  moduleByFile: Map<string, ArchitectureModule>,
  moduleScopes: Map<string, AnalysisScope | undefined>
): Map<string, Set<string>> {
  const neighbors = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (relation.confidence !== "confirmed" || !relation.targetFile) continue;
    const source = moduleByFile.get(relation.sourceFile);
    const target = moduleByFile.get(relation.targetFile);
    if (!source || !target || source.id === target.id || scopeKey(moduleScopes.get(source.id)) !== scopeKey(moduleScopes.get(target.id))) continue;
    neighbors.set(source.id, new Set([...(neighbors.get(source.id) ?? []), target.id]));
    neighbors.set(target.id, new Set([...(neighbors.get(target.id) ?? []), source.id]));
  }
  return neighbors;
}

function connectedCandidateComponents(
  candidates: ArchitectureModule[],
  candidateIds: Set<string>,
  neighbors: Map<string, Set<string>>
): ArchitectureModule[][] {
  const modulesById = new Map(candidates.map((module) => [module.id, module]));
  const remaining = new Set([...candidateIds].sort());
  const components: ArchitectureModule[][] = [];
  while (remaining.size > 0) {
    const start = [...remaining][0];
    if (!start) break;
    const pending = [start];
    const component: ArchitectureModule[] = [];
    remaining.delete(start);
    while (pending.length > 0) {
      const current = pending.shift();
      if (!current) continue;
      const module = modulesById.get(current);
      if (module) component.push(module);
      for (const neighbor of [...(neighbors.get(current) ?? [])].sort()) {
        if (!remaining.has(neighbor)) continue;
        remaining.delete(neighbor);
        pending.push(neighbor);
      }
    }
    components.push(component.sort((left, right) => left.id.localeCompare(right.id)));
  }
  return components;
}

function addGroupMembership(
  groups: Map<string, ArchitectureGroup>,
  reference: ArchitectureGroupReference,
  moduleId: string
): void {
  const previous = groups.get(reference.id);
  const moduleIds = [...new Set([...(previous?.moduleIds ?? []), moduleId])].sort();
  const titleSources = [...new Set([...(previous?.titleSources ?? []), ...(reference.titleSources ?? [])])].sort();
  groups.set(reference.id, { ...reference, titleSources, moduleIds });
}

function groupPathForModule(moduleId: string, groups: ArchitectureGroup[]): ArchitectureGroupReference[] {
  const area = groups.find((group) => group.parentId && group.moduleIds.includes(moduleId));
  if (!area?.parentId) throw new Error(`Architecture module ${moduleId} is missing its derived area.`);
  const packageGroup = groups.find((group) => group.id === area.parentId);
  if (!packageGroup) throw new Error(`Architecture area ${area.id} is missing its package scope.`);
  return [packageGroup, area].map(({ id, title, rootPath, parentId, titleSources }) => ({ id, title, rootPath, parentId, titleSources }));
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
    const key = `${candidate.source}:${candidate.target}:${candidate.relation}:${candidate.confidence ?? "unrated"}`;
    const current = grouped.get(key);
    if (current) {
      current.evidence.push(...candidate.evidence);
      current.semanticKinds = [...new Set([...(current.semanticKinds ?? []), ...(candidate.semanticKinds ?? [])])];
      current.operations = [...new Set([...(current.operations ?? []), ...(candidate.operations ?? [])])];
      current.importUsages = [...new Set([...(current.importUsages ?? []), ...(candidate.importUsages ?? [])])];
      current.sourceRelationIds = [...new Set([...(current.sourceRelationIds ?? []), ...(candidate.sourceRelationIds ?? [])])];
      continue;
    }
    grouped.set(key, {
      ...candidate,
      id: `${candidate.source}-${candidate.target}-${candidate.relation}-${candidate.confidence ?? "unrated"}`,
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
      return relation.targetFile ? "http_contract" : relation.targetRef?.kind === "resource" ? "external_api" : undefined;
    case "database":
    case "filesystem":
      if (!relation.targetFile && relation.targetRef?.kind !== "resource") return undefined;
      return relation.operation === "read" ? "reads" : relation.operation === "write" ? "writes" : undefined;
    case "test":
      return "tests";
    case "process":
      return relation.operation === "invoke" ? "process_invocation" : undefined;
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

function fallbackRole(files: FileInsight[]) {
  const names = files.flatMap((file) => file.symbols.map((symbol) => symbol.name)).slice(0, 3);
  return names.length > 0 ? `Declares ${names.join(", ")}.` : "Functional responsibility is not established by static evidence.";
}

function fallbackModuleDescription(title: string, files: FileInsight[]) {
  const scope = commonDirectory(files.map((file) => file.path));
  const fileCount = files.length;
  const symbolNames = files.flatMap((file) => file.symbols.map((symbol) => symbol.name)).slice(0, 4);
  return `${title} contains ${fileCount} source ${fileCount === 1 ? "file" : "files"}${scope ? ` under ${scope}` : ""}.` +
    (symbolNames.length > 0 ? ` Declared symbols include ${symbolNames.join(", ")}.` : "");
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

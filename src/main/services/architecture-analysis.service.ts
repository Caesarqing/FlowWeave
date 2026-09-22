import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArchitectureLayer,
  ArchitectureAnalysisResult,
  ArchitectureEvidence,
  AnalysisGenerationOptions,
  ArchitectureMap,
  ArchitectureModule,
  ArchitectureModuleCategory,
  ArchitectureRelationship,
  ArchitectureReviewResponse,
  CodeflowProject,
  FileInsight,
  GraphEdge,
  GraphEdgeRelation,
  GraphNode,
  GraphNodeType,
  ProjectStructureFacts,
  RuntimeAgentId,
  SemanticRelation,
  TechnologyStack,
  ToolRunResult,
} from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { startToolPlan } from "./agent-run.service";
import { registerProject } from "./project-registry.service";
import { buildSemanticIndex, moduleClusteringRelations, semanticIndexToStructureFacts } from "./semantic-index.service";
import { clusterArchitectureModules } from "./module-clustering.service";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { parseArchitectureReviewResponse } from "./structured-output.service";
import { assessModules } from "../../utils/module-assessment";
import {
  createArchitectureInputFingerprint,
  enhanceLocalArchitecture,
  startArchitectureReview,
  type ArchitectureReviewRunResult
} from "./architecture-review.service";
export { enhanceLocalArchitecture } from "./architecture-review.service";
import {
  buildArchitectureReviewPrompt,
  createArchitectureReviewPromptInput,
  type ArchitectureReviewPrompt
} from "./architecture-review-prompt.service";
import { waitForArtifactRunResponse } from "./artifact-review-wait.service";
import { readCurrentProjectScanFingerprint } from "./project-scan-fingerprint.service";

const MODULE_CLUSTERING_CONFIG_VERSION = "2";
const ARCHITECTURE_GENERATOR_VERSION = "1";
const ARCHITECTURE_REVIEW_CONTRACT_VERSION = "2";

export async function analyzeArchitecture(
  project: CodeflowProject,
  toolId: RuntimeAgentId,
  options?: AnalysisGenerationOptions
): Promise<ArchitectureAnalysisResult> {
  const result = await analyzeArchitectureOnce(project, toolId, options);
  if (result.outcome === "generated") return result;
  const previous = await readArchitectureMap(project.rootPath);
  return {
    ...result,
    previous: previous?.source === "agent" ? previous.metadata : undefined
  };
}

async function analyzeArchitectureOnce(
  project: CodeflowProject,
  toolId: RuntimeAgentId,
  options: AnalysisGenerationOptions | undefined
): Promise<ArchitectureAnalysisResult> {
  const { index } = await buildSemanticIndex(project, { onProgress: options?.onProgress });
  const facts = semanticIndexToStructureFacts(project, index);
  const clusteringRelations = moduleClusteringRelations(index);
  const previousModules = await readPreviousLocalModules(project.rootPath);
  const scanFingerprint = project.scanFingerprint ?? await readCurrentProjectScanFingerprint(project.rootPath);
  const inputFingerprint = buildArchitectureInputFingerprint(scanFingerprint, index);
  const localArchitectureBase = createLocalArchitectureMap(project, facts, "local", previousModules, clusteringRelations);
  const localQuality = validateArchitectureMap(localArchitectureBase, facts);
  const localArchitecture = assessArchitectureMap(
    withLocalArchitectureMetadata(localArchitectureBase, scanFingerprint, inputFingerprint, localQuality),
    index,
    inputFingerprint
  );
  const promptInput = createArchitectureReviewPromptInput(localArchitecture, index);
  options?.onProgress?.({
    stage: "analyzing",
    completed: 0,
    total: 1,
    failed: 0,
    message: "Generating the local module graph."
  });
  const projectId = options?.projectId ?? await registerProject(project.rootPath);
  const reviewId = options?.resumeArchitectureReview?.reviewId ?? `review-${randomUUID()}`;
  const run = async (onRunId: (runId: string) => Promise<void>): Promise<ArchitectureReviewRunResult> => {
    let prompt: ArchitectureReviewPrompt;
    try {
      prompt = buildArchitectureReviewPrompt(promptInput);
    } catch (error) {
      return reviewFailure(toolId, "agent-failed", formatError(error), undefined);
    }
    if (toolId === "mock") {
      await onRunId("mock");
      const parsed = parseArchitectureReviewResponse(mockArchitectureJson(prompt), prompt);
      return {
        outcome: "reviewed",
        runId: "mock",
        architectureMap: assessArchitectureMap(
          withArchitectureMetadata(
            enhanceLocalArchitecture(localArchitecture, parsed),
            toolId,
            "mock",
            scanFingerprint,
            inputFingerprint,
            reviewId,
            localQuality
          ),
          index,
          inputFingerprint
        )
      };
    }
    return runArchitectureReview(
      project,
      toolId,
      prompt,
      localArchitecture,
      localQuality,
      index,
      scanFingerprint,
      inputFingerprint,
      reviewId,
      onRunId,
      options?.resumeArchitectureReview?.runId
    );
  };
  const review = await startArchitectureReview({
    projectId,
    artifactTarget: "architecture-map",
    projectPath: project.rootPath,
    reviewId,
    scanFingerprint,
    inputFingerprint,
    agentId: toolId,
    localArchitecture,
    startedAt: localArchitecture.generatedAt,
    resume: Boolean(options?.resumeArchitectureReview),
    persistLocal: () => writeLocalArchitectureArtifacts(project.rootPath, localArchitecture),
    persist: (architectureMap) => writeArchitectureArtifacts(project.rootPath, architectureMap),
    toGraph: architectureMapToGraph,
    run,
    onAdoption: async (runId, outcome, message) => {
      const { updateRunArtifactAdoption } = await import("./run-log.service");
      await updateRunArtifactAdoption(project.rootPath, runId, {
        status: outcome === "applied" ? "applied" : outcome,
        message,
        appliedAt: outcome === "applied" ? new Date().toISOString() : undefined
      });
    },
    onEvent: options?.onArchitectureReview ?? (() => undefined)
  });
  return architectureMapToResult(localArchitecture, review);
}

export async function readArchitectureMap(projectPath: string): Promise<ArchitectureMap | undefined> {
  const architecturePath = join(projectPath, FLOWWEAVE_DIR, "architecture-map.json");
  const value = await readJsonArtifact(architecturePath);
  if (value === undefined) return undefined;
  const architectureMap = value as ArchitectureMap;
  if (architectureMap.version !== 2) {
    throw new Error(`FlowWeave architecture artifact must be v2. Regenerate it: ${architecturePath}`);
  }
  return architectureMap;
}

async function readPreviousLocalModules(projectPath: string): Promise<ArchitectureModule[]> {
  const artifactPath = join(projectPath, FLOWWEAVE_DIR, "architecture-local.json");
  const value = await readJsonArtifact(artifactPath);
  if (value === undefined) return [];
  if (
    typeof value !== "object" || value === null ||
    !("version" in value) || (value.version !== 1 && value.version !== 2) ||
    !("source" in value) || value.source !== "local" ||
    !("modules" in value) || !Array.isArray(value.modules)
  ) {
    throw new Error(`FlowWeave local architecture baseline is invalid: ${artifactPath}`);
  }
  return value.modules as ArchitectureModule[];
}

export function architectureMapToResult(
  architectureMap: ArchitectureMap,
  review: import("../../types").ArchitectureReviewStatus,
  runId?: string
): ArchitectureAnalysisResult {
  return {
    outcome: "generated",
    localGenerationStatus: "local-ready",
    architectureMap,
    graph: architectureMapToGraph(architectureMap),
    presentationPhase: architectureMap.source === "local" ? "local-static" : "reviewed",
    review,
    runId
  };
}

async function writeLocalArchitectureArtifacts(projectPath: string, architectureMap: ArchitectureMap): Promise<void> {
  const root = join(projectPath, FLOWWEAVE_DIR);
  await writeJsonAtomic(join(root, "architecture-local.json"), architectureMap);
  await writeArchitectureArtifacts(projectPath, architectureMap);
}

async function runArchitectureReview(
  project: CodeflowProject,
  toolId: RuntimeAgentId,
  prompt: ArchitectureReviewPrompt,
  localArchitecture: ArchitectureMap,
  localQuality: { fileCoverage: number; evidenceCoverage: number },
  index: import("../../types").SemanticIndex,
  scanFingerprint: string,
  inputFingerprint: string,
  reviewId: string,
  onRunId: (runId: string) => Promise<void>,
  resumeRunId: string | undefined
): Promise<ArchitectureReviewRunResult> {
  try {
    const projectId = await registerProject(project.rootPath);
    const firstStarted = resumeRunId
      ? await readArchitectureRun(project.rootPath, resumeRunId, toolId)
      : await startToolPlan({
          projectId,
          toolId,
          prompt: prompt.text,
          executionMode: "plan",
          purpose: "artifact-analysis",
          artifactTarget: "architecture-map",
          scanFingerprint,
          inputFingerprint,
          reviewId
        });
    await onRunId(firstStarted.id);
    const firstRun = await waitForArchitectureRun(project.rootPath, firstStarted);
    if (firstRun.status !== "completed") {
      return reviewFailure(toolId, "agent-failed", firstRun.failure?.message ?? firstRun.summary ?? "Agent review did not complete.", firstRun.id);
    }
    const firstOutput = firstRun.outputText ?? collectStdout(firstRun.events);
    let response: ArchitectureReviewResponse;
    try {
      response = parseArchitectureReviewResponse(firstOutput, prompt);
    } catch (error) {
      return reviewFailure(toolId, "invalid-output", formatError(error), firstRun.id);
    }

    const architectureMap = assessArchitectureMap(
      withArchitectureMetadata(
        enhanceLocalArchitecture(localArchitecture, response),
        toolId,
        firstRun.id,
        scanFingerprint,
        inputFingerprint,
        reviewId,
        localQuality
      ),
      index,
      inputFingerprint
    );
    return {
      outcome: "reviewed",
      architectureMap,
      runId: firstRun.id,
      stateRecovered: firstRun.artifactAdoption?.stateRecovered,
      warning: firstRun.artifactAdoption?.warning
    };
  } catch (error) {
    return reviewFailure(toolId, "agent-failed", formatError(error), undefined);
  }
}

async function readArchitectureRun(
  projectPath: string,
  runId: string,
  toolId: RuntimeAgentId
): Promise<ToolRunResult> {
  const { readRunArtifact } = await import("./run-log.service");
  const artifact = await readRunArtifact(projectPath, runId);
  return {
    id: artifact.summary.id,
    toolId,
    status: artifact.summary.status,
    projectPath,
    startedAt: artifact.summary.startedAt,
    completedAt: artifact.summary.completedAt,
    summary: artifact.summary.summary,
    outputText: artifact.plan,
    failure: artifact.summary.failure,
    events: [],
    executionMode: "plan",
    purpose: "artifact-analysis"
  };
}

export function architectureMapToGraph(architectureMap: ArchitectureMap): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = architectureMap.modules.map((module, index): GraphNode => ({
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
    x: xForCategory(module.category) + (index % 2) * 34,
    y: yForCategory(module.category, index),
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
    guidanceNote: relationship.description,
    evidence: relationship.evidence
  }));
  return { nodes, edges };
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

export async function writeArchitectureArtifacts(projectPath: string, architectureMap: ArchitectureMap) {
  const root = join(projectPath, FLOWWEAVE_DIR);
  await writeJsonAtomic(join(root, "architecture-map.json"), architectureMap);
  await Promise.all([
    rm(join(root, "file-insights.json"), { force: true }),
    rm(join(root, "module-map.json"), { force: true })
  ]);
}

export function buildArchitectureInputFingerprint(
  scanFingerprint: string,
  index: import("../../types").SemanticIndex
): string {
  return createArchitectureInputFingerprint({
    scanFingerprint,
    semanticIndexSchemaVersion: index.version,
    semanticIndexGeneratorVersion: index.generatorVersion,
    moduleClusteringConfigVersion: MODULE_CLUSTERING_CONFIG_VERSION,
    architectureGeneratorVersion: ARCHITECTURE_GENERATOR_VERSION,
    reviewContractVersion: ARCHITECTURE_REVIEW_CONTRACT_VERSION
  });
}

async function waitForArchitectureRun(
  projectPath: string,
  initial: ToolRunResult
): Promise<ToolRunResult> {
  return waitForArtifactRunResponse(projectPath, initial, {
    pollIntervalMs: 1_000
  });
}

function reviewFailure(
  _agentId: RuntimeAgentId,
  code: "agent-failed" | "invalid-output" | "quality-rejected" | "persistence-failed",
  message: string,
  runId: string | undefined
): ArchitectureReviewRunResult {
  return {
    outcome: "failed",
    runId,
    error: { code, message }
  };
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
  const moduleIds = new Set(architectureMap.modules.map((module) => module.id));
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
  if (fileCoverage < 0.3) reasons.push(`Representative file coverage ${fileCoverage.toFixed(2)} is below 0.30.`);
  if (evidenceCoverage < 0.7) reasons.push(`Evidence coverage ${evidenceCoverage.toFixed(2)} is below 0.70.`);
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], fileCoverage, evidenceCoverage };
}

export function withArchitectureMetadata(
  architectureMap: ArchitectureMap,
  agentId: RuntimeAgentId,
  runId: string,
  scanFingerprint: string,
  inputFingerprint: string,
  reviewId: string,
  quality: { fileCoverage: number; evidenceCoverage: number }
): ArchitectureMap {
  const generatedAt = new Date().toISOString();
  return {
    ...architectureMap,
    version: 2,
    source: "agent",
    generatedAt,
    metadata: {
      source: "agent",
      agentId,
      runId,
      reviewId,
      generatedAt,
      scanFingerprint,
      inputFingerprint,
      fileCoverage: quality.fileCoverage,
      evidenceCoverage: quality.evidenceCoverage
    }
  };
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
    version: 2,
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

function collectStdout(events: Array<{ type: string; content?: string }>) {
  return events.filter((event) => event.type === "stdout").map((event) => event.content ?? "").join("\n");
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createLocalArchitectureMap(
  project: CodeflowProject,
  facts: ProjectStructureFacts,
  source: ArchitectureMap["source"],
  previousModules: ArchitectureModule[],
  clusteringRelations: SemanticRelation[]
): ArchitectureMap {
  const clustering = clusterArchitectureModules(facts.files, clusteringRelations, previousModules);
  const modules = clustering.modules.map((cluster): ArchitectureModule => {
    const files = facts.files.filter((file) => cluster.files.includes(file.path));
    const { id, identity, title, category } = cluster;
    const symbols = files.flatMap((file) => file.symbols.slice(0, 12));
    return {
      id,
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
      risk: "unknown"
    };
  });

  const relationships = inferFallbackRelationships(modules, facts);
  return {
    version: 1,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt: new Date().toISOString(),
    source,
    architectureStyle: "inferred functional architecture",
    modules,
    moduleDiagnostics: clustering.diagnostics,
    relationships,
    files: applyModuleIds(facts.files, modules),
    symbols: modules.flatMap((module) => module.symbols)
  };
}

function inferFallbackRelationships(modules: ArchitectureModule[], facts: ProjectStructureFacts) {
  const moduleByFile = new Map<string, string>();
  modules.forEach((module) => module.files.forEach((file) => moduleByFile.set(file, module.id)));
  const relationships: ArchitectureRelationship[] = [];
  const seen = new Set<string>();

  for (const file of facts.files) {
    const source = moduleByFile.get(file.path);
    if (!source) continue;
    for (const specifier of file.imports) {
      const targetFile = resolveImportBySuffix(specifier, moduleByFile);
      const target = targetFile ? moduleByFile.get(targetFile) : undefined;
      if (!target || target === source) continue;
      const relation = relationForModules(modules, target);
      const key = `${source}:${target}:${relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relationships.push({
        id: `${source}-${target}-${relation}`,
        source,
        target,
        relation,
        description: `${file.path} imports ${specifier}`,
        evidence: [{ filePath: file.path, detail: `Import reference: ${specifier}` }]
      });
    }

    if (file.externalCalls.length > 0) {
      const external = modules.find((module) => module.category === "external-integration");
      if (external && external.id !== source) {
        const key = `${source}:${external.id}:external_api`;
        if (!seen.has(key)) {
          seen.add(key);
          relationships.push({
            id: `${source}-${external.id}-external-api`,
            source,
            target: external.id,
            relation: "external_api",
            description: `${file.path} performs external calls`,
            evidence: file.externalCalls.slice(0, 3).map((call) => ({ filePath: file.path, symbol: call.symbol, detail: `${call.kind}: ${call.target}` }))
          });
        }
      }
    }
  }

  return aggregateArchitectureRelationships(modules, facts, relationships);
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
    if (!semanticRelation.sourceFile || !semanticRelation.targetFile) continue;
    const source = moduleByFile.get(semanticRelation.sourceFile);
    const target = moduleByFile.get(semanticRelation.targetFile);
    if (!source || !target || source === target) continue;
    const relation = architectureRelationFromSemantic(semanticRelation.kind);
    allCandidates.push({
      id: `${source}-${target}-${relation}-${semanticRelation.id}`,
      source,
      target,
      relation,
      description: semanticRelation.detail,
      evidence: [{
        filePath: semanticRelation.sourceFile,
        symbol: semanticRelation.symbol,
        line: semanticRelation.symbol
          ? lineByFileAndSymbol.get(`${semanticRelation.sourceFile}\u0000${semanticRelation.symbol}`)
          : undefined,
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
  return `${item.filePath ?? ""}:${item.symbol ?? ""}:${item.line ?? ""}:${item.detail}`;
}

function mockArchitectureJson(prompt: ArchitectureReviewPrompt) {
  return JSON.stringify(
    {
      modules: prompt.modules.map((module) => ({
        moduleId: module.id,
        title: module.title,
        role: module.role,
        description: module.description
      })),
      findings: []
    },
    null,
    2
  );
}

function applyModuleIds(files: FileInsight[], modules: ArchitectureModule[]) {
  const moduleByFile = new Map<string, string>();
  modules.forEach((module) => module.files.forEach((file) => moduleByFile.set(file, module.id)));
  return files.map((file) => ({ ...file, moduleId: moduleByFile.get(file.path), role: file.role ?? fileRoleFromInsight(file, modules.find((module) => module.id === moduleByFile.get(file.path))?.category) }));
}

function architectureRelationFromSemantic(kind: import("../../types").SemanticRelation["kind"]): GraphEdgeRelation {
  if (kind === "database" || kind === "filesystem") return "reads_writes";
  if (kind === "event") return "publishes_event";
  if (kind === "test") return "tests";
  return "calls";
}

function relationForModules(modules: ArchitectureModule[], target: string): GraphEdgeRelation {
  const targetModule = modules.find((module) => module.id === target);
  if (targetModule?.category === "data-access") return "reads_writes";
  if (targetModule?.category === "external-integration") return "external_api";
  if (targetModule?.category === "test-surface") return "tests";
  return "depends_on";
}

function resolveImportBySuffix(specifier: string, moduleByFile: Map<string, string>) {
  const normalized = specifier.replace(/^\.\.?\//, "").replace(/\.(ts|tsx|js|jsx|py|go|java|rs|php|cs)$/i, "");
  return [...moduleByFile.keys()].find((file) => file.includes(normalized) || file.replace(/\.(ts|tsx|js|jsx|py|go|java|rs|php|cs)$/i, "").endsWith(normalized));
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

function xForCategory(category: ArchitectureModuleCategory) {
  if (category === "api-boundary") return 80;
  if (category === "domain-service") return 400;
  if (category === "data-access" || category === "external-integration") return 720;
  return 1040;
}

function yForCategory(category: ArchitectureModuleCategory, index: number) {
  const base = category === "test-surface" || category === "shared-utility" ? 470 : 110;
  return base + Math.floor(index / 2) * 170;
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

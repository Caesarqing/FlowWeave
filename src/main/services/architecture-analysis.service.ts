import { randomUUID } from "node:crypto";
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
  CodeflowProject,
  FileInsight,
  GraphEdge,
  GraphEdgeRelation,
  GraphNode,
  GraphNodeType,
  ModuleMap,
  ProjectMap,
  ProjectStructureFacts,
  RuntimeAgentId,
  StructureSymbol,
  TechnologyStack,
  ToolRunResult,
} from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { startToolPlan } from "./agent-run.service";
import { registerProject } from "./project-registry.service";
import { selectRepresentativeStructureFacts } from "./structure-extractor.service";
import { buildSemanticIndex, semanticIndexToStructureFacts } from "./semantic-index.service";
import { FlowWeaveError, throwIfAborted } from "./flowweave-error.service";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { extractStructuredJson } from "./structured-output.service";
import { assessModules, unknownAssessment } from "../../utils/module-assessment";
import {
  startArchitectureReview,
  writeArchitectureReviewStatus,
  type ArchitectureReviewRunResult
} from "./architecture-review.service";
import { waitForArtifactRunResponse } from "./artifact-review-wait.service";
import { readCurrentProjectScanFingerprint } from "./project-scan-fingerprint.service";

const MAX_PROMPT_FILES = 80;
const MAX_PROMPT_SYMBOLS_PER_FILE = 8;
const REPRESENTATIVE_FILE_LIMIT = 40;
const architectureFlights = new Map<string, Promise<ArchitectureAnalysisResult>>();

export async function analyzeArchitecture(
  project: CodeflowProject,
  toolId: RuntimeAgentId,
  options?: AnalysisGenerationOptions
): Promise<ArchitectureAnalysisResult> {
  if (options?.signal) return analyzeArchitectureOnce(project, toolId, options);
  const flightKey = `${project.rootPath}:${toolId}`;
  const existing = architectureFlights.get(flightKey);
  if (existing) return existing;
  const flight = analyzeArchitectureOnce(project, toolId, options)
    .then(async (result) => {
      if (result.outcome === "generated") return result;
      const previous = await readArchitectureMap(project.rootPath);
      return {
        ...result,
        previous: previous?.source === "agent" ? previous.metadata : undefined
      };
    })
    .finally(() => architectureFlights.delete(flightKey));
  architectureFlights.set(flightKey, flight);
  return flight;
}

async function analyzeArchitectureOnce(
  project: CodeflowProject,
  toolId: RuntimeAgentId,
  options: AnalysisGenerationOptions | undefined
): Promise<ArchitectureAnalysisResult> {
  const { index } = await buildSemanticIndex(project, {
    signal: options?.signal,
    onProgress: options?.onProgress
  });
  throwIfAborted(options?.signal, "Architecture analysis");
  const facts = semanticIndexToStructureFacts(project, index);
  const representativeFacts = { ...facts, files: selectRepresentativeStructureFacts(facts, REPRESENTATIVE_FILE_LIMIT) };
  const inputFingerprint = await readCurrentProjectScanFingerprint(project.rootPath);
  const prompt = buildArchitecturePrompt(representativeFacts);
  const localArchitectureBase = createLocalArchitectureMap(project, facts, "local");
  const localQuality = validateArchitectureMap(localArchitectureBase, facts);
  const localArchitecture = assessArchitectureMap(
    withLocalArchitectureMetadata(localArchitectureBase, inputFingerprint, localQuality),
    index,
    inputFingerprint
  );
  options?.onProgress?.({
    stage: "analyzing",
    completed: 0,
    total: 1,
    failed: 0,
    message: `Analyzing architecture with ${toolId}.`
  });

  if (toolId === "mock") {
    const agentOutput = mockArchitectureJson(localArchitecture);
    const parsed = parseArchitectureJson(agentOutput, project, facts);
    if (!parsed) return failedArchitectureResult(toolId, "invalid-output", "Mock agent returned invalid architecture JSON.", []);
    const quality = validateArchitectureMap(parsed, facts);
    if (!quality.valid) return failedArchitectureResult(toolId, "quality-rejected", quality.reasons.join("; "), []);
    const architectureMap = assessArchitectureMap(
      withArchitectureMetadata(enhanceLocalArchitecture(localArchitecture, parsed), toolId, "mock", inputFingerprint, quality),
      index,
      inputFingerprint
    );
    throwIfAborted(options?.signal, "Architecture analysis");
    await writeArchitectureArtifacts(project.rootPath, architectureMap);
    const review = {
      state: "reviewed",
      reviewId: `review-${randomUUID()}`,
      scanFingerprint: inputFingerprint,
      agentId: toolId,
      runId: "mock",
      completedAt: architectureMap.generatedAt
    } as const;
    await writeArchitectureReviewStatus(project.rootPath, review);
    return architectureMapToResult(architectureMap, review, "mock");
  }

  throwIfAborted(options?.signal, "Architecture analysis");
  await writeLocalArchitectureArtifacts(project.rootPath, localArchitecture);
  const projectId = options?.projectId ?? await registerProject(project.rootPath);
  const reviewId = options?.resumeArchitectureReview?.reviewId ?? `review-${randomUUID()}`;
  const review = await startArchitectureReview({
    projectId,
    projectPath: project.rootPath,
    reviewId,
    scanFingerprint: inputFingerprint,
    agentId: toolId,
    localArchitecture,
    startedAt: localArchitecture.generatedAt,
    persist: (architectureMap) => writeArchitectureArtifacts(project.rootPath, architectureMap),
    toGraph: architectureMapToGraph,
    run: (onRunId) => runArchitectureReview(
      project,
      toolId,
      prompt,
      facts,
      representativeFacts,
      localArchitecture,
      index,
      inputFingerprint,
      reviewId,
      onRunId,
      options?.resumeArchitectureReview?.runId,
      options?.planTimeoutMs,
      options?.signal
    ),
    onEvent: options?.onArchitectureReview ?? (() => undefined)
  });
  return architectureMapToResult(localArchitecture, review);
}

export async function readArchitectureMap(projectPath: string): Promise<ArchitectureMap | undefined> {
  const architecturePath = join(projectPath, FLOWWEAVE_DIR, "architecture-map.json");
  const value = await readJsonArtifact(architecturePath);
  if (value === undefined) return undefined;
  if (!isArchitectureMap(value)) {
    throw new Error(`FlowWeave architecture artifact is invalid and was preserved: ${architecturePath}`);
  }
  return migrateLegacyArchitectureSource(migrateArchitectureAssessments(value));
}

export function buildArchitecturePrompt(facts: ProjectStructureFacts) {
  return `You are FlowWeave's architecture analyst. Return only JSON.

Goal:
Create a functional architecture module map for a visual Canvas that helps a user understand the real code structure and workflow of this project. Nodes must represent feature/architecture modules, not individual files or folders.

Project: ${facts.projectName}
Languages: ${JSON.stringify(facts.languages)}

ProjectStructureFacts:
${JSON.stringify(compactFactsForPrompt(facts), null, 2)}

Analysis priorities:
- Use only the supplied ProjectStructureFacts. Do not invent files, symbols, calls, endpoints, databases, queues, or third-party systems.
- Explain the project as a human-readable explanation for someone trying to understand how the code works.
- Identify real entry points, core business/domain modules, data access, external integrations, background workers, shared utilities, and test surfaces from paths, imports, exports, symbols, calls, and externalCalls.
- Describe the practical workflow: how a request, job, event, or command enters the system, which modules process it, where state is read or written, and where external systems are touched.
- Prefer concrete code evidence over broad guesses. When evidence is partial, say that the detail is inferred from imports, calls, externalCalls, symbols, or file roles.

Return this exact JSON shape:
{
  "architectureStyle": "short architecture style, e.g. layered service, desktop app, MVC, event-driven",
  "modules": [{
    "id": "stable-kebab-id",
    "title": "Human module title",
    "category": "api-boundary|domain-service|data-access|external-integration|job-worker|shared-utility|test-surface",
    "role": "one sentence role",
    "description": "one concise paragraph that explains this module's function and purpose in the project",
    "files": ["path"],
    "fileRoles": [{"path": "path", "role": "short purpose for this file or folder"}],
    "symbols": [{"name": "symbol", "kind": "function|class|method|export|variable", "filePath": "path", "role": "why it matters"}],
    "evidence": [{"filePath": "path", "symbol": "optional", "detail": "import/function/call evidence"}],
    "assessmentNotes": "optional explanation of uncertainty or change impact; FlowWeave calculates final risk and confidence locally"
  }],
  "relationships": [{
    "source": "module-id",
    "target": "module-id",
    "relation": "depends_on|calls|reads_writes|external_api|publishes_event|subscribes_event|tests",
    "description": "how these modules connect",
    "evidence": [{"filePath": "path", "symbol": "optional", "detail": "specific connection evidence"}]
  }]
}

Rules:
- Prefer 5-12 functional architecture modules for medium projects.
- Merge files by responsibility: API boundaries, domain services, data access, external integrations, workers, utilities, tests.
- Do not create one node per file.
- Every module must include concrete files and at least one evidence item when possible.
- For fileRoles, include short explanations for important folders and files. Folder paths such as "src/services" are allowed when several files share a responsibility.
- File and folder roles must describe functional purpose, such as request handling, orchestration, validation, persistence, integration, configuration, or tests. Do not only list symbols.
- For symbols, choose key functions, classes, methods, or exports that explain how the module works; include a role that tells the user why the symbol matters.
- Every relationship must explain how modules connect using imports, calls, symbols, or external call hints.
- Relationship descriptions should describe real workflow collaboration, e.g. API boundary calls domain service, service reads/writes data access, service calls external integration, worker consumes queue work, or tests cover a target module.
- Use only relation and category enum values shown above.`;
}

export function parseArchitectureJson(output: string, project: CodeflowProject, facts: ProjectStructureFacts): ArchitectureMap | undefined {
  const extracted = extractStructuredJson(output, "modules");
  if (!("value" in extracted)) return undefined;
  try {
    const parsed = extracted.value as Partial<ArchitectureMap>;
    if (!Array.isArray(parsed.modules) || parsed.modules.length === 0) return undefined;
    const fileSet = new Set(facts.files.map((file) => file.path));
    const modules = parsed.modules.map((module, index) => normalizeModule(module, facts, fileSet, index)).filter((module): module is ArchitectureModule => Boolean(module));
    if (modules.length === 0) return undefined;
    const relationships = inferFallbackRelationships(modules, facts);

    return {
      version: 1,
      projectName: project.projectName,
      rootPath: project.rootPath,
      generatedAt: new Date().toISOString(),
      source: "agent",
      architectureStyle: stringOrUndefined(parsed.architectureStyle),
      modules,
      relationships,
      files: applyModuleIds(facts.files, modules),
      symbols: modules.flatMap((module) => module.symbols)
    };
  } catch {
    return undefined;
  }
}

export function architectureMapToResult(
  architectureMap: ArchitectureMap,
  review: import("../../types").ArchitectureReviewStatus,
  runId?: string
): ArchitectureAnalysisResult {
  return {
    outcome: "generated",
    architectureMap,
    graph: architectureMapToGraph(architectureMap),
    review,
    runId
  };
}

async function writeLocalArchitectureArtifacts(projectPath: string, architectureMap: ArchitectureMap): Promise<void> {
  const previous = await readArchitectureMap(projectPath);
  if (previous?.source === "agent") return;
  await writeArchitectureArtifacts(projectPath, architectureMap);
}

async function runArchitectureReview(
  project: CodeflowProject,
  toolId: RuntimeAgentId,
  prompt: string,
  facts: ProjectStructureFacts,
  representativeFacts: ProjectStructureFacts,
  localArchitecture: ArchitectureMap,
  index: import("../../types").SemanticIndex,
  inputFingerprint: string,
  reviewId: string,
  onRunId: (runId: string) => Promise<void>,
  resumeRunId: string | undefined,
  planTimeoutMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<ArchitectureReviewRunResult> {
  try {
    const projectId = await registerProject(project.rootPath);
    const firstStarted = resumeRunId
      ? await readArchitectureRun(project.rootPath, resumeRunId, toolId)
      : await startToolPlan({
          projectId,
          toolId,
          prompt,
          executionMode: "plan",
          purpose: "artifact-analysis",
          artifactTarget: "architecture-map",
          scanFingerprint: inputFingerprint,
          reviewId,
          planTimeoutMs
        });
    await onRunId(firstStarted.id);
    const firstRun = await waitForArchitectureRun(project.rootPath, firstStarted, toolId, reviewId, inputFingerprint, planTimeoutMs, signal);
    if (firstRun.status !== "completed") {
      return reviewFailure(toolId, "agent-failed", firstRun.failure?.message ?? firstRun.summary ?? "Agent review did not complete.", firstRun.id);
    }
    const firstOutput = firstRun.outputText ?? collectStdout(firstRun.events);
    const firstParsed = parseArchitectureJson(firstOutput, project, facts);
    const firstQuality = firstParsed ? validateArchitectureMap(firstParsed, representativeFacts) : undefined;
    if (firstParsed && firstQuality?.valid) {
      const architectureMap = assessArchitectureMap(
        withArchitectureMetadata(enhanceLocalArchitecture(localArchitecture, firstParsed), toolId, firstRun.id, inputFingerprint, firstQuality),
        index,
        inputFingerprint
      );
      if (!await architectureInputIsCurrent(project.rootPath, inputFingerprint)) {
        return reviewFailure(toolId, "agent-failed", "Project scan changed before the Agent review completed.", firstRun.id);
      }
      const { updateRunArtifactAdoption } = await import("./run-log.service");
      await updateRunArtifactAdoption(project.rootPath, firstRun.id, {
        status: "applied",
        message: "Run completed and applied to module graph.",
        appliedAt: architectureMap.generatedAt
      });
      return { outcome: "reviewed", architectureMap, runId: firstRun.id };
    }

    const firstFailure = firstParsed
      ? firstQuality?.reasons.join("; ") ?? "Architecture quality validation failed."
      : "Agent returned invalid architecture JSON.";
    const retryStarted = await startToolPlan({
      projectId,
      toolId,
      prompt: buildArchitectureRepairPrompt(prompt, firstOutput, firstFailure),
      executionMode: "plan",
      purpose: "artifact-analysis",
      artifactTarget: "architecture-map",
      scanFingerprint: inputFingerprint,
      reviewId,
      planTimeoutMs
    });
    await onRunId(retryStarted.id);
    const retry = await waitForArchitectureRun(project.rootPath, retryStarted, toolId, reviewId, inputFingerprint, planTimeoutMs, signal);
    if (retry.status !== "completed") {
      return reviewFailure(toolId, "agent-failed", retry.failure?.message ?? retry.summary ?? "Agent repair review did not complete.", retry.id);
    }
    const retryOutput = retry.outputText ?? collectStdout(retry.events);
    const retryParsed = parseArchitectureJson(retryOutput, project, facts);
    const retryQuality = retryParsed ? validateArchitectureMap(retryParsed, representativeFacts) : undefined;
    if (!retryParsed) {
      return reviewFailure(toolId, "invalid-output", "Agent returned invalid architecture JSON after one repair attempt.", retry.id);
    }
    if (!retryQuality?.valid) {
      return reviewFailure(toolId, "quality-rejected", retryQuality?.reasons.join("; ") ?? "Architecture quality validation failed.", retry.id);
    }
    const architectureMap = assessArchitectureMap(
      withArchitectureMetadata(enhanceLocalArchitecture(localArchitecture, retryParsed), toolId, retry.id, inputFingerprint, retryQuality),
      index,
      inputFingerprint
    );
    if (!await architectureInputIsCurrent(project.rootPath, inputFingerprint)) {
      return reviewFailure(toolId, "agent-failed", "Project scan changed before the Agent review completed.", retry.id);
    }
    const { updateRunArtifactAdoption } = await import("./run-log.service");
    await updateRunArtifactAdoption(project.rootPath, retry.id, {
      status: "applied",
      message: "Run completed and applied to module graph.",
      appliedAt: architectureMap.generatedAt
    });
    return { outcome: "reviewed", architectureMap, runId: retry.id };
  } catch (error) {
    if (error instanceof FlowWeaveError && error.category === "canceled") {
      return reviewFailure(toolId, "agent-failed", error.message, undefined);
    }
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

export function architectureMapToProjectMap(map: ArchitectureMap): ProjectMap {
  return {
    language: Object.entries(languageCounts(map.files)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown",
    framework: map.architectureStyle,
    entryFiles: map.modules.filter((module) => module.category === "api-boundary").flatMap((module) => module.files).slice(0, 8),
    directories: map.modules.map((module) => ({
      path: module.files[0] ?? module.id,
      purpose: module.role
    }))
  };
}

export function architectureMapToModuleMap(map: ArchitectureMap): ModuleMap {
  return {
    modules: map.modules.map((module) => ({
      id: module.id,
      title: module.title,
      description: module.description,
      files: module.files,
      dependencies: map.relationships
        .filter((relationship) => relationship.source === module.id)
        .map((relationship) => ({ target: relationship.target, relation: relationship.relation })),
      risk: module.risk
    }))
  };
}

export async function writeArchitectureArtifacts(projectPath: string, architectureMap: ArchitectureMap) {
  const root = join(projectPath, FLOWWEAVE_DIR);
  await Promise.all([
    writeJsonAtomic(join(root, "architecture-map.json"), architectureMap),
    writeJsonAtomic(join(root, "file-insights.json"), architectureMap.files),
    writeJsonAtomic(join(root, "module-map.json"), architectureMapToModuleMap(architectureMap))
  ]);
}

async function waitForArchitectureRun(
  projectPath: string,
  initial: ToolRunResult,
  agentId: RuntimeAgentId,
  reviewId: string,
  inputFingerprint: string,
  planTimeoutMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<ToolRunResult> {
  return waitForArtifactRunResponse(projectPath, initial, {
    softTimeoutMs: planTimeoutMs ?? 300_000,
    signal,
    pollIntervalMs: 1_000,
    onLate: async (late) => {
      await writeArchitectureReviewStatus(projectPath, {
        state: "reviewing",
        reviewId,
        scanFingerprint: inputFingerprint,
        agentId,
        runId: initial.id,
        startedAt: initial.startedAt,
        softTimedOutAt: late.softTimedOutAt,
        message: late.message
      });
    }
  });
}

function reviewFailure(
  agentId: RuntimeAgentId,
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

async function architectureInputIsCurrent(
  projectPath: string,
  inputFingerprint: string
): Promise<boolean> {
  const projectArtifact = await readJsonArtifact(join(projectPath, FLOWWEAVE_DIR, "project.json"));
  if (projectArtifact === undefined) return true;
  if (typeof projectArtifact !== "object" || projectArtifact === null || !("scanFingerprint" in projectArtifact)) {
    return false;
  }
  return projectArtifact.scanFingerprint === inputFingerprint;
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
  inputFingerprint: string,
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
      generatedAt,
      inputFingerprint,
      fileCoverage: quality.fileCoverage,
      evidenceCoverage: quality.evidenceCoverage
    }
  };
}

function withLocalArchitectureMetadata(
  architectureMap: ArchitectureMap,
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
      inputFingerprint,
      fileCoverage: quality.fileCoverage,
      evidenceCoverage: quality.evidenceCoverage
    }
  };
}

function failedArchitectureResult(
  agentId: RuntimeAgentId,
  code: "agent-failed" | "invalid-output" | "quality-rejected",
  message: string,
  runIds: string[],
  firstFailure?: string,
  retryFailure?: string
): Extract<ArchitectureAnalysisResult, { outcome: "failed" }> {
  return {
    outcome: "failed",
    error: {
      code,
      message,
      agentId,
      runId: runIds.at(-1),
      attemptRunIds: runIds,
      firstFailure,
      retryFailure
    }
  };
}

function buildArchitectureRepairPrompt(originalPrompt: string, output: string, failure: string): string {
  return `${originalPrompt}

The previous response failed validation: ${failure}
Return one corrected JSON object only. Do not include Markdown fences or explanatory text.

Previous response:
${output.slice(0, 40_000)}`;
}

function collectStdout(events: Array<{ type: string; content?: string }>) {
  return events.filter((event) => event.type === "stdout").map((event) => event.content ?? "").join("\n");
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createLocalArchitectureMap(project: CodeflowProject, facts: ProjectStructureFacts, source: ArchitectureMap["source"]): ArchitectureMap {
  const groups = new Map<string, FileInsight[]>();
  for (const file of facts.files) {
    const key = fallbackModuleId(file, facts);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }

  const modules = [...groups.entries()].map(([id, files]): ArchitectureModule => {
    const category = fallbackCategoryWithRelations(files, facts);
    const symbols = files.flatMap((file) => file.symbols.slice(0, 12));
    const title = titleFromId(id);
    return {
      id,
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
      const relation = relationForModules(modules, source, target);
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

export function enhanceLocalArchitecture(local: ArchitectureMap, agent: ArchitectureMap): ArchitectureMap {
  const agentByFiles = new Map(agent.modules.map((module) => [moduleFilesKey(module), module]));
  return {
    ...local,
    source: "agent",
    architectureStyle: agent.architectureStyle ?? local.architectureStyle,
    modules: local.modules.map((module) => {
      const review = agentByFiles.get(moduleFilesKey(module));
      return review ? {
        ...module,
        title: review.title,
        role: review.role,
        description: review.description,
        fileRoles: review.fileRoles,
        symbols: review.symbols,
        evidence: review.evidence
      } : module;
    }),
    relationships: local.relationships
  };
}

function moduleFilesKey(module: ArchitectureModule): string {
  return [...module.files].sort().join("\u0000");
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

function normalizeModule(module: Partial<ArchitectureModule>, facts: ProjectStructureFacts, fileSet: Set<string>, index: number): ArchitectureModule | undefined {
  const id = safeId(module.id ?? module.title ?? `module-${index + 1}`);
  const files = (module.files ?? []).filter((file) => fileSet.has(file));
  if (!id || files.length === 0) return undefined;
  const category = isCategory(module.category) ? module.category : fallbackCategory(facts.files.filter((file) => files.includes(file.path)));
  const symbols = normalizeSymbols(module.symbols ?? [], files);
  return {
    id,
    title: module.title?.trim() || titleFromId(id),
    category,
    nodeType: nodeTypeFromCategory(category),
    role: module.role?.trim() || fallbackRole(category, facts.files.filter((file) => files.includes(file.path))),
    description: module.description?.trim() || fallbackModuleDescription(titleFromId(id), category, facts.files.filter((file) => files.includes(file.path))),
    files,
    fileRoles: normalizeFileRoles(module.fileRoles, files, facts.files, category),
    symbols,
    evidence: normalizeEvidence(module.evidence, files),
    risk: "unknown",
    confidence: undefined,
    assessment: undefined
  };
}

function normalizeRelationship(relationship: Partial<ArchitectureRelationship>, moduleIds: Set<string>, index: number): ArchitectureRelationship | undefined {
  if (!relationship.source || !relationship.target || !moduleIds.has(relationship.source) || !moduleIds.has(relationship.target)) return undefined;
  const relation = isRelation(relationship.relation) ? relationship.relation : "depends_on";
  return {
    id: relationship.id || `${relationship.source}-${relationship.target}-${relation}-${index}`,
    source: relationship.source,
    target: relationship.target,
    relation,
    description: relationship.description || `${relationship.source} ${relation} ${relationship.target}`,
    evidence: normalizeEvidence(relationship.evidence, [])
  };
}

function compactFactsForPrompt(facts: ProjectStructureFacts) {
  return {
    ...facts,
    files: facts.files.slice(0, MAX_PROMPT_FILES).map((file) => ({
      path: file.path,
      language: file.language,
      imports: file.imports.slice(0, 16),
      exports: file.exports.slice(0, 12),
      symbols: file.symbols.slice(0, MAX_PROMPT_SYMBOLS_PER_FILE).map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        exported: symbol.exported
      })),
      calls: file.calls.slice(0, 12),
      externalCalls: file.externalCalls.slice(0, 8)
    })),
    relations: facts.relations?.slice(0, 120)
  };
}

function mockArchitectureJson(map: ArchitectureMap) {
  return JSON.stringify(
    {
      architectureStyle: map.architectureStyle,
      modules: map.modules,
      relationships: map.relationships
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

function fallbackModuleId(file: FileInsight, facts: ProjectStructureFacts) {
  const category = fallbackCategoryWithRelations([file], facts);
  const parts = file.path.split("/");
  const srcIndex = parts.lastIndexOf("src");
  const scope = srcIndex >= 0 ? parts[srcIndex + 1] : parts[0];
  if (category === "external-integration") return "external-integrations";
  if (category === "data-access") return "data-access";
  if (category === "api-boundary") return `${scope ?? "api"}-api`;
  if (category === "test-surface") return "test-surface";
  if (category === "job-worker") return `${scope ?? "worker"}-worker`;
  if (category === "shared-utility") return "shared-utilities";
  return safeId(scope ?? "domain-service");
}

function fallbackCategoryWithRelations(
  files: FileInsight[],
  facts: ProjectStructureFacts
): ArchitectureModuleCategory {
  const paths = new Set(files.map((file) => file.path));
  const httpRelations = (facts.relations ?? []).filter((relation) => relation.kind === "http");
  if (httpRelations.some((relation) => relation.targetFile && paths.has(relation.targetFile))) {
    return "api-boundary";
  }
  if (
    httpRelations.some((relation) => relation.sourceFile && paths.has(relation.sourceFile)) &&
    files.some((file) => /(^|\/)(app|index|main|page|view|screen)[^/]*\.(tsx?|jsx?|vue)$/i.test(file.path))
  ) {
    return "api-boundary";
  }
  return fallbackCategory(files);
}

function fallbackCategory(files: FileInsight[]): ArchitectureModuleCategory {
  const text = files.map((file) => `${file.path} ${file.imports.join(" ")} ${file.externalCalls.map((call) => call.kind).join(" ")}`).join("\n");
  if (/test|spec|__tests__/i.test(text)) return "test-surface";
  if (/controller|route|router|api|endpoint/i.test(text)) return "api-boundary";
  if (/repository|database|prisma|schema|migration|sql|mongoose|sequelize|knex|db\b/i.test(text)) return "data-access";
  if (/https?:|fetch|axios|requests|external|webhook|client/i.test(text)) return "external-integration";
  if (/worker|job|queue|cron|schedule|consumer/i.test(text)) return "job-worker";
  if (/util|helper|shared|common|constants|config/i.test(text)) return "shared-utility";
  return "domain-service";
}

function architectureRelationFromSemantic(kind: import("../../types").SemanticRelation["kind"]): GraphEdgeRelation {
  if (kind === "database" || kind === "filesystem") return "reads_writes";
  if (kind === "event") return "publishes_event";
  if (kind === "test") return "tests";
  return "calls";
}

function relationForModules(modules: ArchitectureModule[], source: string, target: string): GraphEdgeRelation {
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
    "test-surface": "test"
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
    "test-surface": "Test Surface"
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
    "test-surface": `${prefix} tests that verify behavior and protect regressions.`
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
    "test-surface": `${title} verifies expected behavior and regression coverage for the project${location}.`
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

function folderPathsForFiles(files: string[]) {
  return [...new Set(files.flatMap((file) => folderPathsForFile(file)))];
}

function folderPathsForFile(filePath: string) {
  const parts = filePath.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
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

function normalizeSymbols(symbols: StructureSymbol[], files: string[]) {
  return symbols.filter((symbol) => files.includes(symbol.filePath)).slice(0, 80);
}

function normalizeFileRoles(
  fileRoles: ArchitectureModule["fileRoles"] | undefined,
  files: string[],
  factsFiles: FileInsight[],
  category: ArchitectureModuleCategory
) {
  const allowedPaths = new Set([...files, ...folderPathsForFiles(files)]);
  const roles = (fileRoles ?? [])
    .map((item) => ({ path: item.path.trim(), role: item.role.trim() }))
    .filter((item) => item.path && item.role && allowedPaths.has(item.path));
  const roleByPath = new Map(roles.map((item) => [item.path, item.role]));
  const fileInsights = factsFiles.filter((file) => files.includes(file.path));
  const generatedRoles = fallbackFileRoles(fileInsights, category).filter((item) => !roleByPath.has(item.path));
  return [...roles, ...generatedRoles];
}

function normalizeEvidence(evidence: ArchitectureModule["evidence"] | undefined, files: string[]) {
  return (evidence ?? [])
    .filter((item) => !item.filePath || files.length === 0 || files.includes(item.filePath))
    .map((item) => ({
      filePath: item.filePath,
      symbol: item.symbol,
      line: Number.isInteger(item.line) ? item.line : undefined,
      detail: item.detail || "Architecture evidence"
    }))
    .slice(0, 30);
}

function titleFromId(id: string) {
  return id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function safeId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "module";
}

function isCategory(value: unknown): value is ArchitectureModuleCategory {
  return (
    value === "api-boundary" ||
    value === "domain-service" ||
    value === "data-access" ||
    value === "external-integration" ||
    value === "job-worker" ||
    value === "shared-utility" ||
    value === "test-surface"
  );
}

function isArchitectureMap(value: unknown): value is ArchitectureMap {
  return typeof value === "object" &&
    value !== null &&
    "version" in value &&
    (value.version === 1 || value.version === 2) &&
    "projectName" in value &&
    typeof value.projectName === "string" &&
    "rootPath" in value &&
    typeof value.rootPath === "string" &&
    "modules" in value &&
    Array.isArray(value.modules) &&
    "relationships" in value &&
    Array.isArray(value.relationships) &&
    "files" in value &&
    Array.isArray(value.files) &&
    "symbols" in value &&
    Array.isArray(value.symbols);
}

function isRelation(value: unknown): value is GraphEdgeRelation {
  return value === "depends_on" || value === "calls" || value === "reads_writes" || value === "external_api" || value === "publishes_event" || value === "subscribes_event" || value === "tests";
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

function migrateArchitectureAssessments(architectureMap: ArchitectureMap): ArchitectureMap {
  return {
    ...architectureMap,
    modules: architectureMap.modules.map((module) => {
      if (module.assessment) return module;
      const legacyRisk = module.risk as unknown as string;
      const risk = legacyRisk === "blocked" ? "high" : legacyRisk === "review" ? "medium" : legacyRisk === "normal" ? "low" : module.risk;
      const assessment = unknownAssessment(architectureMap.metadata?.inputFingerprint ?? "", architectureMap.generatedAt);
      const legacyConfidence = typeof module.confidence === "number"
        ? Math.max(0, Math.min(100, Math.round(module.confidence * 100)))
        : undefined;
      return {
        ...module,
        risk,
        confidence: undefined,
        assessment: {
          ...assessment,
          confidence: legacyConfidence === undefined ? assessment.confidence : {
            score: legacyConfidence,
            level: legacyConfidence >= 80 ? "high" : legacyConfidence >= 50 ? "medium" : "low",
            factors: [{
              id: "legacy-confidence",
              label: "Legacy confidence",
              score: legacyConfidence,
              maxScore: 100,
              reason: "Migrated from a previous architecture artifact. Regenerate architecture to calculate evidence-backed confidence.",
              evidence: [{ detail: "Legacy architecture confidence value" }]
            }]
          },
          risk: {
            systemLevel: risk,
            effectiveLevel: risk,
            factors: [{
              id: "legacy-risk",
              label: "Legacy risk",
              score: risk === "high" ? 70 : risk === "medium" ? 30 : 0,
              maxScore: 100,
              reason: "Migrated from a previous architecture artifact. Regenerate architecture to calculate impact risk.",
              evidence: [{ detail: "Legacy architecture risk value" }]
            }]
          }
        }
      };
    })
  };
}

function migrateLegacyArchitectureSource(architectureMap: ArchitectureMap): ArchitectureMap {
  const legacySource = (architectureMap as unknown as { source?: string }).source;
  if (legacySource !== "fallback") return architectureMap;
  return { ...architectureMap, source: "local", metadata: undefined };
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function languageCounts(files: FileInsight[]) {
  return files.reduce<Record<string, number>>((counts, file) => {
    if (!file.language) return counts;
    counts[file.language] = (counts[file.language] ?? 0) + 1;
    return counts;
  }, {});
}

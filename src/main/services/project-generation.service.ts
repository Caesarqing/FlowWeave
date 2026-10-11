import { ArtifactGenerationMismatchError, GenerationInputChangedError } from "./generation-errors";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisProgressUpdate, ArchitectureMap, CodeflowCanvas, CodeflowProject, GenerationIdentity, SemanticIndex } from "../../types";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { assertCanvasCanStartGeneration, prepareFlowWeaveProject, recordCanvasMigrationFailure, readProjectGenerationManifest, readProjectProtocolCanvas, readProjectProtocolOverview, readProjectProtocolSnapshot, writeBatchAtomic } from "../storage/flowweave-store";
import { withArchitectureArtifactLock } from "./architecture-review.service";
import { buildSemanticIndex, readSemanticIndex, SEMANTIC_INDEX_GENERATOR_VERSION } from "./semantic-index.service";
import { scanProject, type ScanProjectOptions } from "./project-scanner.service";
import { createCanvasArtifact } from "./canvas-artifact.service";
import { architectureMapToGraph, buildArchitectureInputFingerprint, buildStaticArchitecture } from "./static-architecture.service";

export type GenerationRequest = { requestId: string; projectPath: string };
export type GenerationOptions = {
  scanOptions?: ScanProjectOptions;
  onProjectScanned?: (scanFingerprint: string) => void;
  onProgress?: (progress: AnalysisProgressUpdate) => void;
  onMeasurement?: (measurement: GenerationPhaseMeasurement) => void;
};
export type GenerationPhaseMetric = "scanMs" | "semanticAnalysisMs" | "clusteringMs" | "layoutMs" | "commitMs" |
  "lockWaitMs" | "snapshotReadMs" | "snapshotValidationMs" | "snapshotParseMs" | "detailIndexMs";
export type GenerationPhaseMeasurement = {
  metric: GenerationPhaseMetric;
  durationMs: number;
  outcome: "completed" | "failed";
};
export type CommittedGeneration = {
  status: "committed";
  generation: GenerationIdentity;
  project: CodeflowProject;
  index: SemanticIndex;
  delta: import("../../types").ScanDelta;
  architectureMap: ArchitectureMap;
  localArchitecture: ArchitectureMap;
  graph: ReturnType<typeof architectureMapToGraph>;
  canvas: CodeflowCanvas;
  written: import("../../types").CodeflowWriteResult;
};
export type GenerationResult = CommittedGeneration | { status: "superseded"; requestId: string; projectPath: string };
export type ProjectAnalysisWorkerRequest = {
  request: GenerationRequest;
  scanOptions?: ScanProjectOptions;
  measurementsEnabled: boolean;
  transactionAuthorityRoot: string;
};
export type ProjectAnalysisWorkerResult =
  | { status: "superseded"; requestId: string; projectPath: string }
  | Pick<CommittedGeneration, "status" | "generation" | "written"> & {
      scanFingerprint: string;
      localArchitectureInputFingerprint: string;
    };
export type ProjectAnalysisWorkerMessage =
  | { type: "scanned"; requestId: string; scanFingerprint: string }
  | { type: "progress"; requestId: string; progress: AnalysisProgressUpdate }
  | { type: "measurement"; requestId: string; measurement: GenerationPhaseMeasurement }
  | { type: "result"; requestId: string; result: ProjectAnalysisWorkerResult }
  | { type: "failure"; requestId: string; message: string };

const STATIC_GRAPH_RULES_VERSION = "static-graph-v7.1.10";

/** Register before scanning; a later registered request wins even when that request fails. */
export async function registerGenerationRequest(
  projectPath: string,
  requestId: string,
  onLockWaitMs?: (durationMs: number) => void
): Promise<GenerationRequest> {
  const canonical = await realpath(projectPath);
  return withArchitectureArtifactLock(canonical, async () => {
    await assertCanvasCanStartGeneration(canonical, requestId);
    const request = { projectPath: canonical, requestId };
    try {
      await writeJsonAtomic(join(canonical, FLOWWEAVE_DIR, "generation-request.json"), request);
    } catch (error) {
      try {
        await recordCanvasMigrationFailure(canonical, requestId, error);
      } catch (recordError) {
        throw new AggregateError([error, recordError], `Generation request registration and migration failure recording both failed: project=${canonical} request=${requestId}`);
      }
      throw error;
    }
    return request;
  }, onLockWaitMs);
}

export async function generateProject(projectPath: string, options: GenerationOptions): Promise<GenerationResult> {
  return generateRegisteredProject(await registerGenerationRequest(projectPath, randomUUID()), options);
}

export async function generateRegisteredProject(request: GenerationRequest, options: GenerationOptions): Promise<GenerationResult> {
  try {
    return await generateRegisteredProjectInternal(request, options);
  } catch (error) {
    try {
      await recordCanvasMigrationFailure(request.projectPath, request.requestId, error);
    } catch (recordError) {
      throw new AggregateError([error, recordError], `Project analysis failed and its migration failure status could not be persisted: project=${request.projectPath} request=${request.requestId}`);
    }
    throw error;
  }
}

async function generateRegisteredProjectInternal(request: GenerationRequest, options: GenerationOptions): Promise<GenerationResult> {
  const project = await measureGenerationPhase(options, "scanMs", () => scanProject(request.projectPath, options.scanOptions));
  options.onProjectScanned?.(project.scanFingerprint ?? "");
  const prepared = await measureGenerationPhase(options, "semanticAnalysisMs", () =>
    buildSemanticIndex(project, { onProgress: options.onProgress }));
  const architectureInputFingerprint = buildArchitectureInputFingerprint(project.scanFingerprint ?? "", prepared.index);
  const inputFingerprint = createHash("sha256").update(prepared.snapshot.fingerprint()).update(architectureInputFingerprint).digest("hex");
  const generationId = createHash("sha256").update(JSON.stringify({ storageProtocol: 7, rulesVersion: STATIC_GRAPH_RULES_VERSION, inputFingerprint })).digest("hex");
  const generation: GenerationIdentity = { requestId: generationId, inputFingerprint };
  const reused = await reuseCommittedGeneration(request, project, prepared, generation, architectureInputFingerprint, options);
  if (reused) return reused;

  const built = await measureGenerationPhase(options, "clusteringMs", () => buildStaticArchitecture(project, prepared.index));
  if (!built.quality.valid) throw new Error(`Static architecture validation failed for project ${request.projectPath}, request ${request.requestId}: ${built.quality.reasons.join("; ")}`);
  if (built.inputFingerprint !== architectureInputFingerprint) throw new Error(`Static architecture input changed during generation: project ${request.projectPath}, request ${request.requestId}`);
  const latestRequest = await withGenerationArtifactLock(request.projectPath, options, () =>
    readJsonArtifact(join(request.projectPath, FLOWWEAVE_DIR, "generation-request.json")));
  if (!latestRequest || typeof latestRequest !== "object" || !("requestId" in latestRequest)) {
    throw new Error(`Invalid registered generation request for project ${request.projectPath}, request ${request.requestId}`);
  }
  if (latestRequest.requestId !== request.requestId) return { status: "superseded", ...request };
  const currentProject = await measureGenerationPhase(options, "scanMs", () => scanProject(request.projectPath, options.scanOptions));
  if (currentProject.scanFingerprint !== project.scanFingerprint) throw new GenerationInputChangedError(`project file set ${request.projectPath}, request ${request.requestId}`);
  const generatedProject = { ...project, generation };
  const index = { ...prepared.index, generation, files: prepared.index.files.map((file) => ({ ...file, generation })) };
  const localArchitecture = { ...built.architectureMap, generation };
  while (true) {
    const candidate = await withGenerationArtifactLock(request.projectPath, options, async () => {
      const latest = await readJsonArtifact(join(request.projectPath, FLOWWEAVE_DIR, "generation-request.json"));
      if (!latest || typeof latest !== "object" || !("requestId" in latest)) {
        throw new Error(`Invalid registered generation request for project ${request.projectPath}, request ${request.requestId}`);
      }
      if (latest.requestId !== request.requestId) return { status: "superseded" as const, ...request };
      const previousSnapshot = await readProjectProtocolSnapshot(request.projectPath, snapshotMeasurementCallback(options));
      return {
        status: "ready" as const,
        previousSnapshot,
        architectureMap: localArchitecture
      };
    });
    if (candidate.status === "superseded") return candidate;

    const { architectureMap } = candidate;
    const graph = architectureMapToGraph(architectureMap);
    const generatedCanvas: CodeflowCanvas = {
      ...await measureGenerationPhase(options, "layoutMs", () => createCanvasArtifact(request.projectPath, graph.nodes, graph.edges, built.scanFingerprint)),
      generation,
      groups: architectureMap.groups,
      quality: architectureMap.quality,
      inputFingerprint: architectureMap.metadata?.inputFingerprint ?? built.scanFingerprint
    };
    const localPrevious = candidate.previousSnapshot?.localArchitecture;
    const previousGraph = localPrevious ? architectureMapToGraph(localPrevious) : undefined;
    const semanticUpdates = prepared.updates.map((update) => ({ ...update,
      content: JSON.stringify({ ...JSON.parse(update.content) as object, generation,
        ...(update.path.endsWith("semantic-index.json") ? { files: index.files } : {}) }, null, 2) + "\n"
    }));
    await measureGenerationPhase(options, "snapshotValidationMs", () => prepared.snapshot.validate());
    options.onProgress?.({
      stage: "persisting",
      completed: project.summary.totalFiles,
      total: project.summary.totalFiles,
      failed: 0,
      message: "Static graph ready to commit."
    });
    const committed = await measureGenerationPhase(options, "commitMs", () => withGenerationArtifactLock(request.projectPath, options, async () => {
      const latest = await readJsonArtifact(join(request.projectPath, FLOWWEAVE_DIR, "generation-request.json"));
      if (!latest || typeof latest !== "object" || !("requestId" in latest)) {
        throw new Error(`Invalid registered generation request for project ${request.projectPath}, request ${request.requestId}`);
      }
      if (latest.requestId !== request.requestId) return { status: "superseded" as const, ...request };
      await measureGenerationPhase(options, "snapshotValidationMs", () => prepared.snapshot.validate());
      const artifacts = await prepareFlowWeaveProject(request.projectPath, generatedProject, generatedCanvas,
        { local: localArchitecture, current: architectureMap, generation, requestId: request.requestId, semanticIndex: index,
          previousGraph });
      const hashFor = (suffix: string) => {
        const artifact = artifacts.updates.find((update) => update.path.endsWith(suffix));
        if (!artifact) throw new Error(`Protocol v7 artifact was not prepared: project ${request.projectPath}, artifact ${suffix}`);
        return createHash("sha256").update(artifact.content).digest("hex");
      };
      const manifest = {
        storageProtocol: 7 as const,
        generationId,
        inputFingerprint,
        rulesVersion: STATIC_GRAPH_RULES_VERSION,
        analyzerVersion: SEMANTIC_INDEX_GENERATOR_VERSION,
        artifacts: {
          staticSnapshot: hashFor("/.flowweave/static-snapshot.json"),
          graphOverview: hashFor("/.flowweave/graph-overview.json"),
          canvasUserState: hashFor("/.flowweave/canvas/user-state.json")
        },
        committedAt: new Date().toISOString()
      };
      await writeBatchAtomic(request.projectPath, [ ...semanticUpdates, ...artifacts.updates,
        { path: join(request.projectPath, FLOWWEAVE_DIR, "generation.json"), content: JSON.stringify(manifest, null, 2) + "\n" }
      ], [...prepared.removedPaths, ...artifacts.removedPaths], artifacts.validateMigration);
      return { status: "committed" as const, generation, project: generatedProject, index, delta: prepared.delta,
        architectureMap, localArchitecture, graph,
        canvas: artifacts.canvas, written: artifacts.written };
    }));
    if (committed) return committed;
  }
}

async function measureGenerationPhase<T>(
  options: GenerationOptions,
  metric: GenerationPhaseMetric,
  operation: () => Promise<T> | T
): Promise<T> {
  if (!options.onMeasurement) return operation();
  const startedAt = performance.now();
  let outcome: GenerationPhaseMeasurement["outcome"] = "failed";
  try {
    const result = await operation();
    outcome = "completed";
    return result;
  } finally {
    options.onMeasurement({ metric, durationMs: performance.now() - startedAt, outcome });
  }
}

function withGenerationArtifactLock<T>(
  projectPath: string,
  options: GenerationOptions,
  action: () => Promise<T>
): Promise<T> {
  return withArchitectureArtifactLock(projectPath, action, (durationMs) => {
    options.onMeasurement?.({ metric: "lockWaitMs", durationMs, outcome: "completed" });
  });
}

function snapshotMeasurementCallback(options: GenerationOptions): ((
  metric: "snapshotReadMs" | "snapshotParseMs" | "snapshotValidationMs",
  durationMs: number,
  outcome: "completed" | "failed"
) => void) | undefined {
  if (!options.onMeasurement) return undefined;
  return (metric, durationMs, outcome) => options.onMeasurement?.({ metric, durationMs, outcome });
}

async function reuseCommittedGeneration(
  request: GenerationRequest,
  project: CodeflowProject,
  prepared: Awaited<ReturnType<typeof buildSemanticIndex>>,
  generation: GenerationIdentity,
  architectureInputFingerprint: string,
  options: GenerationOptions
): Promise<GenerationResult | undefined> {
  const candidate = await withGenerationArtifactLock(request.projectPath, options, async () => {
    const latest = await readJsonArtifact(join(request.projectPath, FLOWWEAVE_DIR, "generation-request.json"));
    if (!latest || typeof latest !== "object" || !("requestId" in latest)) {
      throw new Error(`Invalid registered generation request for project ${request.projectPath}, request ${request.requestId}`);
    }
    if (latest.requestId !== request.requestId) return { status: "superseded", ...request } satisfies GenerationResult;
    const manifest = await readProjectGenerationManifest(request.projectPath);
    const storedIndex = await readSemanticIndex(request.projectPath);
    return storedIndex?.generatorVersion === SEMANTIC_INDEX_GENERATOR_VERSION &&
      storedIndex.scanFingerprint === prepared.index.scanFingerprint &&
      storedIndex.configurationFingerprint === prepared.index.configurationFingerprint &&
      manifest?.generationId === generation.requestId && manifest.inputFingerprint === generation.inputFingerprint &&
      manifest.rulesVersion === STATIC_GRAPH_RULES_VERSION && manifest.analyzerVersion === SEMANTIC_INDEX_GENERATOR_VERSION;
  });
  if (candidate === false || candidate === undefined) return undefined;
  if (typeof candidate === "object") return candidate;

  const currentProject = await scanProject(request.projectPath, options.scanOptions);
  if (currentProject.scanFingerprint !== project.scanFingerprint) throw new GenerationInputChangedError(`project file set ${request.projectPath}, request ${request.requestId}`);
  await measureGenerationPhase(options, "snapshotValidationMs", () => prepared.snapshot.validate());
  return withGenerationArtifactLock(request.projectPath, options, async () => {
    const latest = await readJsonArtifact(join(request.projectPath, FLOWWEAVE_DIR, "generation-request.json"));
    if (!latest || typeof latest !== "object" || !("requestId" in latest)) {
      throw new Error(`Invalid registered generation request for project ${request.projectPath}, request ${request.requestId}`);
    }
    if (latest.requestId !== request.requestId) return { status: "superseded", ...request };
    const manifest = await readProjectGenerationManifest(request.projectPath);
    if (manifest?.generationId !== generation.requestId || manifest.inputFingerprint !== generation.inputFingerprint ||
        manifest.rulesVersion !== STATIC_GRAPH_RULES_VERSION || manifest.analyzerVersion !== SEMANTIC_INDEX_GENERATOR_VERSION) return undefined;
    const [snapshot, canvas, overview] = await Promise.all([
      readProjectProtocolSnapshot(request.projectPath, snapshotMeasurementCallback(options)),
      readProjectProtocolCanvas(request.projectPath),
      readProjectProtocolOverview(request.projectPath)
    ]);
    if (!snapshot || !canvas || !overview) throw new Error(`Committed protocol v7 artifacts are incomplete: project ${request.projectPath}, generation ${generation.requestId}`);
    if (snapshot.project.scanFingerprint !== project.scanFingerprint ||
        snapshot.semanticIndex.configurationFingerprint !== prepared.index.configurationFingerprint ||
        snapshot.localArchitecture.metadata?.inputFingerprint !== architectureInputFingerprint) return undefined;
    return {
      status: "committed",
      generation,
      project: snapshot.project,
      index: snapshot.semanticIndex,
      delta: prepared.delta,
      architectureMap: snapshot.localArchitecture,
      localArchitecture: snapshot.localArchitecture,
      graph: architectureMapToGraph(snapshot.localArchitecture),
      canvas,
      written: {
        generationManifestPath: join(request.projectPath, FLOWWEAVE_DIR, "generation.json"),
        staticSnapshotPath: join(request.projectPath, FLOWWEAVE_DIR, "static-snapshot.json"),
        graphOverviewPath: join(request.projectPath, FLOWWEAVE_DIR, "graph-overview.json"),
        canvasUserStatePath: join(request.projectPath, FLOWWEAVE_DIR, "canvas", "user-state.json")
      }
    };
  });
}

/** Caller holds the shared artifact lock. Legacy artifacts are allowed only without a generation marker. */
export async function assertArtifactGeneration(projectPath: string, artifactPath: string, artifact: { generation?: GenerationIdentity }): Promise<void> {
  const marker = await readCommittedGeneration(projectPath);
  if (!marker && !artifact.generation) return;
  if (!marker || marker.requestId !== artifact.generation?.requestId || marker.inputFingerprint !== artifact.generation.inputFingerprint) {
    throw new ArtifactGenerationMismatchError(projectPath, artifactPath, marker, artifact.generation);
  }
}

/** Read under the shared artifact lock to prevent observing a partially replaced batch. */
export async function readCommittedGeneration(projectPath: string): Promise<GenerationIdentity | undefined> {
  const protocol = await readProjectGenerationManifest(projectPath);
  return protocol ? { requestId: protocol.generationId, inputFingerprint: protocol.inputFingerprint } : undefined;
}

export type CommittedAnalysis = {
  project: CodeflowProject;
  index: SemanticIndex;
  localArchitecture: ArchitectureMap;
  generation: GenerationIdentity;
};

/** Read one committed analysis for AI consumers; old unversioned generations require the unified scan. */
export async function readCommittedAnalysis(projectPath: string): Promise<CommittedAnalysis | undefined> {
  return withArchitectureArtifactLock(projectPath, async () => {
    const protocol = await readProjectGenerationManifest(projectPath);
    if (!protocol) return undefined;
    const snapshot = await readProjectProtocolSnapshot(projectPath);
    if (!snapshot) throw new Error(`Committed static snapshot is missing: project ${projectPath}, generation ${protocol.generationId}`);
    return {
      generation: { requestId: protocol.generationId, inputFingerprint: protocol.inputFingerprint },
      project: snapshot.project,
      index: snapshot.semanticIndex,
      localArchitecture: snapshot.localArchitecture
    };
  });
}

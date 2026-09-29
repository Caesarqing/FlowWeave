import { ArtifactGenerationMismatchError, GenerationInputChangedError } from "./generation-errors";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisProgressUpdate, ArchitectureMap, CodeflowCanvas, CodeflowProject, GenerationIdentity, SemanticIndex } from "../../types";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { prepareFlowWeaveProject, writeBatchAtomic } from "../storage/flowweave-store";
import { withArchitectureArtifactLock } from "./architecture-review.service";
import { buildSemanticIndex } from "./semantic-index.service";
import { scanProject, type ScanProjectOptions } from "./project-scanner.service";
import { architectureMapToGraph, buildStaticArchitecture, isCurrentAgentArchitecture } from "./static-architecture.service";

export type GenerationRequest = { requestId: string; projectPath: string };
export type GenerationOptions = {
  scanOptions?: ScanProjectOptions;
  onProgress?: (progress: AnalysisProgressUpdate) => void;
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

/** Register before scanning; a later registered request wins even when that request fails. */
export async function registerGenerationRequest(projectPath: string): Promise<GenerationRequest> {
  const canonical = await realpath(projectPath);
  return withArchitectureArtifactLock(canonical, async () => {
    const request = { projectPath: canonical, requestId: randomUUID() };
    await writeJsonAtomic(join(canonical, FLOWWEAVE_DIR, "generation-request.json"), request);
    return request;
  });
}

export async function generateProject(projectPath: string, options: GenerationOptions): Promise<GenerationResult> {
  return generateRegisteredProject(await registerGenerationRequest(projectPath), options);
}

export async function generateRegisteredProject(request: GenerationRequest, options: GenerationOptions): Promise<GenerationResult> {
  const project = await scanProject(request.projectPath, options.scanOptions);
  const prepared = await buildSemanticIndex(project, { onProgress: options.onProgress });
  return withArchitectureArtifactLock(request.projectPath, async () => {
    const latest = await readJsonArtifact(join(request.projectPath, FLOWWEAVE_DIR, "generation-request.json"));
    if (!latest || typeof latest !== "object" || !("requestId" in latest)) throw new Error(`Invalid registered generation request for project ${request.projectPath}, request ${request.requestId}`);
    if (latest.requestId !== request.requestId) return { status: "superseded", ...request };
    prepared.snapshot.validate();
    const built = await buildStaticArchitecture(project, prepared.index);
    if (!built.quality.valid) throw new Error(`Static architecture validation failed for project ${request.projectPath}, request ${request.requestId}: ${built.quality.reasons.join("; ")}`);
    const generation: GenerationIdentity = { requestId: request.requestId, inputFingerprint: createHash("sha256").update(prepared.snapshot.fingerprint()).update(built.inputFingerprint).digest("hex") };
    const generatedProject = { ...project, generation };
    const index = { ...prepared.index, generation, files: prepared.index.files.map((file) => ({ ...file, generation })) };
    const localArchitecture = { ...built.architectureMap, generation };
    const previousCurrent = await readJsonArtifact(join(request.projectPath, FLOWWEAVE_DIR, "architecture-map.json"));
    const architectureMap: ArchitectureMap = isCurrentAgentArchitecture(previousCurrent, localArchitecture)
      ? { ...previousCurrent, generation } : localArchitecture;
    const graph = architectureMapToGraph(architectureMap);
    const localPrevious = await readJsonArtifact(join(request.projectPath, FLOWWEAVE_DIR, "architecture-local.json")) as ArchitectureMap | undefined;
    const artifacts = await prepareFlowWeaveProject(request.projectPath, generatedProject,
      graph.nodes, graph.edges, built.scanFingerprint,
      { local: localArchitecture, current: architectureMap, generation, previousGraph: localPrevious ? architectureMapToGraph(localPrevious) : undefined });
    const semanticUpdates = prepared.updates.map((update) => ({ ...update,
      content: JSON.stringify({ ...JSON.parse(update.content) as object, generation,
        ...(update.path.endsWith("semantic-index.json") ? { files: index.files } : {}) }, null, 2) + "\n"
    }));
    const currentProject = await scanProject(request.projectPath, options.scanOptions);
    if (currentProject.scanFingerprint !== project.scanFingerprint) throw new GenerationInputChangedError(`project file set ${request.projectPath}, request ${request.requestId}`);
    prepared.snapshot.validate();
    await writeBatchAtomic(request.projectPath, [ ...semanticUpdates, ...artifacts.updates,
      { path: join(request.projectPath, FLOWWEAVE_DIR, "generation.json"), content: JSON.stringify(generation) + "\n" }
    ], prepared.removedPaths);
    return { status: "committed", generation, project: generatedProject, index, delta: prepared.delta,
      architectureMap, localArchitecture, graph,
      canvas: artifacts.canvas, written: artifacts.written };
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
  const value = await readJsonArtifact(join(projectPath, FLOWWEAVE_DIR, "generation.json"));
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || !("requestId" in value) || typeof value.requestId !== "string" || !("inputFingerprint" in value) || typeof value.inputFingerprint !== "string") throw new Error(`Invalid committed generation marker: project ${projectPath}`);
  return value as GenerationIdentity;
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
    const generation = await readCommittedGeneration(projectPath);
    if (!generation) return undefined;
    const root = join(projectPath, FLOWWEAVE_DIR);
    const [project, index, localArchitecture] = await Promise.all([
      readJsonArtifact(join(root, "project.json")),
      readJsonArtifact(join(root, "index/semantic-index.json")),
      readJsonArtifact(join(root, "architecture-local.json"))
    ]);
    const artifacts = [["project.json", project], ["index/semantic-index.json", index], ["architecture-local.json", localArchitecture]] as const;
    for (const [path, artifact] of artifacts) {
      if (!artifact || typeof artifact !== "object") throw new Error(`Committed analysis artifact missing or invalid: project ${projectPath}, artifact ${path}, generation ${generation.requestId}`);
      await assertArtifactGeneration(projectPath, path, artifact);
    }
    const semantic = index as SemanticIndex;
    const local = localArchitecture as ArchitectureMap;
    const storedProject = project as CodeflowProject;
    if (semantic.version !== 5 || semantic.generatorVersion !== "5.0.1" || !Array.isArray(semantic.files) || !Array.isArray(semantic.relations) || local.version !== 3 || local.source !== "local" || !Array.isArray(local.modules) || !Array.isArray(local.relationships) || !Array.isArray(storedProject.files)) {
      throw new Error(`Unsupported committed analysis schema: project ${projectPath}, generation ${generation.requestId}, index ${semantic.version}/${semantic.generatorVersion}, local ${local.version}`);
    }
    return { generation, project: storedProject, index: semantic, localArchitecture: local };
  });
}

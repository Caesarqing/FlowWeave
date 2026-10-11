import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArchitectureAnalysisResult,
  AnalysisGenerationOptions,
  ArchitectureMap,
  ArchitectureReviewResponse,
  CodeflowProject,
  RuntimeAgentId,
  ToolRunResult,
} from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { readProjectProtocolSnapshot } from "../storage/flowweave-store";
import { startToolPlan } from "./agent-run.service";
import { registerProject } from "./project-registry.service";
import { readCommittedAnalysis, assertArtifactGeneration } from "./project-generation.service";
import { ArtifactGenerationMismatchError, GenerationSupersededError } from "./generation-errors";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { parseArchitectureReviewResponse } from "./structured-output.service";
import {
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
import {
  architectureMapToGraph, assessArchitectureMap, buildArchitectureInputFingerprint, buildStaticArchitecture, isCurrentAgentArchitecture
} from "./static-architecture.service";

export {
  aggregateArchitectureRelationships,
  architectureMapToGraph,
  assessArchitectureMap,
  buildArchitectureInputFingerprint,
  buildStaticArchitecture,
  validateArchitectureMap,
  type StaticArchitectureBuild
} from "./static-architecture.service";




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
  const committed = await loadAnalysisGeneration(project);
  const { index, localArchitecture } = committed;
  const scanFingerprint = committed.project.scanFingerprint!;
  const inputFingerprint = localArchitecture.metadata!.inputFingerprint;
  const localQuality = localArchitecture.metadata!;
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
      options?.resumeArchitectureReview?.runId,
      options?.timeoutMs
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
    persistLocal: () => assertArtifactGeneration(project.rootPath, "static-snapshot.json", localArchitecture),
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
  const snapshot = await readProjectProtocolSnapshot(projectPath);
  if (!snapshot) return undefined;
  const architecturePath = join(projectPath, FLOWWEAVE_DIR, "architecture-map.json");
  const value = await readJsonArtifact(architecturePath);
  if (value === undefined) return snapshot.localArchitecture;
  const architectureMap = value as ArchitectureMap;
  if (architectureMap.version !== 2 && architectureMap.version !== 3) {
    throw new Error(`FlowWeave architecture artifact must be v2 or v3. Regenerate it: ${architecturePath}`);
  }
  if (!isCurrentAgentArchitecture(architectureMap, snapshot.localArchitecture)) return snapshot.localArchitecture;
  try {
    await assertArtifactGeneration(projectPath, architecturePath, architectureMap);
  } catch (error) {
    if (!(error instanceof ArtifactGenerationMismatchError)) throw error;
    const latestSnapshot = await readProjectProtocolSnapshot(projectPath);
    if (!latestSnapshot) throw error;
    return latestSnapshot.localArchitecture;
  }
  return architectureMap;
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

export async function loadAnalysisGeneration(project: CodeflowProject) {
  const committed = await readCommittedAnalysis(project.rootPath);
  if (!committed) throw new Error(`Static project analysis has not completed: ${project.rootPath}`);
  if (committed.project.scanFingerprint !== project.scanFingerprint ||
      (project.generation && committed.generation.requestId !== project.generation.requestId)) {
    throw new GenerationSupersededError(project.rootPath, committed.generation.requestId, "the requested project generation is stale");
  }
  return committed;
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
  resumeRunId: string | undefined,
  timeoutMs: number | undefined
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
          timeoutMs,
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

export async function writeArchitectureArtifacts(projectPath: string, architectureMap: ArchitectureMap) {
  const root = join(projectPath, FLOWWEAVE_DIR);
  await assertArtifactGeneration(projectPath, "architecture-map.json", architectureMap);
  await writeJsonAtomic(join(root, "architecture-map.json"), architectureMap);
  await Promise.all([
    rm(join(root, "file-insights.json"), { force: true }),
    rm(join(root, "module-map.json"), { force: true })
  ]);
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
    version: 3,
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

function collectStdout(events: Array<{ type: string; content?: string }>) {
  return events.filter((event) => event.type === "stdout").map((event) => event.content ?? "").join("\n");
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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

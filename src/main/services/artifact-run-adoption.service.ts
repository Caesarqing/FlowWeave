import { join } from "node:path";
import type {
  ArchitectureReviewStatus,
  ArtifactAdoption,
  CodeflowProject,
  ProjectStructureFacts,
  RuntimeAgentId,
  SemanticIndex,
  SequenceDiagramBundle,
  SequenceReviewStatus,
  ToolRunResult
} from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { readJsonArtifact } from "../storage/artifact-store";
import {
  assessArchitectureMap,
  buildArchitectureInputFingerprint,
  readArchitectureMap,
  validateArchitectureMap,
  withArchitectureMetadata,
  writeArchitectureArtifacts
} from "./architecture-analysis.service";
import { adoptArchitectureReview, enhanceLocalArchitecture } from "./architecture-review.service";
import {
  buildArchitectureReviewPrompt,
  createArchitectureReviewPromptInput
} from "./architecture-review-prompt.service";
import { parseArchitectureReviewResponse } from "./structured-output.service";
import { scanProject } from "./project-scanner.service";
import { buildSemanticIndex, semanticIndexToStructureFacts } from "./semantic-index.service";
import {
  parseSequenceDiagramBundleJson,
  parseSequenceDiagramJson,
  readSequenceDiagrams,
  validateSequenceBundle,
  withSequenceMetadata,
  writeSequenceDiagramBundle
} from "./sequence-diagram.service";
import {
  compareSequenceBundles,
  readSequenceReviewStatus,
  writeSequenceReviewStatus
} from "./sequence-review.service";

export type ArtifactRunAdoptionMode = "auto" | "manual";

export async function adoptArtifactRun(
  projectPath: string,
  result: Partial<ToolRunResult>,
  output: string,
  mode: ArtifactRunAdoptionMode
): Promise<ArtifactAdoption> {
  if (result.purpose !== "artifact-analysis") {
    return { status: "not-applicable", message: "Run is not an artifact-analysis run." };
  }
  if (result.status !== "completed") {
    return { status: "pending", message: "Waiting for Agent response before applying artifact output." };
  }
  if (!result.artifactTarget) {
    return { status: "rejected", message: "Run is missing an artifact target." };
  }
  if (!output.trim()) {
    return { status: "rejected", message: "Run completed without artifact output." };
  }

  if (result.artifactTarget === "architecture-map") {
    return adoptArchitectureRun(projectPath, result, output);
  }
  if (result.artifactTarget === "sequence-diagrams" || result.artifactTarget === "sequence-revision") {
    return adoptSequenceRun(projectPath, result, output, mode);
  }
  return { status: "rejected", message: `Unsupported artifact target: ${result.artifactTarget}` };
}

async function adoptArchitectureRun(
  projectPath: string,
  result: Partial<ToolRunResult>,
  output: string
): Promise<ArtifactAdoption> {
  const project = await scanProject(projectPath);
  const { facts, index, scanFingerprint } = await adoptionFacts(project);
  const stale = await staleScanMessage(projectPath, scanFingerprint);
  if (stale) return stale;
  if (result.scanFingerprint !== scanFingerprint) {
    return { status: "stale", message: "Run completed but not applied because the project scan changed." };
  }
  if (!result.inputFingerprint) {
    return { status: "rejected", message: "Run is missing its architecture input fingerprint." };
  }
  const inputFingerprint = buildArchitectureInputFingerprint(scanFingerprint, index);
  if (result.inputFingerprint !== inputFingerprint) {
    return { status: "stale", message: "Run completed but not applied because the architecture analysis input changed." };
  }
  if (!result.projectId || !result.reviewId || !result.id || !result.toolId) {
    return { status: "rejected", message: "Run is missing architecture review identity metadata." };
  }

  const localValue = await readJsonArtifact(join(projectPath, FLOWWEAVE_DIR, "architecture-local.json"));
  if (!isArchitectureMap(localValue) || localValue.source !== "local") {
    return { status: "rejected", message: "Current local architecture baseline is missing or invalid." };
  }
  const quality = validateArchitectureMap(localValue, facts);
  let reviewResponse;
  try {
    const prompt = buildArchitectureReviewPrompt(createArchitectureReviewPromptInput(localValue, index));
    reviewResponse = parseArchitectureReviewResponse(output, prompt);
  } catch (error) {
    return {
      status: "rejected",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  const architectureMap = assessArchitectureMap(
    withArchitectureMetadata(
      enhanceLocalArchitecture(localValue, reviewResponse),
      runAgentId(result),
      result.id,
      scanFingerprint,
      inputFingerprint,
      result.reviewId,
      quality
    ),
    index,
    inputFingerprint
  );
  const adoption = await adoptArchitectureReview({
    projectPath,
    projectId: result.projectId,
    artifactTarget: "architecture-map",
    scanFingerprint,
    inputFingerprint,
    agentId: runAgentId(result),
    reviewId: result.reviewId,
    runId: result.id,
    architectureMap,
    localArchitecture: localValue,
    persist: (map) => writeArchitectureArtifacts(projectPath, map)
  });
  if (adoption.status === "stale" || adoption.status === "rejected") return adoption;
  const recoveryMessage = adoption.stateRecovered
    ? " Review state was recovered from the persisted architecture map."
    : "";
  const warningMessage = adoption.warning ? ` ${adoption.warning}` : "";
  return {
    status: "applied",
    message: `Run completed and applied to module graph.${recoveryMessage}${warningMessage}`,
    appliedAt: architectureMap.generatedAt,
    stateRecovered: adoption.stateRecovered,
    warning: adoption.warning
  };
}

async function adoptSequenceRun(
  projectPath: string,
  result: Partial<ToolRunResult>,
  output: string,
  mode: ArtifactRunAdoptionMode
): Promise<ArtifactAdoption> {
  const project = await scanProject(projectPath);
  const { facts, scanFingerprint } = await adoptionFacts(project);
  const inputFingerprint = result.scanFingerprint ?? scanFingerprint;
  const stale = await staleScanMessage(projectPath, scanFingerprint);
  if (stale) return stale;
  if (result.scanFingerprint && result.scanFingerprint !== scanFingerprint) {
    return { status: "stale", message: "Run completed but not applied because the project scan changed." };
  }
  const activeReview = await readSequenceReviewStatus(projectPath, inputFingerprint);
  const reviewMismatch = reviewMismatchMessage(activeReview, result, mode);
  if (reviewMismatch) return reviewMismatch;

  const architectureMap = await readArchitectureMap(projectPath);
  const parsed = result.artifactTarget === "sequence-revision"
    ? await revisedSequenceBundle(projectPath, output)
    : parseSequenceDiagramBundleJson(output, project, facts, architectureMap);
  const quality = parsed ? validateSequenceBundle(parsed, facts) : undefined;
  if (!parsed || !quality?.valid) {
    return {
      status: "rejected",
      message: quality?.reasons.join("; ") || "Run completed but artifact JSON failed validation."
    };
  }

  const bundle = withSequenceMetadata(
    parsed,
    runAgentId(result),
    result.id ?? "unknown-run",
    inputFingerprint,
    quality
  );
  const previous = await readSequenceDiagrams(projectPath);
  await writeSequenceDiagramBundle(projectPath, bundle, undefined);
  await writeSequenceReviewStatus(projectPath, {
    state: "reviewed",
    reviewId: result.reviewId ?? activeReview.reviewId,
    scanFingerprint: inputFingerprint,
    agentId: runAgentId(result),
    runId: result.id,
    completedAt: bundle.generatedAt,
    diff: previous ? compareSequenceBundles(previous, bundle) : undefined
  });
  return {
    status: "applied",
    message: result.artifactTarget === "sequence-revision"
      ? "Run completed and applied to sequence revision."
      : "Run completed and applied to sequence diagrams.",
    appliedAt: bundle.generatedAt
  };
}

async function revisedSequenceBundle(projectPath: string, output: string): Promise<SequenceDiagramBundle | undefined> {
  const current = await readSequenceDiagrams(projectPath);
  if (!current) return undefined;
  const diagram = parseSequenceDiagramJson(output);
  if (!diagram) return undefined;
  return {
    ...current,
    generatedAt: new Date().toISOString(),
    source: "agent",
    architectural: diagram
  };
}

async function adoptionFacts(
  project: CodeflowProject
): Promise<{
  facts: ProjectStructureFacts;
  index: SemanticIndex;
  scanFingerprint: string;
}> {
  const { index } = await buildSemanticIndex(project);
  const facts = semanticIndexToStructureFacts(project, index);
  if (!project.scanFingerprint) {
    throw new Error(`Project scan fingerprint is missing for ${project.rootPath}.`);
  }
  return { facts, index, scanFingerprint: project.scanFingerprint };
}

async function staleScanMessage(projectPath: string, inputFingerprint: string): Promise<ArtifactAdoption | undefined> {
  const value = await readJsonArtifact(join(projectPath, FLOWWEAVE_DIR, "project.json"));
  if (value && typeof value === "object" && "scanFingerprint" in value && value.scanFingerprint !== inputFingerprint) {
    return {
      status: "stale",
      message: "Run completed but not applied because the project scan changed."
    };
  }
  return undefined;
}

function reviewMismatchMessage(
  status: ArchitectureReviewStatus | SequenceReviewStatus,
  result: Partial<ToolRunResult>,
  mode: ArtifactRunAdoptionMode
): ArtifactAdoption | undefined {
  if (mode === "manual") return undefined;
  if (!result.reviewId) return undefined;
  if (status.reviewId && status.reviewId !== result.reviewId) {
    return {
      status: "stale",
      message: "Run completed but not applied because a newer review is active."
    };
  }
  if (status.runId && result.id && status.runId !== result.id && status.state === "reviewed") {
    return {
      status: "stale",
      message: "Run completed but not applied because another run was already applied."
    };
  }
  return undefined;
}

function runAgentId(result: Partial<ToolRunResult>): RuntimeAgentId {
  return result.toolId ?? "mock";
}

function isArchitectureMap(value: unknown): value is import("../../types").ArchitectureMap {
  return typeof value === "object" && value !== null &&
    "version" in value && "modules" in value && "relationships" in value;
}

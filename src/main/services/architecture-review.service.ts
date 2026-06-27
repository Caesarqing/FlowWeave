import { join } from "node:path";
import type {
  ArchitectureDiffCounts,
  ArchitectureMap,
  ArchitectureReviewError,
  ArchitectureReviewEvent,
  ArchitectureReviewStatus,
  RuntimeAgentId
} from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";

const REVIEW_STATE_FILENAME = "architecture-review.json";
const activeReviewIds = new Set<string>();

export type ArchitectureReviewRunResult =
  | {
      outcome: "reviewed";
      architectureMap: ArchitectureMap;
      runId: string;
    }
  | {
      outcome: "failed";
      error: ArchitectureReviewError;
      runId?: string;
    };

export type StartArchitectureReviewInput = {
  projectId: string;
  projectPath: string;
  reviewId: string;
  scanFingerprint: string;
  agentId: RuntimeAgentId;
  localArchitecture: ArchitectureMap;
  startedAt: string;
  run: (onRunId: (runId: string) => Promise<void>) => Promise<ArchitectureReviewRunResult>;
  persist: (architectureMap: ArchitectureMap) => Promise<void>;
  toGraph: (architectureMap: ArchitectureMap) => ArchitectureReviewEvent["graph"];
  onEvent: (event: ArchitectureReviewEvent) => void;
};

export async function startArchitectureReview(input: StartArchitectureReviewInput): Promise<ArchitectureReviewStatus> {
  const reviewing: ArchitectureReviewStatus = {
    state: "reviewing",
    reviewId: input.reviewId,
    scanFingerprint: input.scanFingerprint,
    agentId: input.agentId,
    startedAt: input.startedAt
  };
  await writeArchitectureReviewStatus(input.projectPath, reviewing);
  input.onEvent(reviewEvent(input, reviewing));

  activeReviewIds.add(input.reviewId);
  void completeArchitectureReview(input, reviewing)
    .finally(() => activeReviewIds.delete(input.reviewId));
  return reviewing;
}

export function isArchitectureReviewActive(reviewId: string): boolean {
  return activeReviewIds.has(reviewId);
}

export async function readArchitectureReviewStatus(
  projectPath: string,
  scanFingerprint: string
): Promise<ArchitectureReviewStatus> {
  const value = await readJsonArtifact(reviewStatePath(projectPath));
  if (!isArchitectureReviewStatus(value)) {
    return deriveReviewStatusFromArchitecture(projectPath, scanFingerprint);
  }
  if (value.scanFingerprint && value.scanFingerprint !== scanFingerprint) {
    return { ...value, state: "stale" };
  }
  if (value.state === "reviewed") {
    const derived = await deriveReviewStatusFromArchitecture(projectPath, scanFingerprint);
    if (derived.state !== "reviewed") return derived;
  }
  return value;
}

export async function writeArchitectureReviewStatus(
  projectPath: string,
  status: ArchitectureReviewStatus
): Promise<void> {
  await writeJsonAtomic(reviewStatePath(projectPath), status);
}

export function compareArchitectureMaps(
  local: ArchitectureMap,
  reviewed: ArchitectureMap
): ArchitectureDiffCounts {
  return {
    modules: compareById(local.modules, reviewed.modules),
    relationships: compareById(local.relationships, reviewed.relationships)
  };
}

function compareById<T extends { id: string }>(
  local: T[],
  reviewed: T[]
): { added: number; removed: number; modified: number } {
  const localById = new Map(local.map((item) => [item.id, item]));
  const reviewedById = new Map(reviewed.map((item) => [item.id, item]));
  let added = 0;
  let removed = 0;
  let modified = 0;

  for (const [id, reviewedItem] of reviewedById) {
    const localItem = localById.get(id);
    if (!localItem) {
      added += 1;
      continue;
    }
    if (stableJson(localItem) !== stableJson(reviewedItem)) {
      modified += 1;
    }
  }

  for (const id of localById.keys()) {
    if (!reviewedById.has(id)) {
      removed += 1;
    }
  }

  return { added, removed, modified };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)])
  );
}

async function completeArchitectureReview(
  input: StartArchitectureReviewInput,
  reviewing: ArchitectureReviewStatus
): Promise<void> {
  try {
    const result = await input.run(async (runId) => {
      const running = { ...reviewing, runId };
      await writeArchitectureReviewStatus(input.projectPath, running);
      input.onEvent(reviewEvent(input, running));
    });
    if (result.outcome === "failed") {
      const failed: ArchitectureReviewStatus = {
        ...reviewing,
        state: "review-failed",
        runId: result.runId,
        completedAt: new Date().toISOString(),
        error: result.error
      };
      await writeArchitectureReviewStatus(input.projectPath, failed);
      input.onEvent(reviewEvent(input, failed));
      return;
    }
    await input.persist(result.architectureMap);
    const reviewed: ArchitectureReviewStatus = {
      ...reviewing,
      state: "reviewed",
      runId: result.runId,
      completedAt: result.architectureMap.generatedAt,
      diff: compareArchitectureMaps(input.localArchitecture, result.architectureMap)
    };
    await writeArchitectureReviewStatus(input.projectPath, reviewed);
    input.onEvent({
      ...reviewEvent(input, reviewed),
      architectureMap: result.architectureMap,
      graph: input.toGraph(result.architectureMap)
    });
  } catch (error) {
    const failed: ArchitectureReviewStatus = {
      ...reviewing,
      state: "review-failed",
      completedAt: new Date().toISOString(),
      error: {
        code: "persistence-failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
    await writeArchitectureReviewStatus(input.projectPath, failed).catch(() => undefined);
    input.onEvent(reviewEvent(input, failed));
  }
}

function reviewEvent(
  input: StartArchitectureReviewInput,
  status: ArchitectureReviewStatus
): ArchitectureReviewEvent {
  return {
    projectId: input.projectId,
    reviewId: input.reviewId,
    scanFingerprint: input.scanFingerprint,
    status
  };
}

function reviewStatePath(projectPath: string): string {
  return join(projectPath, FLOWWEAVE_DIR, REVIEW_STATE_FILENAME);
}

function isArchitectureReviewStatus(value: unknown): value is ArchitectureReviewStatus {
  if (typeof value !== "object" || value === null || !("state" in value)) return false;
  return (
    value.state === "local" ||
    value.state === "reviewing" ||
    value.state === "reviewed" ||
    value.state === "review-failed" ||
    value.state === "stale" ||
    value.state === "missing"
  );
}

async function deriveReviewStatusFromArchitecture(
  projectPath: string,
  scanFingerprint: string
): Promise<ArchitectureReviewStatus> {
  const value = await readJsonArtifact(join(projectPath, FLOWWEAVE_DIR, "architecture-map.json"));
  if (typeof value !== "object" || value === null) {
    return { state: "missing", scanFingerprint };
  }
  const source = "source" in value ? value.source : undefined;
  const metadata = "metadata" in value && typeof value.metadata === "object" && value.metadata !== null
    ? value.metadata
    : undefined;
  const inputFingerprint = metadata && "inputFingerprint" in metadata
    ? metadata.inputFingerprint
    : undefined;
  if (typeof inputFingerprint === "string" && inputFingerprint !== scanFingerprint) {
    return { state: "stale", scanFingerprint: inputFingerprint };
  }
  if (source !== "agent" || typeof inputFingerprint !== "string") {
    return { state: "local", scanFingerprint };
  }
  return {
    state: "reviewed",
    scanFingerprint,
    agentId: metadata && "agentId" in metadata && typeof metadata.agentId === "string"
      ? metadata.agentId as RuntimeAgentId
      : undefined,
    runId: metadata && "runId" in metadata && typeof metadata.runId === "string"
      ? metadata.runId
      : undefined,
    completedAt: metadata && "generatedAt" in metadata && typeof metadata.generatedAt === "string"
      ? metadata.generatedAt
      : undefined
  };
}

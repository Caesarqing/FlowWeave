import { join } from "node:path";
import type {
  RuntimeAgentId,
  SequenceDiagramBundle,
  SequenceDiffCounts,
  SequenceReviewError,
  SequenceReviewEvent,
  SequenceReviewStatus
} from "../../types";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

const REVIEW_STATE_FILENAME = "sequence-review.json";
const activeReviewIds = new Set<string>();

export type SequenceReviewRunResult =
  | {
      outcome: "reviewed";
      bundle: SequenceDiagramBundle;
      runId: string;
    }
  | {
      outcome: "failed";
      error: SequenceReviewError;
      runId?: string;
    };

export type StartSequenceReviewInput = {
  projectId: string;
  projectPath: string;
  reviewId: string;
  scanFingerprint: string;
  agentId: RuntimeAgentId;
  localBundle: SequenceDiagramBundle;
  startedAt: string;
  run: (onRunId: (runId: string) => Promise<void>) => Promise<SequenceReviewRunResult>;
  persist: (bundle: SequenceDiagramBundle) => Promise<void>;
  onEvent: (event: SequenceReviewEvent) => void;
};

export async function startSequenceReview(input: StartSequenceReviewInput): Promise<SequenceReviewStatus> {
  const reviewing: SequenceReviewStatus = {
    state: "reviewing",
    reviewId: input.reviewId,
    scanFingerprint: input.scanFingerprint,
    agentId: input.agentId,
    startedAt: input.startedAt
  };
  await writeSequenceReviewStatus(input.projectPath, reviewing);
  input.onEvent(reviewEvent(input, reviewing));

  activeReviewIds.add(input.reviewId);
  void completeSequenceReview(input, reviewing)
    .finally(() => activeReviewIds.delete(input.reviewId));
  return reviewing;
}

export function isSequenceReviewActive(reviewId: string): boolean {
  return activeReviewIds.has(reviewId);
}

export async function readSequenceReviewStatus(
  projectPath: string,
  scanFingerprint: string
): Promise<SequenceReviewStatus> {
  const value = await readJsonArtifact(reviewStatePath(projectPath));
  if (!isSequenceReviewStatus(value)) {
    return deriveReviewStatusFromBundle(projectPath, scanFingerprint);
  }
  const derived = await deriveReviewStatusFromBundle(projectPath, scanFingerprint);
  if (!value.scanFingerprint) return derived;
  if (value.scanFingerprint !== scanFingerprint) {
    return { ...value, state: "stale" };
  }
  if (value.state === "local" || value.state === "reviewed") {
    if (derived.state !== value.state) return derived;
  }
  return value;
}

export async function writeSequenceReviewStatus(
  projectPath: string,
  status: SequenceReviewStatus
): Promise<void> {
  await writeJsonAtomic(reviewStatePath(projectPath), status);
}

export function compareSequenceBundles(
  local: SequenceDiagramBundle,
  reviewed: SequenceDiagramBundle
): SequenceDiffCounts {
  return {
    participants: compareById(local.architectural.participants, reviewed.architectural.participants),
    messages: compareById(local.architectural.messages, reviewed.architectural.messages)
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
    } else if (stableJson(localItem) !== stableJson(reviewedItem)) {
      modified += 1;
    }
  }
  for (const id of localById.keys()) {
    if (!reviewedById.has(id)) removed += 1;
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

async function completeSequenceReview(
  input: StartSequenceReviewInput,
  reviewing: SequenceReviewStatus
): Promise<void> {
  let result: SequenceReviewRunResult;
  try {
    result = await input.run(async (runId) => {
      const running = { ...reviewing, runId };
      await writeSequenceReviewStatus(input.projectPath, running);
      input.onEvent(reviewEvent(input, running));
    });
  } catch (error) {
    await publishFailedReview(input, reviewing, {
      code: "agent-failed",
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  if (result.outcome === "failed") {
    await publishFailedReview(input, reviewing, result.error, result.runId);
    return;
  }
  try {
    await input.persist(result.bundle);
    const reviewed: SequenceReviewStatus = {
      ...reviewing,
      state: "reviewed",
      runId: result.runId,
      completedAt: result.bundle.generatedAt,
      diff: compareSequenceBundles(input.localBundle, result.bundle)
    };
    await writeSequenceReviewStatus(input.projectPath, reviewed);
    input.onEvent({
      ...reviewEvent(input, reviewed),
      bundle: result.bundle
    });
  } catch (error) {
    const failed: SequenceReviewStatus = {
      ...reviewing,
      state: "review-failed",
      completedAt: new Date().toISOString(),
      error: {
        code: "persistence-failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
    await writeSequenceReviewStatus(input.projectPath, failed).catch(() => undefined);
    input.onEvent(reviewEvent(input, failed));
  }
}

async function publishFailedReview(
  input: StartSequenceReviewInput,
  reviewing: SequenceReviewStatus,
  error: SequenceReviewError,
  runId?: string
): Promise<void> {
  const failed: SequenceReviewStatus = {
    ...reviewing,
    state: "review-failed",
    runId,
    completedAt: new Date().toISOString(),
    error
  };
  await writeSequenceReviewStatus(input.projectPath, failed);
  input.onEvent(reviewEvent(input, failed));
}

function reviewEvent(
  input: StartSequenceReviewInput,
  status: SequenceReviewStatus
): SequenceReviewEvent {
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

function isSequenceReviewStatus(value: unknown): value is SequenceReviewStatus {
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

async function deriveReviewStatusFromBundle(
  projectPath: string,
  scanFingerprint: string
): Promise<SequenceReviewStatus> {
  const value = await readJsonArtifact(join(projectPath, FLOWWEAVE_DIR, "sequence-diagrams.json"));
  if (typeof value !== "object" || value === null) {
    return { state: "missing", scanFingerprint };
  }
  if (!("version" in value) || value.version !== 2) {
    throw new Error(`FlowWeave sequence diagram artifact must be v2. Regenerate it: ${join(projectPath, FLOWWEAVE_DIR, "sequence-diagrams.json")}`);
  }
  const source = "source" in value ? value.source : undefined;
  const metadata = "metadata" in value && typeof value.metadata === "object" && value.metadata !== null
    ? value.metadata
    : undefined;
  const inputFingerprint = metadata && "inputFingerprint" in metadata
    ? metadata.inputFingerprint
    : undefined;
  if (typeof inputFingerprint !== "string") {
    return { state: "stale" };
  }
  if (inputFingerprint !== scanFingerprint) {
    return { state: "stale", scanFingerprint: inputFingerprint };
  }
  if (source !== "agent") {
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

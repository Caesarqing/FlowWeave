import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
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
const ARCHITECTURE_MAP_FILENAME = "architecture-map.json";
const ARCHITECTURE_LOCAL_FILENAME = "architecture-local.json";
const activeReviewIds = new Set<string>();
const artifactLocks = new Map<string, Promise<void>>();

export type ArchitectureInputFingerprintParts = {
  scanFingerprint: string;
  semanticIndexSchemaVersion: number;
  semanticIndexGeneratorVersion: string;
  moduleClusteringConfigVersion: string;
  architectureGeneratorVersion: string;
  reviewContractVersion: string;
};

export type ArchitectureReviewKey = {
  projectId: string;
  artifactTarget: "architecture-map";
  scanFingerprint: string;
  inputFingerprint: string;
  agentId: RuntimeAgentId;
};

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

export type StartArchitectureReviewInput = ArchitectureReviewKey & {
  projectPath: string;
  reviewId: string;
  localArchitecture: ArchitectureMap;
  startedAt: string;
  resume?: boolean;
  persistLocal: () => Promise<void>;
  run: (onRunId: (runId: string) => Promise<void>) => Promise<ArchitectureReviewRunResult>;
  persist: (architectureMap: ArchitectureMap) => Promise<void>;
  toGraph: (architectureMap: ArchitectureMap) => ArchitectureReviewEvent["graph"];
  onEvent: (event: ArchitectureReviewEvent) => void;
  onAdoption?: (
    runId: string,
    outcome: "applied" | "stale" | "rejected",
    message: string
  ) => Promise<void>;
};

export type AdoptArchitectureReviewInput = ArchitectureReviewKey & {
  projectPath: string;
  reviewId: string;
  runId: string;
  architectureMap: ArchitectureMap;
  localArchitecture: ArchitectureMap;
  persist: (architectureMap: ArchitectureMap) => Promise<void>;
};

export type ArchitectureReviewAdoption =
  | { status: "applied" | "reused"; architectureMap: ArchitectureMap }
  | { status: "stale"; message: string }
  | { status: "rejected"; message: string };

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

export function createArchitectureInputFingerprint(parts: ArchitectureInputFingerprintParts): string {
  const input = [
    parts.scanFingerprint,
    parts.semanticIndexSchemaVersion,
    parts.semanticIndexGeneratorVersion,
    parts.moduleClusteringConfigVersion,
    parts.architectureGeneratorVersion,
    parts.reviewContractVersion
  ];
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function withArchitectureArtifactLock<T>(
  projectPath: string,
  action: () => Promise<T>
): Promise<T> {
  const key = `${resolve(projectPath)}:${"architecture-map"}`;
  const previous = artifactLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  artifactLocks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (artifactLocks.get(key) === current) artifactLocks.delete(key);
  }
}

export async function startArchitectureReview(input: StartArchitectureReviewInput): Promise<ArchitectureReviewStatus> {
  const start = await withArchitectureArtifactLock(input.projectPath, async () => {
    const stored = await readStoredArchitectureReviewStatus(input.projectPath);
    if (stored?.state === "reviewing" && isSameReviewKey(stored, input)) {
      const existingId = stored.reviewId;
      if (!existingId) return { status: stored, shouldStart: false };
      if (input.resume === true && !activeReviewIds.has(existingId)) {
        return { status: stored, shouldStart: true };
      }
      return { status: stored, shouldStart: false };
    }

    await input.persistLocal();
    const reviewing: ArchitectureReviewStatus = {
      state: "reviewing",
      ...reviewKey(input),
      reviewId: input.reviewId,
      startedAt: input.startedAt,
      message: "Agent enhancement is running in the background."
    };
    await writeArchitectureReviewStatusUnlocked(input.projectPath, reviewing);
    return { status: reviewing, shouldStart: true };
  });

  if (!start.shouldStart) return start.status;
  const reviewId = start.status.reviewId;
  if (!reviewId) return start.status;
  activeReviewIds.add(reviewId);
  input.onEvent(reviewEvent(input.projectId, reviewId, input.scanFingerprint, start.status));
  void completeArchitectureReview(input, start.status)
    .finally(() => activeReviewIds.delete(reviewId));
  return start.status;
}

export function isArchitectureReviewActive(reviewId: string): boolean {
  return activeReviewIds.has(reviewId);
}

export async function readArchitectureReviewStatus(
  projectPath: string,
  fingerprints: Pick<ArchitectureReviewKey, "scanFingerprint" | "inputFingerprint">
): Promise<ArchitectureReviewStatus> {
  return withArchitectureArtifactLock(projectPath, () => readArchitectureReviewStatusUnlocked(projectPath, fingerprints));
}

export async function writeArchitectureReviewStatus(
  projectPath: string,
  status: ArchitectureReviewStatus
): Promise<void> {
  await withArchitectureArtifactLock(projectPath, () => writeArchitectureReviewStatusUnlocked(projectPath, status));
}

export async function adoptArchitectureReview(
  input: AdoptArchitectureReviewInput
): Promise<ArchitectureReviewAdoption> {
  return withArchitectureArtifactLock(input.projectPath, async () => {
    const current = await readStoredArchitectureReviewStatus(input.projectPath);
    if (!current || !isCurrentReview(current, input)) {
      return { status: "stale", message: "Run completed but not applied because a newer review is active." };
    }
    if (current.state === "reviewed" && current.runId === input.runId) {
      return { status: "reused", architectureMap: input.architectureMap };
    }
    if (current.state !== "reviewing") {
      return { status: "stale", message: "Run completed but not applied because its review is no longer active." };
    }

    const currentScanFingerprint = await readProjectScanFingerprint(input.projectPath);
    if (!currentScanFingerprint) {
      return { status: "rejected", message: "Current project scan fingerprint is missing or invalid." };
    }
    if (currentScanFingerprint !== input.scanFingerprint) {
      return { status: "stale", message: "Run completed but not applied because the project scan changed." };
    }
    const localArtifact = await readJsonArtifact(join(input.projectPath, FLOWWEAVE_DIR, ARCHITECTURE_LOCAL_FILENAME));
    if (
      !isArchitectureMap(localArtifact) ||
      localArtifact.source !== "local" ||
      localArtifact.metadata?.source !== "local"
    ) {
      return { status: "rejected", message: "Current local architecture baseline is missing or invalid." };
    }
    const localFingerprint = artifactInputFingerprint(localArtifact);
    const localScanFingerprint = artifactScanFingerprint(localArtifact);
    if (!localFingerprint || !localScanFingerprint) {
      return { status: "rejected", message: "Current local architecture baseline is missing fingerprint metadata." };
    }
    if (localScanFingerprint !== input.scanFingerprint || localFingerprint !== input.inputFingerprint) {
      return { status: "stale", message: "Run completed but not applied because the local architecture baseline changed." };
    }
    const invalid = validateArchitectureReviewArtifact(input);
    if (invalid) return { status: "rejected", message: invalid };

    const localArchitecture = localArtifact;
    const architectureMap = {
      ...enhanceLocalArchitecture(localArchitecture, input.architectureMap),
      generatedAt: input.architectureMap.generatedAt,
      metadata: input.architectureMap.metadata
    };
    await input.persist(architectureMap);
    const reviewed: ArchitectureReviewStatus = {
      ...reviewKey(input),
      state: "reviewed",
      reviewId: input.reviewId,
      agentId: input.agentId,
      runId: input.runId,
      startedAt: current.startedAt,
      completedAt: architectureMap.generatedAt,
      diff: compareArchitectureMaps(localArchitecture, architectureMap)
    };
    await writeArchitectureReviewStatusUnlocked(input.projectPath, reviewed);
    return { status: "applied", architectureMap };
  });
}

export async function markArchitectureReviewFailedIfCurrent(
  projectPath: string,
  identity: ArchitectureReviewKey & { reviewId: string; runId?: string },
  error: ArchitectureReviewError
): Promise<boolean> {
  return withArchitectureArtifactLock(projectPath, async () => {
    const current = await readStoredArchitectureReviewStatus(projectPath);
    if (!current || !isCurrentReview(current, identity) || current.state !== "reviewing") return false;
    await writeArchitectureReviewStatusUnlocked(projectPath, {
      ...reviewKey(identity),
      state: "review-failed",
      reviewId: identity.reviewId,
      agentId: identity.agentId,
      runId: identity.runId ?? current.runId,
      startedAt: current.startedAt,
      completedAt: new Date().toISOString(),
      error
    });
    return true;
  });
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
    if (stableJson(localItem) !== stableJson(reviewedItem)) modified += 1;
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

async function completeArchitectureReview(
  input: StartArchitectureReviewInput,
  reviewing: ArchitectureReviewStatus
): Promise<void> {
  try {
    const result = await input.run(async (runId) => {
      const running = { ...reviewing, runId };
      const isCurrent = await withArchitectureArtifactLock(input.projectPath, async () => {
        const current = await readStoredArchitectureReviewStatus(input.projectPath);
        if (!current || !isCurrentReview(current, input) || current.state !== "reviewing") return false;
        await writeArchitectureReviewStatusUnlocked(input.projectPath, running);
        return true;
      });
      if (isCurrent) input.onEvent(reviewEvent(input.projectId, input.reviewId, input.scanFingerprint, running));
    });

    if (result.outcome === "failed") {
      const failed = await markArchitectureReviewFailedIfCurrent(
        input.projectPath,
        { ...reviewKey(input), reviewId: input.reviewId, runId: result.runId },
        result.error
      );
      if (failed) {
        if (result.runId) await input.onAdoption?.(result.runId, "rejected", result.error.message);
        const status = await readArchitectureReviewStatus(input.projectPath, input);
        input.onEvent(reviewEvent(input.projectId, input.reviewId, input.scanFingerprint, status));
      } else if (result.runId) {
        await input.onAdoption?.(result.runId, "stale", "Run completed but not applied because a newer review is active.");
      }
      return;
    }

    const adoption = await adoptArchitectureReview({
      ...reviewKey(input),
      projectPath: input.projectPath,
      reviewId: input.reviewId,
      runId: result.runId,
      architectureMap: result.architectureMap,
      localArchitecture: input.localArchitecture,
      persist: input.persist
    });
    if (adoption.status === "stale") {
      await input.onAdoption?.(result.runId, adoption.status, adoption.message);
      return;
    }
    if (adoption.status === "rejected") {
      await input.onAdoption?.(result.runId, "rejected", adoption.message);
      const failed = await markArchitectureReviewFailedIfCurrent(
        input.projectPath,
        { ...reviewKey(input), reviewId: input.reviewId, runId: result.runId },
        { code: "invalid-output", message: adoption.message }
      );
      if (failed) {
        const status = await readArchitectureReviewStatus(input.projectPath, input);
        input.onEvent(reviewEvent(input.projectId, input.reviewId, input.scanFingerprint, status));
      }
      return;
    }

    await input.onAdoption?.(result.runId, "applied", "Run completed and applied to module graph.");
    const reviewed = await readArchitectureReviewStatus(input.projectPath, input);
    input.onEvent({
      ...reviewEvent(input.projectId, input.reviewId, input.scanFingerprint, reviewed),
      architectureMap: adoption.architectureMap,
      graph: input.toGraph(adoption.architectureMap)
    });
  } catch (error) {
    const failure: ArchitectureReviewError = {
      code: "persistence-failed",
      message: error instanceof Error ? error.message : String(error)
    };
    const failed = await markArchitectureReviewFailedIfCurrent(
      input.projectPath,
      { ...reviewKey(input), reviewId: input.reviewId },
      failure
    );
    if (failed) {
      const status = await readArchitectureReviewStatus(input.projectPath, input);
      input.onEvent(reviewEvent(input.projectId, input.reviewId, input.scanFingerprint, status));
    }
  }
}

function reviewEvent(
  projectId: string,
  reviewId: string,
  scanFingerprint: string,
  status: ArchitectureReviewStatus
): ArchitectureReviewEvent {
  return { projectId, reviewId, scanFingerprint, status };
}

function reviewKey(input: ArchitectureReviewKey): ArchitectureReviewKey {
  return {
    projectId: input.projectId,
    artifactTarget: input.artifactTarget,
    scanFingerprint: input.scanFingerprint,
    inputFingerprint: input.inputFingerprint,
    agentId: input.agentId
  };
}

function isSameReviewKey(status: ArchitectureReviewStatus, input: ArchitectureReviewKey): boolean {
  return status.projectId === input.projectId &&
    status.artifactTarget === input.artifactTarget &&
    status.scanFingerprint === input.scanFingerprint &&
    status.inputFingerprint === input.inputFingerprint &&
    status.agentId === input.agentId;
}

function isCurrentReview(
  status: ArchitectureReviewStatus,
  input: ArchitectureReviewKey & { reviewId: string }
): boolean {
  return status.reviewId === input.reviewId && isSameReviewKey(status, input);
}

function validateArchitectureReviewArtifact(input: AdoptArchitectureReviewInput): string | undefined {
  const metadata = input.architectureMap.metadata;
  if (input.architectureMap.source !== "agent" || metadata?.source !== "agent") {
    return "Architecture review output must be an Agent artifact.";
  }
  if (metadata.inputFingerprint !== input.inputFingerprint || metadata.scanFingerprint !== input.scanFingerprint) {
    return "Architecture review output fingerprints do not match the active review.";
  }
  if (metadata.agentId !== input.agentId || metadata.runId !== input.runId || metadata.reviewId !== input.reviewId) {
    return "Architecture review output identity does not match the active review.";
  }
  return undefined;
}

async function readProjectScanFingerprint(projectPath: string): Promise<string | undefined> {
  const project = await readJsonArtifact(join(projectPath, FLOWWEAVE_DIR, "project.json"));
  if (project === undefined) return undefined;
  if (typeof project !== "object" || project === null || !("scanFingerprint" in project)) return "";
  return typeof project.scanFingerprint === "string" ? project.scanFingerprint : "";
}

async function readArchitectureReviewStatusUnlocked(
  projectPath: string,
  fingerprints: Pick<ArchitectureReviewKey, "scanFingerprint" | "inputFingerprint">
): Promise<ArchitectureReviewStatus> {
  const value = await readStoredArchitectureReviewStatus(projectPath);
  if (!value || !value.scanFingerprint || !value.inputFingerprint) {
    return deriveReviewStatusFromArchitecture(projectPath, fingerprints);
  }
  const derived = await deriveReviewStatusFromArchitecture(projectPath, fingerprints);
  if (value.scanFingerprint !== fingerprints.scanFingerprint || value.inputFingerprint !== fingerprints.inputFingerprint) {
    return { ...value, state: "stale" };
  }
  if (value.state === "local" || value.state === "reviewed") {
    if (derived.state !== value.state) return derived;
  }
  return value;
}

async function readStoredArchitectureReviewStatus(projectPath: string): Promise<ArchitectureReviewStatus | undefined> {
  const value = await readJsonArtifact(reviewStatePath(projectPath));
  return isArchitectureReviewStatus(value) ? value : undefined;
}

async function writeArchitectureReviewStatusUnlocked(
  projectPath: string,
  status: ArchitectureReviewStatus
): Promise<void> {
  await writeJsonAtomic(reviewStatePath(projectPath), status);
}

async function deriveReviewStatusFromArchitecture(
  projectPath: string,
  fingerprints: Pick<ArchitectureReviewKey, "scanFingerprint" | "inputFingerprint">
): Promise<ArchitectureReviewStatus> {
  const value = await readJsonArtifact(join(projectPath, FLOWWEAVE_DIR, ARCHITECTURE_MAP_FILENAME));
  if (typeof value !== "object" || value === null) {
    return { state: "missing", ...fingerprints };
  }
  const source = "source" in value ? value.source : undefined;
  const metadata = "metadata" in value && typeof value.metadata === "object" && value.metadata !== null
    ? value.metadata
    : undefined;
  const inputFingerprint = metadata && "inputFingerprint" in metadata && typeof metadata.inputFingerprint === "string"
    ? metadata.inputFingerprint
    : undefined;
  const scanFingerprint = metadata && "scanFingerprint" in metadata && typeof metadata.scanFingerprint === "string"
    ? metadata.scanFingerprint
    : inputFingerprint;
  if (!inputFingerprint || !scanFingerprint) return { state: "stale", ...fingerprints };
  if (inputFingerprint !== fingerprints.inputFingerprint || scanFingerprint !== fingerprints.scanFingerprint) {
    return { state: "stale", scanFingerprint, inputFingerprint };
  }
  if (source !== "agent") return { state: "local", ...fingerprints };
  return {
    state: "reviewed",
    ...fingerprints,
    reviewId: metadata && "reviewId" in metadata && typeof metadata.reviewId === "string" ? metadata.reviewId : undefined,
    agentId: metadata && "agentId" in metadata && typeof metadata.agentId === "string"
      ? metadata.agentId as RuntimeAgentId
      : undefined,
    runId: metadata && "runId" in metadata && typeof metadata.runId === "string" ? metadata.runId : undefined,
    completedAt: metadata && "generatedAt" in metadata && typeof metadata.generatedAt === "string"
      ? metadata.generatedAt
      : undefined
  };
}

function artifactInputFingerprint(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("metadata" in value)) return undefined;
  const metadata = value.metadata;
  if (typeof metadata !== "object" || metadata === null || !("inputFingerprint" in metadata)) return undefined;
  return typeof metadata.inputFingerprint === "string" ? metadata.inputFingerprint : undefined;
}

function artifactScanFingerprint(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("metadata" in value)) return undefined;
  const metadata = value.metadata;
  if (typeof metadata !== "object" || metadata === null || !("scanFingerprint" in metadata)) return undefined;
  return typeof metadata.scanFingerprint === "string" ? metadata.scanFingerprint : undefined;
}

function isArchitectureMap(value: unknown): value is ArchitectureMap {
  return typeof value === "object" && value !== null && "version" in value && "modules" in value && "relationships" in value;
}

function isArchitectureReviewStatus(value: unknown): value is ArchitectureReviewStatus {
  if (typeof value !== "object" || value === null || !("state" in value)) return false;
  return value.state === "local" ||
    value.state === "reviewing" ||
    value.state === "reviewed" ||
    value.state === "review-failed" ||
    value.state === "stale" ||
    value.state === "missing";
}

function reviewStatePath(projectPath: string): string {
  return join(projectPath, FLOWWEAVE_DIR, REVIEW_STATE_FILENAME);
}

function moduleFilesKey(module: ArchitectureMap["modules"][number]): string {
  return [...module.files].sort().join(String.fromCharCode(0));
}

import { basename, join } from "node:path";
import type {
  CodeflowCanvas,
  ModificationAcknowledgementScope,
  ModificationBaseline,
  ModificationDeltaResult,
  ModificationSnapshot
} from "../../types";
import {
  acknowledgeModificationDelta,
  buildModificationDelta,
  hasModificationDelta,
  normalizeModificationSnapshot
} from "../../utils/modification-delta";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

const MODIFICATION_BASELINE_FILE = "modification-baseline.json";

export async function readModificationDelta(
  projectPath: string,
  sequenceInstruction: string,
  canvas?: CodeflowCanvas
): Promise<ModificationDeltaResult> {
  const currentCanvas = canvas ?? await readCurrentCanvas(projectPath);
  const snapshot = normalizeModificationSnapshot(currentCanvas, sequenceInstruction);
  const baseline = await readOrInitializeBaseline(projectPath, snapshot, currentCanvas);
  const delta = buildModificationDelta(baseline, snapshot);
  return {
    baseline,
    snapshot,
    delta,
    hasChanges: hasModificationDelta(delta)
  };
}

export async function acknowledgeModificationChanges(
  projectPath: string,
  sentSnapshot: ModificationSnapshot,
  scope: ModificationAcknowledgementScope
): Promise<ModificationBaseline> {
  const baseline = await readBaseline(projectPath);
  if (!baseline) {
    throw new Error(`Modification baseline does not exist for project: ${projectPath}`);
  }
  const acknowledged = acknowledgeModificationDelta(
    baseline,
    sentSnapshot,
    scope,
    new Date().toISOString()
  );
  await writeJsonAtomic(baselinePath(projectPath), acknowledged);
  return acknowledged;
}

export function modificationBaselinePath(projectPath: string): string {
  return baselinePath(projectPath);
}

async function readOrInitializeBaseline(
  projectPath: string,
  snapshot: ModificationSnapshot,
  canvas: CodeflowCanvas
): Promise<ModificationBaseline> {
  const existing = await readBaseline(projectPath);
  if (existing) {
    if (snapshot.scanFingerprint && snapshot.scanFingerprint !== existing.scanFingerprint) {
      const reconciled = reconcileGeneratedAdditions(existing, snapshot, canvas);
      await writeJsonAtomic(baselinePath(projectPath), reconciled);
      return reconciled;
    }
    return existing;
  }
  const baseline: ModificationBaseline = {
    version: 1,
    acknowledgedAt: new Date().toISOString(),
    scanFingerprint: snapshot.scanFingerprint,
    canvas: snapshot.canvas,
    sequenceInstruction: undefined
  };
  await writeJsonAtomic(baselinePath(projectPath), baseline);
  return baseline;
}

function reconcileGeneratedAdditions(
  baseline: ModificationBaseline,
  snapshot: ModificationSnapshot,
  canvas: CodeflowCanvas
): ModificationBaseline {
  const baselineModuleIds = new Set(baseline.canvas.modules.map((module) => module.id));
  const baselineRelationIds = new Set(baseline.canvas.relations.map((relation) => relation.id));
  const userDraftModuleIds = new Set(
    canvas.nodes.filter((module) => module.status === "draft").map((module) => module.id)
  );
  const generatedRelationIds = new Set(
    canvas.edges.filter((relation) => Boolean(relation.evidence?.length)).map((relation) => relation.id)
  );
  return {
    ...baseline,
    scanFingerprint: snapshot.scanFingerprint,
    canvas: {
      modules: [
        ...baseline.canvas.modules,
        ...snapshot.canvas.modules.filter((module) =>
          !baselineModuleIds.has(module.id) && !userDraftModuleIds.has(module.id)
        )
      ].sort((left, right) => left.id.localeCompare(right.id)),
      relations: [
        ...baseline.canvas.relations,
        ...snapshot.canvas.relations.filter((relation) =>
          !baselineRelationIds.has(relation.id) && generatedRelationIds.has(relation.id)
        )
      ].sort((left, right) => left.id.localeCompare(right.id))
    }
  };
}

async function readBaseline(projectPath: string): Promise<ModificationBaseline | undefined> {
  const path = baselinePath(projectPath);
  const value = await readJsonArtifact(path);
  if (value === undefined) return undefined;
  if (!isModificationBaseline(value)) {
    throw new Error(`FlowWeave modification baseline is invalid and was preserved: ${path}`);
  }
  return value;
}

async function readCurrentCanvas(projectPath: string): Promise<CodeflowCanvas> {
  const path = join(projectPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
  let value: unknown;
  try {
    value = await readJsonArtifact(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("FlowWeave artifact is unreadable and was preserved:")) {
      return emptyCanvas(projectPath);
    }
    throw error;
  }
  if (!value || typeof value !== "object") {
    return emptyCanvas(projectPath);
  }
  const canvas = value as Partial<CodeflowCanvas>;
  if (canvas.version !== 5) throw new Error(`FlowWeave Canvas must be v5. Re-scan the project to rebuild it: ${path}`);
  return canvas as CodeflowCanvas;
}

function emptyCanvas(projectPath: string): CodeflowCanvas {
  return {
    version: 5,
    id: "main",
    title: "Main Canvas",
    projectPath,
    generatedAt: new Date(0).toISOString(),
    artifactState: "current",
    nodes: [],
    edges: []
  };
}

function baselinePath(projectPath: string): string {
  return join(projectPath, FLOWWEAVE_DIR, MODIFICATION_BASELINE_FILE);
}

function isModificationBaseline(value: unknown): value is ModificationBaseline {
  if (!value || typeof value !== "object") return false;
  const baseline = value as Partial<ModificationBaseline>;
  return baseline.version === 1 &&
    typeof baseline.acknowledgedAt === "string" &&
    Boolean(baseline.canvas) &&
    Array.isArray(baseline.canvas?.modules) &&
    Array.isArray(baseline.canvas?.relations);
}

export function modificationProjectLabel(projectPath: string): string {
  return basename(projectPath);
}

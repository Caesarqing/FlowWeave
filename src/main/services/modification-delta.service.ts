import { assertArtifactGeneration } from "./project-generation.service";
import { withArchitectureArtifactLock } from "./architecture-review.service";
import type { StoredCanvas } from "./canvas-migration.service";
import { basename, join } from "node:path";
import type {
  ArchitectureMap,
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
  migrateModificationBaseline,
  normalizeModificationSnapshot
} from "../../utils/modification-delta";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { architectureMapToGraph } from "./static-architecture.service";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

const MODIFICATION_BASELINE_FILE = "modification-baseline.json";

export async function readModificationDelta(
  projectPath: string,
  sequenceInstruction: string,
  canvas?: CodeflowCanvas
): Promise<ModificationDeltaResult> {
  return withArchitectureArtifactLock(projectPath, async () => {
    const currentCanvas = canvas ?? await readCurrentCanvas(projectPath);
    await assertArtifactGeneration(projectPath, "canvas/main.canvas.json", currentCanvas);
    const snapshot = normalizeModificationSnapshot(currentCanvas, sequenceInstruction);
    const existing = await readBaseline(projectPath);
    if (currentCanvas.generation && !existing) throw new Error(`Committed modification baseline is missing: project ${projectPath}, generation ${currentCanvas.generation.requestId}`);
    if (existing) await assertArtifactGeneration(projectPath, MODIFICATION_BASELINE_FILE, existing);
    const baseline: ModificationBaseline = existing ?? {
      ...(await readGeneratedSnapshot(projectPath, currentCanvas) ?? snapshot),
      generation: currentCanvas.generation, version: 1, graphModelVersion: currentCanvas.version,
      acknowledgedAt: new Date(0).toISOString(), sequenceInstruction: undefined
    };
    const delta = buildModificationDelta(baseline, snapshot);
    return { baseline, snapshot, delta, hasChanges: hasModificationDelta(delta) };
  });
}

/** Called under the artifact lock; prepares the independent confirmation baseline without acknowledging edits. */
export async function prepareModificationBaseline(
  projectPath: string, canvas: CodeflowCanvas, generatedCanvas: CodeflowCanvas
): Promise<ModificationBaseline> {
  const existing = await readBaseline(projectPath);
  const current = normalizeModificationSnapshot(canvas, "");
  const generated = normalizeModificationSnapshot(generatedCanvas, "");
  const baseline = existing ? migrateModificationBaseline(existing, current, generated) : {
    ...generated, version: 1 as const, graphModelVersion: 6, acknowledgedAt: new Date().toISOString()
  };
  return { ...baseline, generation: canvas.generation };
}

export async function acknowledgeModificationChanges(
  projectPath: string,
  sentSnapshot: ModificationSnapshot,
  scope: ModificationAcknowledgementScope
): Promise<ModificationBaseline> {
  return withArchitectureArtifactLock(projectPath, async () => {
    const canvas = await readCurrentCanvas(projectPath);
    if (canvas.version !== 6) throw new Error(`Legacy Canvas is read-only; re-scan before acknowledging changes: ${projectPath}`);
    await assertArtifactGeneration(projectPath, "canvas/main.canvas.json", canvas);
    await assertArtifactGeneration(projectPath, "acknowledgement snapshot", sentSnapshot);
    const baseline = await readBaseline(projectPath);
    if (!baseline) throw new Error(`Modification baseline does not exist for project: ${projectPath}`);
    await assertArtifactGeneration(projectPath, MODIFICATION_BASELINE_FILE, baseline);
    const acknowledged = acknowledgeModificationDelta(baseline, sentSnapshot, scope, new Date().toISOString());
    await writeJsonAtomic(baselinePath(projectPath), acknowledged);
    return acknowledged;
  });
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

async function readCurrentCanvas(projectPath: string): Promise<StoredCanvas> {
  const path = join(projectPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
  const value = await readJsonArtifact(path);
  if (value === undefined) return emptyCanvas(projectPath);
  if (!value || typeof value !== "object") throw new Error(`FlowWeave Canvas is invalid and was preserved: ${path}`);
  const canvas = value as Partial<StoredCanvas>;
  if (canvas.version !== 5 && canvas.version !== 6) throw new Error(`FlowWeave Canvas must be v6. Re-scan the project to rebuild it: ${path}`);
  return canvas as StoredCanvas;
}

async function readGeneratedSnapshot(projectPath: string, canvas: StoredCanvas): Promise<ModificationSnapshot | undefined> {
  const path = join(projectPath, FLOWWEAVE_DIR, "architecture-local.json");
  const value = await readJsonArtifact(path);
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || !("version" in value) || ![2, 3].includes(Number(value.version)) || !("modules" in value) || !Array.isArray(value.modules) || !("relationships" in value) || !Array.isArray(value.relationships)) {
    throw new Error(`FlowWeave generated architecture baseline is invalid and was preserved: ${path}`);
  }
  await assertArtifactGeneration(projectPath, "architecture-local.json", value as ArchitectureMap);
  const graph = architectureMapToGraph(value as ArchitectureMap);
  return normalizeModificationSnapshot({ ...canvas, ...graph, orphanedEdges: [], orphanedNodeEdits: [] }, "");
}

function emptyCanvas(projectPath: string): CodeflowCanvas {
  return {
    version: 6,
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

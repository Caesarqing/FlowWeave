import { assertArtifactGeneration } from "./project-generation.service";
import { withArchitectureArtifactLock } from "./architecture-review.service";
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
  GRAPH_MODEL_VERSION,
  hasModificationDelta,
  migrateModificationBaseline,
  normalizeModificationSnapshot
} from "../../utils/modification-delta";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { architectureMapToGraph } from "./static-architecture.service";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { readProjectProtocolCanvas, readProjectProtocolSnapshot } from "../storage/flowweave-store";

const MODIFICATION_BASELINE_FILE = "modification-baseline.json";

export async function readModificationDelta(
  projectPath: string,
  sequenceInstruction: string,
  canvas?: CodeflowCanvas
): Promise<ModificationDeltaResult> {
  return withArchitectureArtifactLock(projectPath, async () => {
    const currentCanvas = canvas ?? await readCurrentCanvas(projectPath);
    await assertArtifactGeneration(projectPath, "canvas/user-state.json", currentCanvas);
    const snapshot = normalizeModificationSnapshot(currentCanvas, sequenceInstruction);
    const existing = await readBaseline(projectPath);
    let baseline: ModificationBaseline;
    if (existing && existing.graphModelVersion === GRAPH_MODEL_VERSION && sameGeneration(existing.generation, currentCanvas.generation)) {
      await assertArtifactGeneration(projectPath, MODIFICATION_BASELINE_FILE, existing);
      baseline = existing;
    } else if (existing) {
      baseline = {
        ...migrateModificationBaseline(existing, snapshot, await readGeneratedSnapshot(projectPath, currentCanvas)),
        generation: currentCanvas.generation
      };
      await writeJsonAtomic(baselinePath(projectPath), baseline);
    } else {
      baseline = {
        ...(await readGeneratedSnapshot(projectPath, currentCanvas) ?? snapshot),
      generation: currentCanvas.generation, version: 1, graphModelVersion: GRAPH_MODEL_VERSION,
      acknowledgedAt: new Date(0).toISOString(), sequenceInstruction: undefined
      };
      await writeJsonAtomic(baselinePath(projectPath), baseline);
    }
    const delta = buildModificationDelta(baseline, snapshot);
    return { baseline, snapshot, delta, hasChanges: hasModificationDelta(delta) };
  });
}

function sameGeneration(left: ModificationSnapshot["generation"], right: ModificationSnapshot["generation"]): boolean {
  return Boolean(left && right && left.requestId === right.requestId && left.inputFingerprint === right.inputFingerprint);
}

/** Called under the artifact lock; prepares the independent confirmation baseline without acknowledging edits. */
export async function prepareModificationBaseline(
  projectPath: string, canvas: CodeflowCanvas, generatedCanvas: CodeflowCanvas
): Promise<ModificationBaseline> {
  const existing = await readBaseline(projectPath);
  const current = normalizeModificationSnapshot(canvas, "");
  const generated = normalizeModificationSnapshot(generatedCanvas, "");
  const baseline = existing ? migrateModificationBaseline(existing, current, generated) : {
    ...generated, version: 1 as const, graphModelVersion: GRAPH_MODEL_VERSION, acknowledgedAt: new Date().toISOString()
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
    await assertArtifactGeneration(projectPath, "canvas/user-state.json", canvas);
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

async function readCurrentCanvas(projectPath: string): Promise<CodeflowCanvas> {
  const canvas = await readProjectProtocolCanvas(projectPath);
  if (!canvas) throw new Error(`Project has not been migrated to FlowWeave protocol v7: ${projectPath}`);
  return canvas;
}

async function readGeneratedSnapshot(projectPath: string, canvas: CodeflowCanvas): Promise<ModificationSnapshot | undefined> {
  const staticSnapshot = await readProjectProtocolSnapshot(projectPath);
  if (!staticSnapshot) return undefined;
  await assertArtifactGeneration(projectPath, "static-snapshot.json", staticSnapshot.localArchitecture);
  const graph = architectureMapToGraph(staticSnapshot.localArchitecture);
  return normalizeModificationSnapshot({ ...canvas, ...graph, nodes: graph.nodes.map((node) => ({ ...node, guidanceDraft: "" })), orphanedEdges: [], orphanedNodeEdits: [] }, "");
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

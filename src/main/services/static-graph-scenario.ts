import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ProjectScanSelection } from "../../types";
import { readCanvasNodeDetail, type CanvasDetailCacheLookup } from "./canvas-detail.service";
import { generateProject } from "./project-generation.service";
import { validateMeasurementSourceInventory, type MeasurementSourceInventoryEntry } from "./static-graph-measurement";
import { readProjectProtocolCanvas } from "../storage/flowweave-store";

export type MeasurementSourceChange = { path: string; beforeSha256: string; afterContent: string };
export type StaticGraphDetailRevisionObservation = {
  generationId: string;
  completionUserRevision: number;
  committedGenerationId: string | null;
  committedUserRevision: number | null;
  renderedGenerationId: string | null;
  renderedUserRevision: string | null;
};

/** A same-generation autosave can advance the completion event revision before detail is ready. */
export function resolveStaticGraphDetailRevision(input: StaticGraphDetailRevisionObservation): number {
  if (input.committedGenerationId !== input.generationId || input.renderedGenerationId !== input.generationId) {
    throw new Error("Detail measurement generation differs from the current committed and rendered generation.");
  }
  if (!Number.isInteger(input.committedUserRevision) || input.committedUserRevision === null || input.committedUserRevision < input.completionUserRevision ||
    input.renderedUserRevision !== String(input.committedUserRevision)) {
    throw new Error("Detail measurement requires the current committed revision to match the rendered revision and not precede the completion event.");
  }
  return input.committedUserRevision;
}
export const STATIC_GRAPH_MEASUREMENT_SCENARIOS = ["first-analysis", "cached-reopen", "incremental-source", "detail-cold", "detail-hot", "old-format-migration"] as const;

export function isMeasurementSourceChange(value: unknown): value is MeasurementSourceChange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const change = value as Record<string, unknown>;
  return typeof change.path === "string" && change.path.length > 0 && change.path.trim() === change.path && !change.path.includes("\\") &&
    change.path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..") &&
    typeof change.beforeSha256 === "string" && /^[a-f\d]{64}$/i.test(change.beforeSha256) && typeof change.afterContent === "string";
}
export type StaticGraphScenarioPreparationInput = {
  projectPath: string;
  outputDirectory: string;
  scenarioId: string;
  selection: ProjectScanSelection;
  sourceInventoryEntries: MeasurementSourceInventoryEntry[];
  sourceChange: MeasurementSourceChange | undefined;
};
export type PreparedStaticGraphScenario = {
  projectPath: string;
  selection: ProjectScanSelection;
  sourceInventoryEntries: MeasurementSourceInventoryEntry[];
  seedGenerationId: string | null;
  evidence: {
    sourceProjectPath: string;
    isolatedProjectPath: string;
    scenarioId: string;
    applicationCacheAtEntry: "absent" | "committed";
    seedGenerationId: string | null;
    constructedHistory?: { format: "canvas-v6"; sourceGenerationId: string; sha256: string };
    sourceChange?: { path: string; beforeSha256: string; afterSha256: string };
  };
};

/** Prepare a fresh selected-source copy; setup generation is excluded from the measured UI action. */
export async function prepareStaticGraphScenario(input: StaticGraphScenarioPreparationInput): Promise<PreparedStaticGraphScenario> {
  if (!STATIC_GRAPH_MEASUREMENT_SCENARIOS.some((scenario) => scenario === input.scenarioId)) {
    throw new Error(`Unsupported measurement scenario: ${input.scenarioId}.`);
  }
  if (input.scenarioId === "incremental-source" && !input.sourceChange) {
    throw new Error("Incremental measurement requires an explicit source change for this development project.");
  }
  if (input.scenarioId !== "incremental-source" && input.sourceChange) {
    throw new Error(`Source changes are only valid for incremental-source, found ${input.scenarioId}.`);
  }
  await validateMeasurementSourceInventory(input.projectPath, input.selection, input.sourceInventoryEntries);
  const sourceProjectPath = await realpath(input.projectPath);
  const outputDirectory = await assertMeasurementOutputIsolated(input.outputDirectory, [sourceProjectPath]);
  await mkdir(outputDirectory, { recursive: true });
  const projectPath = join(outputDirectory, basename(sourceProjectPath));
  await mkdir(projectPath);
  for (const entry of input.sourceInventoryEntries) {
    const target = join(projectPath, ...entry.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sourceProjectPath, ...entry.path.split("/")), target);
    await chmod(target, Number.parseInt(entry.mode.slice(-3), 8));
  }
  await validateMeasurementSourceInventory(projectPath, input.selection, input.sourceInventoryEntries);
  const prepared: PreparedStaticGraphScenario = {
    projectPath,
    selection: { ...input.selection, sourcePaths: [...input.selection.sourcePaths], configurationPaths: [...input.selection.configurationPaths] },
    sourceInventoryEntries: input.sourceInventoryEntries.map((entry) => ({ ...entry })),
    seedGenerationId: null,
    evidence: { sourceProjectPath, isolatedProjectPath: projectPath, scenarioId: input.scenarioId, applicationCacheAtEntry: "absent", seedGenerationId: null }
  };
  if (input.scenarioId === "first-analysis") return prepared;

  const seeded = await generateProject(projectPath, { scanOptions: { selection: prepared.selection } });
  if (seeded.status !== "committed") throw new Error(`Scenario setup generation was superseded: ${input.scenarioId}, project ${projectPath}.`);
  if (input.scenarioId === "old-format-migration") {
    const canvas = await readProjectProtocolCanvas(projectPath);
    if (!canvas) throw new Error(`Migration scenario setup did not produce a committed protocol canvas: ${projectPath}.`);
    const historyBytes = Buffer.from(JSON.stringify({ ...canvas, version: 6 }, null, 2), "utf8");
    const flowweaveRoot = join(projectPath, ".flowweave");
    await rm(flowweaveRoot, { recursive: true, force: true });
    const legacyCanvasPath = join(flowweaveRoot, "canvas", "main.canvas.json");
    await mkdir(dirname(legacyCanvasPath), { recursive: true });
    await writeFile(legacyCanvasPath, historyBytes, { flag: "wx" });
    const legacyCanvasSha256 = createHash("sha256").update(historyBytes).digest("hex");
    return {
      ...prepared,
      seedGenerationId: null,
      evidence: {
        ...prepared.evidence,
        applicationCacheAtEntry: "absent",
        seedGenerationId: null,
        constructedHistory: { format: "canvas-v6", sourceGenerationId: seeded.generation.requestId, sha256: legacyCanvasSha256 }
      }
    };
  }
  const evidence = { ...prepared.evidence, applicationCacheAtEntry: "committed" as const, seedGenerationId: seeded.generation.requestId };
  const seededPreparation = { ...prepared, seedGenerationId: seeded.generation.requestId, evidence };
  if (!input.sourceChange) return seededPreparation;

  const change = input.sourceChange;
  const entry = prepared.sourceInventoryEntries.find((candidate) => candidate.kind === "source" && candidate.path === change.path);
  if (!entry || entry.sha256 !== change.beforeSha256) {
    throw new Error(`Incremental change must match a frozen selected source: ${change.path}, expected before hash ${entry?.sha256 ?? "not selected"}, received ${change.beforeSha256}.`);
  }
  const afterBytes = Buffer.from(change.afterContent, "utf8");
  const afterSha256 = createHash("sha256").update(afterBytes).digest("hex");
  if (afterSha256 === entry.sha256) throw new Error(`Incremental source change has identical bytes: ${change.path}.`);
  const target = resolve(projectPath, ...entry.path.split("/"));
  if (createHash("sha256").update(await readFile(target)).digest("hex") !== entry.sha256) throw new Error(`Incremental source changed after setup: ${change.path}.`);
  await writeFile(target, afterBytes);
  const sourceInventoryEntries = prepared.sourceInventoryEntries.map((candidate) => candidate.path === entry.path ? { ...candidate, sizeBytes: afterBytes.byteLength, sha256: afterSha256 } : candidate);
  const sourceInventorySha256 = createHash("sha256").update(sourceInventoryEntries.map((candidate) => JSON.stringify(candidate)).join("\n") + "\n").digest("hex");
  return {
    ...seededPreparation,
    selection: { ...prepared.selection, sourceInventorySha256 },
    sourceInventoryEntries,
    evidence: { ...evidence, sourceChange: { path: change.path, beforeSha256: entry.sha256, afterSha256 } }
  };
}

async function resolveFutureDirectory(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Measurement output path contains a dangling symlink: ${directory}.`);
    } catch (statError) {
      if (!(statError instanceof Error) || !("code" in statError) || statError.code !== "ENOENT") throw statError;
    }
    return join(await resolveFutureDirectory(dirname(directory)), basename(directory));
  }
}

function resolveFutureDirectorySync(directory: string): string {
  try {
    return realpathSync(directory);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    try {
      if (lstatSync(directory).isSymbolicLink()) {
        throw new Error(`Measurement output path contains a dangling symlink: ${directory}.`);
      }
    } catch (statError) {
      if (statError instanceof Error && "code" in statError && statError.code !== "ENOENT") throw statError;
      if (!(statError instanceof Error) || !("code" in statError) || statError.code !== "ENOENT") throw statError;
    }
    const parent = dirname(directory);
    if (parent === directory) throw error;
    return join(resolveFutureDirectorySync(parent), basename(directory));
  }
}

/** Synchronous variant for Electron paths that must be checked before app.setPath. */
export function assertMeasurementOutputIsolatedSync(outputPath: string, sourceProjectPaths: readonly string[]): string {
  const canonicalOutputPath = resolveFutureDirectorySync(resolve(outputPath));
  for (const sourceProjectPath of new Set(sourceProjectPaths)) {
    const canonicalSource = resolveFutureDirectorySync(resolve(sourceProjectPath));
    const outputRelativeToSource = relative(canonicalSource, canonicalOutputPath);
    if (!outputRelativeToSource || (!outputRelativeToSource.startsWith(`..${sep}`) && outputRelativeToSource !== "..")) {
      throw new Error(`Measurement output must be outside the source checkout: output ${canonicalOutputPath}, source ${canonicalSource}.`);
    }
  }
  return canonicalOutputPath;
}

/** Resolve existing symlinks and missing descendants before any measurement output is written. */
export async function assertMeasurementOutputIsolated(outputPath: string, sourceProjectPaths: readonly string[]): Promise<string> {
  const canonicalOutputPath = await resolveFutureDirectory(resolve(outputPath));
  for (const sourceProjectPath of new Set(sourceProjectPaths)) {
    const canonicalSource = await resolveFutureDirectory(resolve(sourceProjectPath));
    const outputRelativeToSource = relative(canonicalSource, canonicalOutputPath);
    if (!outputRelativeToSource || (!outputRelativeToSource.startsWith(`..${sep}`) && outputRelativeToSource !== "..")) {
      throw new Error(`Measurement output must be outside the source checkout: output ${canonicalOutputPath}, source ${canonicalSource}.`);
    }
  }
  return canonicalOutputPath;
}

/** Reject planned output paths redirected outside the freshly claimed output root. */
export async function assertMeasurementOutputTargetContained(outputRoot: string, outputTarget: string): Promise<void> {
  const canonicalRoot = await realpath(resolve(outputRoot));
  const canonicalTarget = await resolveFutureDirectory(resolve(outputTarget));
  const targetRelativeToRoot = relative(canonicalRoot, canonicalTarget);
  if (!targetRelativeToRoot || targetRelativeToRoot === ".." || targetRelativeToRoot.startsWith(`..${sep}`)) {
    throw new Error(`Measurement output target must remain inside its claimed output directory: target ${canonicalTarget}, root ${canonicalRoot}.`);
  }
}

export class HotDetailCacheUnavailableError extends Error {
  constructor(projectPath: string, generationId: string, userRevision: number, nodeId: string, artifactBytes: number | undefined) {
    super(`Hot detail setup could not establish a retained cache hit: project ${projectPath}, generation ${generationId}, revision ${userRevision}, node ${nodeId}, snapshot bytes ${artifactBytes ?? "unknown"}.`);
    this.name = "HotDetailCacheUnavailableError";
  }
}

/** Prime the exact detail identity before starting the hot UI detail timer. */
export async function primeStaticGraphDetail(projectPath: string, generationId: string, userRevision: number, nodeId: string): Promise<CanvasDetailCacheLookup> {
  const lookups: CanvasDetailCacheLookup[] = [];
  const observe = (lookup: CanvasDetailCacheLookup) => {
    lookups.push(lookup);
    if (!lookup.eligibleForRetention) throw new HotDetailCacheUnavailableError(projectPath, generationId, userRevision, nodeId, lookup.artifactBytes);
  };
  await readCanvasNodeDetail(projectPath, generationId, userRevision, nodeId, undefined, observe);
  const response = await readCanvasNodeDetail(projectPath, generationId, userRevision, nodeId, undefined, observe);
  if (!response.detail || response.generationId !== generationId || response.userRevision !== userRevision || response.nodeId !== nodeId) {
    throw new Error(`Hot detail setup did not return the requested identity: project ${projectPath}, generation ${generationId}, revision ${userRevision}, node ${nodeId}.`);
  }
  const retainedLookup = lookups[1];
  if (!retainedLookup?.hit || retainedLookup.snapshotSha256 !== lookups[0]?.snapshotSha256) {
    throw new HotDetailCacheUnavailableError(projectPath, generationId, userRevision, nodeId, retainedLookup?.artifactBytes);
  }
  return retainedLookup;
}

import { stat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { CanvasEdgeDetail, CanvasEdgeDetailResponse, CanvasNodeDetail, CanvasNodeDetailResponse, GraphEdge, GraphNode, ProjectGenerationManifestV7, StaticSnapshotV1 } from "../../types";
import { readProjectGenerationManifest, readProjectProtocolCanvas, readProjectProtocolOverview, readProjectProtocolSnapshot, readProjectProtocolUserRevision } from "../storage/flowweave-store";
import { withArchitectureArtifactLock } from "./architecture-review.service";
import { applyAssessmentOverride } from "../../utils/module-assessment";

type StaticDetailIndex = {
  modules: StaticSnapshotV1["localArchitecture"]["modules"];
  moduleById: Map<string, StaticSnapshotV1["localArchitecture"]["modules"][number]>;
  relationById: Map<string, StaticSnapshotV1["localArchitecture"]["relationships"][number]>;
  resourceById: Map<string, NonNullable<StaticSnapshotV1["localArchitecture"]["resources"]>[number]>;
};
type CacheEntry = { index: StaticDetailIndex; fileIdentity: string; bytes: number };
const MAX_DETAIL_CACHE_BYTES = 128 * 1024 * 1024;
const staticDetailCache = new Map<string, CacheEntry>();
const loadingDetails = new Map<string, Promise<StaticDetailIndex>>();
const activeCacheKeys = new Map<string, string>();
export type CanvasDetailMeasurementMetric = "lockWaitMs" | "snapshotReadMs" | "snapshotParseMs" | "snapshotValidationMs" | "detailIndexMs";
type CanvasDetailMeasurement = (
  metric: CanvasDetailMeasurementMetric,
  durationMs: number,
  outcome: "completed" | "failed"
) => void;
export type CanvasDetailCacheLookup = {
  projectPath: string;
  generationId: string;
  userRevision: number;
  nodeId: string;
  snapshotSha256: string;
  artifactBytes: number;
  retainedBytes: number | undefined;
  eligibleForRetention: boolean;
  hit: boolean;
};

/** Serialized UTF-8 weight of retained detail data; process RSS is measured separately. */
export function getStaticDetailCacheResidentBytes(): number {
  return [...staticDetailCache.values()].reduce((total, entry) => total + entry.bytes, 0);
}

export class CanvasDetailGenerationChangedError extends Error {
  constructor(projectPath: string, expected: string, actual: string) {
    super(`Canvas detail generation changed: project ${projectPath}, expected ${expected}, actual ${actual}`);
    this.name = "CanvasDetailGenerationChangedError";
  }
}

export class CanvasDetailRevisionChangedError extends Error {
  constructor(projectPath: string, generationId: string, expected: number, actual: number | undefined) {
    super(`Canvas detail revision changed: project ${projectPath}, generation ${generationId}, expected ${expected}, actual ${actual ?? "missing"}`);
    this.name = "CanvasDetailRevisionChangedError";
  }
}

function cacheKey(projectPath: string, manifest: ProjectGenerationManifestV7): string {
  return `${projectPath}:${manifest.generationId}:${manifest.artifacts.staticSnapshot}`;
}

async function loadStaticDetails(
  projectPath: string,
  manifest: ProjectGenerationManifestV7,
  onMeasurement?: CanvasDetailMeasurement
): Promise<StaticDetailIndex> {
  const canonicalPath = await realpath(projectPath);
  const key = cacheKey(canonicalPath, manifest);
  if (activeCacheKeys.get(canonicalPath) !== key) {
    for (const previousKey of staticDetailCache.keys()) {
      if (previousKey.startsWith(`${canonicalPath}:`) && previousKey !== key) staticDetailCache.delete(previousKey);
    }
    activeCacheKeys.delete(canonicalPath);
    activeCacheKeys.set(canonicalPath, key);
    while (activeCacheKeys.size > 16) {
      const oldestPath = activeCacheKeys.keys().next().value;
      if (!oldestPath) break;
      activeCacheKeys.delete(oldestPath);
    }
  }
  const snapshotPath = join(canonicalPath, ".flowweave", "static-snapshot.json");
  const file = await stat(snapshotPath, { bigint: true });
  const fileIdentity = `${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
  const cached = staticDetailCache.get(key);
  if (cached && cached.fileIdentity === fileIdentity) {
    staticDetailCache.delete(key);
    staticDetailCache.set(key, cached);
    return cached.index;
  }
  staticDetailCache.delete(key);
  const pendingKey = `${key}:${fileIdentity}`;
  const pending = loadingDetails.get(pendingKey);
  if (pending) return pending;
  const loading = (async () => {
    const snapshot = await readProjectProtocolSnapshot(canonicalPath, onMeasurement);
    if (!snapshot || snapshot.generationId !== manifest.generationId) {
      throw new CanvasDetailGenerationChangedError(canonicalPath, manifest.generationId, snapshot?.generationId ?? "missing");
    }
    const after = await stat(snapshotPath, { bigint: true });
    if (fileIdentity !== `${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}`) {
      throw new Error(`Canvas detail snapshot changed while reading: project ${canonicalPath}, generation ${manifest.generationId}`);
    }
    const architecture = snapshot.localArchitecture;
    const indexStartedAt = onMeasurement ? performance.now() : undefined;
    const index: StaticDetailIndex = {
      modules: architecture.modules,
      moduleById: new Map(architecture.modules.map((module) => [module.id, module])),
      relationById: new Map(architecture.relationships.map((relation) => [relation.id, relation])),
      resourceById: new Map((architecture.resources ?? []).map((resource) => [resource.id, resource]))
    };
    const bytes = Buffer.byteLength(JSON.stringify({ modules: architecture.modules,
      relationships: architecture.relationships, resources: architecture.resources ?? [] }), "utf8");
    if (indexStartedAt !== undefined) onMeasurement?.("detailIndexMs", performance.now() - indexStartedAt, "completed");
    if (activeCacheKeys.get(canonicalPath) !== key) return index;
    if (bytes <= MAX_DETAIL_CACHE_BYTES) {
      staticDetailCache.set(key, { index, fileIdentity, bytes });
      let total = [...staticDetailCache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      while (total > MAX_DETAIL_CACHE_BYTES) {
        const oldest = staticDetailCache.keys().next().value;
        if (!oldest) break;
        total -= staticDetailCache.get(oldest)!.bytes;
        staticDetailCache.delete(oldest);
      }
    } else {
      console.warn("Canvas detail index exceeds cache budget", { projectPath: canonicalPath, generationId: manifest.generationId, bytes });
    }
    return index;
  })();
  loadingDetails.set(pendingKey, loading);
  try { return await loading; } finally { loadingDetails.delete(pendingKey); }
}

async function readDetailCanvas(projectPath: string, generationId: string, userRevision: number, onMeasurement?: CanvasDetailMeasurement) {
  return withArchitectureArtifactLock(projectPath, async () => {
    const [manifest, canvas, canonicalPath] = await Promise.all([
      readProjectGenerationManifest(projectPath), readProjectProtocolCanvas(projectPath), realpath(projectPath)
    ]);
    if (!manifest || !canvas || manifest.generationId !== generationId || canvas.generation?.requestId !== generationId) {
      throw new CanvasDetailGenerationChangedError(projectPath, generationId, manifest?.generationId ?? "missing");
    }
    if (canvas.userRevision !== userRevision) {
      throw new CanvasDetailRevisionChangedError(projectPath, generationId, userRevision, canvas.userRevision);
    }
    const snapshotPath = join(canonicalPath, ".flowweave", "static-snapshot.json");
    const file = await stat(snapshotPath, { bigint: true });
    const fileIdentity = `${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
    const key = cacheKey(canonicalPath, manifest);
    const cached = staticDetailCache.get(key);
    if (cached && cached.fileIdentity === fileIdentity) {
      staticDetailCache.delete(key);
      staticDetailCache.set(key, cached);
    }
    return { manifest, canvas, canonicalPath, artifactBytes: Number(file.size), cachedIndex: cached?.fileIdentity === fileIdentity ? cached.index : undefined };
  }, onMeasurement ? (durationMs) => onMeasurement("lockWaitMs", durationMs, "completed") : undefined);
}

async function assertDetailCurrent(
  projectPath: string,
  generationId: string,
  userRevision: number,
  snapshotHash: string,
  onMeasurement?: CanvasDetailMeasurement
): Promise<void> {
  await withArchitectureArtifactLock(projectPath, async () => {
    const manifest = await readProjectGenerationManifest(projectPath);
    if (!manifest || manifest.generationId !== generationId || manifest.artifacts.staticSnapshot !== snapshotHash) {
      throw new CanvasDetailGenerationChangedError(projectPath, generationId, manifest?.generationId ?? "missing");
    }
    const actualRevision = await readProjectProtocolUserRevision(projectPath, generationId);
    if (actualRevision !== userRevision) {
      throw new CanvasDetailRevisionChangedError(projectPath, generationId, userRevision, actualRevision);
    }
  }, onMeasurement ? (durationMs) => onMeasurement("lockWaitMs", durationMs, "completed") : undefined);
}

export async function readCanvasNodeDetail(
  projectPath: string,
  generationId: string,
  userRevision: number,
  nodeId: string,
  onMeasurement?: CanvasDetailMeasurement,
  onCacheLookup?: (lookup: CanvasDetailCacheLookup) => void
): Promise<CanvasNodeDetailResponse> {
  const { manifest, canvas, canonicalPath, artifactBytes, cachedIndex } = await readDetailCanvas(projectPath, generationId, userRevision, onMeasurement);
  const index = cachedIndex ?? await loadStaticDetails(projectPath, manifest, onMeasurement);
  if (!cachedIndex) await assertDetailCurrent(projectPath, generationId, userRevision, manifest.artifacts.staticSnapshot, onMeasurement);
  const retained = staticDetailCache.get(cacheKey(canonicalPath, manifest));
  onCacheLookup?.({ projectPath: canonicalPath, generationId, userRevision, nodeId,
    snapshotSha256: manifest.artifacts.staticSnapshot, artifactBytes, retainedBytes: retained?.bytes,
    eligibleForRetention: retained !== undefined, hit: cachedIndex !== undefined });
  const visible = canvas.nodes.find((node) => node.id === nodeId);
  if (!visible) return { generationId, userRevision, nodeId };
  const module = index.moduleById.get(nodeId);
  let detail: CanvasNodeDetail | undefined;
  if (module) {
    const files = new Set(visible.files);
    const sourceModules = index.modules.filter((candidate) => candidate.files.some((file) => files.has(file)));
    detail = { symbols: sourceModules.flatMap((candidate) => candidate.symbols ?? []).filter((symbol) => files.has(symbol.filePath)),
      fileRoles: sourceModules.flatMap((candidate) => candidate.fileRoles ?? []).filter((role) => files.has(role.path)),
      evidence: sourceModules.flatMap((candidate) => candidate.evidence ?? []).filter((item) => item.filePath && files.has(item.filePath)),
      assessment: visible.assessmentPending ? visible.assessment : module.assessment && visible.assessment?.risk.override
        ? applyAssessmentOverride(module.assessment, visible.assessment.risk.override) : module.assessment ?? visible.assessment,
      relationDiagnostics: [...new Map(sourceModules.flatMap((candidate) => candidate.relationDiagnostics ?? [])
        .filter((diagnostic) => files.has(diagnostic.filePath))
        .map((diagnostic) => [JSON.stringify([diagnostic.filePath, diagnostic.code, diagnostic.relationId,
          diagnostic.range, diagnostic.message]), diagnostic])).values()] };
  } else {
    const resource = index.resourceById.get(nodeId);
    if (resource) detail = { evidence: resource.evidence };
  }
  return { generationId, userRevision, nodeId, detail };
}

export async function readGeneratedCanvasGraph(projectPath: string, generationId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  return withArchitectureArtifactLock(projectPath, async () => {
    const [overview, canvas] = await Promise.all([readProjectProtocolOverview(projectPath), readProjectProtocolCanvas(projectPath)]);
    if (!overview || !canvas || overview.generationId !== generationId || canvas.generation?.requestId !== generationId) {
      throw new Error(`Generated Canvas graph generation changed: project ${projectPath}, expected ${generationId}, actual ${overview?.generationId ?? "missing"}`);
    }
    return {
      nodes: overview.nodes.map((node) => ({ ...node, guidanceDraft: "", origin: "generated" as const })),
      edges: overview.edges.map((edge) => ({ ...edge, origin: "generated" as const }))
    };
  });
}

export async function readCanvasEdgeDetail(
  projectPath: string,
  generationId: string,
  userRevision: number,
  edgeId: string,
  onMeasurement?: CanvasDetailMeasurement
): Promise<CanvasEdgeDetailResponse> {
  const { manifest, canvas, cachedIndex } = await readDetailCanvas(projectPath, generationId, userRevision, onMeasurement);
  const index = cachedIndex ?? await loadStaticDetails(projectPath, manifest, onMeasurement);
  if (!cachedIndex) await assertDetailCurrent(projectPath, generationId, userRevision, manifest.artifacts.staticSnapshot, onMeasurement);
  const visible = canvas.edges.find((edge) => edge.id === edgeId);
  const relation = index.relationById.get(edgeId);
  if (!visible || !relation) return { generationId, userRevision, edgeId };
  const corrected = visible.source !== relation.source || visible.target !== relation.target || visible.relation !== relation.relation;
  const detail: CanvasEdgeDetail = { source: visible.source, target: visible.target, relation: visible.relation,
    evidence: corrected ? [] : relation.evidence, confidence: corrected ? "inferred" : relation.confidence,
    semanticKinds: corrected ? [] : relation.semanticKinds, operations: corrected ? [] : relation.operations,
    importUsages: corrected ? [] : relation.importUsages, sourceRelationIds: corrected ? [] : relation.sourceRelationIds };
  return { generationId, userRevision, edgeId, detail };
}

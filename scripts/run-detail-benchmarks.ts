import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { readCanvasNodeDetail, type CanvasDetailMeasurementMetric } from "../src/main/services/canvas-detail.service";
import { withArchitectureArtifactLock } from "../src/main/services/architecture-review.service";
import { readProjectProtocolCanvas, readProjectProtocolSnapshot } from "../src/main/storage/flowweave-store";
import { configureTransactionAuthorityRoot } from "../src/main/storage/transaction-authority";
import type { ArchitectureMap, CodeflowCanvas, CodeflowProject, GraphNode } from "../src/types";
import { writeArchitectureProtocolFixture } from "../tests/main/protocol.fixture";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("Usage: node --import tsx scripts/run-detail-benchmarks.ts <output.json> [iterations]");
const SIZES = [{ name: "small", modules: 20 }, { name: "medium", modules: 200 }, { name: "large", modules: 1000 }];
const ITERATIONS = process.argv[3] === undefined ? 20 : Number(process.argv[3]);
if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS < 1) throw new RangeError(`Detail benchmark iterations must be a positive integer: ${process.argv[3]}`);
type DetailStageSample = { metric: CanvasDetailMeasurementMetric; durationMs: number; outcome: "completed" | "failed" };
type Sample = { size: string; modules: number; mode: "legacy-cold" | "indexed-cold" | "legacy-warm" | "indexed-warm";
  iteration: number; durationMs?: number; error?: string; lockWaitMs?: number; snapshotMs?: number; canvasMs?: number; extractMs?: number;
  stageSamples: DetailStageSample[]; rssMiB: number };
const samples: Sample[] = [];
const temporaryRoot = await mkdtemp(join(tmpdir(), "flowweave-detail-benchmark-"));
configureTransactionAuthorityRoot(join(temporaryRoot, "user-data"));

try {
  for (const size of SIZES) {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const projectPath = await mkdtemp(join(temporaryRoot, `${size.name}-cold-`));
      const generationId = await createFixture(projectPath, size.modules);
      const runs = iteration % 2 === 0 ? ["legacy-cold", "indexed-cold"] as const : ["indexed-cold", "legacy-cold"] as const;
      for (const mode of runs) {
        samples.push(await measure(projectPath, generationId, size.name, size.modules, mode, iteration));
      }
    }
    const warmPath = await mkdtemp(join(temporaryRoot, `${size.name}-warm-`));
    const generationId = await createFixture(warmPath, size.modules);
    await readCanvasNodeDetail(warmPath, generationId, 0, "module-0");
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const runs = iteration % 2 === 0 ? ["legacy-warm", "indexed-warm"] as const : ["indexed-warm", "legacy-warm"] as const;
      for (const mode of runs) {
        samples.push(await measure(warmPath, generationId, size.name, size.modules, mode, iteration));
      }
    }
  }
  const summary = SIZES.flatMap((size) => (["legacy-cold", "indexed-cold", "legacy-warm", "indexed-warm"] as const).map((mode) => {
    const values = samples.filter((sample) => sample.size === size.name && sample.mode === mode);
    const durations = values.flatMap((sample) => sample.durationMs === undefined ? [] : [sample.durationMs]);
    const errorCount = values.length - durations.length;
    return { size: size.name, modules: size.modules, mode, iterations: values.length,
      errorCount, errorRate: errorCount / values.length,
      p50Ms: durations.length ? percentile(durations, 0.5) : undefined,
      p95Ms: durations.length ? percentile(durations, 0.95) : undefined,
      maxCompletionRssMiB: Math.max(...values.map((sample) => sample.rssMiB)) };
  }));
  const report = { measuredAt: new Date().toISOString(), runtime: process.version, platform: process.platform, arch: process.arch,
    iterations: ITERATIONS, fixture: "synthetic protocol-v7 modules with 12 symbols and evidence records per module; OS page cache not cleared; no Electron IPC or renderer",
    memoryMeasurement: "Node process RSS sampled only at each request completion; maxCompletionRssMiB is not peak RSS or Electron process-tree memory.",
    stageMeasurement: "snapshotReadMs includes file read and SHA-256 verification; snapshotParseMs is JSON parsing; snapshotValidationMs checks generation identity; detailIndexMs builds lookup maps; stageSamples retains each actual callback, with absent stages skipped on cache hits.",
    summary, samples };
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.table(summary);
  console.log(`Raw detail benchmark samples: ${resolve(outputPath)}`);
  const failures = samples.filter((sample) => sample.error);
  if (failures.length) throw new Error(`Detail benchmark recorded ${failures.length} failures; inspect ${resolve(outputPath)}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function createFixture(projectPath: string, count: number): Promise<string> {
  const generatedAt = "2026-10-03T00:00:00.000Z";
  const nodes: GraphNode[] = Array.from({ length: count }, (_, index) => ({
    id: `module-${index}`, title: `Module ${index}`, subtitle: "Service", kind: "module", nodeType: "service",
    risk: "unknown", description: `Service ${index}`, files: [`src/module-${index}.ts`], guidanceDraft: "",
    status: "mapped", x: 0, y: 0, origin: "generated"
  }));
  const project: CodeflowProject = { version: 2, projectName: "Detail benchmark", rootPath: projectPath, generatedAt,
    git: { isRepo: false }, summary: { totalFiles: count, totalFolders: 1, languages: { TypeScript: count } },
    files: [], scanFingerprint: `detail-benchmark-${count}` };
  const canvas: CodeflowCanvas = { id: "main", title: "Main", projectPath, generatedAt, scanFingerprint: project.scanFingerprint,
    nodes, edges: [] };
  const architecture: ArchitectureMap = { version: 3, source: "local", generatedAt, relationships: [],
    modules: nodes.map((node) => ({ id: node.id, title: node.title, category: "domain-service", nodeType: "service",
      role: "Service", description: node.description, files: node.files,
      fileRoles: [{ path: node.files[0], role: "implementation" }], risk: "unknown",
      symbols: Array.from({ length: 12 }, (_, symbol) => ({ name: `function${symbol}`, kind: "function" as const, filePath: node.files[0] })),
      evidence: Array.from({ length: 12 }, (_, evidence) => ({ filePath: node.files[0], line: evidence + 1,
        detail: `Verified source fact ${evidence} for ${node.title}` }))
    })) };
  const written = await writeArchitectureProtocolFixture(projectPath, project, canvas, architecture);
  const generationId = written.canvas.generation?.requestId;
  if (!generationId) throw new Error(`Benchmark fixture has no generation: ${projectPath}`);
  return generationId;
}

async function measure(projectPath: string, generationId: string, size: string, modules: number, mode: Sample["mode"], iteration: number): Promise<Sample> {
  const startedAt = performance.now();
  const stageSamples: DetailStageSample[] = [];
  const onMeasurement = (metric: CanvasDetailMeasurementMetric, durationMs: number, outcome: "completed" | "failed") => {
    stageSamples.push({ metric, durationMs, outcome });
  };
  let stages: Pick<Sample, "lockWaitMs" | "snapshotMs" | "canvasMs" | "extractMs"> = {};
  try {
    if (mode.startsWith("legacy")) {
      stages = await legacyRead(projectPath, generationId, onMeasurement);
    } else {
      const response = await readCanvasNodeDetail(projectPath, generationId, 0, "module-0", onMeasurement);
      if (response.detail?.symbols?.length !== 12) throw new Error(`Indexed detail lost symbols: ${size} ${iteration}`);
    }
    return { size, modules, mode, iteration, ...stages, stageSamples, durationMs: performance.now() - startedAt,
      rssMiB: process.memoryUsage().rss / 1048576 };
  } catch (error) {
    return { size, modules, mode, iteration, ...stages, stageSamples, error: String(error), rssMiB: process.memoryUsage().rss / 1048576 };
  }
}

async function legacyRead(projectPath: string, generationId: string, onMeasurement: (
  metric: CanvasDetailMeasurementMetric, durationMs: number, outcome: "completed" | "failed"
) => void): Promise<Pick<Sample, "lockWaitMs" | "snapshotMs" | "canvasMs" | "extractMs">> {
  const lockStartedAt = performance.now();
  return withArchitectureArtifactLock(projectPath, async () => {
    const lockWaitMs = performance.now() - lockStartedAt;
    onMeasurement("lockWaitMs", lockWaitMs, "completed");
    const snapshotStartedAt = performance.now();
    const snapshot = await readProjectProtocolSnapshot(projectPath, onMeasurement);
    const snapshotMs = performance.now() - snapshotStartedAt;
    const canvasStartedAt = performance.now();
    const canvas = await readProjectProtocolCanvas(projectPath);
    const canvasMs = performance.now() - canvasStartedAt;
    if (!snapshot || !canvas || snapshot.generationId !== generationId) throw new Error(`Legacy benchmark generation mismatch: ${projectPath}`);
    const extractStartedAt = performance.now();
    const node = canvas.nodes.find((candidate) => candidate.id === "module-0");
    const module = snapshot.localArchitecture.modules.find((candidate) => candidate.id === "module-0");
    if (!node || module?.symbols.length !== 12) throw new Error(`Legacy benchmark lost module: ${projectPath}`);
    const extractMs = performance.now() - extractStartedAt;
    return { lockWaitMs, snapshotMs, canvasMs, extractMs };
  });
}

function percentile(values: number[], percentileRank: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentileRank * sorted.length) - 1];
}

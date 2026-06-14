import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import ELK from "elkjs/lib/elk.bundled.js";
import { buildSemanticIndex } from "../src/main/services/semantic-index.service";
import { scanProject } from "../src/main/services/project-scanner.service";

const FILE_COUNTS = [1_000, 5_000, 10_000];
const NODE_COUNTS = [100, 500, 1_000];
const WRITE_CONCURRENCY = 64;

type BenchmarkResult = {
  scenario: string;
  size: number;
  milliseconds: number;
};

const root = await mkdtemp(join(tmpdir(), "flowweave-benchmark-"));
const results: BenchmarkResult[] = [];

try {
  await createFiles(root, FILE_COUNTS.at(-1) ?? 10_000);
  for (const count of FILE_COUNTS) {
    const startedAt = performance.now();
    const project = await scanProject(root, {
      concurrency: 64,
      maxDepth: 2,
      maxEntries: count
    });
    results.push({
      scenario: "project-scan",
      size: count,
      milliseconds: performance.now() - startedAt
    });
    if (project.summary.totalFiles !== count) {
      throw new Error(`Expected ${count} scanned files, received ${project.summary.totalFiles}.`);
    }
  }

  const project = await scanProject(root, {
    concurrency: 64,
    maxDepth: 2,
    maxEntries: 10_000
  });
  const firstStartedAt = performance.now();
  await buildSemanticIndex(project, { concurrency: 16 });
  const firstDuration = performance.now() - firstStartedAt;
  const secondStartedAt = performance.now();
  await buildSemanticIndex(await scanProject(root, {
    concurrency: 64,
    maxDepth: 2,
    maxEntries: 10_000
  }), { concurrency: 16 });
  const secondDuration = performance.now() - secondStartedAt;
  const improvement = 1 - secondDuration / firstDuration;
  results.push({ scenario: "semantic-index-cold", size: 10_000, milliseconds: firstDuration });
  results.push({ scenario: "semantic-index-unchanged", size: 10_000, milliseconds: secondDuration });
  if (improvement < 0.7) {
    throw new Error(`Unchanged semantic scan improved ${(improvement * 100).toFixed(1)}%; expected at least 70%.`);
  }

  const elk = new ELK();
  for (const count of NODE_COUNTS) {
    const startedAt = performance.now();
    await elk.layout({
      id: "root",
      layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT" },
      children: Array.from({ length: count }, (_, index) => ({
        id: `node-${index}`,
        width: 280,
        height: 150
      })),
      edges: Array.from({ length: count - 1 }, (_, index) => ({
        id: `edge-${index}`,
        sources: [`node-${index}`],
        targets: [`node-${index + 1}`]
      }))
    });
    results.push({
      scenario: "elk-layout",
      size: count,
      milliseconds: performance.now() - startedAt
    });
  }

  console.table(results.map((result) => ({
    ...result,
    milliseconds: Number(result.milliseconds.toFixed(1))
  })));
  console.log(`Unchanged 10k semantic scan improvement: ${(improvement * 100).toFixed(1)}%`);
} finally {
  await rm(root, { force: true, recursive: true });
}

async function createFiles(projectPath: string, count: number): Promise<void> {
  const indexes = Array.from({ length: count }, (_, index) => index);
  await mapWithConcurrency(indexes, WRITE_CONCURRENCY, async (index) => {
    await writeFile(
      join(projectPath, `module-${String(index).padStart(5, "0")}.ts`),
      `export const value${index} = ${index};\n`,
      "utf8"
    );
  });
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
}

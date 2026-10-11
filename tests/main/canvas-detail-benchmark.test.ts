import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("records real cold and warm detail stages in a bounded synthetic benchmark smoke", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-detail-benchmark-test-"));
  const output = join(root, "report.json");
  try {
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/run-detail-benchmarks.ts", output, "1"], {
      cwd: process.cwd(), timeout: 20_000
    });
    const report = JSON.parse(await readFile(output, "utf8")) as {
      iterations: number;
      memoryMeasurement: string;
      samples: Array<{ size: string; mode: string; error?: string; stageSamples: Array<{ metric: string; durationMs: number; outcome: string }> }>;
      summary: Array<{ size: string; mode: string; iterations: number; maxCompletionRssMiB: number }>;
    };
    const expectedSizes = ["small", "medium", "large"];
    const expectedModes = ["legacy-cold", "indexed-cold", "legacy-warm", "indexed-warm"];
    expect(report.summary).toHaveLength(expectedSizes.length * expectedModes.length);
    for (const size of expectedSizes) {
      for (const mode of expectedModes) {
        const samples = report.samples.filter((sample) => sample.size === size && sample.mode === mode);
        const summaries = report.summary.filter((summary) => summary.size === size && summary.mode === mode);
        expect(samples, `${size}/${mode} sample count`).toHaveLength(report.iterations);
        expect(summaries, `${size}/${mode} summary count`).toHaveLength(1);
        expect(summaries[0]?.iterations, `${size}/${mode} summary iterations`).toBe(report.iterations);
      }
    }
    for (const sample of report.samples.filter(({ mode }) => mode === "indexed-cold")) {
      expect(sample.error).toBeUndefined();
      expect(sample.stageSamples).toBeDefined();
      expect(sample.stageSamples.map(({ metric }) => metric)).toEqual([
        "lockWaitMs", "snapshotReadMs", "snapshotParseMs", "snapshotValidationMs", "detailIndexMs", "lockWaitMs"
      ]);
      expect(sample.stageSamples.every(({ durationMs, outcome }) => Number.isFinite(durationMs) && durationMs >= 0 && outcome === "completed")).toBe(true);
    }
    for (const sample of report.samples.filter(({ mode }) => mode === "indexed-warm")) {
      expect(sample.error).toBeUndefined();
      expect(sample.stageSamples.map(({ metric }) => metric)).toEqual(["lockWaitMs"]);
    }
    expect(report.iterations).toBe(1);
    expect(report.samples).toHaveLength(12);
    expect(report.summary.every(({ maxCompletionRssMiB }) => maxCompletionRssMiB > 0)).toBe(true);
    expect(report.memoryMeasurement).toContain("completion");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

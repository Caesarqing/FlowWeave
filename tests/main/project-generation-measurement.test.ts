import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateProject, generateRegisteredProject, type GenerationPhaseMeasurement } from "../../src/main/services/project-generation.service";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project generation measurements", () => {
  it("reports generation lock waits and snapshot validation alongside the analysis stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-generation-measurement-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "main.py"), "def main():\n    return 1\n", "utf8");
    const measurements: GenerationPhaseMeasurement[] = [];

    const result = await generateProject(root, {
      onMeasurement: (measurement) => measurements.push(measurement)
    });

    expect(result.status).toBe("committed");
    const measuredMetrics = measurements.map(({ metric }) => metric);
    expect(measuredMetrics).toEqual(expect.arrayContaining([
      "scanMs",
      "semanticAnalysisMs",
      "clusteringMs",
      "layoutMs",
      "commitMs",
      "lockWaitMs",
      "snapshotValidationMs"
    ]));
    expect(measuredMetrics.filter((metric) => metric === "lockWaitMs")).toHaveLength(4);
    expect(measuredMetrics.filter((metric) => metric === "snapshotValidationMs")).toHaveLength(2);
    expect(measurements.every(({ durationMs, outcome }) => Number.isFinite(durationMs) && durationMs >= 0 && outcome === "completed")).toBe(true);

    measurements.length = 0;
    const reused = await generateProject(root, {
      onMeasurement: (measurement) => measurements.push(measurement)
    });

    expect(reused.status).toBe("committed");
    expect(measurements.map(({ metric }) => metric)).toContain("snapshotParseMs");
    expect(measurements.map(({ metric }) => metric)).toContain("snapshotValidationMs");
    expect(measurements.every(({ durationMs, outcome }) => Number.isFinite(durationMs) && durationMs >= 0 && outcome === "completed")).toBe(true);
  });

  it("reports a failed scan duration without claiming later stages ran", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-generation-measurement-removed-"));
    temporaryRoots.push(root);
    await rm(root, { recursive: true, force: true });
    const measurements: GenerationPhaseMeasurement[] = [];

    await expect(generateRegisteredProject({ projectPath: root, requestId: "measurement-failure" }, {
      onMeasurement: (measurement) => measurements.push(measurement)
    })).rejects.toThrow();

    expect(measurements).toHaveLength(1);
    expect(measurements[0]).toMatchObject({ metric: "scanMs", outcome: "failed" });
    expect(measurements[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});

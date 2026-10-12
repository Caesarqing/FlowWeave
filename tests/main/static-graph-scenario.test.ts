import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMeasurementOutputIsolatedSync, assertMeasurementOutputTargetContained } from "../../src/main/services/static-graph-scenario";
import * as scenarios from "../../src/main/services/static-graph-scenario";
import { generateProject } from "../../src/main/services/project-generation.service";
import { getStaticDetailCacheResidentBytes, readCanvasNodeDetail } from "../../src/main/services/canvas-detail.service";
import { readProjectProtocolCanvas } from "../../src/main/storage/flowweave-store";

const overBudgetSnapshotPaths = vi.hoisted(() => new Set<string>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: async (...args: Parameters<typeof actual.stat>) => {
    const result = await actual.stat(...args);
    if (!overBudgetSnapshotPaths.has(String(args[0]))) return result;
    const overBudgetBytes = 128 * 1024 * 1024 + 1;
    return { ...result, size: typeof result.size === "bigint" ? BigInt(overBudgetBytes) : overBudgetBytes };
  } };
});

const roots: string[] = [];
const source = "def main():\n    return 1\n";
const changedSource = "def main():\n    return 2\n";

afterEach(async () => {
  overBudgetSnapshotPaths.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flowweave-scenario-"));
  roots.push(root);
  const projectPath = join(root, "source");
  await mkdir(projectPath);
  await writeFile(join(projectPath, "main.py"), source);
  const sourceInventoryEntries = [{ path: "main.py", kind: "source" as const, mode: "100644", sizeBytes: Buffer.byteLength(source), sha256: createHash("sha256").update(source).digest("hex") }];
  const selection = { sourcePaths: ["main.py"], configurationPaths: [], scopeSha256: "a".repeat(64), sourceInventorySha256: "b".repeat(64) };
  return { root, projectPath, sourceInventoryEntries, selection };
}

describe("static graph scenario preparation", () => {
  it("rejects planned targets redirected through a nested symlink", async () => {
    const input = await fixture();
    const outputRoot = join(input.root, "claimed-output");
    const escapedDirectory = join(input.root, "escaped-output");
    await mkdir(outputRoot);
    await mkdir(escapedDirectory);
    await symlink(escapedDirectory, join(outputRoot, "raw"));

    await expect(assertMeasurementOutputTargetContained(outputRoot, join(outputRoot, "raw", "D01", "run-01", "context.json")))
      .rejects.toThrow(/inside its claimed output directory/);
    expect(await readdir(escapedDirectory)).toEqual([]);
  });

  it("synchronously rejects a symlinked report profile inside the source checkout", async () => {
    const input = await fixture();
    const alias = join(input.root, "source-alias");
    await symlink(input.projectPath, alias);

    expect(() => assertMeasurementOutputIsolatedSync(join(alias, "run", "report.json"), [input.projectPath]))
      .toThrow(/outside the source checkout/);
  });

  it("retains compact detail indexes when the snapshot artifact exceeds the cache budget", async () => {
    const input = await fixture();
    const prepared = await scenarios.prepareStaticGraphScenario({ ...input, scenarioId: "detail-hot", outputDirectory: join(input.root, "run"), sourceChange: undefined });
    const canvas = await readProjectProtocolCanvas(prepared.projectPath);
    if (!canvas?.generation || !canvas.nodes[0]) throw new Error("Synthetic hot detail graph is missing.");
    overBudgetSnapshotPaths.add(join(await realpath(prepared.projectPath), ".flowweave", "static-snapshot.json"));
    const lookup = await scenarios.primeStaticGraphDetail(prepared.projectPath, canvas.generation.requestId, canvas.userRevision ?? 0, canvas.nodes[0].id);
    expect(lookup).toMatchObject({ hit: true, eligibleForRetention: true });
    expect(lookup.retainedBytes).toBeLessThan(lookup.artifactBytes);
  });

  it("refuses output inside the source checkout before creating any directory there", async () => {
    const input = await fixture();
    const outputDirectory = join(input.projectPath, "forbidden-output");
    await expect(scenarios.prepareStaticGraphScenario({ ...input, scenarioId: "first-analysis", outputDirectory, sourceChange: undefined })).rejects.toThrow(/outside the source checkout/);
    await expect(stat(outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds detail to an autosaved revision and rejects a stale rendered or committed identity", () => {
    const observation = { generationId: "generation-one", completionUserRevision: 0, committedGenerationId: "generation-one", committedUserRevision: 1, renderedGenerationId: "generation-one", renderedUserRevision: "1" };
    expect(scenarios.resolveStaticGraphDetailRevision(observation)).toBe(1);
    expect(() => scenarios.resolveStaticGraphDetailRevision({ ...observation, renderedUserRevision: "0" })).toThrow(/current committed revision/);
    expect(() => scenarios.resolveStaticGraphDetailRevision({ ...observation, committedGenerationId: "generation-other" })).toThrow(/generation/);
    expect(() => scenarios.resolveStaticGraphDetailRevision({ ...observation, completionUserRevision: 2 })).toThrow(/current committed revision/);
  });

  it("starts first analysis with no application artifacts even when the source checkout already has a graph", async () => {
    const input = await fixture();
    await writeFile(join(input.projectPath, "outside-scope.py"), "def excluded():\n    return 2\n");
    await generateProject(input.projectPath, { scanOptions: { selection: input.selection } });
    const prepared = await scenarios.prepareStaticGraphScenario({ ...input, scenarioId: "first-analysis", outputDirectory: join(input.root, "run"), sourceChange: undefined });

    expect(prepared.projectPath).not.toBe(input.projectPath);
    await expect(stat(join(prepared.projectPath, ".flowweave"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(prepared.projectPath, "main.py"), "utf8")).toBe(source);
    await expect(stat(join(prepared.projectPath, "outside-scope.py"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readProjectProtocolCanvas(input.projectPath)).not.toBeNull();
  });

  it("seeds a committed graph that cached reopen reuses without clustering, layout, or commit work", async () => {
    const input = await fixture();
    const prepared = await scenarios.prepareStaticGraphScenario({ ...input, scenarioId: "cached-reopen", outputDirectory: join(input.root, "run"), sourceChange: undefined });
    const measuredStages: string[] = [];
    const reopened = await generateProject(prepared.projectPath, { scanOptions: { selection: prepared.selection }, onMeasurement: ({ metric }) => measuredStages.push(metric) });

    expect(reopened.status).toBe("committed");
    if (reopened.status !== "committed") throw new Error("Synthetic reopen was superseded.");
    expect(reopened.generation.requestId).toBe(prepared.seedGenerationId);
    expect(measuredStages).not.toContain("clusteringMs");
    expect(measuredStages).not.toContain("layoutMs");
    expect(measuredStages).not.toContain("commitMs");
  });

  it("changes only the isolated selected source after seeding, causing a new generation", async () => {
    const input = await fixture();
    const prepared = await scenarios.prepareStaticGraphScenario({ ...input, scenarioId: "incremental-source", outputDirectory: join(input.root, "run"), sourceChange: { path: "main.py", beforeSha256: input.sourceInventoryEntries[0].sha256, afterContent: changedSource } });
    const generated = await generateProject(prepared.projectPath, { scanOptions: { selection: prepared.selection } });

    expect(await readFile(join(input.projectPath, "main.py"), "utf8")).toBe(source);
    expect(await readFile(join(prepared.projectPath, "main.py"), "utf8")).toBe(changedSource);
    expect(generated.status).toBe("committed");
    if (generated.status !== "committed") throw new Error("Synthetic incremental generation was superseded.");
    expect(generated.generation.requestId).not.toBe(prepared.seedGenerationId);
    expect(prepared.sourceInventoryEntries[0].sha256).toBe(createHash("sha256").update(changedSource).digest("hex"));
  });

  it("leaves cold detail unprimed and primes a matching hot detail without conflating the measured reads", async () => {
    const input = await fixture();
    const prepared = await scenarios.prepareStaticGraphScenario({ ...input, scenarioId: "detail-cold", outputDirectory: join(input.root, "run"), sourceChange: undefined });
    const canvas = await readProjectProtocolCanvas(prepared.projectPath);
    if (!canvas?.generation || !canvas.nodes[0]) throw new Error("Synthetic detail graph is missing.");
    const coldStages: string[] = [];
    const cold = await readCanvasNodeDetail(prepared.projectPath, canvas.generation.requestId, canvas.userRevision ?? 0, canvas.nodes[0].id, (metric) => coldStages.push(metric));
    expect(cold.detail).toBeDefined();
    expect(coldStages).toContain("snapshotParseMs");

    const hotPrepared = await scenarios.prepareStaticGraphScenario({ ...input, scenarioId: "detail-hot", outputDirectory: join(input.root, "hot-run"), sourceChange: undefined });
    const hotCanvas = await readProjectProtocolCanvas(hotPrepared.projectPath);
    if (!hotCanvas?.generation || !hotCanvas.nodes[0]) throw new Error("Synthetic hot detail graph is missing.");
    const hotPriming = await scenarios.primeStaticGraphDetail(hotPrepared.projectPath, hotCanvas.generation.requestId, hotCanvas.userRevision ?? 0, hotCanvas.nodes[0].id);
    expect(hotPriming).toMatchObject({ hit: true, generationId: hotCanvas.generation.requestId, userRevision: hotCanvas.userRevision ?? 0, nodeId: hotCanvas.nodes[0].id });
    expect(hotPriming.retainedBytes).toBeGreaterThan(0);
    expect(getStaticDetailCacheResidentBytes()).toBeGreaterThanOrEqual(hotPriming.retainedBytes!);
    const hotStages: string[] = [];
    const hot = await readCanvasNodeDetail(hotPrepared.projectPath, hotCanvas.generation.requestId, hotCanvas.userRevision ?? 0, hotCanvas.nodes[0].id, (metric) => hotStages.push(metric));
    expect(hot.detail).toBeDefined();
    expect(hotStages).not.toContain("snapshotParseMs");
  });

  it("migrates a constructed v6 history on real isolated source and rejects unregistered or incomplete scenarios", async () => {
    const input = await fixture();
    const prepared = await scenarios.prepareStaticGraphScenario({ ...input, scenarioId: "old-format-migration", outputDirectory: join(input.root, "migration-run"), sourceChange: undefined });
    const legacyCanvasPath = join(prepared.projectPath, ".flowweave/canvas/main.canvas.json");
    const legacyBytes = await readFile(legacyCanvasPath);
    const legacyCanvas = JSON.parse(legacyBytes.toString("utf8"));
    expect(prepared).toMatchObject({
      seedGenerationId: null,
      evidence: {
        applicationCacheAtEntry: "absent",
        constructedHistory: { format: "canvas-v6", sha256: createHash("sha256").update(legacyBytes).digest("hex") }
      }
    });
    expect(legacyCanvas.version).toBe(6);
    await expect(readFile(join(prepared.projectPath, ".flowweave/generation.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const migrated = await generateProject(prepared.projectPath, { scanOptions: { selection: prepared.selection } });
    expect(migrated.status).toBe("committed");
    const migrationRecord = JSON.parse(await readFile(join(prepared.projectPath, ".flowweave/migration/record.json"), "utf8"));
    expect(migrationRecord.status).toBe("complete");
    expect(await readFile(join(prepared.projectPath, migrationRecord.backupPath, "artifacts/canvas/main.canvas.json"))).toEqual(legacyBytes);
    const migratedCanvas = await readProjectProtocolCanvas(prepared.projectPath);
    expect(migratedCanvas?.generation?.requestId).not.toBe(prepared.evidence.constructedHistory?.sourceGenerationId);
    expect(migratedCanvas?.generation?.inputFingerprint).toBe(legacyCanvas.generation.inputFingerprint);

    for (const [scenarioId, error] of [["generic-flow", /Unsupported measurement scenario/], ["incremental-source", /explicit source change/]] as const) {
      await expect(scenarios.prepareStaticGraphScenario({ ...input, scenarioId, outputDirectory: join(input.root, scenarioId), sourceChange: undefined })).rejects.toThrow(error);
    }
  });
});

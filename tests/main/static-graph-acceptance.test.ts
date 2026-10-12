import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOMATED_ENGINEERING_BUDGET_RULES,
  assertAutomatedOutputAvoidsReservedPaths,
  calculateAutomatedAppBundleTreeSha256,
  collectInstrumentationComparisonPairs,
  collectAutomatedInstrumentationComparison,
  collectAutomatedReservedRegression,
  createAutomatedReservedSourceChange,
  evaluateAutomatedEngineeringBudgets,
  inventoryAutomatedReservedCheckout,
  collectStaticGraphBaseline,
  verifyAutomatedEngineeringInputs,
  verifyAutomatedReservedFirstRunReport,
  runStaticGraphAcceptance,
  type AcceptanceRunSpec,
  type AutomatedEngineeringRunSpec,
  type BaselineRunSpec,
  type MeasurementReport
} from "../../scripts/run-static-graph-acceptance";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })));
});

describe("static graph measurement runner", () => {
  it("reports cold app startup without gating it and applies the 1-second budget to app-running project open", () => {
    const metricValues = {
      appStartupMs: 2_100,
      projectSelectionMs: 20,
      workspaceInteractiveMs: 30,
      scanMs: 40,
      semanticAnalysisMs: 50,
      clusteringMs: 20,
      layoutMs: 25,
      commitMs: 15,
      ipcReceiptMs: 5,
      clickableGraphMs: 120,
      detailReadyMs: 40,
      lockWaitMs: 1,
      snapshotValidationMs: 1,
      snapshotParseMs: 1,
      snapshotReadMs: 1,
      detailIndexMs: 1,
      detailIpcRoundTripMs: 1,
      detailPanelPresentationMs: 1,
      selectionToWorkspaceInteractiveMs: 900,
      selectionToClickableGraphMs: 950,
      cancellationUiResponseMs: 10,
      backgroundTaskExitMs: 10,
      firstScreenIpcBytes: 100,
      cacheResidentBytes: 100,
      rendererLongTaskCount: 0,
      rendererLongTaskTotalMs: 0,
      rendererLongTaskMaxMs: 0,
      processTreePeakRssMiB: 100
    };
    const runs = [metricValues, { ...metricValues, appStartupMs: 2_500, selectionToWorkspaceInteractiveMs: 950 }]
      .map((metrics) => ({ projectId: "D01", scenarioId: "first-analysis", measurementValid: true, productOutcome: "success", metrics }));
    const corpus = { projects: [{ id: "D01", split: "development", sizeBand: "medium" }] };
    const spec = {
      repetitions: 2,
      scenarios: [{ id: "first-analysis", availability: "available" }],
      budgetRules: AUTOMATED_ENGINEERING_BUDGET_RULES
    };

    const result = evaluateAutomatedEngineeringBudgets(
      runs as unknown as Parameters<typeof evaluateAutomatedEngineeringBudgets>[0],
      corpus as unknown as Parameters<typeof evaluateAutomatedEngineeringBudgets>[1],
      spec as unknown as Parameters<typeof evaluateAutomatedEngineeringBudgets>[2]
    );

    expect(result.metrics["first-analysis/medium/appStartupMs"]).toBeUndefined();
    expect(result.reportedMetrics["first-analysis/medium/appStartupMs"]).toMatchObject({
      disposition: "reported-only", observed: 2_500, sampleCount: 2, plannedCount: 2,
      perProject: { D01: { observed: 2_500, sampleCount: 2, plannedCount: 2 } }
    });
    expect(result.reportedMetrics["first-analysis/medium/appStartupMs"]).not.toHaveProperty("passed");
    expect(result.metrics["first-analysis/medium/selectionToWorkspaceInteractiveMs"]).toMatchObject({
      observed: 950, maximum: 1_000, passed: true
    });
  });

  it("alternates five instrumented-on/off comparison pairs and records external durations", async () => {
    const launches: Array<{ mode: string; pair: number }> = [];
    const result = await collectInstrumentationComparisonPairs(5, async (mode, pair) => {
      launches.push({ mode, pair });
      return { mode, pair, externalDurationMs: pair * 10 + (mode === "on" ? 1 : 2) };
    });

    expect(launches).toEqual([
      { mode: "on", pair: 1 }, { mode: "off", pair: 1 },
      { mode: "off", pair: 2 }, { mode: "on", pair: 2 },
      { mode: "on", pair: 3 }, { mode: "off", pair: 3 },
      { mode: "off", pair: 4 }, { mode: "on", pair: 4 },
      { mode: "on", pair: 5 }, { mode: "off", pair: 5 }
    ]);
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ pair: 1, first: { mode: "on", pair: 1, externalDurationMs: 11 }, second: { mode: "off", pair: 1, externalDurationMs: 12 } });
    await expect(collectInstrumentationComparisonPairs(4, async () => ({ externalDurationMs: 1 })))
      .rejects.toThrow(/at least five pairs/i);
  });

  it("rejects instrumentation output paths that overlap the A3 output before input preflight", async () => {
    const a3OutputDirectory = join(tmpdir(), "flowweave-a3-output");
    const spec = {
      outputDirectory: a3OutputDirectory,
      reservedProjectCheckouts: { H01: join(tmpdir(), "holdout", "H01") },
      reservedOutputDirectory: join(tmpdir(), "reserved-output")
    } as AutomatedEngineeringRunSpec;
    for (const comparisonOutputDirectory of [a3OutputDirectory, join(a3OutputDirectory, "nested"), dirname(a3OutputDirectory)]) {
      await expect(collectAutomatedInstrumentationComparison(spec, comparisonOutputDirectory, "D03", "first-analysis", 5))
        .rejects.toThrow(/must not overlap/i);
    }
  });

  it("rejects outputs overlapping reserved paths by lexical metadata only", () => {
    const holdoutPath = "/Users/test/project/.superpowers/corpus-checkouts/H01";
    const reservedOutputPath = "/Users/test/project/.superpowers/reserved-run";
    for (const outputPath of [join(holdoutPath, "results"), dirname(holdoutPath), join(reservedOutputPath, "first-run")]) {
      expect(() => assertAutomatedOutputAvoidsReservedPaths(outputPath, { H01: holdoutPath }, reservedOutputPath))
        .toThrow(/must not overlap a registered holdout checkout or reserved output directory/i);
    }
    expect(() => assertAutomatedOutputAvoidsReservedPaths("/tmp/safe-output", { H01: holdoutPath }, reservedOutputPath)).not.toThrow();
  });

  it("runs the reserved-regression preflight before touching registered holdout paths", async () => {
    const fixture = await createFixture();
    const reservedCheckout = join(fixture.root, "not-a-checkout");
    const reservedOutputDirectory = join(fixture.root, "reserved-output");
    const spec = {
      ...fixture.baselineSpec,
      scenarios: ["first-analysis", "cached-reopen", "incremental-source", "detail-cold", "detail-hot", "old-format-migration"]
        .map((id) => ({ id, availability: "available" as const })),
      schemaVersion: 1,
      evaluationKind: "automated-engineering",
      corpusSha256: "a".repeat(64),
      taskId: "test/a4-preflight-order",
      developmentManifests: {},
      reservedProjectCheckouts: { D06: reservedCheckout },
      reservedOutputDirectory,
      boundFiles: [],
      budgetRules: AUTOMATED_ENGINEERING_BUDGET_RULES
    } as unknown as Parameters<typeof collectAutomatedReservedRegression>[0];

    await expect(collectAutomatedReservedRegression(spec, "first-run"))
      .rejects.toThrow(/boundFiles must bind unique/i);
    await expect(collectAutomatedReservedRegression({
      ...spec,
      budgetRules: { ...AUTOMATED_ENGINEERING_BUDGET_RULES, reportOnlyP95Metrics: [] }
    }, "first-run")).rejects.toThrow(/predeclared absolute time\/resource budget/i);
    await expect(collectAutomatedReservedRegression({
      ...spec,
      budgetRules: {
        ...AUTOMATED_ENGINEERING_BUDGET_RULES,
        timeP95AbsoluteMsByMetric: {
          ...AUTOMATED_ENGINEERING_BUDGET_RULES.timeP95AbsoluteMsByMetric,
          selectionToWorkspaceInteractiveMs: 60_000
        }
      }
    }, "first-run")).rejects.toThrow(/predeclared absolute time\/resource budget/i);
    await expect(readdir(reservedOutputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("verifies original first-run reports from an external preserved root and the current output root", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flowweave-first-report-")));
    temporaryDirectories.push(root);
    for (const outputRoot of ["preserved-v5", "fresh-v6"]) {
      const directory = join(root, outputRoot, "first-run");
      await mkdir(directory, { recursive: true });
      const path = join(directory, "automated-reserved-regression.json");
      const content = JSON.stringify({ schemaVersion: 1, kind: "automated-reserved-regression", evaluationKind: "automated-engineering",
        phase: "first-run", formalAcceptance: false, taskId: "same-task", corpusSha256: "a".repeat(64), specSha256: "b".repeat(64),
        outputDirectory: directory, projects: [{ id: "H01" }], runs: [], measurementValid: false, complete: true, productOutcome: "mixed" });
      await writeFile(path, content);
      const reference = await verifyAutomatedReservedFirstRunReport(path, "same-task", "a".repeat(64));
      expect(reference).toEqual({ path, sha256: createHash("sha256").update(content).digest("hex") });
      expect(await readFile(path, "utf8")).toBe(content);
      expect(await readdir(directory)).toEqual(["automated-reserved-regression.json"]);
    }
  });

  it.each([
    { label: "foreign task", change: { taskId: "foreign-task" } },
    { label: "foreign corpus", change: { corpusSha256: "c".repeat(64) } },
    { label: "repair phase", change: { phase: "repair-regression" } },
    { label: "foreign directory", change: { outputDirectory: "/not-the-report-parent" } },
    { label: "complete valid success", change: { measurementValid: true, complete: true, productOutcome: "success" } },
    { label: "missing validity status", change: { measurementValid: undefined } },
    { label: "foreign report kind", change: { kind: "automated-engineering" } },
    { label: "formal acceptance", change: { formalAcceptance: true } }
  ])("rejects a preserved first-run report with $label", async ({ change }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flowweave-foreign-first-report-")));
    temporaryDirectories.push(root);
    const path = join(root, "automated-reserved-regression.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, kind: "automated-reserved-regression", evaluationKind: "automated-engineering",
      phase: "first-run", formalAcceptance: false, taskId: "same-task", corpusSha256: "a".repeat(64), specSha256: "b".repeat(64),
      outputDirectory: root, projects: [{ id: "H01" }], runs: [], measurementValid: false, complete: true, productOutcome: "mixed", ...change }));
    await expect(verifyAutomatedReservedFirstRunReport(path, "same-task", "a".repeat(64))).rejects.toThrow(/failing first-run report/);
  });

  it("rejects preserved-report symlinks, symlinked ancestors and directories", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flowweave-symlink-first-report-")));
    temporaryDirectories.push(root);
    const directory = join(root, "preserved");
    await mkdir(directory);
    const path = join(directory, "automated-reserved-regression.json");
    await writeFile(path, "{}");
    const fileAlias = join(root, "report-alias.json");
    const directoryAlias = join(root, "directory-alias");
    await symlink(path, fileAlias);
    await symlink(directory, directoryAlias);
    await writeFile(join(root, "automated-reserved-regression.json"), "{}");
    for (const candidate of [fileAlias, join(directoryAlias, "automated-reserved-regression.json"),
      `${directoryAlias}/../automated-reserved-regression.json`, directory]) {
      await expect(verifyAutomatedReservedFirstRunReport(candidate, "same-task", "a".repeat(64))).rejects.toThrow(/regular file.*canonical path/);
    }
  });

  it.each(["main.py", "main.ts"])("binds an explicit reserved incremental change for %s to verified source bytes", (path) => {
    const content = path.endsWith(".py") ? "value = 1\r\n" : "export const value = 1;\n";
    const entry = { path, kind: "source" as const, mode: "100644", sizeBytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
    const change = createAutomatedReservedSourceChange(entry, content);
    expect(change).toMatchObject({ path, beforeSha256: entry.sha256 });
    expect(change.afterContent).toBe(`${content}${path.endsWith(".py") ? "\r\n#" : "\n//"} FlowWeave automated incremental-source fixture.${path.endsWith(".py") ? "\r\n" : "\n"}`);
    expect(() => createAutomatedReservedSourceChange(entry, `${content}changed`)).toThrow(/verified inventory/);
  });

  it("hashes only tracked regular reserved candidates and records excluded symlinks", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "flowweave-a4-inventory-"));
    temporaryDirectories.push(checkout);
    execFileSync("git", ["init", "-q", checkout]);
    execFileSync("git", ["-C", checkout, "config", "user.name", "FlowWeave fixture"]);
    execFileSync("git", ["-C", checkout, "config", "user.email", "fixture@example.invalid"]);
    await mkdir(join(checkout, "src"));
    await writeFile(join(checkout, "src/main.ts"), "export const fixture = 1;\n");
    await writeFile(join(checkout, "package.json"), "{}\n");
    await writeFile(join(checkout, "LICENSE"), "fixture license\n");
    await symlink("main.ts", join(checkout, "src/link.ts"));
    const unsafePath = "src/unsafe\\name.ts";
    if (process.platform !== "win32") await writeFile(join(checkout, unsafePath), "export const unsafe = true;\n");
    await writeFile(join(checkout, "README.md"), "not an inventory candidate\n");
    execFileSync("git", ["-C", checkout, "add", "."]);
    execFileSync("git", ["-C", checkout, "commit", "-qm", "fixture"]);
    const sourceRevision = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const checkoutTreeOid = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();

    const result = await inventoryAutomatedReservedCheckout({
      id: "H01",
      path: checkout,
      sourceRevision,
      checkoutTreeOid,
      generationProtocol: 7,
      language: "TypeScript",
      projectKinds: ["library"]
    });

    expect(result.project.inventoryEntries.map((entry) => entry.path)).toEqual(["LICENSE", "package.json", "src/main.ts"]);
    expect(result.evidence.excludedCandidatePaths).toEqual([
      { path: "src/link.ts", mode: "120000", reason: "symlink" },
      ...(process.platform === "win32" ? [] : [{ path: unsafePath, mode: "100644", reason: "unsafe-path" }])
    ]);
    expect(result.evidence.inventory).toMatchObject({ fileCount: 3, sourceFileCount: 1, languageCounts: { TypeScript: 1 } });
    expect(result.evidence.scope).toMatchObject({ includePaths: ["."], excludePaths: ["src/link.ts", ...(process.platform === "win32" ? [] : [unsafePath])], sha256: expect.any(String) });
    expect(result.evidence.scale).toMatchObject({ stratum: "unclassified", sourceFileCount: 1, sha256: expect.any(String) });
    expect(execFileSync("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" })).toBe("");
  });

  it("rejects incomplete automated registration without opening reserved manifests or relaxing formal acceptance", async () => {
    const fixture = await createFixture();
    const registry = JSON.parse(await readFile(fixture.baselineSpec.corpusPath, "utf8"));
    registry.status = "proposed";
    registry.repositories = [registry.repositories[0], registry.repositories[8]];
    registry.repositories[0].status = "proposed";
    registry.repositories[1].commit = "e".repeat(40);
    registry.repositories[1].sourceInventory.manifestPath = "manifests/never-open-reserved.jsonl";
    registry.repositories[0].acquisition.ownerStatus = "unassigned";
    registry.repositories[0].collectionScope.status = "proposed";
    registry.repositories[0].scale.status = "proposed";
    registry.repositories[0].sourceInventory.contentHash = registry.repositories[0].sourceInventory.manifestSha256;
    registry.selection = { repositoryCount: 2, developmentCount: 1, holdoutCount: 1, perLanguage: { TypeScript: { total: 2, development: 1, holdout: 1 } } };
    const corpusBytes = JSON.stringify(registry);
    await writeFile(fixture.baselineSpec.corpusPath, corpusBytes);
    const appRoot = join(fixture.root, "AutomatedFlowWeave.app", "Contents");
    const executablePath = join(appRoot, "MacOS", "FlowWeave");
    const appAsarPath = join(appRoot, "Resources", "app.asar");
    const resourcesManifestPath = join(fixture.root, "resources-manifest.json");
    const sourceManifestPath = join(fixture.root, "source-manifest.json");
    const packageSummaryPath = join(fixture.root, "summary.json");
    await mkdir(dirname(executablePath), { recursive: true });
    await mkdir(dirname(appAsarPath), { recursive: true });
    const frameworkFile = join(appRoot, "Frameworks", "fixture-framework.bin");
    await mkdir(dirname(frameworkFile), { recursive: true });
    await writeFile(executablePath, "fixture executable");
    await writeFile(appAsarPath, "fixture app bundle");
    await writeFile(frameworkFile, "fixture framework");
    await writeFile(resourcesManifestPath, JSON.stringify([{ path: "Contents/Resources/app.asar", sha256: createHash("sha256").update("fixture app bundle").digest("hex") }]));
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const measurementSources = [
      resolve(sourceRoot, "scripts/run-static-graph-acceptance.ts"),
      resolve(sourceRoot, "src/main/index.ts"),
      resolve(sourceRoot, "src/main/services/static-graph-measurement.ts"),
      resolve(sourceRoot, "src/main/services/static-graph-scenario.ts"),
      resolve(sourceRoot, "src/main/ipc/project.ipc.ts"),
      resolve(sourceRoot, "src/main/project-analysis.worker.ts"),
      resolve(sourceRoot, "src/main/services/project-generation.service.ts"),
      resolve(sourceRoot, "src/main/storage/flowweave-store.ts"),
      resolve(sourceRoot, "src/main/services/canvas-detail.service.ts"),
      resolve(sourceRoot, "src/preload/index.ts"),
      resolve(sourceRoot, "src/common/ipc-channels.ts"),
      resolve(sourceRoot, "src/components/ModulePanel.tsx"),
      resolve(sourceRoot, "src/types.ts")
    ];
    const runtimeSourceManifest = await Promise.all(measurementSources.slice(1).map(async (path) => ({
      path: relative(sourceRoot, path).split(sep).join("/"),
      sha256: createHash("sha256").update(await readFile(path)).digest("hex")
    })));
    await writeFile(sourceManifestPath, JSON.stringify(runtimeSourceManifest));
    const resourcesManifestSha256 = createHash("sha256").update(await readFile(resourcesManifestPath)).digest("hex");
    const sourceManifestSha256 = createHash("sha256").update(await readFile(sourceManifestPath)).digest("hex");
    await writeFile(packageSummaryPath, JSON.stringify({
      status: "passed",
      formalDistribution: false,
      notarized: false,
      artifact: {
        path: resolve(dirname(executablePath), "../.."),
        appAsarSha256: createHash("sha256").update(await readFile(appAsarPath)).digest("hex"),
        executableSha256: createHash("sha256").update(await readFile(executablePath)).digest("hex"),
        bundleTreeSha256: await calculateAutomatedAppBundleTreeSha256(resolve(dirname(executablePath), "../.."))
      },
      sourceManifest: { path: sourceManifestPath, sha256: sourceManifestSha256 },
      resourcesManifest: { path: resourcesManifestPath, sha256: resourcesManifestSha256 }
    }));
    const boundFiles = await Promise.all([...measurementSources, executablePath, appAsarPath, resourcesManifestPath, sourceManifestPath, packageSummaryPath].map(async (path) => ({
      path,
      sha256: createHash("sha256").update(await readFile(path)).digest("hex")
    })));
    const measurementSha256 = createHash("sha256").update(JSON.stringify(measurementSources.map((path) => ({
      path: relative(sourceRoot, path),
      sha256: boundFiles.find((file) => file.path === path)!.sha256
    })))).digest("hex");
    const spec = {
      ...fixture.baselineSpec,
      executablePath,
      schemaVersion: 1 as const,
      evaluationKind: "automated-engineering" as const,
      scenarios: [
        { id: "first-analysis", availability: "available" as const },
        { id: "cached-reopen", availability: "available" as const },
        { id: "incremental-source", availability: "available" as const },
        { id: "detail-cold", availability: "available" as const },
        { id: "detail-hot", availability: "available" as const },
        { id: "old-format-migration", availability: "available" as const }
      ],
      corpusSha256: createHash("sha256").update(corpusBytes).digest("hex"),
      taskId: "test/automated-input-freeze",
      projectCheckouts: { D01: fixture.projectPath },
      sourceChangesByProject: { D01: {
        path: "tracked.ts",
        beforeSha256: JSON.parse(await readFile(join(fixture.root, "manifests/D01.jsonl"), "utf8")).sha256,
        afterContent: "export const fixture = 2;\n"
      } },
      developmentManifests: { D01: { path: join(fixture.root, "manifests/D01.jsonl"), sha256: registry.repositories[0].sourceInventory.contentHash as string } },
      reservedProjectCheckouts: { D09: join(fixture.root, "reserved-D09") },
      reservedOutputDirectory: join(fixture.root, "reserved-results"),
      boundFiles,
      measurement: { ...fixture.baselineSpec.measurement, sha256: measurementSha256 },
      budgetRules: AUTOMATED_ENGINEERING_BUDGET_RULES
    };
    const registeredCorpusPath = resolve(sourceRoot, "docs/evidence/static-graph-generalization/corpus.json");
    const registeredCorpusBytes = await readFile(registeredCorpusPath);
    const registeredCorpus = JSON.parse(registeredCorpusBytes.toString("utf8"));
    const reservedProjectCheckouts = Object.fromEntries(registeredCorpus.repositories
      .filter((entry: { split: string }) => entry.split === "holdout")
      .map((entry: { id: string }) => [entry.id, join(fixture.root, "not-created", entry.id)]));
    const registeredSpec = {
      ...spec,
      corpusPath: registeredCorpusPath,
      corpusSha256: createHash("sha256").update(registeredCorpusBytes).digest("hex"),
      reservedProjectCheckouts
    };
    const preservedReportPath = join(fixture.root, "preserved/first-run.json");
    await mkdir(dirname(preservedReportPath), { recursive: true });
    await writeFile(preservedReportPath, "{}\n");
    const preservedReportHash = createHash("sha256").update(await readFile(preservedReportPath)).digest("hex");
    await expect(verifyAutomatedEngineeringInputs({
      ...registeredSpec,
      preservedFirstRunReport: { path: preservedReportPath, sha256: preservedReportHash }
    })).rejects.toThrow(/preservedFirstRunReport must bind its canonical absolute path and SHA-256/i);
    await expect(verifyAutomatedEngineeringInputs({
      ...registeredSpec,
      preservedFirstRunReport: { path: preservedReportPath, sha256: preservedReportHash },
      boundFiles: [...registeredSpec.boundFiles, { path: preservedReportPath, sha256: "0".repeat(64) }]
    })).rejects.toThrow(/preservedFirstRunReport must bind its canonical absolute path and SHA-256/i);
    await expect(verifyAutomatedEngineeringInputs({ ...registeredSpec, reservedProjectCheckouts: undefined as unknown as Record<string, string> }))
      .rejects.toThrow(/reserved.*holdout/i);
    await expect(verifyAutomatedEngineeringInputs({ ...registeredSpec, reservedProjectCheckouts: { EXTRA: join(fixture.root, "not-created") } }))
      .rejects.toThrow(/reserved.*holdout/i);
    await expect(verifyAutomatedEngineeringInputs({ ...registeredSpec, reservedProjectCheckouts: { ...reservedProjectCheckouts, H01: "relative-checkout" } }))
      .rejects.toThrow(/reserved.*absolute/i);
    await expect(verifyAutomatedEngineeringInputs({ ...registeredSpec, reservedOutputDirectory: "relative-output" }))
      .rejects.toThrow(/reserved.*absolute/i);
    await expect(verifyAutomatedEngineeringInputs(registeredSpec))
      .rejects.toThrow(/Automated development sample D01 needs a matching registered manifest hash/i);

    await writeFile(frameworkFile, "tampered framework");
    await expect(verifyAutomatedEngineeringInputs(spec)).rejects.toThrow(/app bundle tree hash/i);
    await writeFile(frameworkFile, "fixture framework");
    await expect(verifyAutomatedEngineeringInputs({ ...spec, boundFiles: boundFiles.filter((file) => file.path !== measurementSources[0]) })).rejects.toThrow(/must bind its measurement source/i);
    await expect(verifyAutomatedEngineeringInputs(spec)).rejects.toThrow(/registered A1 corpus/i);
    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/not frozen/);
    await expect(verifyAutomatedEngineeringInputs({ ...spec, corpusSha256: "0".repeat(64) })).rejects.toThrow(/registered A1 corpus/i);
    expect(await readFile(fixture.baselineSpec.corpusPath, "utf8")).toBe(corpusBytes);
    await expect(readFile(join(fixture.outputDirectory, "automated-run.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const resourcesRoot = join(appRoot, "Resources");
    const unlistedResource = join(resourcesRoot, "unlisted.bin");
    await writeFile(unlistedResource, "unlisted");
    await expect(verifyAutomatedEngineeringInputs(spec)).rejects.toThrow(/cover every file/i);
    await rm(unlistedResource);

    const outsideDirectory = join(fixture.root, "outside-resource");
    const linkedResource = join(resourcesRoot, "outside");
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, linkedResource);
    const resourcesManifest = [
      { path: "Contents/Resources/app.asar", sha256: createHash("sha256").update("fixture app bundle").digest("hex") },
      { path: "Contents/Resources/outside", sha256: createHash("sha256").update("outside resource").digest("hex") }
    ];
    await writeFile(resourcesManifestPath, JSON.stringify(resourcesManifest));
    const packageSummary = JSON.parse(await readFile(packageSummaryPath, "utf8"));
    packageSummary.resourcesManifest.sha256 = createHash("sha256").update(await readFile(resourcesManifestPath)).digest("hex");
    await writeFile(packageSummaryPath, JSON.stringify(packageSummary));
    const symlinkSpec = {
      ...spec,
      boundFiles: await Promise.all(spec.boundFiles.map(async (file) => ({
        ...file,
        sha256: file.path === resourcesManifestPath || file.path === packageSummaryPath
          ? createHash("sha256").update(await readFile(file.path === resourcesManifestPath ? resourcesManifestPath : packageSummaryPath)).digest("hex")
          : file.sha256
      })))
    };
    await expect(verifyAutomatedEngineeringInputs(symlinkSpec)).rejects.toThrow(/cannot contain unbound symlinks/i);
  });

  it("preserves partial prior evidence and refuses to launch into an existing output directory", async () => {
    const fixture = await createFixture();
    const priorResult = Buffer.from('{"prior":"result"}\n');
    const priorContext = Buffer.from('{"prior":"context"}\n');
    const partialRunDirectory = join(fixture.outputDirectory, "raw", "D01", "first-analysis", "run-01");
    await mkdir(partialRunDirectory, { recursive: true });
    await writeFile(join(fixture.outputDirectory, "baseline-run.json"), priorResult);
    await writeFile(join(partialRunDirectory, "context.json"), priorContext);

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/output directory already exists/i);

    expect(await readFile(join(fixture.outputDirectory, "baseline-run.json"))).toEqual(priorResult);
    expect(await readFile(join(partialRunDirectory, "context.json"))).toEqual(priorContext);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
  });

  it("preflights nested and symlinked future output locations against every checkout before any source write", async () => {
    for (const kind of ["nested", "symlinked", "other-checkout"]) {
      const fixture = await createFixture();
      let protectedRoot = fixture.projectPath;
      let outputDirectory = join(protectedRoot, "results", "future");
      let projectCheckouts = fixture.baselineSpec.projectCheckouts;
      if (kind === "symlinked") {
        const alias = join(fixture.root, "source-alias");
        await symlink(protectedRoot, alias);
        outputDirectory = join(alias, "results", "future");
      }
      if (kind === "other-checkout") {
        protectedRoot = join(fixture.root, "other-source");
        await mkdir(protectedRoot);
        projectCheckouts = { ...projectCheckouts, D02: protectedRoot };
        outputDirectory = join(protectedRoot, "results", "future");
      }
      const entriesBefore = await readdir(protectedRoot);
      const outcome = await collectStaticGraphBaseline({ ...fixture.baselineSpec, outputDirectory, projectCheckouts })
        .then(() => "unexpectedly accepted", (error: unknown) => error instanceof Error ? error.message : String(error));

      expect(outcome).toMatch(/outside.*source checkout/i);
      expect(await readdir(protectedRoot)).toEqual(entriesBefore);
      await expect(stat(join(protectedRoot, "results"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
    }
  });

  it("forwards the explicit per-project incremental source change into each measurement context", async () => {
    const fixture = await createFixture();
    const sourceChange = { path: "tracked.ts", beforeSha256: createHash("sha256").update("export const fixture = 1;\n").digest("hex"), afterContent: "export const fixture = 2;\n" };
    const spec = { ...fixture.baselineSpec, scenarios: [{ id: "incremental-source", availability: "available" as const }], sourceChangesByProject: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`D${String(index + 1).padStart(2, "0")}`, sourceChange])) };

    await collectStaticGraphBaseline(spec);
    const context = JSON.parse(await readFile(join(fixture.outputDirectory, "raw", "D01", "incremental-source", "run-01", "context.json"), "utf8"));
    expect(context.sourceChange).toEqual(sourceChange);
    expect(context.instrumentationMode).toBe("on");
    expect(await readFile(join(fixture.projectPath, "tracked.ts"), "utf8")).toBe("export const fixture = 1;\n");
  });

  it("rejects unknown scenarios and missing incremental edits before launching any process", async () => {
    const fixture = await createFixture();
    await expect(collectStaticGraphBaseline({ ...fixture.baselineSpec, scenarios: [{ id: "generic-flow", availability: "available" }] })).rejects.toThrow(/Unsupported measurement scenario/);
    await expect(collectStaticGraphBaseline({ ...fixture.baselineSpec, scenarios: [{ id: "incremental-source", availability: "available" }] })).rejects.toThrow(/explicit source change/);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
  });

  it("retains an early product failure without generation identity as a valid product failure", async () => {
    const fixture = await createFixture({
      productOutcome: "failure",
      failureStage: "scan",
      error: "source scan failed",
      omitGraphIdentityOnFailure: true,
      metrics: { appStartupMs: 200, projectSelectionMs: 20 },
      unavailableMetrics: Object.fromEntries(requiredPerformanceMetrics()
        .filter((metric) => metric !== "appStartupMs" && metric !== "projectSelectionMs")
        .map((metric) => [metric, "Not reached because the source scan failed."]))
    });
    await writeFile(join(fixture.projectPath, "README.md"), "out-of-scope checkout change", "utf8");

    const result = await collectStaticGraphBaseline(fixture.baselineSpec);
    const record = result.runs[0];

    expect(result.corpusPath).toBe(fixture.baselineSpec.corpusPath);
    expect(result.generationProtocol).toBe(fixture.baselineSpec.generationProtocol);
    expect(result.measurementValid).toBe(true);
    expect(result.productOutcome).toBe("failure");
    expect(result.runs).toHaveLength(160);
    expect(record).toMatchObject({ productOutcome: "failure", failureStage: "scan", error: "source scan failed" });
    expect(record.metrics.appStartupMs).toBe(200);
    expect(JSON.parse(await readFile(join(fixture.outputDirectory, "baseline-run.json"), "utf8"))).toMatchObject({
      measurementValid: true,
      productOutcome: "failure"
    });
    const rawRuns = (await readFile(join(fixture.outputDirectory, "baseline.jsonl"), "utf8")).trim().split("\n");
    expect(rawRuns).toHaveLength(160);
    expect(JSON.parse(rawRuns[0])).toMatchObject({ projectId: "D01", repetition: 1, productOutcome: "failure" });
  }, 60_000);

  it("rejects an unexplained missing metric", async () => {
    const fixture = await createFixture({ metrics: { appStartupMs: 1 }, unavailableMetrics: {} });

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/unexplained missing metric/i);
  });

  it("requires a reason when the metric for a failed stage is absent", async () => {
    const fixture = await createFixture({
      productOutcome: "failure",
      failureStage: "semanticAnalysis",
      error: "analysis stopped",
      metrics: { appStartupMs: 1, projectSelectionMs: 1, workspaceInteractiveMs: 1, scanMs: 1 },
      unavailableMetrics: Object.fromEntries(Object.entries(downstreamReasons("semanticAnalysis")).filter(([metric]) => metric !== "semanticAnalysisMs"))
    });

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/unexplained missing metric semanticAnalysisMs/i);
  });

  it("invalidates a run when a selected source file changes during the measurement process", async () => {
    const fixture = await createFixture({ mutateSelectedSourceAtRepetition: 1 });
    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/frozen source inventory changed during the measurement process/i);
    const output = JSON.parse(await readFile(join(fixture.outputDirectory, "baseline-run.json"), "utf8"));
    const affectedRuns = output.runs.filter((run: { projectId: string; scenarioId: string }) =>
      run.projectId === "D01" && run.scenarioId === "first-analysis");

    expect(affectedRuns).toHaveLength(20);
    expect(affectedRuns.every((run: { measurementValid: boolean; failureStage: string; productOutcome: string; error: string }) =>
      !run.measurementValid && run.failureStage === "collector" && run.productOutcome === "unknown" &&
      /source inventory changed during the measurement process.*tracked\.ts/i.test(run.error))).toBe(true);
  }, 120_000);

  it("rejects evidence from the wrong generation or pinned source revision", async () => {
    const fixture = await createFixture({ sourceRevision: "different-revision" });

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/revision/i);
    const wrongGeneration = await createFixture({ currentGenerationId: "stale-generation" });

    await expect(collectStaticGraphBaseline(wrongGeneration.baselineSpec)).rejects.toThrow(/generation/i);
  }, 120_000);

  it("rejects a clean checkout committed at a different source revision before launching", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.projectPath, "tracked.txt"), "different source bytes\n", "utf8");
    execFileSync("git", ["-C", fixture.projectPath, "add", "tracked.txt"]);
    execFileSync("git", ["-C", fixture.projectPath, "commit", "-q", "-m", "different pinned source"]);

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/corpus pins/i);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
  });

  it("rejects a checkout whose tree differs from the registered acquisition tree before launching", async () => {
    const fixture = await createFixture();
    const corpusPath = join(fixture.root, "corpus.json");
    const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
    corpus.repositories[0].acquisition.checkoutTreeOid = "f".repeat(40);
    await writeFile(corpusPath, JSON.stringify(corpus), "utf8");

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/checkout tree.*corpus registers/i);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
  });

  it("rejects a development manifest with a tampered file hash before launching", async () => {
    const fixture = await createFixture();
    const corpusPath = join(fixture.root, "corpus.json");
    const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
    const project = corpus.repositories[0];
    const manifestPath = join(fixture.root, project.sourceInventory.manifestPath);
    const manifest = (await readFile(manifestPath, "utf8")).trim().split("\n").map((line: string) => JSON.parse(line));
    manifest[0].sha256 = "f".repeat(64);
    const manifestBytes = `${manifest.map((entry: unknown) => JSON.stringify(entry)).join("\n")}\n`;
    await writeFile(manifestPath, manifestBytes, "utf8");
    project.sourceInventory.manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    await writeFile(corpusPath, JSON.stringify(corpus), "utf8");

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/content SHA-256 mismatch/i);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
  });

  it("rejects glob syntax in the frozen collection-scope contract before launching", async () => {
    const fixture = await createFixture();
    const corpusPath = join(fixture.root, "corpus.json");
    const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
    corpus.repositories[0].collectionScope.includePaths = ["src/**/*.ts"];
    await writeFile(corpusPath, JSON.stringify(corpus), "utf8");

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/glob patterns are unsupported/i);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
  });

  it("accepts a module-specific Gradle file as a frozen configuration inventory entry", async () => {
    const fixture = await createFixture();
    const corpusPath = join(fixture.root, "corpus.json");
    const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
    const project = corpus.repositories[0];
    const manifestPath = join(fixture.root, project.sourceInventory.manifestPath);
    const manifest = (await readFile(manifestPath, "utf8")).trim().split("\n").map((line: string) => JSON.parse(line));
    manifest.push(await inventoryEntry(fixture.projectPath, "spring-core.gradle", "configuration"));
    manifest.push(await inventoryEntry(fixture.projectPath, "gradle.properties", "configuration"));
    manifest.push(await inventoryEntry(fixture.projectPath, "gradle/wrapper/gradle-wrapper.properties", "configuration"));
    manifest.sort((left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path));
    const manifestBytes = `${manifest.map((entry: unknown) => JSON.stringify(entry)).join("\n")}\n`;
    await writeFile(manifestPath, manifestBytes, "utf8");
    project.collectionScope.includePaths.push("spring-core.gradle");
    project.collectionScope.includePaths.push("gradle.properties");
    project.collectionScope.includePaths.push("gradle/wrapper/gradle-wrapper.properties");
    project.sourceInventory.manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    project.sourceInventory.fileCount = manifest.length;
    await writeFile(corpusPath, JSON.stringify(corpus), "utf8");

    const result = await collectStaticGraphBaseline(fixture.baselineSpec);

    expect(result.measurementValid).toBe(true);
    expect(result.runs[0].selection.configurationPaths).toEqual(["gradle.properties", "gradle/wrapper/gradle-wrapper.properties", "spring-core.gradle"]);
  });

  it("rejects a scoped source path omitted from the development inventory manifest", async () => {
    const fixture = await createFixture();
    const corpusPath = join(fixture.root, "corpus.json");
    const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
    corpus.repositories[0].collectionScope.includePaths.push("secondary.go");
    await writeFile(corpusPath, JSON.stringify(corpus), "utf8");

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/inventory paths.*unregistered=secondary\.go/i);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
  });

  it("rejects false UI-ready evidence", async () => {
    const fixture = await createFixture({ uiReadyEvidence: {
      workspaceInteractive: { status: "not-reached", reason: "Not reached." },
      clickableGraph: { status: "ready", generationId: "generation-1", userRevision: 4 },
      detailReady: { status: "ready", generationId: "generation-1", userRevision: 4 }
    } });

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/UI-ready/i);
  });

  it("keeps completed detail readiness when its later timing validation fails", async () => {
    const fixture = await createFixture({
      sampleCount: 12,
      productOutcome: "failure",
      failureStage: "detailReadyMs",
      error: "Detail timing identity validation failed after the panel became ready.",
      uiReadyEvidence: {
        workspaceInteractive: { status: "ready", generationId: "generation-1", userRevision: 4 },
        clickableGraph: { status: "ready", generationId: "generation-1", userRevision: 4 },
        detailReady: { status: "ready", generationId: "generation-1", userRevision: 4 }
      }
    });

    const result = await collectStaticGraphBaseline(fixture.baselineSpec);

    expect(result.measurementValid).toBe(true);
    expect(result.runs[0]).toMatchObject({
      measurementValid: true,
      productOutcome: "failure",
      failureStage: "detailReadyMs"
    });
  });

  it("retains every planned run and rejects an omitted failed run", async () => {
    const fixture = await createFixture({ omitReportAtRepetition: 2 });

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/planned run.*missing|missing.*planned run/i);
    const output = JSON.parse(await readFile(join(fixture.outputDirectory, "baseline-run.json"), "utf8"));
    await expect(readFile(join(fixture.outputDirectory, "raw/D01/first-analysis/run-02/electron.stderr.log"), "utf8"))
      .resolves.toContain("fixture startup failure");
    expect(output.runs).toHaveLength(160);
    expect((await readFile(join(fixture.outputDirectory, "baseline.jsonl"), "utf8")).trim().split("\n")).toHaveLength(160);
    expect(output.runs[1]).toMatchObject({ measurementValid: false, productOutcome: "unknown", failureStage: "collector" });
  });

  it("never launches or reads holdout project outputs", async () => {
    const fixture = await createFixture({ includeHoldout: true });
    const projectCheckouts = Object.fromEntries(Object.entries(fixture.baselineSpec.projectCheckouts).map(([id, path]) => [
      id,
      id >= "D09" ? join(fixture.root, "holdout-checkout-must-not-be-read") : path
    ]));

    const result = await collectStaticGraphBaseline({ ...fixture.baselineSpec, projectCheckouts });

    expect(result.plannedRuns).toBe(160);
    expect(result.runs.every((run) => run.split === "development")).toBe(true);
    await expect(readFile(join(fixture.outputDirectory, "raw", "D09"))).rejects.toThrow();
  });

  it("validates exact sample, scope, scenario, and complete gates before launching acceptance", async () => {
    const fixture = await createFixture();
    const contractPath = await writeCompleteContract(fixture.root);
    const contract = JSON.parse(await readFile(contractPath, "utf8"));
    contract.samples[0].id = "different-project";
    await writeFile(contractPath, JSON.stringify(contract), "utf8");
    await expect(runAcceptanceWithContract(fixture, contractPath)).rejects.toThrow(/sample.*mismatch/i);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();

    contract.samples[0].id = "D01";
    contract.samples[0].treeOid = "f".repeat(40);
    await writeFile(contractPath, JSON.stringify(contract), "utf8");
    await expect(runAcceptanceWithContract(fixture, contractPath)).rejects.toThrow(/sample.*mismatch/i);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();

    const scenarioFixture = await createFixture({ launchMarkerPath: join(fixture.root, "scenario-launches.log") });
    const completeContract = await writeCompleteContract(scenarioFixture.root);
    await expect(runAcceptanceWithContract({ ...scenarioFixture, baselineSpec: { ...scenarioFixture.baselineSpec, repetitions: 21 } }, completeContract))
      .rejects.toThrow(/scenario IDs.*repetition counts mismatch/i);
    await expect(readFile(join(scenarioFixture.root, "scenario-launches.log"))).rejects.toThrow();
  });

  it("requires each supported language to have development and holdout corpus coverage", async () => {
    const fixture = await createFixture({ includeHoldout: false });
    const contractPath = await writeCompleteContract(fixture.root);

    await expect(runAcceptanceWithContract(fixture, contractPath)).rejects.toThrow(/language TypeScript requires|at least 12 independent samples/i);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
  });

  it("rejects a corpus with fewer than twelve independent sample IDs before launch", async () => {
    const fixture = await createFixture({ sampleCount: 7 });

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/language TypeScript requires|at least 12 independent samples/i);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
  });

  it("rejects the registered real corpus while source inventory and scope are pending", async () => {
    const fixture = await createFixture();
    const spec = {
      ...fixture.baselineSpec,
      corpusPath: join(process.cwd(), "docs/evidence/static-graph-generalization/corpus.json")
    };

    await expect(collectStaticGraphBaseline(spec)).rejects.toThrow(/not frozen.*proposed/i);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
  });

  it("rejects a corpus whose top-level status is frozen while candidate identities remain pending", async () => {
    const fixture = await createFixture();
    const corpusPath = join(fixture.root, "corpus.json");
    const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
    corpus.selection.identityFreezeStatus = "pending";
    await writeFile(corpusPath, JSON.stringify(corpus), "utf8");

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/identities are not frozen/i);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
  });

  it("requires holdout labels to be reviewed by people independent from development", async () => {
    const fixture = await createFixture();
    const contractPath = await writeCompleteContract(fixture.root);
    const contract = JSON.parse(await readFile(contractPath, "utf8"));
    contract.qualityGates.labelEvidenceBySplit.holdout.reviewerIds = ["reviewer-a", "reviewer-c"];
    await writeFile(contractPath, JSON.stringify(contract), "utf8");

    await expect(runAcceptanceWithContract(fixture, contractPath)).rejects.toThrow(/reviewers independent/i);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
  });

  it("rejects a holdout split in the ordinary acceptance entrypoint before launch", async () => {
    const fixture = await createFixture();
    const contractPath = await writeCompleteContract(fixture.root);
    const acceptance = {
      ...fixture.baselineSpec,
      contractPath,
      contractSha256: createHash("sha256").update(await readFile(contractPath)).digest("hex"),
      targetSplit: "holdout"
    } as unknown as AcceptanceRunSpec;

    await expect(runStaticGraphAcceptance(acceptance)).rejects.toThrow(/development-only|T11/i);
    await expect(readFile(join(fixture.root, "launches.log"))).rejects.toThrow();
  });

  it("records reproducibility identity and reports module-quality gates per project", async () => {
    const fixture = await createFixture({
      projectQualityOverrides: { D02: { responsibilityConsistency: 3 } },
      projectMetricOverrides: { D02: { appStartupMs: 2_000, cancellationUiResponseMs: 700 } }
    });
    const contractPath = await writeCompleteContract(fixture.root);
    const result = await runAcceptanceWithContract(fixture, contractPath);

    expect(result.contractPath).toBe(contractPath);
    expect(result.contractSha256).toBe(createHash("sha256").update(await readFile(contractPath)).digest("hex"));
    expect(result.corpusSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.corpusPath).toBe(fixture.baselineSpec.corpusPath);
    expect(result.generationProtocol).toBe(fixture.baselineSpec.generationProtocol);
    expect(result.selectedSplit).toBe("development");
    expect(result.measurementIdentity).toMatchObject(fixture.baselineSpec.measurement);
    expect(result.qualityResults["project/D02/moduleQuality/responsibilityConsistency"]).toMatchObject({ observed: 3, passed: false });
    expect(result.qualityResults["moduleQuality/responsibilityConsistency"].passed).toBe(false);
    expect(result.thresholdResults["first-analysis/small/appStartupMs"].perProject.D02).toMatchObject({ passed: false, p95: 2_000 });
    expect(result.resourceResults["small/cancellationUiResponseMs"].perProject.D02).toMatchObject({ passed: false, observed: 700 });
    expect(result.formalAcceptance).toBe(false);
    expect((await readFile(join(fixture.outputDirectory, "acceptance.jsonl"), "utf8")).trim().split("\n")).toHaveLength(160);
  });

  it("covers every positive source-inventory language in a mixed Go and TypeScript repository", async () => {
    const fixture = await createFixture({ mixedLanguage: true });
    const contractPath = await writeCompleteContract(fixture.root);
    const result = await runAcceptanceWithContract(fixture, contractPath);
    const context = JSON.parse(await readFile(join(fixture.outputDirectory, "raw", "D01", "first-analysis", "run-01", "context.json"), "utf8"));
    const corpus = JSON.parse(await readFile(join(fixture.root, "corpus.json"), "utf8"));
    const project = corpus.repositories.find(({ id }: { id: string }) => id === "D01");
    const record = result.runs.find((run) => run.projectId === "D01");
    const expectedScopeSha256 = createHash("sha256").update(JSON.stringify({
      includePaths: [...project.collectionScope.includePaths].sort(),
      excludePaths: [...project.collectionScope.excludePaths].sort()
    })).digest("hex");

    expect(fixture.baselineSpec.supportedScope.languages).toEqual(["Go", "TypeScript"]);
    expect(context).toMatchObject({
      languages: ["Go", "TypeScript"],
      sourceInventoryEntries: expect.arrayContaining([
        expect.objectContaining({ path: "tracked.ts", kind: "source", sha256: expect.any(String) }),
        expect.objectContaining({ path: "secondary.go", kind: "source", sha256: expect.any(String) }),
        expect.objectContaining({ path: "go.mod", kind: "configuration", sha256: expect.any(String) })
      ]),
      collectionScope: { includePaths: ["tracked.ts", "secondary.go", "go.mod"], excludePaths: [] },
      selection: {
        sourcePaths: ["secondary.go", "tracked.ts"],
        configurationPaths: ["go.mod"],
        scopeSha256: expectedScopeSha256,
        sourceInventorySha256: project.sourceInventory.manifestSha256
      }
    });
    expect(record).toMatchObject({
      language: "TypeScript",
      languages: ["Go", "TypeScript"],
      collectionScope: { includePaths: ["tracked.ts", "secondary.go", "go.mod"], excludePaths: [] },
      selection: context.selection
    });
    expect(record?.selection.sourceInventorySha256).toBe(context.selection.sourceInventorySha256);
    expect(result.qualityResults["callPrecision/Go"].observed).toBeCloseTo(0.99);
    expect(result.qualityResults["callPrecision/Go"].passed).toBe(true);
    expect(result.qualityResults["callPrecision/TypeScript"].observed).toBeCloseTo(0.99);
    expect(result.qualityResults["callPrecision/TypeScript"].passed).toBe(true);
  });

  it("fails the secondary-language quality gate when mixed-project evidence omits that language", async () => {
    const fixture = await createFixture({ mixedLanguage: true, omitSecondaryLanguageEvidence: true });
    const contractPath = await writeCompleteContract(fixture.root);
    const result = await runAcceptanceWithContract(fixture, contractPath);

    expect(result.qualityResults["callPrecision/Go"]).toMatchObject({ observed: null, passed: false });
    expect(result.qualityResults["staticCallRecall/Go"]).toMatchObject({ observed: null, passed: false });
    expect(result.thresholdOutcome).toBe("fail");
    expect(result.formalAcceptance).toBe(false);
  });

  it("fails the secondary-language quality gate when mixed-project quality is below threshold", async () => {
    const fixture = await createFixture({ mixedLanguage: true, secondaryLanguageQuality: 0.8 });
    const contractPath = await writeCompleteContract(fixture.root);
    const result = await runAcceptanceWithContract(fixture, contractPath);

    expect(result.qualityResults["callPrecision/Go"].observed).toBeCloseTo(0.8);
    expect(result.qualityResults["callPrecision/Go"].passed).toBe(false);
    expect(result.thresholdOutcome).toBe("fail");
    expect(result.formalAcceptance).toBe(false);
  });

  it("rejects incomplete quality, resource, or measurement identity gates", async () => {
    const fixture = await createFixture();
    const contractPath = await writeCompleteContract(fixture.root);
    const contract = JSON.parse(await readFile(contractPath, "utf8"));
    delete contract.qualityGates.identityErrorsMax;
    await writeFile(contractPath, JSON.stringify(contract), "utf8");
    await expect(runAcceptanceWithContract(fixture, contractPath)).rejects.toThrow(/quality gate/i);
  });

  it("fails formal acceptance closed when quality or full-process resource evidence is missing", async () => {
    const fixture = await createFixture({ qualityEvidence: {} });
    const contractPath = await writeCompleteContract(fixture.root);
    const result = await runAcceptanceWithContract(fixture, contractPath);

    expect(result.measurementValid).toBe(true);
    expect(result.formalAcceptance).toBe(false);
    expect(result.qualityResults.labelDatasetIdentity.passed).toBe(false);
    expect(result.qualityResults["moduleQuality/responsibilityConsistency"].passed).toBe(false);
    expect(result.resourceResults["small/processTreePeakRssMiB"].passed).toBe(false);
  });

  it("records malformed JSON report shapes as collector failures and continues every planned run", async () => {
    const fixture = await createFixture({ malformedReportsAt: [1, 2, 3] });

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/collector/i);
    const output = JSON.parse(await readFile(join(fixture.outputDirectory, "baseline-run.json"), "utf8"));
    expect(output.runs).toHaveLength(160);
    const malformedRuns = output.runs.filter((run: { repetition: number }) => run.repetition <= 3);
    const remainingRuns = output.runs.filter((run: { repetition: number }) => run.repetition > 3);
    expect(malformedRuns).toHaveLength(24);
    expect(malformedRuns.every((run: { measurementValid: boolean; failureStage: string }) => !run.measurementValid && run.failureStage === "collector")).toBe(true);
    expect(remainingRuns).toHaveLength(136);
    expect(remainingRuns.every((run: { measurementValid: boolean }) => run.measurementValid)).toBe(true);
  });

  it("rejects report reuse across project, scenario, or repetition identities", async () => {
    const fixture = await createFixture({ reportRepetition: 1 });

    await expect(collectStaticGraphBaseline(fixture.baselineSpec)).rejects.toThrow(/repetition/i);
  });

  it("escalates an ignored SIGTERM and persists timeout failure while retaining all runs", async () => {
    const fixture = await createFixture({ hangAtRepetition: 1 });

    await expect(collectStaticGraphBaseline({ ...fixture.baselineSpec, processTimeoutMs: 100, killGraceMs: 100 })).rejects.toThrow(/timed out/i);
    const output = JSON.parse(await readFile(join(fixture.outputDirectory, "baseline-run.json"), "utf8"));
    expect(output.runs).toHaveLength(160);
    expect(output.runs[0]).toMatchObject({ measurementValid: false, failureStage: "collector", productOutcome: "unknown" });
    expect(output.runs[0].error).toMatch(process.platform === "win32" ? /sent SIGTERM/i : /SIGKILL/i);
  });

  it("allows baseline collection before a contract is frozen and refuses formal acceptance", async () => {
    const fixture = await createFixture();
    const baseline = await collectStaticGraphBaseline(fixture.baselineSpec);

    expect(baseline.measurementValid).toBe(true);
    await expect(runStaticGraphAcceptance({ ...fixture.baselineSpec, contractPath: "", contractSha256: "", targetSplit: "development" } as AcceptanceRunSpec))
      .rejects.toThrow(/frozen contract/i);
  });

  it("requires a complete frozen contract with the exact declared hash", async () => {
    const fixture = await createFixture();
    const contractPath = join(fixture.root, "acceptance-contract.json");
    const contractBytes = JSON.stringify({ schemaVersion: 1, status: "frozen", thresholds: {} });
    await writeFile(contractPath, contractBytes, "utf8");
    const incompleteSpec = { ...fixture.baselineSpec, contractPath, contractSha256: createHash("sha256").update(contractBytes).digest("hex"), targetSplit: "development" } as AcceptanceRunSpec;

    await expect(runStaticGraphAcceptance(incompleteSpec)).rejects.toThrow(/incomplete frozen contract/i);
    await expect(runStaticGraphAcceptance({ ...incompleteSpec, contractSha256: "0".repeat(64) }))
      .rejects.toThrow(/contract hash mismatch/i);
  });

  it("never passes formal acceptance when a product run fails despite complete measurement", async () => {
    const fixture = await createFixture({
      productOutcome: "failure",
      failureStage: "detailReadyMs",
      error: "detail panel failed",
      metrics: {
        appStartupMs: 200, projectSelectionMs: 20, workspaceInteractiveMs: 30, scanMs: 40,
        semanticAnalysisMs: 50, clusteringMs: 20, layoutMs: 25, commitMs: 15, ipcReceiptMs: 5, clickableGraphMs: 120
      },
      unavailableMetrics: downstreamReasons("detailReady"),
      uiReadyEvidence: {
        workspaceInteractive: { status: "ready", generationId: "generation-1", userRevision: 4 },
        clickableGraph: { status: "ready", generationId: "generation-1", userRevision: 4 },
        detailReady: { status: "not-reached", reason: "The detail panel failed after graph interaction." }
      }
    });
    const contractPath = await writeCompleteContract(fixture.root);
    const result = await runStaticGraphAcceptance({
      ...fixture.baselineSpec,
      contractPath,
      targetSplit: "development",
      contractSha256: createHash("sha256").update(await readFile(contractPath)).digest("hex")
    });

    expect(result.measurementValid).toBe(true);
    expect(result.productOutcome).toBe("failure");
    expect(result.thresholdOutcome).toBe("fail");
    expect(result.formalAcceptance).toBe(false);
    expect(JSON.parse(await readFile(join(fixture.outputDirectory, "acceptance-run.json"), "utf8"))).toMatchObject({
      formalAcceptance: false,
      thresholdOutcome: "fail"
    });
  });
});

interface FixtureOptions {
  productOutcome?: MeasurementReport["productOutcome"];
  failureStage?: string;
  error?: string;
  metrics?: Record<string, number>;
  qualityEvidence?: unknown;
  unavailableMetrics?: Record<string, string>;
  sourceRevision?: string;
  currentGenerationId?: string;
  uiReadyEvidence?: MeasurementReport["uiReadyEvidence"];
  omitGraphIdentityOnFailure?: boolean;
  mutateSelectedSourceAtRepetition?: number;
  omitReportAtRepetition?: number;
  includeHoldout?: boolean;
  malformedReportsAt?: number[];
  reportProjectId?: string;
  reportScenarioId?: string;
  reportRepetition?: number;
  hangAtRepetition?: number;
  launchMarkerPath?: string;
  projectQualityOverrides?: Record<string, Record<string, number>>;
  projectMetricOverrides?: Record<string, Record<string, number>>;
  sampleCount?: number;
  mixedLanguage?: boolean;
  omitSecondaryLanguageEvidence?: boolean;
  secondaryLanguageQuality?: number;
}

async function createFixture(options?: FixtureOptions) {
  const root = await mkdtemp(join(tmpdir(), "flowweave-static-graph-acceptance-"));
  temporaryDirectories.push(root);
  const fixtureOptions: FixtureOptions = { ...options, launchMarkerPath: options?.launchMarkerPath ?? join(root, "launches.log") };
  const projectPath = join(root, "project");
  const outputDirectory = join(root, "results");
  await mkdir(projectPath, { recursive: true });
  await mkdir(join(root, "manifests"), { recursive: true });
  await writeFile(join(projectPath, "tracked.ts"), "export const fixture = 1;\n", "utf8");
  await writeFile(join(projectPath, "secondary.go"), "package fixture\n", "utf8");
  await writeFile(join(projectPath, "go.mod"), "module example.invalid/fixture\n\ngo 1.25\n", "utf8");
  await writeFile(join(projectPath, "spring-core.gradle"), "plugins { id 'java-library' }\n", "utf8");
  await writeFile(join(projectPath, "gradle.properties"), "org.gradle.caching=true\n", "utf8");
  await mkdir(join(projectPath, "gradle", "wrapper"), { recursive: true });
  await writeFile(join(projectPath, "gradle", "wrapper", "gradle-wrapper.properties"), "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.0-bin.zip\n", "utf8");
  execFileSync("git", ["-C", projectPath, "init", "-q"]);
  execFileSync("git", ["-C", projectPath, "config", "user.email", "fixture@example.invalid"]);
  execFileSync("git", ["-C", projectPath, "config", "user.name", "Fixture"]);
  execFileSync("git", ["-C", projectPath, "add", "tracked.ts", "secondary.go", "go.mod", "spring-core.gradle", "gradle.properties", "gradle/wrapper/gradle-wrapper.properties"]);
  execFileSync("git", ["-C", projectPath, "commit", "-q", "-m", "fixture source"]);
  const sourceCommit = execFileSync("git", ["-C", projectPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sourceTree = execFileSync("git", ["-C", projectPath, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const projects = await Promise.all(Array.from({ length: fixtureOptions.sampleCount ?? 12 }, async (_, index) => {
    const id = `D${String(index + 1).padStart(2, "0")}`;
    const split = index < (fixtureOptions.includeHoldout === false ? 12 : 8) ? "development" : "holdout";
    const isMixedLanguage = fixtureOptions.mixedLanguage === true && (id === "D01" || id === "D09");
    const manifestEntries = [await inventoryEntry(projectPath, "tracked.ts", "source", "TypeScript")];
    if (isMixedLanguage) {
      manifestEntries.push(await inventoryEntry(projectPath, "secondary.go", "source", "Go"));
      manifestEntries.push(await inventoryEntry(projectPath, "go.mod", "configuration"));
    }
    const manifestBytes = `${manifestEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const manifestPath = `manifests/${id}.jsonl`;
    await writeFile(join(root, manifestPath), manifestBytes, "utf8");
    return {
      id,
      status: "acquired",
      split,
      canonicalUrl: `https://example.invalid/fixtures/${id}`,
      commit: sourceCommit,
      commitVerification: { status: "verified", method: "test fixture" },
      primaryLanguage: "TypeScript",
      roles: ["library"],
      license: { status: "verified-primary-license-only", spdxId: "MIT", contentSha256: "c".repeat(64) },
      acquisition: { owner: "fixture owner", ownerStatus: "assigned", checkoutTreeOid: sourceTree },
      collectionScope: { status: "frozen", includePaths: isMixedLanguage ? ["tracked.ts", "secondary.go", "go.mod"] : ["tracked.ts"], excludePaths: [] },
      sourceInventory: {
        status: "complete", contentHash: "a".repeat(64), manifestPath,
        manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
        fileCount: manifestEntries.length, sourceFileCount: isMixedLanguage ? 2 : 1,
        sourceBytes: manifestEntries.filter(({ kind }) => kind === "source").reduce((sum, entry) => sum + entry.sizeBytes, 0),
        languageCounts: isMixedLanguage ? { Go: 1, TypeScript: 1 } : { TypeScript: 1 }
      },
      scale: { status: "frozen", stratum: "small", thresholdContract: "frozen-fixture-v1" }
    };
  }));
  await Promise.all([
    writeFile(join(root, "project-marker"), "fixture", "utf8"),
    writeFile(join(root, "measurement-executable.mjs"), measurementExecutable, "utf8"),
    writeFile(join(root, "report-options.json"), JSON.stringify(fixtureOptions), "utf8"),
    writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      status: "frozen",
      selection: {
        identityFreezeStatus: "frozen",
        repositoryCount: projects.length,
        developmentCount: projects.filter(({ split }) => split === "development").length,
        holdoutCount: projects.filter(({ split }) => split === "holdout").length,
        perLanguage: {
          TypeScript: {
            total: projects.length,
            development: projects.filter(({ primaryLanguage, split }) => primaryLanguage === "TypeScript" && split === "development").length,
            holdout: projects.filter(({ primaryLanguage, split }) => primaryLanguage === "TypeScript" && split === "holdout").length
          }
        }
      },
      collectionPolicy: { holdoutAnalysisOutputsInspected: false, holdoutAnalysisRunsPerformed: false },
      repositories: projects
    }), "utf8")
  ]);
  await chmod(join(root, "measurement-executable.mjs"), 0o755);
  const baselineSpec: BaselineRunSpec = {
    corpusPath: join(root, "corpus.json"),
    executablePath: process.execPath,
    executableArgs: [join(root, "measurement-executable.mjs"), join(root, "report-options.json")],
    outputDirectory,
    scenarios: [{ id: "first-analysis", availability: "available" }],
    supportedScope: { languages: fixtureOptions.mixedLanguage ? ["Go", "TypeScript"] : ["TypeScript"], projectKinds: ["library"], sizeBands: ["small"] },
    generationProtocol: 7,
    projectCheckouts: Object.fromEntries(projects.map(({ id }) => [id, projectPath])),
    repetitions: 20,
    osCacheState: "not-cleared",
    processTimeoutMs: 2_000,
    killGraceMs: 500,
    measurement: { method: "instrumented app stages", version: "1.0.0", sha256: "b".repeat(64) }
  };
  return { root, projectPath, outputDirectory, baselineSpec, sourceCommit, sourceTree };
}

async function inventoryEntry(projectPath: string, path: string, kind: "source" | "configuration" | "license", language?: string) {
  const bytes = await readFile(join(projectPath, path));
  return {
    path,
    kind,
    mode: "100644",
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(language ? { language } : {})
  };
}

async function writeCompleteContract(root: string): Promise<string> {
  const contractPath = join(root, "acceptance-contract.json");
  const corpus = JSON.parse(await readFile(join(root, "corpus.json"), "utf8")) as { repositories: Array<{ id: string; split: "development" | "holdout"; commit: string; scale: { stratum: string } }> };
  const fixtureTree = execFileSync("git", ["-C", join(root, "project"), "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  await writeFile(contractPath, JSON.stringify({
    schemaVersion: 1,
    status: "frozen",
    generationProtocol: 7,
    samples: corpus.repositories.map(({ id, split, commit }) => ({ id, split, commit, treeOid: fixtureTree })),
    supportedScope: { languages: corpus.repositories.some(({ sourceInventory }: { sourceInventory: { languageCounts: Record<string, number> } }) => sourceInventory.languageCounts.Go > 0) ? ["Go", "TypeScript"] : ["TypeScript"], projectKinds: ["library"], sizeBands: ["small"] },
    scenarios: [{
      id: "first-analysis",
      repetitions: 20,
      availability: "available",
      performanceBudgets: Object.fromEntries(["small", "medium", "large"].map((sizeBand) => [
        sizeBand,
        Object.fromEntries(requiredPerformanceMetrics().map((metric) => [metric, {
          p95Max: 1_000,
          baselineP95MsByProject: Object.fromEntries(corpus.repositories
            .filter(({ scale }) => scale.stratum === sizeBand)
            .map(({ id }) => [id, 900])),
          baselineMaxRatio: 1.05
        }]))
      ]))
    }],
    qualityGates: {
      callPrecisionByLanguage: corpus.repositories.some(({ sourceInventory }: { sourceInventory: { languageCounts: Record<string, number> } }) => sourceInventory.languageCounts.Go > 0) ? { Go: 0.98, TypeScript: 0.98 } : { TypeScript: 0.98 },
      staticCallRecallByLanguage: corpus.repositories.some(({ sourceInventory }: { sourceInventory: { languageCounts: Record<string, number> } }) => sourceInventory.languageCounts.Go > 0) ? { Go: 0.9, TypeScript: 0.9 } : { TypeScript: 0.9 },
      moduleQualityByDimensionMin: {
        responsibilityConsistency: 4,
        nameDistinctiveness: 4,
        memberReasonableness: 4,
        fragmentationBalance: 4
      },
      unresolvedCallRatioMax: 0.1,
      identityErrorsMax: 0,
      userDataLossMax: 0,
      mixedGenerationMax: 0,
      duplicateReviewItemsMax: 0,
      labelEvidenceBySplit: {
        development: { sha256: "a".repeat(64), reviewerIds: ["reviewer-a", "reviewer-b"], eligibleCallSitesByLanguage: corpus.repositories.some(({ sourceInventory }: { sourceInventory: { languageCounts: Record<string, number> } }) => sourceInventory.languageCounts.Go > 0) ? { Go: 100, TypeScript: 100 } : { TypeScript: 100 }, annotatedCallSitesByLanguage: corpus.repositories.some(({ sourceInventory }: { sourceInventory: { languageCounts: Record<string, number> } }) => sourceInventory.languageCounts.Go > 0) ? { Go: 100, TypeScript: 100 } : { TypeScript: 100 }, exhaustiveLanguages: [] },
        holdout: { sha256: "c".repeat(64), reviewerIds: ["reviewer-c", "reviewer-d"], eligibleCallSitesByLanguage: corpus.repositories.some(({ sourceInventory }: { sourceInventory: { languageCounts: Record<string, number> } }) => sourceInventory.languageCounts.Go > 0) ? { Go: 100, TypeScript: 100 } : { TypeScript: 100 }, annotatedCallSitesByLanguage: corpus.repositories.some(({ sourceInventory }: { sourceInventory: { languageCounts: Record<string, number> } }) => sourceInventory.languageCounts.Go > 0) ? { Go: 100, TypeScript: 100 } : { TypeScript: 100 }, exhaustiveLanguages: [] }
      }
    },
    resourceBudgets: Object.fromEntries(["small", "medium", "large"].map((sizeBand) => [sizeBand, {
      processTreePeakRssMiB: { max: 2048 },
      firstScreenIpcBytes: { max: 1_000_000 },
      cacheResidentBytes: { max: 1_000_000 },
      rendererLongTaskCount: { max: 0 },
      rendererLongTaskTotalMs: { max: 0 },
      rendererLongTaskMaxMs: { max: 0 },
      cancellationUiResponseMs: { p95Max: 500 },
      backgroundTaskExitMs: { max: 2_000 }
    }])),
    measurement: { method: "instrumented app stages", version: "1.0.0", sha256: "b".repeat(64) },
    osCacheState: "not-cleared"
  }), "utf8");
  return contractPath;
}

function downstreamReasons(failureStage: string): Record<string, string> {
  const stages = ["semanticAnalysis", "clustering", "layout", "commit", "ipcReceipt", "clickableGraph", "detailReady"];
  const failureIndex = stages.indexOf(failureStage);
  return Object.fromEntries(stages.slice(failureIndex).map((stage) => [`${stage}Ms`, stage === failureStage ? `No elapsed duration was measured for failed stage ${failureStage}.` : `Not reached because ${failureStage} failed.`]));
}

function requiredPerformanceMetrics(): string[] {
  return ["appStartupMs", "projectSelectionMs", "workspaceInteractiveMs", "scanMs", "semanticAnalysisMs", "clusteringMs", "layoutMs", "commitMs", "ipcReceiptMs", "clickableGraphMs", "detailReadyMs"];
}

async function runAcceptanceWithContract(fixture: Awaited<ReturnType<typeof createFixture>>, contractPath: string) {
  const contractSha256 = createHash("sha256").update(await readFile(contractPath)).digest("hex");
  return await runStaticGraphAcceptance({
    ...fixture.baselineSpec,
    contractPath,
    contractSha256,
    targetSplit: "development"
  });
}

const measurementExecutable = `
import { appendFile, readFile, writeFile } from 'node:fs/promises';
const contextPath = process.argv[process.argv.indexOf('--run-context') + 1];
const reportPath = process.argv[process.argv.indexOf('--report') + 1];
const optionsPath = process.argv[2];
if (!Number.isSafeInteger(Number(process.env.FLOWWEAVE_STATIC_GRAPH_PROCESS_LAUNCH_REQUEST_EPOCH_MS))) throw new Error('Missing runner process-launch timestamp');
const context = JSON.parse(await readFile(contextPath, 'utf8'));
const options = JSON.parse(await readFile(optionsPath, 'utf8'));
const earlyFailure = options.omitGraphIdentityOnFailure && options.productOutcome === 'failure';
if (options.launchMarkerPath) await appendFile(options.launchMarkerPath, 'launch\\n');
if (options.omitReportAtRepetition === context.repetition) { console.error('fixture startup failure'); process.exit(9); }
  const report = {
  schemaVersion: 1,
  generationProtocol: 7,
  generationId: earlyFailure ? null : 'generation-1',
  currentGenerationId: earlyFailure ? null : options.currentGenerationId ?? 'generation-1',
  sourceRevision: options.sourceRevision ?? context.sourceRevision,
  currentSourceRevision: options.sourceRevision ?? context.sourceRevision,
  userRevision: earlyFailure ? null : 4,
  detailUserRevision: earlyFailure ? null : 4,
  projectId: options.reportProjectId ?? context.projectId,
  scenarioId: options.reportScenarioId ?? context.scenarioId,
  repetition: options.reportRepetition ?? context.repetition,
  runAttemptId: context.runAttemptId,
  measurementMethod: context.measurement.method,
  measurementVersion: context.measurement.version,
  measurementSha256: context.measurement.sha256,
  instrumentationMode: context.instrumentationMode,
  productOutcome: options.productOutcome ?? 'success',
  failureStage: options.failureStage,
  error: options.error,
  uiReadyEvidence: options.uiReadyEvidence ?? (earlyFailure ? {
    workspaceInteractive: { status: 'not-reached', reason: 'The scan failed before a matching graph generation existed.' },
    clickableGraph: { status: 'not-reached', reason: 'No matching graph generation reached the UI.' },
    detailReady: { status: 'not-reached', reason: 'No matching graph generation reached the UI.' }
  } : options.productOutcome === 'failure' ? {
    workspaceInteractive: { status: 'ready', generationId: 'generation-1', userRevision: 4 },
    clickableGraph: { status: 'not-reached', reason: 'Analysis failed before the graph became clickable.' },
    detailReady: { status: 'not-reached', reason: 'The graph was not clickable.' }
  } : {
    workspaceInteractive: { status: 'ready', generationId: 'generation-1', userRevision: 4 },
    clickableGraph: { status: 'ready', generationId: 'generation-1', userRevision: 4 },
    detailReady: { status: 'ready', generationId: 'generation-1', userRevision: 4 }
  }),
  metrics: {
    ...(options.metrics ?? {
      appStartupMs: 200, projectSelectionMs: 20, workspaceInteractiveMs: 30, scanMs: 40,
      semanticAnalysisMs: 50, clusteringMs: 20, layoutMs: 25, commitMs: 15, ipcReceiptMs: 5,
      clickableGraphMs: 120, detailReadyMs: 40
    }),
    ...(options.projectMetricOverrides?.[context.projectId] ?? {})
  },
  qualityEvidence: {
    ...(options.qualityEvidence ?? {
    callPrecisionByLanguage: Object.fromEntries(context.languages.filter((language) => !(options.omitSecondaryLanguageEvidence && language === 'Go')).map((language) => [language, options.secondaryLanguageQuality ?? 0.99])),
    staticCallRecallByLanguage: Object.fromEntries(context.languages.filter((language) => !(options.omitSecondaryLanguageEvidence && language === 'Go')).map((language) => [language, options.secondaryLanguageQuality ?? 0.95])),
    moduleQualityByDimension: {
      responsibilityConsistency: 4.5, nameDistinctiveness: 4.5, memberReasonableness: 4.5, fragmentationBalance: 4.5,
      ...(options.projectQualityOverrides?.[context.projectId] ?? {})
    },
    unresolvedCallRatio: 0.05, identityErrors: 0, userDataLoss: 0,
    mixedGeneration: 0, duplicateReviewItems: 0, labelDatasetSha256: 'a'.repeat(64), reviewerIds: ['reviewer-a', 'reviewer-b']
    }),
    sourceInventoryValidation: { entryVerified: true, exitVerified: true, entriesVerified: context.sourceInventoryEntries.length }
  },
  unavailableMetrics: options.unavailableMetrics ?? {},
  startedAt: '2026-10-04T01:00:00.000Z',
  endedAt: '2026-10-04T01:00:01.000Z'
};
if (options.malformedReportsAt?.includes(context.repetition)) {
  const malformed = context.repetition === 1 ? null : context.repetition === 2 ? [] : { ...report, metrics: [] };
  await writeFile(reportPath, JSON.stringify(malformed), 'utf8');
} else if (options.hangAtRepetition === context.repetition) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  await writeFile(reportPath, JSON.stringify(report), 'utf8');
  if (options.mutateSelectedSourceAtRepetition === context.repetition) {
    await writeFile(context.projectPath + '/tracked.ts', 'export const fixture = 2;\\n', 'utf8');
  }
  process.exit(options.productExitCode ?? 0);
}
`;

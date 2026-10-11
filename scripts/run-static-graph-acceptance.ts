import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { validateMeasurementSourceInventory, type MeasurementSourceInventoryEntry } from "../src/main/services/static-graph-measurement";
import { assertMeasurementOutputIsolated, assertMeasurementOutputTargetContained, isMeasurementSourceChange, STATIC_GRAPH_MEASUREMENT_SCENARIOS, type MeasurementSourceChange } from "../src/main/services/static-graph-scenario";

const execFileAsync = promisify(execFile);

const REQUIRED_METRICS = [
  "appStartupMs",
  "projectSelectionMs",
  "workspaceInteractiveMs",
  "scanMs",
  "semanticAnalysisMs",
  "clusteringMs",
  "layoutMs",
  "commitMs",
  "ipcReceiptMs",
  "clickableGraphMs",
  "detailReadyMs"
] as const;
const OPTIONAL_METRICS = ["lockWaitMs", "snapshotValidationMs", "snapshotParseMs", "snapshotReadMs", "detailIndexMs", "detailIpcRoundTripMs", "detailPanelPresentationMs", "firstScreenIpcBytes", "cacheResidentBytes", "rendererLongTaskCount", "rendererLongTaskTotalMs", "rendererLongTaskMaxMs", "processTreePeakRssMiB", "selectionToWorkspaceInteractiveMs", "selectionToClickableGraphMs", "cancellationUiResponseMs", "backgroundTaskExitMs"] as const;
const AUTOMATED_REPORT_ONLY_P95_METRICS = ["appStartupMs"] as const;
const AUTOMATED_P95_METRICS = [
  "projectSelectionMs", "workspaceInteractiveMs", "scanMs", "semanticAnalysisMs", "clusteringMs", "layoutMs", "commitMs",
  "ipcReceiptMs", "clickableGraphMs", "detailReadyMs", "lockWaitMs", "snapshotValidationMs", "snapshotParseMs", "snapshotReadMs", "detailIndexMs",
  "detailIpcRoundTripMs", "detailPanelPresentationMs", "selectionToWorkspaceInteractiveMs", "selectionToClickableGraphMs",
  "cancellationUiResponseMs", "backgroundTaskExitMs"
] as const;
const AUTOMATED_MAX_METRICS = ["firstScreenIpcBytes", "cacheResidentBytes", "rendererLongTaskCount", "rendererLongTaskTotalMs", "rendererLongTaskMaxMs", "processTreePeakRssMiB"] as const;
export const AUTOMATED_ENGINEERING_BUDGET_RULES = {
  timeP95BaselineRatioMax: 1.05,
  workspaceInteractiveP95MsMax: 1000,
  detailColdP95MsMax: 300,
  detailWarmP95MsMax: 100,
  cancellationUiP95MsMax: 500,
  missingBudget: "fail",
  remainingMetrics: "predeclared-absolute-or-comparable-baseline",
  reportOnlyP95Metrics: AUTOMATED_REPORT_ONLY_P95_METRICS,
  errorRateMax: 0,
  timeP95AbsoluteMsByMetric: {
    projectSelectionMs: 1000, workspaceInteractiveMs: 1000, scanMs: 20000,
    semanticAnalysisMs: 30000, clusteringMs: 10000, layoutMs: 15000, commitMs: 10000,
    ipcReceiptMs: 500, clickableGraphMs: 3000, detailReadyMs: 300, lockWaitMs: 1000,
    snapshotValidationMs: 5000, snapshotParseMs: 10000, snapshotReadMs: 10000, detailIndexMs: 15000,
    detailIpcRoundTripMs: 300, detailPanelPresentationMs: 300, selectionToWorkspaceInteractiveMs: 1000,
    selectionToClickableGraphMs: 65000, cancellationUiResponseMs: 500, backgroundTaskExitMs: 10000
  },
  sizeBandMultiplier: { small: 1, medium: 2, large: 4 },
  absoluteMaxByMetric: {
    firstScreenIpcBytes: 10 * 1024 * 1024, cacheResidentBytes: 128 * 1024 * 1024,
    rendererLongTaskCount: 500, rendererLongTaskTotalMs: 10000, rendererLongTaskMaxMs: 1000,
    processTreePeakRssMiB: 4096
  }
} as const;
const REGISTERED_AUTOMATED_CORPUS_SHA256 = "8cdeb59d92a2326bf38c680517af481b031624869063fdfdc66afbf40ba3fcc7";
const AUTOMATED_MEASUREMENT_SOURCE_FILES = [
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("../src/main/index.ts", import.meta.url)),
  fileURLToPath(new URL("../src/main/services/static-graph-measurement.ts", import.meta.url)),
  fileURLToPath(new URL("../src/main/services/static-graph-scenario.ts", import.meta.url)),
  fileURLToPath(new URL("../src/main/ipc/project.ipc.ts", import.meta.url)),
  fileURLToPath(new URL("../src/main/project-analysis.worker.ts", import.meta.url)),
  fileURLToPath(new URL("../src/main/services/project-generation.service.ts", import.meta.url)),
  fileURLToPath(new URL("../src/main/storage/flowweave-store.ts", import.meta.url)),
  fileURLToPath(new URL("../src/main/services/canvas-detail.service.ts", import.meta.url)),
  fileURLToPath(new URL("../src/preload/index.ts", import.meta.url)),
  fileURLToPath(new URL("../src/common/ipc-channels.ts", import.meta.url)),
  fileURLToPath(new URL("../src/components/ModulePanel.tsx", import.meta.url)),
  fileURLToPath(new URL("../src/types.ts", import.meta.url))
];
const AUTOMATED_RUNTIME_SOURCE_FILES = AUTOMATED_MEASUREMENT_SOURCE_FILES.slice(1);

type RequiredMetric = (typeof REQUIRED_METRICS)[number];
type OptionalMetric = (typeof OPTIONAL_METRICS)[number];
type ProductOutcome = "success" | "failure";
type RunAvailability = "available" | "incomplete";
type ProjectSizeBand = "small" | "medium" | "large";
type ReportedProjectSizeBand = ProjectSizeBand | "unclassified";
const MODULE_QUALITY_DIMENSIONS = ["responsibilityConsistency", "nameDistinctiveness", "memberReasonableness", "fragmentationBalance"] as const;

interface SupportedScope {
  languages: string[];
  projectKinds: string[];
  sizeBands: ProjectSizeBand[];
}

interface PerformanceBudget {
  p95Max: number;
  baselineP95MsByProject: Record<string, number>;
  baselineMaxRatio: number;
}

export interface BaselineRunSpec {
  corpusPath: string;
  executablePath: string;
  executableArgs: string[];
  outputDirectory: string;
  projectCheckouts: Record<string, string>;
  generationProtocol: number;
  scenarios: Array<{ id: string; availability: RunAvailability; reason?: string }>;
  sourceChangesByProject?: Record<string, MeasurementSourceChange>;
  supportedScope: SupportedScope;
  repetitions: number;
  osCacheState: "cleared" | "not-cleared" | "unknown";
  processTimeoutMs: number;
  killGraceMs: number;
  measurement: { method: string; version: string; sha256: string };
}

export interface AcceptanceRunSpec extends BaselineRunSpec {
  contractPath: string;
  contractSha256: string;
  targetSplit: "development";
}

export interface AutomatedEngineeringRunSpec extends BaselineRunSpec {
  schemaVersion: 1;
  evaluationKind: "automated-engineering";
  corpusSha256: string;
  taskId: string;
  developmentManifests: Record<string, { path: string; sha256: string }>;
  reservedProjectCheckouts: Record<string, string>;
  reservedOutputDirectory: string;
  preservedFirstRunReport?: { path: string; sha256: string };
  boundFiles: Array<{ path: string; sha256: string }>;
  budgetRules: typeof AUTOMATED_ENGINEERING_BUDGET_RULES;
}

interface AutomatedInputVerification {
  evaluationKind: "automated-engineering";
  formalAcceptance: false;
  specSha256: string;
  corpusSha256: string;
  packageBundleTreeSha256: string;
  registeredSamples: Array<{
    id: string;
    split: "development" | "holdout";
    canonicalUrl: string;
    commit: string;
    treeOid: string;
    verification: "checkout-and-manifest" | "registered-identity-only";
  }>;
}

export interface MeasurementReport {
  schemaVersion: number;
  generationProtocol: number;
  generationId: string | null;
  currentGenerationId: string | null;
  sourceRevision: string | null;
  currentSourceRevision: string | null;
  projectId: string;
  scenarioId: string;
  repetition: number;
  runAttemptId: string;
  measurementMethod: string;
  measurementVersion: string;
  measurementSha256: string;
  instrumentationMode: InstrumentationMode;
  userRevision: number | null;
  detailUserRevision: number | null;
  productOutcome: ProductOutcome;
  failureStage?: string;
  error?: string;
  uiReadyEvidence: Record<"workspaceInteractive" | "clickableGraph" | "detailReady", UiReadySignal>;
  metrics: Record<string, number>;
  unavailableMetrics: Record<string, string>;
  qualityEvidence?: unknown;
  startedAt: string;
  endedAt: string;
}

export type UiReadySignal =
  | { status: "ready"; generationId: string; userRevision: number }
  | { status: "not-reached"; reason: string };

interface CorpusProject {
  id: string;
  path: string;
  split: "development" | "holdout";
  sourceRevision: string;
  checkoutTreeOid: string;
  sourceTreeOid: string;
  generationProtocol: number;
  language: string;
  languages: string[];
  projectKinds: string[];
  sizeBand: ReportedProjectSizeBand;
  selection: ProjectScanSelection;
  collectionScope: { includePaths: string[]; excludePaths: string[] };
  inventoryEntries: InventoryEntry[];
}

interface ProjectScanSelection {
  sourcePaths: string[];
  configurationPaths: string[];
  scopeSha256: string;
  sourceInventorySha256: string;
}

interface InventoryEntry {
  path: string;
  kind: "source" | "configuration" | "license";
  mode: string;
  sizeBytes: number;
  sha256: string;
  language?: string;
}

export interface AutomatedReservedCheckoutIdentity {
  id: string;
  path: string;
  sourceRevision: string;
  checkoutTreeOid: string;
  generationProtocol: number;
  language: string;
  projectKinds: string[];
}

interface AutomatedReservedProjectEvidence {
  id: string;
  canonicalUrl?: string;
  sourceRevision: string;
  checkoutTreeOid: string;
  primaryLanguage: string;
  languages: string[];
  projectKinds: string[];
  inventory: { fileCount: number; sourceFileCount: number; sourceBytes: number; languageCounts: Record<string, number>; sha256: string; manifestPath?: string; entries: InventoryEntry[] };
  scope: { includePaths: string[]; excludePaths: string[]; sha256: string };
  scale: { stratum: "unclassified"; thresholdContract: "registered threshold unavailable; no budget evaluation"; sourceFileCount: number; sourceBytes: number; sha256: string };
  excludedCandidatePaths: Array<{ path: string; mode: string; reason: "symlink" | "non-regular" | "unsafe-path" }>;
}

export interface AutomatedReservedRegressionResult {
  schemaVersion: 1;
  kind: "automated-reserved-regression";
  phase: "first-run" | "repair-regression";
  evaluationKind: "automated-engineering";
  formalAcceptance: false;
  taskId: string;
  specSha256: string;
  corpusSha256: string;
  measurementIdentity: BaselineRunSpec["measurement"];
  outputDirectory: string;
  firstRunReport?: { path: string; sha256: string };
  projects: AutomatedReservedProjectEvidence[];
  plannedRuns: number;
  complete: boolean;
  measurementValid: boolean;
  productOutcome: BaselineRunResult["productOutcome"];
  runs: RunRecord[];
  packageTreeUnchangedAfterCollection: boolean;
  packageTreeHashAfterCollection?: string;
  packageTreeError?: string;
}

interface CorpusFile {
  schemaVersion: number;
  sha256: string;
  projects: CorpusProject[];
}

interface RunRecord {
  projectId: string;
  scenarioId: string;
  repetition: number;
  language: string;
  languages: string[];
  sizeBand: ReportedProjectSizeBand;
  split: CorpusProject["split"];
  selection: ProjectScanSelection;
  collectionScope: { includePaths: string[]; excludePaths: string[] };
  measurementValid: boolean;
  productOutcome: ProductOutcome | "unknown" | "incomplete";
  failureStage?: string;
  error?: string;
  startedAt: string;
  endedAt: string;
  metrics: Record<string, number>;
  unavailableMetrics: Record<string, string>;
  qualityEvidence?: unknown;
  generationId?: string;
  generationProtocol?: number;
  sourceRevision?: string;
  userRevision?: number;
  processExitCode?: number | null;
  processSignal?: NodeJS.Signals | null;
  instrumentationMode?: InstrumentationMode;
  externalStartedAtEpochMs?: number;
  externalEndedAtEpochMs?: number;
  externalDurationMs?: number;
}

export interface BaselineRunResult {
  schemaVersion: 1;
  kind: "baseline";
  corpusPath: string;
  corpusSha256: string;
  selectedSplit: "development";
  generationProtocol: number;
  measurementIdentity: BaselineRunSpec["measurement"];
  measurementValid: boolean;
  complete: boolean;
  productOutcome: ProductOutcome | "unknown" | "mixed" | "incomplete";
  thresholdOutcome: "not-evaluated";
  formalAcceptance: false;
  osCacheState: BaselineRunSpec["osCacheState"];
  plannedRuns: number;
  runs: RunRecord[];
}

export interface AutomatedEngineeringRunResult extends Omit<BaselineRunResult, "kind" | "thresholdOutcome" | "formalAcceptance">, AutomatedInputVerification {
  kind: "automated-engineering";
  formalAcceptance: false;
  thresholdOutcome: "pass" | "fail";
  packageTreeUnchangedAfterCollection: boolean;
  packageTreeHashAfterCollection?: string;
  packageTreeError?: string;
  budgetEvaluation: {
    productErrors: { count: number; plannedCount: number; errorRate: number | null; maximum: number; passed: boolean };
    baselineComparison: { status: "not-comparable"; reason: string; ratioMaximum: number };
    reportedMetrics: Record<string, {
      disposition: "reported-only";
      definition: string;
      observed: number | null;
      sampleCount: number;
      plannedCount: number;
      aggregation: "p95";
      perProject: Record<string, { observed: number | null; sampleCount: number; plannedCount: number }>;
    }>;
    metrics: Record<string, {
      observed: number | null;
      sampleCount: number;
      plannedCount: number;
      maximum: number;
      aggregation: "p95" | "max";
      passed: boolean;
      perProject: Record<string, { observed: number | null; sampleCount: number; plannedCount: number; maximum: number; passed: boolean }>;
    }>;
  };
}

export interface InstrumentationComparisonResult {
  schemaVersion: 1;
  kind: "instrumentation-comparison";
  comparisonScope: "optional-internal-timing-and-sampling-overhead";
  formalAcceptance: false;
  specSha256: string;
  corpusSha256: string;
  measurementIdentity: BaselineRunSpec["measurement"];
  projectId: string;
  scenarioId: string;
  outputDirectory: string;
  sourceRevision: string;
  sourceInventorySha256: string;
  scopeSha256: string;
  pairCount: number;
  bundleIdentity: { executablePath: string; executableSha256: string; appAsarSha256: string; bundleTreeSha256: string };
  measurementValid: boolean;
  allPairsProductOutcomeMatched: boolean;
  allPairsSuccessful: boolean;
  pairedExternalDurationDeltaMedianMs: number;
  pairs: Array<{
    pair: number;
    firstMode: InstrumentationMode;
    on: RunRecord;
    off: RunRecord;
    externalDurationDeltaMs: number;
  }>;
}

export interface AcceptanceRunResult extends Omit<BaselineRunResult, "kind" | "thresholdOutcome" | "formalAcceptance"> {
  kind: "acceptance";
  thresholdOutcome: "pass" | "fail";
  formalAcceptance: boolean;
  contractPath: string;
  contractSha256: string;
  thresholdResults: Record<string, {
    p95: number | null;
    sampleCount: number;
    plannedCount: number;
    maximum: number;
    passed: boolean;
    perProject: Record<string, { p95: number | null; sampleCount: number; plannedCount: number; maximum: number; baselineP95: number; baselineRatioMaximum: number; passed: boolean }>;
  }>;
  qualityResults: Record<string, { observed: number | null; maximum: number; passed: boolean }>;
  resourceResults: Record<string, {
    observed: number | null;
    sampleCount: number;
    maximum: number;
    aggregation: "max" | "p95";
    passed: boolean;
    perProject: Record<string, { observed: number | null; sampleCount: number; plannedCount: number; passed: boolean }>;
  }>;
}

interface Contract {
  schemaVersion: 1;
  status: "frozen";
  generationProtocol: number;
  samples: Array<{ id: string; split: "development" | "holdout"; commit: string; treeOid: string }>;
  supportedScope: SupportedScope;
  scenarios: Array<{
    id: string;
    repetitions: number;
    availability: RunAvailability;
    performanceBudgets: Partial<Record<ProjectSizeBand, Partial<Record<RequiredMetric, PerformanceBudget>>>>;
  }>;
  qualityGates: {
    callPrecisionByLanguage: Record<string, number>;
    staticCallRecallByLanguage: Record<string, number>;
    moduleQualityByDimensionMin: Record<(typeof MODULE_QUALITY_DIMENSIONS)[number], number>;
    unresolvedCallRatioMax: number;
    identityErrorsMax: number;
    userDataLossMax: number;
    mixedGenerationMax: number;
    duplicateReviewItemsMax: number;
    labelEvidenceBySplit: Record<"development" | "holdout", {
      sha256: string;
      reviewerIds: string[];
      eligibleCallSitesByLanguage: Record<string, number>;
      annotatedCallSitesByLanguage: Record<string, number>;
      exhaustiveLanguages: string[];
    }>;
  };
  resourceBudgets: Partial<Record<ProjectSizeBand, Partial<Record<OptionalMetric, { max?: number; p95Max?: number }>>>>;
  measurement: { method: string; version: string; sha256: string };
  osCacheState: BaselineRunSpec["osCacheState"];
}

interface RunContext {
  runAttemptId: string;
  projectId: string;
  projectPath: string;
  sourceRevision: string;
  languages: string[];
  selection: ProjectScanSelection;
  sourceInventoryEntries: MeasurementSourceInventoryEntry[];
  collectionScope: { includePaths: string[]; excludePaths: string[] };
  generationProtocol: number;
  scenarioId: string;
  sourceChange?: MeasurementSourceChange;
  repetition: number;
  osCacheState: BaselineRunSpec["osCacheState"];
  measurement: BaselineRunSpec["measurement"];
  instrumentationMode: InstrumentationMode;
}

interface MeasurementProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  timedOut: boolean;
  timeoutMessage?: string;
  timeoutEscalated?: boolean;
  externalStartedAtEpochMs: number;
  externalEndedAtEpochMs: number;
  externalDurationMs: number;
}

export type InstrumentationMode = "on" | "off";

export async function collectInstrumentationComparisonPairs<T>(
  pairCount: number,
  collect: (mode: InstrumentationMode, pair: number) => Promise<T>
): Promise<Array<{ pair: number; first: T; second: T }>> {
  if (!Number.isSafeInteger(pairCount) || pairCount < 5) throw new RangeError("Instrumentation comparison requires at least five pairs.");
  const pairs: Array<{ pair: number; first: T; second: T }> = [];
  for (let pair = 1; pair <= pairCount; pair += 1) {
    const firstMode: InstrumentationMode = pair % 2 === 1 ? "on" : "off";
    const secondMode: InstrumentationMode = firstMode === "on" ? "off" : "on";
    const first = await collect(firstMode, pair);
    const second = await collect(secondMode, pair);
    pairs.push({ pair, first, second });
  }
  return pairs;
}

export function assertAutomatedOutputAvoidsReservedPaths(
  outputDirectory: string,
  reservedProjectCheckouts: Record<string, string>,
  reservedOutputDirectory: string
): void {
  if (!isRecord(reservedProjectCheckouts) || !isAbsolute(outputDirectory) || !isAbsolute(reservedOutputDirectory) ||
    Object.values(reservedProjectCheckouts).some((path) => !isAbsolute(path))) {
    throw new Error("Automated measurement and reserved paths must be absolute.");
  }
  const outputRoot = resolve(outputDirectory);
  const protectedRoots = [...Object.values(reservedProjectCheckouts), reservedOutputDirectory].map((path) => resolve(path));
  if (protectedRoots.some((protectedRoot) => isPathInside(protectedRoot, outputRoot) || isPathInside(outputRoot, protectedRoot))) {
    throw new Error("Automated measurement output must not overlap a registered holdout checkout or reserved output directory.");
  }
}

export async function collectStaticGraphBaseline(spec: BaselineRunSpec): Promise<BaselineRunResult> {
  validateSpec(spec);
  const outputDirectory = await assertMeasurementOutputIsolated(spec.outputDirectory, Object.values(spec.projectCheckouts));
  const runSpec = { ...spec, outputDirectory };
  const corpus = await prepareCorpus(spec);
  const runs = await collectRuns(runSpec, corpus, "development");
  const result: BaselineRunResult = {
    schemaVersion: 1,
    kind: "baseline",
    corpusPath: resolve(spec.corpusPath),
    corpusSha256: corpus.sha256,
    selectedSplit: "development",
    generationProtocol: spec.generationProtocol,
    measurementIdentity: spec.measurement,
    measurementValid: runs.every((run) => run.measurementValid),
    complete: runs.every((run) => run.productOutcome !== "incomplete"),
    productOutcome: summarizeProductOutcome(runs),
    thresholdOutcome: "not-evaluated",
    formalAcceptance: false,
    osCacheState: spec.osCacheState,
    plannedRuns: countPlannedRuns(corpus, spec, "development"),
    runs
  };
  await writeRunLines(outputDirectory, "baseline.jsonl", runs);
  await writeRunResult(outputDirectory, "baseline-run.json", result);
  if (!result.measurementValid) throw new Error(formatCollectionError(runs, join(spec.outputDirectory, "baseline-run.json"), "Baseline"));
  return result;
}

/** Verify pinned automated inputs without opening reserved source manifests or asserting human approval. */
export async function verifyAutomatedEngineeringInputs(spec: AutomatedEngineeringRunSpec): Promise<AutomatedInputVerification> {
  return (await prepareAutomatedEngineering(spec)).verification;
}

/** Collect development measurements only; performance budgets are evaluated separately after baseline collection. */
export async function collectAutomatedEngineering(spec: AutomatedEngineeringRunSpec): Promise<AutomatedEngineeringRunResult> {
  assertAutomatedOutputAvoidsReservedPaths(spec.outputDirectory, spec.reservedProjectCheckouts, spec.reservedOutputDirectory);
  const { corpus, verification } = await prepareAutomatedEngineering(spec);
  const outputDirectory = await assertMeasurementOutputIsolated(spec.outputDirectory, Object.values(spec.projectCheckouts));
  assertAutomatedOutputAvoidsReservedPaths(outputDirectory, spec.reservedProjectCheckouts, spec.reservedOutputDirectory);
  const runs = await collectRuns({ ...spec, outputDirectory }, corpus, "development");
  const budgetEvaluation = evaluateAutomatedEngineeringBudgets(runs, corpus, spec);
  const measurementValid = runs.every((run) => run.measurementValid);
  const packageTreeCheck = await checkAutomatedPackageTree(spec, verification.packageBundleTreeSha256);
  const complete = spec.scenarios.every((scenario) => scenario.availability === "available") &&
    runs.every((run) => run.productOutcome !== "incomplete") && packageTreeCheck.unchanged;
  const thresholdOutcome: "pass" | "fail" = measurementValid && complete && budgetEvaluation.productErrors.passed &&
    Object.values(budgetEvaluation.metrics).every((metric) => metric.passed) ? "pass" : "fail";
  const result = {
    ...verification,
    schemaVersion: 1 as const,
    kind: "automated-engineering" as const,
    formalAcceptance: false as const,
    corpusPath: resolve(spec.corpusPath),
    selectedSplit: "development" as const,
    generationProtocol: spec.generationProtocol,
    measurementIdentity: spec.measurement,
    measurementValid,
    complete,
    packageTreeUnchangedAfterCollection: packageTreeCheck.unchanged,
    ...(packageTreeCheck.actualSha256 ? { packageTreeHashAfterCollection: packageTreeCheck.actualSha256 } : {}),
    ...(packageTreeCheck.error ? { packageTreeError: packageTreeCheck.error } : {}),
    productOutcome: summarizeProductOutcome(runs),
    thresholdOutcome,
    osCacheState: spec.osCacheState,
    plannedRuns: countPlannedRuns(corpus, spec, "development"),
    budgetEvaluation,
    runs
  };
  await writeRunResult(outputDirectory, "automated-spec.json", spec);
  await writeRunLines(outputDirectory, "automated.jsonl", runs);
  await writeRunResult(outputDirectory, "automated-run.json", result);
  if (!result.measurementValid) throw new Error(formatCollectionError(runs, join(outputDirectory, "automated-run.json"), "Automated engineering"));
  return result;
}

export async function collectAutomatedInstrumentationComparison(
  spec: AutomatedEngineeringRunSpec,
  comparisonOutputDirectory: string,
  projectId: string,
  scenarioId: string,
  pairCount: number
): Promise<InstrumentationComparisonResult> {
  if (!Number.isSafeInteger(pairCount) || pairCount < 5) throw new RangeError("Instrumentation comparison requires at least five pairs.");
  if (!isAbsolute(comparisonOutputDirectory)) throw new Error("Instrumentation comparison output directory must be absolute.");
  const a2OutputRoot = resolve(comparisonOutputDirectory);
  const a3OutputRoot = resolve(spec.outputDirectory);
  assertAutomatedOutputAvoidsReservedPaths(a2OutputRoot, spec.reservedProjectCheckouts, spec.reservedOutputDirectory);
  assertAutomatedOutputAvoidsReservedPaths(a3OutputRoot, spec.reservedProjectCheckouts, spec.reservedOutputDirectory);
  if (isPathInside(a2OutputRoot, a3OutputRoot) || isPathInside(a3OutputRoot, a2OutputRoot)) {
    throw new Error("Instrumentation comparison output directory must not overlap the A3 engineering output directory.");
  }
  const { corpus, verification } = await prepareAutomatedEngineering(spec);
  const project = corpus.projects.find((candidate) => candidate.id === projectId && candidate.split === "development");
  if (!project) throw new Error(`Instrumentation comparison project must be a registered development sample: ${projectId}.`);
  if (!spec.scenarios.some((scenario) => scenario.id === scenarioId && scenario.availability === "available")) {
    throw new Error(`Instrumentation comparison scenario must be registered and available: ${scenarioId}.`);
  }
  const canonicalA2OutputRoot = await assertMeasurementOutputIsolated(a2OutputRoot, Object.values(spec.projectCheckouts));
  const canonicalA3OutputRoot = await assertMeasurementOutputIsolated(a3OutputRoot, Object.values(spec.projectCheckouts));
  assertAutomatedOutputAvoidsReservedPaths(canonicalA2OutputRoot, spec.reservedProjectCheckouts, spec.reservedOutputDirectory);
  assertAutomatedOutputAvoidsReservedPaths(canonicalA3OutputRoot, spec.reservedProjectCheckouts, spec.reservedOutputDirectory);
  if (isPathInside(canonicalA2OutputRoot, canonicalA3OutputRoot) || isPathInside(canonicalA3OutputRoot, canonicalA2OutputRoot)) {
    throw new Error("Canonical instrumentation comparison output directory must not overlap the canonical A3 output directory.");
  }
  const outputDirectory = await claimMeasurementOutputDirectory(canonicalA2OutputRoot, Object.values(spec.projectCheckouts));
  await writeRunResult(outputDirectory, "instrumentation-spec.json", spec);
  const runSpec = { ...spec, outputDirectory };
  const appRoot = resolve(dirname(spec.executablePath), "../..");
  const boundFile = (path: string): string => {
    const file = spec.boundFiles.find((candidate) => resolve(candidate.path) === resolve(path));
    if (!file) throw new Error(`Instrumentation comparison has no A1-bound package file: ${path}.`);
    return file.sha256.toLowerCase();
  };
  const bundleIdentity = {
    executablePath: resolve(spec.executablePath),
    executableSha256: boundFile(spec.executablePath),
    appAsarSha256: boundFile(join(appRoot, "Contents", "Resources", "app.asar")),
    bundleTreeSha256: verification.packageBundleTreeSha256
  };
  const rawPairs = await collectInstrumentationComparisonPairs(pairCount, async (mode, pair) => {
    const record = await collectOneRun(runSpec, project, scenarioId, pair, mode,
      ["instrumentation-comparison", `pair-${String(pair).padStart(2, "0")}`, mode]);
    const currentBundleTreeSha256 = await calculateAutomatedAppBundleTreeSha256(appRoot);
    if (currentBundleTreeSha256 !== bundleIdentity.bundleTreeSha256) {
      throw new Error(`A1-bound application bundle changed during the instrumentation comparison: expected ${bundleIdentity.bundleTreeSha256}, found ${currentBundleTreeSha256}.`);
    }
    return record;
  });
  const pairs = rawPairs.map(({ pair, first, second }) => {
    const firstMode = first.instrumentationMode;
    const on = first.instrumentationMode === "on" ? first : second;
    const off = first.instrumentationMode === "off" ? first : second;
    if ((firstMode !== "on" && firstMode !== "off") || on.instrumentationMode !== "on" || off.instrumentationMode !== "off" ||
      on.externalDurationMs === undefined || off.externalDurationMs === undefined) {
      throw new Error(`Instrumentation comparison pair ${pair} is missing its mode or external process timing evidence.`);
    }
    return {
      pair,
      firstMode,
      on,
      off,
      externalDurationDeltaMs: on.externalDurationMs - off.externalDurationMs
    };
  });
  const result: InstrumentationComparisonResult = {
    schemaVersion: 1,
    kind: "instrumentation-comparison",
    comparisonScope: "optional-internal-timing-and-sampling-overhead",
    formalAcceptance: false,
    specSha256: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
    corpusSha256: verification.corpusSha256,
    measurementIdentity: spec.measurement,
    projectId,
    scenarioId,
    outputDirectory,
    sourceRevision: project.sourceRevision,
    sourceInventorySha256: project.selection.sourceInventorySha256,
    scopeSha256: project.selection.scopeSha256,
    pairCount,
    bundleIdentity,
    measurementValid: pairs.every(({ on, off }) => on.measurementValid && off.measurementValid),
    allPairsProductOutcomeMatched: pairs.every(({ on, off }) => on.productOutcome === off.productOutcome),
    allPairsSuccessful: pairs.every(({ on, off }) => on.productOutcome === "success" && off.productOutcome === "success"),
    pairedExternalDurationDeltaMedianMs: median(pairs.map(({ externalDurationDeltaMs }) => externalDurationDeltaMs)),
    pairs
  };
  await writeRunResult(outputDirectory, "instrumentation-comparison.json", result);
  return result;
}

/** Verify the original report in place; a fresh repair output may use a different root. */
export async function verifyAutomatedReservedFirstRunReport(
  firstRunReportPath: string,
  taskId: string,
  corpusSha256: string
): Promise<{ path: string; sha256: string }> {
  const path = resolve(firstRunReportPath);
  const reportStats = await lstat(path);
  if (!reportStats.isFile() || reportStats.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error("Repair regression first-run report must be a regular file at its original canonical path.");
  }
  let parent = dirname(isAbsolute(firstRunReportPath) ? firstRunReportPath : `${process.cwd()}${sep}${firstRunReportPath}`);
  while (parent !== dirname(parent)) {
    if ((await lstat(parent)).isSymbolicLink()) {
      throw new Error("Repair regression first-run report must be a regular file at its original canonical path.");
    }
    parent = dirname(parent);
  }
  const reportBytes = await readFile(path);
  const value: unknown = JSON.parse(reportBytes.toString("utf8"));
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "automated-reserved-regression" ||
    value.evaluationKind !== "automated-engineering" || value.phase !== "first-run" || value.formalAcceptance !== false ||
    value.taskId !== taskId || value.corpusSha256 !== corpusSha256 || value.outputDirectory !== dirname(path) ||
    !isSha256(value.specSha256) || !Array.isArray(value.projects) || value.projects.length === 0 || !Array.isArray(value.runs) ||
    typeof value.measurementValid !== "boolean" || typeof value.complete !== "boolean" ||
    typeof value.productOutcome !== "string" || !["success", "failure", "mixed", "unknown", "incomplete"].includes(value.productOutcome) ||
    (value.measurementValid && value.complete && value.productOutcome === "success")) {
    throw new Error("Repair regression requires a failing first-run report for the same task and registered corpus at its original output directory.");
  }
  return { path, sha256: createHash("sha256").update(reportBytes).digest("hex") };
}

export async function collectAutomatedReservedRegression(
  spec: AutomatedEngineeringRunSpec,
  phase: "first-run" | "repair-regression",
  firstRunReportPath?: string
): Promise<AutomatedReservedRegressionResult> {
  const { verification } = await prepareAutomatedEngineering(spec);
  if (phase !== "first-run" && phase !== "repair-regression") throw new Error(`Unsupported reserved-regression phase: ${String(phase)}.`);

  const reservedOutputRoot = await assertMeasurementOutputIsolated(spec.reservedOutputDirectory, Object.values(spec.reservedProjectCheckouts));
  let firstRunReport: AutomatedReservedRegressionResult["firstRunReport"];
  if (phase === "repair-regression") {
    const expectedReport = spec.preservedFirstRunReport;
    if (!expectedReport || typeof firstRunReportPath !== "string" || !firstRunReportPath.trim() || resolve(firstRunReportPath) !== expectedReport.path) {
      throw new Error("Repair regression must reference the A1-bound preserved first-run report path.");
    }
    firstRunReport = await verifyAutomatedReservedFirstRunReport(firstRunReportPath, spec.taskId, verification.corpusSha256);
    if (firstRunReport.sha256 !== expectedReport.sha256.toLowerCase()) {
      throw new Error("Repair regression first-run report hash does not match the A1-bound preserved report.");
    }
  } else if (firstRunReportPath !== undefined) {
    throw new Error("A first-run collection cannot reference a repair report.");
  }

  const outputDirectory = phase === "first-run"
    ? join(reservedOutputRoot, "first-run")
    : join(reservedOutputRoot, "repair-regression");
  const claimedOutputDirectory = await claimMeasurementOutputDirectory(outputDirectory, Object.values(spec.reservedProjectCheckouts));

  const registryBytes = await readFile(spec.corpusPath);
  const registryHash = createHash("sha256").update(registryBytes).digest("hex");
  if (registryHash !== verification.corpusSha256) throw new Error("Registered corpus changed after automated preflight; no reserved checkout was inspected.");
  const registry: unknown = JSON.parse(registryBytes.toString("utf8"));
  if (!isRecord(registry) || !Array.isArray(registry.repositories)) throw new Error("Registered corpus repositories metadata is invalid after automated preflight.");
  const registeredHoldouts = registry.repositories.filter((entry) => isRecord(entry) && entry.split === "holdout");
  if (registeredHoldouts.length !== verification.registeredSamples.filter((sample) => sample.split === "holdout").length) {
    throw new Error("Registered holdout identities changed after automated preflight.");
  }

  const projects: CorpusProject[] = [];
  const projectEvidence: AutomatedReservedProjectEvidence[] = [];
  for (const entry of registeredHoldouts) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.canonicalUrl !== "string" ||
      typeof entry.primaryLanguage !== "string" || !entry.primaryLanguage.trim() || !isRecord(entry.acquisition) ||
      typeof entry.acquisition.checkoutTreeOid !== "string" || !Array.isArray(entry.roles)) {
      throw new Error("Registered holdout identity metadata is incomplete; no checkout was inspected.");
    }
    const identity: AutomatedReservedCheckoutIdentity = {
      id: entry.id,
      path: spec.reservedProjectCheckouts[entry.id],
      sourceRevision: String(entry.commit).toLowerCase(),
      checkoutTreeOid: entry.acquisition.checkoutTreeOid.toLowerCase(),
      generationProtocol: spec.generationProtocol,
      language: entry.primaryLanguage,
      projectKinds: uniqueStringArray(entry.roles)
    };
    if (!identity.projectKinds.length) throw new Error(`Registered holdout ${identity.id} has no repository roles.`);
    const inspected = await inventoryAutomatedReservedCheckout(identity);
    projects.push(inspected.project);
    projectEvidence.push({
      ...inspected.evidence,
      canonicalUrl: entry.canonicalUrl,
      inventory: { ...inspected.evidence.inventory, manifestPath: `inventories/${identity.id}.jsonl` }
    });
  }
  const projectCheckouts = Object.fromEntries(projects.map((project) => [project.id, project.path]));
  if (!sameStringSet(Object.keys(projectCheckouts), Object.keys(spec.reservedProjectCheckouts))) {
    throw new Error("Registered holdout IDs do not exactly match reserved checkout paths.");
  }
  const inventoriesDirectory = join(claimedOutputDirectory, "inventories");
  await mkdir(inventoriesDirectory);
  for (const evidence of projectEvidence) {
    const manifestBytes = Buffer.from(`${evidence.inventory.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    const actualSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    if (actualSha256 !== evidence.inventory.sha256) throw new Error(`Dynamic reserved inventory serialization changed for ${evidence.id}.`);
    if (!evidence.inventory.manifestPath) throw new Error(`Dynamic reserved inventory output path is missing for ${evidence.id}.`);
    await writeFile(join(claimedOutputDirectory, evidence.inventory.manifestPath), manifestBytes, { flag: "wx" });
  }
  const sourceChangesByProject: Record<string, MeasurementSourceChange> = {};
  for (const project of projects) {
    const source = project.inventoryEntries.filter((entry) => entry.kind === "source")
      .sort((left, right) => left.sizeBytes - right.sizeBytes || left.path.localeCompare(right.path))[0];
    if (!source) throw new Error(`Reserved project ${project.id} has no source for incremental regression.`);
    sourceChangesByProject[project.id] = createAutomatedReservedSourceChange(source, await readFile(join(project.path, source.path), "utf8"));
  }
  const runSpec: BaselineRunSpec = {
    ...spec,
    outputDirectory: join(claimedOutputDirectory, "runs"),
    projectCheckouts,
    sourceChangesByProject,
    repetitions: 1
  };
  const runs = await collectRuns(runSpec, { schemaVersion: 1, sha256: verification.corpusSha256, projects }, "holdout");
  for (const project of projects) await assertReservedCheckoutIdentity(project);
  const packageTreeCheck = await checkAutomatedPackageTree(spec, verification.packageBundleTreeSha256);
  if (firstRunReport) {
    const current = await verifyAutomatedReservedFirstRunReport(firstRunReport.path, spec.taskId, verification.corpusSha256);
    if (current.sha256 !== firstRunReport.sha256 || current.sha256 !== spec.preservedFirstRunReport?.sha256.toLowerCase()) {
      throw new Error("Repair regression changed the A1-bound preserved first-run report.");
    }
  }
  const plannedRuns = projects.length * spec.scenarios.length;
  const result: AutomatedReservedRegressionResult = {
    schemaVersion: 1,
    kind: "automated-reserved-regression",
    phase,
    evaluationKind: "automated-engineering",
    formalAcceptance: false,
    taskId: spec.taskId,
    specSha256: verification.specSha256,
    corpusSha256: verification.corpusSha256,
    measurementIdentity: spec.measurement,
    outputDirectory: claimedOutputDirectory,
    ...(firstRunReport ? { firstRunReport } : {}),
    projects: projectEvidence,
    plannedRuns,
    complete: runs.length === plannedRuns && runs.every((run) => run.productOutcome !== "incomplete") && packageTreeCheck.unchanged,
    measurementValid: runs.length === plannedRuns && runs.every((run) => run.measurementValid),
    productOutcome: summarizeProductOutcome(runs),
    runs,
    packageTreeUnchangedAfterCollection: packageTreeCheck.unchanged,
    ...(packageTreeCheck.actualSha256 ? { packageTreeHashAfterCollection: packageTreeCheck.actualSha256 } : {}),
    ...(packageTreeCheck.error ? { packageTreeError: packageTreeCheck.error } : {})
  };
  await writeRunResult(claimedOutputDirectory, "reserved-inventory.json", projectEvidence);
  await writeRunLines(claimedOutputDirectory, "automated-reserved.jsonl", runs);
  await writeRunResult(claimedOutputDirectory, "automated-reserved-regression.json", result);
  return result;
}

export function createAutomatedReservedSourceChange(entry: InventoryEntry, content: string): MeasurementSourceChange {
  if (entry.kind !== "source" || createHash("sha256").update(content, "utf8").digest("hex") !== entry.sha256) {
    throw new Error(`Reserved incremental source does not match its verified inventory: ${entry.path}.`);
  }
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const comment = entry.path.endsWith(".py") ? "#" : "//";
  return { path: entry.path, beforeSha256: entry.sha256,
    afterContent: `${content}${lineEnding}${comment} FlowWeave automated incremental-source fixture.${lineEnding}` };
}

export async function inventoryAutomatedReservedCheckout(
  identity: AutomatedReservedCheckoutIdentity
): Promise<{ project: CorpusProject; evidence: AutomatedReservedProjectEvidence }> {
  if (!/^[A-Za-z0-9_-]+$/.test(identity.id) || !isAbsolute(identity.path) || !/^[a-f0-9]{40}$/i.test(identity.sourceRevision) ||
    !/^[a-f0-9]{40}$/i.test(identity.checkoutTreeOid) || !Number.isInteger(identity.generationProtocol) || identity.generationProtocol < 1 ||
    !identity.language.trim() || !identity.projectKinds.length) {
    throw new Error("Reserved checkout identity is incomplete or unsafe.");
  }
  await assertReservedCheckoutIdentity({ id: identity.id, path: resolve(identity.path), sourceRevision: identity.sourceRevision, checkoutTreeOid: identity.checkoutTreeOid });
  const listing = (await execFileAsync("git", ["-C", identity.path, "ls-tree", "-r", "-z", "--full-tree", "HEAD"], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  const inventoryEntries: InventoryEntry[] = [];
  const excludedCandidatePaths: AutomatedReservedProjectEvidence["excludedCandidatePaths"] = [];
  for (const record of listing.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error(`Reserved checkout tree for ${identity.id} contains an unreadable Git tree entry.`);
    const [mode, type, objectId] = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    if (!mode || !type || !/^[a-f0-9]{40}$/i.test(objectId ?? "")) throw new Error(`Reserved checkout tree for ${identity.id} contains an invalid object record.`);
    if (!isInventoryCandidatePath(path)) continue;
    if (mode !== "100644" && mode !== "100755" || type !== "blob") {
      excludedCandidatePaths.push({ path, mode, reason: mode === "120000" ? "symlink" : "non-regular" });
      continue;
    }
    if (!isSafeFilePath(path)) {
      excludedCandidatePaths.push({ path, mode, reason: "unsafe-path" });
      continue;
    }
    const filePath = join(identity.path, ...path.split("/"));
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Reserved tracked candidate is not a regular checkout file: ${identity.id}/${path}.`);
    const bytes = await readFile(filePath);
    const language = sourceLanguageForPath(path);
    const kind = language ? "source" : isConfigurationPath(path) ? "configuration" : "license";
    inventoryEntries.push({ path, kind, mode, sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"), ...(language ? { language } : {}) });
  }
  inventoryEntries.sort((left, right) => left.path.localeCompare(right.path));
  const languages = [...new Set(inventoryEntries.filter((entry) => entry.kind === "source").map((entry) => entry.language!))].sort();
  if (!languages.length || !languages.includes(identity.language)) throw new Error(`Reserved checkout ${identity.id} does not contain tracked source in its registered primary language ${identity.language}.`);
  const sourcePaths = inventoryEntries.filter((entry) => entry.kind === "source").map((entry) => entry.path);
  const configurationPaths = inventoryEntries.filter((entry) => entry.kind === "configuration").map((entry) => entry.path);
  const includePaths = ["."];
  const excludePaths = excludedCandidatePaths.map((entry) => entry.path).sort();
  const manifestBytes = Buffer.from(`${inventoryEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  const sourceInventorySha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const scopeSha256 = collectionScopeSha256(includePaths, excludePaths);
  const sourceEntries = inventoryEntries.filter((entry) => entry.kind === "source");
  const languageCounts = Object.fromEntries(languages.map((language) => [language, sourceEntries.filter((entry) => entry.language === language).length]));
  const sourceBytes = sourceEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const scaleData = {
    stratum: "unclassified" as const,
    thresholdContract: "registered threshold unavailable; no budget evaluation" as const,
    sourceFileCount: sourceEntries.length,
    sourceBytes
  };
  const scaleSha256 = createHash("sha256").update(JSON.stringify(scaleData)).digest("hex");
  const project: CorpusProject = {
    id: identity.id,
    path: resolve(identity.path),
    split: "holdout",
    sourceRevision: identity.sourceRevision.toLowerCase(),
    checkoutTreeOid: identity.checkoutTreeOid.toLowerCase(),
    sourceTreeOid: identity.checkoutTreeOid.toLowerCase(),
    generationProtocol: identity.generationProtocol,
    language: identity.language,
    languages,
    projectKinds: [...identity.projectKinds],
    sizeBand: "unclassified",
    selection: { sourcePaths, configurationPaths, scopeSha256, sourceInventorySha256 },
    collectionScope: { includePaths, excludePaths },
    inventoryEntries
  };
  await validateMeasurementSourceInventory(project.path, project.selection, project.inventoryEntries);
  const evidence: AutomatedReservedProjectEvidence = {
    id: identity.id,
    sourceRevision: project.sourceRevision,
    checkoutTreeOid: project.checkoutTreeOid,
    primaryLanguage: identity.language,
    languages,
    projectKinds: [...identity.projectKinds],
    inventory: {
      fileCount: inventoryEntries.length,
      sourceFileCount: sourceEntries.length,
      sourceBytes,
      languageCounts,
      sha256: sourceInventorySha256,
      entries: inventoryEntries.map((entry) => ({ ...entry }))
    },
    scope: { includePaths, excludePaths, sha256: scopeSha256 },
    scale: { ...scaleData, sha256: scaleSha256 },
    excludedCandidatePaths
  };
  return { project, evidence };
}

async function assertReservedCheckoutIdentity(
  identity: Pick<AutomatedReservedCheckoutIdentity, "id" | "path" | "sourceRevision" | "checkoutTreeOid">
): Promise<void> {
  const head = (await execFileAsync("git", ["-C", identity.path, "rev-parse", "HEAD", "HEAD^{tree}"])).stdout.trim().split("\n");
  if (head[0] !== identity.sourceRevision || head[1] !== identity.checkoutTreeOid) {
    throw new Error(`Reserved checkout identity mismatch for ${identity.id}: expected ${identity.sourceRevision}/${identity.checkoutTreeOid}, found ${head[0] ?? "missing"}/${head[1] ?? "missing"}.`);
  }
  const status = (await execFileAsync("git", ["-C", identity.path, "status", "--porcelain", "--untracked-files=all"])).stdout.trim();
  if (status) throw new Error(`Reserved checkout ${identity.id} must remain clean during regression collection.`);
}

export function evaluateAutomatedEngineeringBudgets(
  runs: RunRecord[],
  corpus: CorpusFile,
  spec: AutomatedEngineeringRunSpec
): AutomatedEngineeringRunResult["budgetEvaluation"] {
  const plannedCount = countPlannedRuns(corpus, spec, "development");
  const errorCount = runs.filter((run) => !run.measurementValid || run.productOutcome !== "success").length + Math.max(0, plannedCount - runs.length);
  const productErrors = {
    count: errorCount,
    plannedCount,
    errorRate: plannedCount > 0 ? errorCount / plannedCount : null,
    maximum: spec.budgetRules.errorRateMax,
    passed: plannedCount > 0 && errorCount / plannedCount <= spec.budgetRules.errorRateMax
  };
  const metrics: AutomatedEngineeringRunResult["budgetEvaluation"]["metrics"] = {};
  const reportedMetrics: AutomatedEngineeringRunResult["budgetEvaluation"]["reportedMetrics"] = {};
  const scenarios = spec.scenarios.filter((scenario) => scenario.availability === "available");
  for (const scenario of scenarios) {
    for (const project of corpus.projects.filter((candidate) => candidate.split === "development")) {
      if (project.sizeBand === "unclassified") throw new Error(`Automated budget evaluation requires a registered scale stratum: ${project.id}.`);
      const projectRuns = runs.filter((run) => run.projectId === project.id && run.scenarioId === scenario.id);
      for (const metric of spec.budgetRules.reportOnlyP95Metrics) {
        const values = projectRuns.map((run) => run.metrics[metric]).filter((value): value is number => typeof value === "number");
        const resultKey = `${scenario.id}/${project.sizeBand}/${metric}`;
        const result: AutomatedEngineeringRunResult["budgetEvaluation"]["reportedMetrics"][string] = reportedMetrics[resultKey] ?? {
          disposition: "reported-only",
          definition: "Runner process-launch request to renderer window load; cold-process startup diagnostic with no pass/fail threshold.",
          observed: null,
          sampleCount: 0,
          plannedCount: 0,
          aggregation: "p95",
          perProject: {}
        };
        result.perProject[project.id] = {
          observed: values.length ? nearestRank(values, 0.95) : null,
          sampleCount: values.length,
          plannedCount: spec.repetitions
        };
        reportedMetrics[resultKey] = result;
      }
      for (const metric of AUTOMATED_P95_METRICS) {
        if (!automatedMetricApplies(scenario.id, metric) && projectRuns.every((run) => typeof run.metrics[metric] !== "number")) continue;
        const values = projectRuns.map((run) => run.metrics[metric]).filter((value): value is number => typeof value === "number");
        const maximum = automatedTimeBudget(spec, project.sizeBand, scenario.id, metric);
        const observed = values.length ? nearestRank(values, 0.95) : null;
        const passed = projectRuns.length === spec.repetitions && values.length === spec.repetitions && observed !== null && observed <= maximum;
        addAutomatedBudgetResult(metrics, `${scenario.id}/${project.sizeBand}/${metric}`, project.id, observed, values.length,
          spec.repetitions, maximum, "p95", passed);
      }
      for (const metric of AUTOMATED_MAX_METRICS) {
        const values = projectRuns.map((run) => run.metrics[metric]).filter((value): value is number => typeof value === "number");
        const maximum = spec.budgetRules.absoluteMaxByMetric[metric];
        const observed = values.length ? Math.max(...values) : null;
        const passed = projectRuns.length === spec.repetitions && values.length === spec.repetitions && observed !== null && observed <= maximum;
        addAutomatedBudgetResult(metrics, `${scenario.id}/${project.sizeBand}/${metric}`, project.id, observed, values.length,
          spec.repetitions, maximum, "max", passed);
      }
    }
  }
  for (const result of Object.values(metrics)) {
    const projectValues = Object.values(result.perProject).map((project) => project.observed).filter((value): value is number => value !== null);
    result.observed = projectValues.length ? result.aggregation === "p95" ? Math.max(...projectValues) : Math.max(...projectValues) : null;
    result.sampleCount = Object.values(result.perProject).reduce((sum, project) => sum + project.sampleCount, 0);
    result.plannedCount = Object.values(result.perProject).reduce((sum, project) => sum + project.plannedCount, 0);
    result.passed = Object.values(result.perProject).length === corpus.projects.filter((project) => project.split === "development").length &&
      Object.values(result.perProject).every((project) => project.passed);
  }
  for (const result of Object.values(reportedMetrics)) {
    const projectValues = Object.values(result.perProject).map((project) => project.observed).filter((value): value is number => value !== null);
    result.observed = projectValues.length ? Math.max(...projectValues) : null;
    result.sampleCount = Object.values(result.perProject).reduce((sum, project) => sum + project.sampleCount, 0);
    result.plannedCount = Object.values(result.perProject).reduce((sum, project) => sum + project.plannedCount, 0);
  }
  return {
    productErrors,
    baselineComparison: {
      status: "not-comparable",
      reason: "A2 instrumentation-on/off comparison is reported separately; A3 evaluates only the predeclared absolute engineering budgets.",
      ratioMaximum: spec.budgetRules.timeP95BaselineRatioMax
    },
    reportedMetrics,
    metrics
  };
}

function automatedMetricApplies(scenarioId: string, metric: (typeof AUTOMATED_P95_METRICS)[number]): boolean {
  const cachedScenarios = ["cached-reopen", "detail-cold", "detail-hot"];
  if (cachedScenarios.includes(scenarioId) && ["semanticAnalysisMs", "clusteringMs", "layoutMs", "commitMs"].includes(metric)) return false;
  if (scenarioId === "detail-hot" && ["snapshotValidationMs", "snapshotParseMs", "snapshotReadMs", "detailIndexMs"].includes(metric)) return false;
  return true;
}

function automatedTimeBudget(
  spec: AutomatedEngineeringRunSpec,
  sizeBand: ProjectSizeBand,
  scenarioId: string,
  metric: (typeof AUTOMATED_P95_METRICS)[number]
): number {
  if (metric === "workspaceInteractiveMs") return spec.budgetRules.workspaceInteractiveP95MsMax;
  if (metric === "cancellationUiResponseMs") return spec.budgetRules.cancellationUiP95MsMax;
  if (metric === "detailReadyMs" && scenarioId === "detail-cold") return spec.budgetRules.detailColdP95MsMax;
  if (metric === "detailReadyMs" && scenarioId === "detail-hot") return spec.budgetRules.detailWarmP95MsMax;
  const fixedMetrics = ["projectSelectionMs", "workspaceInteractiveMs", "ipcReceiptMs", "detailReadyMs", "selectionToWorkspaceInteractiveMs",
    "detailIpcRoundTripMs", "detailPanelPresentationMs", "cancellationUiResponseMs", "backgroundTaskExitMs"];
  const base = spec.budgetRules.timeP95AbsoluteMsByMetric[metric];
  return base * (fixedMetrics.includes(metric) ? 1 : spec.budgetRules.sizeBandMultiplier[sizeBand]);
}

function addAutomatedBudgetResult(
  results: AutomatedEngineeringRunResult["budgetEvaluation"]["metrics"],
  key: string,
  projectId: string,
  observed: number | null,
  sampleCount: number,
  plannedCount: number,
  maximum: number,
  aggregation: "p95" | "max",
  passed: boolean
): void {
  const result = results[key] ?? {
    observed: null,
    sampleCount: 0,
    plannedCount: 0,
    maximum,
    aggregation,
    passed: true,
    perProject: {}
  };
  result.perProject[projectId] = { observed, sampleCount, plannedCount, maximum, passed };
  results[key] = result;
}

async function prepareAutomatedEngineering(spec: AutomatedEngineeringRunSpec): Promise<{ corpus: CorpusFile; verification: AutomatedInputVerification }> {
  validateSpec(spec);
  if (spec.schemaVersion !== 1 || spec.evaluationKind !== "automated-engineering" || !isSha256(spec.corpusSha256) || typeof spec.taskId !== "string" || !spec.taskId.trim()) {
    throw new Error("Automated engineering requires schema 1, an explicit evaluation kind, corpus hash, and task ID.");
  }
  if (spec.repetitions !== 20 || spec.scenarios.some((scenario) => scenario.availability !== "available")) {
    throw new Error("Automated engineering requires all six predeclared scenarios to be available at exactly 20 repetitions each.");
  }
  if (!isRecord(spec.developmentManifests)) throw new Error("Automated engineering requires an explicit development manifest map.");
  if (!sameStringSet(spec.scenarios.map((scenario) => scenario.id), [...STATIC_GRAPH_MEASUREMENT_SCENARIOS])) {
    throw new Error("Automated engineering must register every predeclared measurement scenario exactly once.");
  }
  const rules = spec.budgetRules;
  if (!isRecord(rules) || rules.timeP95BaselineRatioMax !== 1.05 || rules.workspaceInteractiveP95MsMax !== 1000 || rules.detailColdP95MsMax !== 300 ||
    rules.detailWarmP95MsMax !== 100 || rules.cancellationUiP95MsMax !== 500 || rules.errorRateMax !== 0 || rules.missingBudget !== "fail" ||
    rules.remainingMetrics !== "predeclared-absolute-or-comparable-baseline" ||
    !sameStringSet(uniqueStringArray(rules.reportOnlyP95Metrics), [...AUTOMATED_REPORT_ONLY_P95_METRICS]) ||
    !matchesNumberRecord(rules.timeP95AbsoluteMsByMetric, AUTOMATED_ENGINEERING_BUDGET_RULES.timeP95AbsoluteMsByMetric) ||
    !matchesNumberRecord(rules.absoluteMaxByMetric, AUTOMATED_ENGINEERING_BUDGET_RULES.absoluteMaxByMetric) ||
    !matchesNumberRecord(rules.sizeBandMultiplier, AUTOMATED_ENGINEERING_BUDGET_RULES.sizeBandMultiplier)) {
    throw new Error("Automated engineering requires every predeclared absolute time/resource budget and its size-band formula; missing budgets must fail.");
  }
  if (!Array.isArray(spec.boundFiles) || !spec.boundFiles.length || spec.boundFiles.some((file) => !isRecord(file) || typeof file.path !== "string" || !isAbsolute(file.path) || !isSha256(file.sha256)) ||
    !spec.boundFiles.some((file) => resolve(file.path) === resolve(spec.executablePath)) || new Set(spec.boundFiles.map((file) => resolve(file.path))).size !== spec.boundFiles.length) {
    throw new Error("Automated engineering boundFiles must bind unique absolute files, including the executable, to SHA-256 hashes.");
  }
  if (spec.preservedFirstRunReport !== undefined && (!isRecord(spec.preservedFirstRunReport) ||
    typeof spec.preservedFirstRunReport.path !== "string" || !isAbsolute(spec.preservedFirstRunReport.path) ||
    resolve(spec.preservedFirstRunReport.path) !== spec.preservedFirstRunReport.path || !isSha256(spec.preservedFirstRunReport.sha256) ||
    !spec.boundFiles.some((file) => resolve(file.path) === spec.preservedFirstRunReport?.path && file.sha256.toLowerCase() === spec.preservedFirstRunReport.sha256.toLowerCase()))) {
    throw new Error("Automated engineering preservedFirstRunReport must bind its canonical absolute path and SHA-256 in boundFiles.");
  }
  const boundFileHashes = new Map(spec.boundFiles.map((file) => [resolve(file.path), file.sha256.toLowerCase()]));
  for (const file of spec.boundFiles) {
    if (createHash("sha256").update(await readFile(file.path)).digest("hex") !== file.sha256.toLowerCase()) throw new Error(`Automated engineering bound file hash mismatch: ${file.path}.`);
  }
  const appAsarPath = resolve(dirname(spec.executablePath), "../Resources/app.asar");
  if (!boundFileHashes.has(appAsarPath)) throw new Error("Automated engineering must bind the app.asar packaged with its executable.");
  const missingMeasurementSources = AUTOMATED_MEASUREMENT_SOURCE_FILES.filter((path) => !boundFileHashes.has(resolve(path)));
  if (missingMeasurementSources.length) throw new Error(`Automated engineering must bind its measurement source files: ${missingMeasurementSources.join(", ")}.`);
  await verifyAutomatedResourceBundle(spec.executablePath, spec.boundFiles);
  const packageBundleTreeSha256 = await verifyAutomatedPackageSourceEvidence(spec.executablePath, spec.boundFiles, boundFileHashes);
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const measurementSha256 = createHash("sha256").update(JSON.stringify(AUTOMATED_MEASUREMENT_SOURCE_FILES.map((path) => ({
    path: relative(sourceRoot, path),
    sha256: boundFileHashes.get(resolve(path))
  })))).digest("hex");
  if (spec.measurement.sha256.toLowerCase() !== measurementSha256) throw new Error("Automated engineering measurement SHA-256 does not match its bound collector and runtime sources.");
  const bytes = await readFile(spec.corpusPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== REGISTERED_AUTOMATED_CORPUS_SHA256 || spec.corpusSha256.toLowerCase() !== REGISTERED_AUTOMATED_CORPUS_SHA256) {
    throw new Error(`Automated engineering corpus hash does not match the registered A1 corpus: expected ${REGISTERED_AUTOMATED_CORPUS_SHA256}, found ${sha256}.`);
  }
  const registry: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(registry) || registry.schemaVersion !== 1 || !Array.isArray(registry.repositories) || !registry.repositories.length || !isRecord(registry.selection)) {
    throw new Error("Automated engineering requires the registered repositories and selection metadata.");
  }
  const holdoutIds = registry.repositories.flatMap((entry): string[] => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.id) ||
      (entry.split !== "development" && entry.split !== "holdout")) {
      throw new Error("Automated registry requires valid repository IDs and splits before reserving holdouts.");
    }
    return entry.split === "holdout" ? [entry.id] : [];
  });
  if (!holdoutIds.length || new Set(holdoutIds).size !== holdoutIds.length || !isRecord(spec.reservedProjectCheckouts) ||
    !sameStringSet(Object.keys(spec.reservedProjectCheckouts), holdoutIds) ||
    Object.values(spec.reservedProjectCheckouts).some((path) => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error("Automated engineering reservedProjectCheckouts must exactly match registered holdout IDs and use absolute paths.");
  }
  if (typeof spec.reservedOutputDirectory !== "string" || !isAbsolute(spec.reservedOutputDirectory)) {
    throw new Error("Automated engineering reservedOutputDirectory must be an absolute path.");
  }
  const registeredSamples: AutomatedInputVerification["registeredSamples"] = [];
  const projects: CorpusProject[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  const commits = new Set<string>();
  const counts = new Map<string, { total: number; development: number; holdout: number }>();
  for (const entry of registry.repositories) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.id) || ids.has(entry.id) ||
      (entry.split !== "development" && entry.split !== "holdout") || typeof entry.commit !== "string" || !/^[a-f0-9]{40}$/i.test(entry.commit) ||
      !isRecord(entry.acquisition) || typeof entry.acquisition.checkoutTreeOid !== "string" || !/^[a-f0-9]{40}$/i.test(entry.acquisition.checkoutTreeOid) ||
      typeof entry.primaryLanguage !== "string" || !entry.primaryLanguage.trim()) throw new Error("Automated registry requires unique IDs, splits, commits, trees, and primary languages.");
    const canonicalUrl = parseCanonicalRepositoryUrl(entry.canonicalUrl, entry.id);
    const commit = entry.commit.toLowerCase();
    const treeOid = entry.acquisition.checkoutTreeOid.toLowerCase();
    if (urls.has(canonicalUrl) || commits.has(commit)) throw new Error(`Automated registry repeats a repository URL or commit: ${entry.id}.`);
    ids.add(entry.id); urls.add(canonicalUrl); commits.add(commit);
    const languageCount = counts.get(entry.primaryLanguage) ?? { total: 0, development: 0, holdout: 0 };
    counts.set(entry.primaryLanguage, { ...languageCount, total: languageCount.total + 1, [entry.split]: languageCount[entry.split] + 1 });
    registeredSamples.push({ id: entry.id, split: entry.split, canonicalUrl, commit, treeOid,
      verification: entry.split === "development" ? "checkout-and-manifest" : "registered-identity-only" });
    // Reserved entries stop at registry metadata; even their manifest paths must not be opened here.
    if (entry.split === "holdout") continue;
    const inventory = entry.sourceInventory;
    const scope = entry.collectionScope;
    const manifest = spec.developmentManifests?.[entry.id];
    const registeredManifestSha256 = isRecord(inventory) ? inventory.manifestSha256 ?? inventory.contentHash : undefined;
    if ((entry.status !== "proposed" && entry.status !== "acquired") || !isRecord(inventory) || !isSha256(registeredManifestSha256) ||
      !manifest || !isRecord(manifest) || !isAbsolute(manifest.path) || !isSha256(manifest.sha256) ||
      manifest.sha256.toLowerCase() !== registeredManifestSha256.toLowerCase() || !isIntegerMap(inventory.languageCounts) ||
      !isRecord(scope) || !isStringArray(scope.includePaths) || !scope.includePaths.length || !isStringArray(scope.excludePaths) ||
      [...scope.includePaths, ...scope.excludePaths].some((path) => !isSafeScopePath(path)) || !isRecord(entry.scale) || !["small", "medium", "large"].includes(String(entry.scale.stratum))) {
      throw new Error(`Automated development sample ${entry.id} needs a matching registered manifest hash, exact scope and size stratum.`);
    }
    const path = spec.projectCheckouts[entry.id];
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`Automated development sample ${entry.id} needs an absolute checkout path.`);
    const manifestRoot = await realpath(dirname(resolve(spec.corpusPath)));
    const manifestPath = await realpath(manifest.path);
    if (!isPathInside(manifestRoot, manifestPath)) throw new Error(`Automated development sample ${entry.id} manifest must remain inside the registered evidence directory.`);
    const inventoryEntries = await readInventoryManifest(manifestRoot, entry.id, relative(manifestRoot, manifestPath), manifest.sha256);
    validateInventorySummary(entry.id, inventory, inventoryEntries);
    const languages = [...new Set(inventoryEntries.filter((item) => item.kind === "source").map((item) => item.language!))].sort();
    const roles = uniqueStringArray(entry.roles);
    if (!languages.includes(entry.primaryLanguage) || !roles.length) throw new Error(`Automated development sample ${entry.id} has inconsistent language or role metadata.`);
    const project: CorpusProject = {
      id: entry.id, path, split: "development", sourceRevision: commit, checkoutTreeOid: treeOid,
      sourceTreeOid: treeOid, generationProtocol: spec.generationProtocol, language: entry.primaryLanguage, languages,
      projectKinds: roles, sizeBand: entry.scale.stratum as ProjectSizeBand,
      selection: { sourcePaths: inventoryEntries.filter((item) => item.kind === "source").map((item) => item.path).sort(),
        configurationPaths: inventoryEntries.filter((item) => item.kind === "configuration").map((item) => item.path).sort(),
        scopeSha256: collectionScopeSha256(scope.includePaths, scope.excludePaths), sourceInventorySha256: registeredManifestSha256 },
      collectionScope: { includePaths: scope.includePaths, excludePaths: scope.excludePaths }, inventoryEntries
    };
    const head = (await execFileAsync("git", ["-C", path, "rev-parse", "HEAD", "HEAD^{tree}"])).stdout.trim().split("\n");
    if (head[0] !== project.sourceRevision || head[1] !== project.checkoutTreeOid) throw new Error(`Automated development checkout identity mismatch: ${entry.id}.`);
    if ((await execFileAsync("git", ["-C", path, "status", "--porcelain", "--untracked-files=all"])).stdout.trim()) throw new Error(`Automated development requires a clean checkout: ${entry.id}.`);
    await validateCheckoutInventory(project);
    projects.push(project);
  }
  const selection = registry.selection;
  if (registeredSamples.length !== 14 || projects.length !== 10 || registeredSamples.length - projects.length !== 4 ||
    selection.repositoryCount !== 14 || selection.developmentCount !== 10 || selection.holdoutCount !== 4) {
    throw new Error("Automated engineering requires the registered 14-sample split: 10 development and 4 reserved identities.");
  }
  if (registeredSamples.length !== selection.repositoryCount || projects.length !== selection.developmentCount || registeredSamples.length - projects.length !== selection.holdoutCount ||
    !isRecord(selection.perLanguage) || !sameStringSet(Object.keys(selection.perLanguage), [...counts.keys()])) throw new Error("Automated registry selection counts do not match registered identities.");
  for (const [language, count] of counts) {
    const declared = selection.perLanguage[language];
    if (!isRecord(declared) || declared.total !== count.total || declared.development !== count.development || declared.holdout !== count.holdout) throw new Error(`Automated registry language counts mismatch: ${language}.`);
  }
  if (!sameStringSet(Object.keys(spec.projectCheckouts), projects.map((project) => project.id)) ||
    !sameStringSet(Object.keys(spec.developmentManifests), projects.map((project) => project.id)) ||
    !sameStringSet(spec.supportedScope.languages, [...new Set(projects.flatMap((project) => project.languages))]) ||
    !sameStringSet(spec.supportedScope.projectKinds, [...new Set(projects.flatMap((project) => project.projectKinds))]) ||
    !sameStringSet(spec.supportedScope.sizeBands, [...new Set(projects.map((project) => project.sizeBand))])) throw new Error("Automated spec must exactly cover development checkouts, languages, roles and size strata.");
  const incrementalScenario = spec.scenarios.find((scenario) => scenario.id === "incremental-source");
  if (incrementalScenario?.availability === "available") {
    if (!isRecord(spec.sourceChangesByProject) || !sameStringSet(Object.keys(spec.sourceChangesByProject), projects.map((project) => project.id))) {
      throw new Error("An available incremental scenario requires one registered source change for every development project.");
    }
    for (const project of projects) {
      const change = spec.sourceChangesByProject[project.id];
      const inventoryEntry = project.inventoryEntries.find((entry) => entry.kind === "source" && entry.path === change.path);
      const afterSha256 = createHash("sha256").update(change.afterContent, "utf8").digest("hex");
      if (!inventoryEntry || inventoryEntry.sha256.toLowerCase() !== change.beforeSha256.toLowerCase() || afterSha256 === inventoryEntry.sha256.toLowerCase()) {
        throw new Error(`Incremental source change does not bind a selected file and distinct after-content hash: ${project.id}.`);
      }
    }
  } else if (spec.sourceChangesByProject && Object.keys(spec.sourceChangesByProject).length) {
    throw new Error("Incremental source changes cannot be registered while the scenario is incomplete.");
  }
  return { corpus: { schemaVersion: 1, sha256, projects }, verification: { evaluationKind: "automated-engineering", formalAcceptance: false,
    corpusSha256: sha256, specSha256: createHash("sha256").update(JSON.stringify(spec)).digest("hex"), packageBundleTreeSha256, registeredSamples } };
}

export async function runStaticGraphAcceptance(spec: AcceptanceRunSpec): Promise<AcceptanceRunResult> {
  validateSpec(spec);
  const outputDirectory = await assertMeasurementOutputIsolated(spec.outputDirectory, Object.values(spec.projectCheckouts));
  const runSpec = { ...spec, outputDirectory };
  if (spec.targetSplit !== "development") throw new Error("The ordinary acceptance entrypoint is development-only; holdout evaluation is reserved for T11.");
  if (!spec.contractPath || !spec.contractSha256) throw new Error("Formal acceptance requires a complete frozen contract and SHA-256.");
  const contractBytes = await readFile(spec.contractPath);
  const actualHash = createHash("sha256").update(contractBytes).digest("hex");
  if (actualHash !== spec.contractSha256) throw new Error(`Contract hash mismatch: expected ${spec.contractSha256}, got ${actualHash}.`);
  const contract = parseContract(JSON.parse(contractBytes.toString("utf8")) as unknown);
  const corpus = await prepareCorpus(spec);
  validateContractBinding(contract, corpus, spec);
  const runs = await collectRuns(runSpec, corpus, "development");
  const thresholdResults = evaluatePerformanceBudgets(runs, contract);
  const qualityResults = evaluateQualityGates(runs, contract);
  const resourceResults = evaluateResourceBudgets(runs, corpus, contract);
  const measurementValid = runs.every((run) => run.measurementValid);
  const complete = runs.every((run) => run.productOutcome !== "incomplete");
  const productOutcome = summarizeProductOutcome(runs);
  const thresholdOutcome = measurementValid && complete && productOutcome === "success" &&
    Object.values(thresholdResults).every((threshold) => threshold.passed) &&
    Object.values(qualityResults).every((gate) => gate.passed) &&
    Object.values(resourceResults).every((budget) => budget.passed)
    ? "pass"
    : "fail";
  const result: AcceptanceRunResult = {
    schemaVersion: 1,
    kind: "acceptance",
    corpusPath: resolve(spec.corpusPath),
    measurementValid,
    complete,
    productOutcome,
    thresholdOutcome,
    formalAcceptance: thresholdOutcome === "pass",
    osCacheState: spec.osCacheState,
    generationProtocol: spec.generationProtocol,
    plannedRuns: countPlannedRuns(corpus, spec, "development"),
    runs,
    contractPath: resolve(spec.contractPath),
    contractSha256: actualHash,
    corpusSha256: corpus.sha256,
    selectedSplit: "development",
    measurementIdentity: spec.measurement,
    thresholdResults,
    qualityResults,
    resourceResults
  };
  await writeRunLines(outputDirectory, "acceptance.jsonl", runs);
  await writeRunResult(outputDirectory, "acceptance-run.json", result);
  if (!measurementValid) throw new Error(formatCollectionError(runs, join(spec.outputDirectory, "acceptance-run.json"), "Acceptance"));
  return result;
}

async function collectRuns(spec: BaselineRunSpec, corpus: CorpusFile, targetSplit: CorpusProject["split"]): Promise<RunRecord[]> {
  const sourceProjectPaths = Object.values(spec.projectCheckouts);
  const outputDirectory = await claimMeasurementOutputDirectory(spec.outputDirectory, sourceProjectPaths);
  const runSpec = { ...spec, outputDirectory };
  const outputTargets = ["baseline.jsonl", "baseline-run.json", "acceptance.jsonl", "acceptance-run.json"]
    .map((filename) => join(outputDirectory, filename));
  for (const project of corpus.projects.filter((candidate) => candidate.split === targetSplit)) {
    for (const scenario of spec.scenarios.filter((candidate) => candidate.availability === "available")) {
      for (let repetition = 1; repetition <= spec.repetitions; repetition += 1) {
        const runDirectory = join(outputDirectory, "raw", project.id, scenario.id, `run-${String(repetition).padStart(2, "0")}`);
        outputTargets.push(...["context.json", "measurement-report.json", "run-record.json", "user-data", "scenario-project"].map((name) => join(runDirectory, name)));
      }
    }
  }
  for (const outputTarget of outputTargets) {
    await assertMeasurementOutputTargetContained(outputDirectory, outputTarget);
    await assertMeasurementOutputIsolated(outputTarget, sourceProjectPaths);
  }
  const records: RunRecord[] = [];
  for (const project of corpus.projects.filter((candidate) => candidate.split === targetSplit)) {
    for (const scenario of spec.scenarios) {
      for (let repetition = 1; repetition <= spec.repetitions; repetition += 1) {
        const startedAt = new Date().toISOString();
        if (scenario.availability === "incomplete") {
          records.push({
            projectId: project.id,
            scenarioId: scenario.id,
            repetition,
            measurementValid: true,
            productOutcome: "incomplete",
            language: project.language,
            ...projectEvidenceFields(project),
            sizeBand: project.sizeBand,
            split: project.split,
            startedAt,
            endedAt: new Date().toISOString(),
            metrics: {},
            unavailableMetrics: Object.fromEntries(REQUIRED_METRICS.map((metric) => [metric, scenario.reason ?? "Scenario has no real historical fixture."]))
          });
          continue;
        }
        records.push(await collectOneRun(runSpec, project, scenario.id, repetition, "on", []));
      }
    }
  }
  return records;
}

async function claimMeasurementOutputDirectory(outputDirectory: string, sourceProjectPaths: readonly string[]): Promise<string> {
  const isolatedOutputDirectory = await assertMeasurementOutputIsolated(outputDirectory, sourceProjectPaths);
  await mkdir(dirname(isolatedOutputDirectory), { recursive: true });
  try {
    await mkdir(isolatedOutputDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Measurement output directory already exists; choose a fresh outputDirectory: ${isolatedOutputDirectory}.`, { cause: error });
    }
    throw error;
  }
  const claimedOutputDirectory = await realpath(isolatedOutputDirectory);
  if (claimedOutputDirectory !== isolatedOutputDirectory) {
    throw new Error(`Measurement output directory changed while being claimed: expected ${isolatedOutputDirectory}, found ${claimedOutputDirectory}.`);
  }
  await assertMeasurementOutputIsolated(claimedOutputDirectory, sourceProjectPaths);
  return claimedOutputDirectory;
}

async function collectOneRun(
  spec: BaselineRunSpec,
  project: CorpusProject,
  scenarioId: string,
  repetition: number,
  instrumentationMode: InstrumentationMode,
  outputSegments: string[]
): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  const runDirectory = join(spec.outputDirectory, "raw", project.id, scenarioId, ...outputSegments, `run-${String(repetition).padStart(2, "0")}`);
  const contextPath = join(runDirectory, "context.json");
  const reportPath = join(runDirectory, "measurement-report.json");
  const context: RunContext = {
    runAttemptId: randomUUID(),
    projectId: project.id,
    projectPath: project.path,
    sourceRevision: project.sourceRevision,
    ...projectEvidenceFields(project),
    sourceInventoryEntries: project.inventoryEntries.map((entry) => ({ ...entry })),
    generationProtocol: project.generationProtocol,
    scenarioId,
    ...(scenarioId === "incremental-source" ? { sourceChange: spec.sourceChangesByProject?.[project.id] } : {}),
    repetition,
    osCacheState: spec.osCacheState,
    measurement: spec.measurement,
    instrumentationMode
  };
  let processResult: MeasurementProcessResult | undefined;
  try {
    if (scenarioId === "incremental-source" && !context.sourceChange) throw new Error(`Incremental measurement requires an explicit source change for development project ${project.id}.`);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(contextPath, JSON.stringify(context, null, 2), { encoding: "utf8", flag: "wx" });
    processResult = await runMeasurementProcess(spec, contextPath, reportPath, instrumentationMode);
    try {
      await validateMeasurementSourceInventory(project.path, project.selection, project.inventoryEntries);
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      const record = attachProcessEvidence(collectorFailure(project, scenarioId, repetition, startedAt,
        `Frozen source inventory changed during the measurement process: ${description}`, processResult), instrumentationMode, processResult);
      await persistRunRecord(runDirectory, record);
      return record;
    }
    let report: unknown;
    try {
      report = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      const record = attachProcessEvidence(collectorFailure(project, scenarioId, repetition, startedAt,
        `Planned run is missing its valid measurement report: ${description}; process exit=${processResult.code ?? "none"}; signal=${processResult.signal ?? "none"}; process error=${processResult.error ?? "none"}.${processResult.timeoutMessage ? ` ${processResult.timeoutMessage}` : ""}`,
        processResult), instrumentationMode, processResult);
      await persistRunRecord(runDirectory, record);
      return record;
    }
    const record = attachProcessEvidence(validateReport(report, project, scenarioId, repetition, startedAt, processResult,
      spec.measurement, context.runAttemptId, instrumentationMode), instrumentationMode, processResult);
    await persistRunRecord(runDirectory, record);
    return record;
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    return attachProcessEvidence(collectorFailure(project, scenarioId, repetition, startedAt,
      `Collector could not execute or persist the planned run: ${description}.`, processResult), instrumentationMode, processResult);
  }
}

function attachProcessEvidence(record: RunRecord, mode: InstrumentationMode, processResult: MeasurementProcessResult | undefined): RunRecord {
  return {
    ...record,
    instrumentationMode: mode,
    ...(processResult ? {
      externalStartedAtEpochMs: processResult.externalStartedAtEpochMs,
      externalEndedAtEpochMs: processResult.externalEndedAtEpochMs,
      externalDurationMs: processResult.externalDurationMs
    } : {})
  };
}

function validateReport(
  value: unknown,
  project: CorpusProject,
  scenarioId: string,
  repetition: number,
  collectionStartedAt: string,
  processResult: MeasurementProcessResult,
  measurement: BaselineRunSpec["measurement"],
  expectedRunAttemptId: string,
  expectedInstrumentationMode: InstrumentationMode
): RunRecord {
  if (!isRecord(value)) return collectorFailure(project, scenarioId, repetition, collectionStartedAt, "Collector received a report that was not a JSON object.", processResult);
  const report = value;
  const errors: string[] = [];
  if (report.schemaVersion !== 1) errors.push(`unsupported report schema ${String(report.schemaVersion)}`);
  if (report.projectId !== project.id) errors.push("report project ID does not match planned run");
  if (report.scenarioId !== scenarioId) errors.push("report scenario ID does not match planned run");
  if (report.repetition !== repetition) errors.push("report repetition does not match planned run");
  if (report.runAttemptId !== expectedRunAttemptId) errors.push("report run-attempt ID does not match planned context");
  if (report.measurementMethod !== measurement.method || report.measurementVersion !== measurement.version || report.measurementSha256 !== measurement.sha256) errors.push("report measurement method/version/hash does not match run spec");
  if (report.instrumentationMode !== expectedInstrumentationMode) errors.push("report instrumentation mode does not match the runner context");
  if (report.generationProtocol !== project.generationProtocol) errors.push(`wrong generation protocol ${String(report.generationProtocol)}`);
  if (report.productOutcome === "success") {
    if (typeof report.generationId !== "string" || !report.generationId || report.currentGenerationId !== report.generationId) errors.push("wrong generation identity");
    if (typeof report.sourceRevision !== "string" || report.sourceRevision !== project.sourceRevision || report.currentSourceRevision !== report.sourceRevision) errors.push("wrong pinned source revision");
    if (!isNonNegativeInteger(report.userRevision) || report.detailUserRevision !== report.userRevision) errors.push("wrong user revision");
  } else {
    const generationIsAbsent = report.generationId === null && report.currentGenerationId === null;
    const generationMatches = typeof report.generationId === "string" && Boolean(report.generationId) && report.currentGenerationId === report.generationId;
    if (!generationIsAbsent && !generationMatches) errors.push("partial or mismatched generation identity on product failure");
    if (report.sourceRevision !== null && report.sourceRevision !== project.sourceRevision) errors.push("wrong pinned source revision");
    if (report.currentSourceRevision !== null && report.currentSourceRevision !== project.sourceRevision) errors.push("wrong current source revision");
    if (report.sourceRevision !== null && report.currentSourceRevision !== null && report.sourceRevision !== report.currentSourceRevision) errors.push("source revision changed during product failure");
    if (report.userRevision === null) {
      if (report.detailUserRevision !== null) errors.push("detail revision exists without a UI user revision");
    } else if (!isNonNegativeInteger(report.userRevision) ||
      report.detailUserRevision !== null && report.detailUserRevision !== report.userRevision) {
      errors.push("invalid user revision on product failure");
    }
  }
  if (!isTimestampValue(report.startedAt) || !isTimestampValue(report.endedAt) || Date.parse(String(report.endedAt)) < Date.parse(String(report.startedAt))) errors.push("invalid start/end timestamps");
  if (report.productOutcome !== "success" && report.productOutcome !== "failure") errors.push("missing product outcome");
  if (report.productOutcome === "failure" && (typeof report.failureStage !== "string" || !report.failureStage || typeof report.error !== "string" || !report.error)) errors.push("product failure omitted its stage or error");
  if (report.productOutcome === "success" && processResult.code !== 0) errors.push(`successful product report exited ${processResult.code ?? processResult.signal ?? "without status"}`);
  if (!isRecord(report.metrics) || !isNumberMap(report.metrics)) errors.push("malformed metrics map");
  if (!isRecord(report.unavailableMetrics) || !isStringMap(report.unavailableMetrics)) errors.push("malformed unavailableMetrics map");
  if (report.qualityEvidence !== undefined && !isRecord(report.qualityEvidence)) errors.push("malformed quality evidence map");
  const sourceInventoryValidation = isRecord(report.qualityEvidence) && isRecord(report.qualityEvidence.sourceInventoryValidation)
    ? report.qualityEvidence.sourceInventoryValidation
    : undefined;
  if (!sourceInventoryValidation || sourceInventoryValidation.entryVerified !== true || sourceInventoryValidation.exitVerified !== true ||
    sourceInventoryValidation.entriesVerified !== project.inventoryEntries.length) {
    errors.push("source inventory was not verified at both measurement boundaries");
  }
  const typedReport = report as unknown as MeasurementReport;
  validateUiReadyEvidence(typedReport, errors);
  const metrics = isNumberMap(report.metrics) ? report.metrics : {};
  const unavailable = isStringMap(report.unavailableMetrics) ? report.unavailableMetrics : {};
  for (const metric of [...REQUIRED_METRICS, ...OPTIONAL_METRICS]) {
    if (metric in metrics && (!Number.isFinite(metrics[metric]) || metrics[metric] < 0)) errors.push(`invalid metric ${metric}`);
    if (metric in unavailable && (!unavailable[metric] || typeof unavailable[metric] !== "string")) errors.push(`missing reason for ${metric}`);
  }
  for (const metric of REQUIRED_METRICS) {
    const value = metrics[metric];
    if (typeof value === "number") continue;
    if (!unavailable[metric]) errors.push(`unexplained missing metric ${metric}`);
  }
  for (const metric of Object.keys(metrics)) {
    if (![...REQUIRED_METRICS, ...OPTIONAL_METRICS].includes(metric as RequiredMetric | (typeof OPTIONAL_METRICS)[number])) {
      errors.push(`unknown metric ${metric}`);
    }
  }
  if (processResult.timedOut) errors.push(processResult.timeoutMessage ?? "measurement process timed out");
  if (errors.length > 0) {
    return {
      projectId: project.id,
      scenarioId,
      repetition,
      language: project.language,
      ...projectEvidenceFields(project),
      sizeBand: project.sizeBand,
      split: project.split,
      measurementValid: false,
      productOutcome: processResult.timedOut ? "unknown" : isProductOutcome(report.productOutcome) ? report.productOutcome : "unknown",
      failureStage: "collector",
      error: [...errors, typeof report.error === "string" ? report.error : undefined].filter(Boolean).join("; "),
      startedAt: isTimestampValue(report.startedAt) ? String(report.startedAt) : collectionStartedAt,
      endedAt: isTimestampValue(report.endedAt) ? String(report.endedAt) : new Date().toISOString(),
      metrics,
      unavailableMetrics: unavailable,
      qualityEvidence: isRecord(report.qualityEvidence) ? report.qualityEvidence : undefined,
      generationId: typeof report.generationId === "string" ? report.generationId : undefined,
      generationProtocol: typeof report.generationProtocol === "number" ? report.generationProtocol : undefined,
      sourceRevision: typeof report.sourceRevision === "string" ? report.sourceRevision : undefined,
      userRevision: typeof report.userRevision === "number" ? report.userRevision : undefined,
      processExitCode: processResult.code,
      processSignal: processResult.signal
    };
  }
  return {
    projectId: project.id,
    scenarioId,
    repetition,
    language: project.language,
    ...projectEvidenceFields(project),
    sizeBand: project.sizeBand,
    split: project.split,
    measurementValid: true,
    productOutcome: report.productOutcome as ProductOutcome,
    failureStage: typeof report.failureStage === "string" ? report.failureStage : undefined,
    error: typeof report.error === "string" ? report.error : undefined,
    startedAt: String(report.startedAt),
    endedAt: String(report.endedAt),
    metrics,
    unavailableMetrics: unavailable,
    qualityEvidence: isRecord(report.qualityEvidence) ? report.qualityEvidence : undefined,
    generationId: String(report.generationId),
    generationProtocol: Number(report.generationProtocol),
    sourceRevision: String(report.sourceRevision),
    userRevision: Number(report.userRevision),
    processExitCode: processResult.code,
    processSignal: processResult.signal
  };
}

function validateUiReadyEvidence(report: MeasurementReport, errors: string[]): void {
  const milestones = ["workspaceInteractive", "clickableGraph", "detailReady"] as const;
  const failureOrder = ["sourceInventory", "sourceRevision", "scenarioSetup", "appStartup", "projectSelection", "scan", "semanticAnalysis", "clustering", "layout", "commit", "analysis", "ipcReceipt", "workspaceInteractive", "clickableGraph", "detailReady", "currentIdentity", "processTreeRss"];
  const failureAliases: Record<string, string> = {
    appStartupMs: "appStartup", projectSelectionMs: "projectSelection", scanMs: "scan",
    semanticAnalysisMs: "semanticAnalysis", clusteringMs: "clustering", layoutMs: "layout",
    commitMs: "commit", ipcReceiptMs: "ipcReceipt", workspaceInteractiveMs: "workspaceInteractive",
    clickableGraphMs: "clickableGraph", detailReadyMs: "detailReady"
  };
  const canonicalFailureStage = report.failureStage ? failureAliases[report.failureStage] ?? report.failureStage : undefined;
  const failureIndex = canonicalFailureStage ? failureOrder.indexOf(canonicalFailureStage) : -1;
  const milestoneFailureRanks = milestones.map((milestone) => failureOrder.indexOf(milestone));
  if (report.productOutcome === "failure" && failureIndex < 0) errors.push("product failure has an unknown failure stage");
  for (const [index, milestone] of milestones.entries()) {
    const signal = report.uiReadyEvidence?.[milestone];
    if (signal?.status === "ready") {
      if (signal.generationId !== report.generationId || signal.userRevision !== report.userRevision) {
        errors.push(`false UI-ready evidence: ${milestone} has the wrong generation or user revision`);
      }
      if (report.productOutcome === "failure" && failureIndex < milestoneFailureRanks[index]) {
        errors.push(`false UI-ready evidence: ${milestone} claims readiness after the recorded failure stage`);
      }
      continue;
    }
    if (signal?.status === "not-reached" && signal.reason && report.productOutcome === "failure" && failureIndex >= 0 && failureIndex <= milestoneFailureRanks[index]) continue;
    errors.push(`false UI-ready evidence: ${milestone} is not evidenced as ready or explained as not reached`);
  }
}

async function runMeasurementProcess(
  spec: BaselineRunSpec,
  contextPath: string,
  reportPath: string,
  instrumentationMode: InstrumentationMode
): Promise<MeasurementProcessResult> {
  const stdoutLog = await open(join(dirname(reportPath), "electron.stdout.log"), "wx");
  let stderrLog: Awaited<ReturnType<typeof open>>;
  try {
    stderrLog = await open(join(dirname(reportPath), "electron.stderr.log"), "wx");
  } catch (error) {
    await stdoutLog.close();
    throw error;
  }
  return await new Promise((resolveResult) => {
    let child: ReturnType<typeof spawn>;
    const externalStartedAtEpochMs = Date.now();
    const externalStartedAt = performance.now();
    const withExternalTiming = (result: Omit<MeasurementProcessResult, "externalStartedAtEpochMs" | "externalEndedAtEpochMs" | "externalDurationMs">): MeasurementProcessResult => {
      const externalEndedAtEpochMs = Date.now();
      return {
        ...result,
        externalStartedAtEpochMs,
        externalEndedAtEpochMs,
        externalDurationMs: Math.max(0, performance.now() - externalStartedAt)
      };
    };
    const processLaunchRequestedAtEpochMs = Date.now();
    try {
      child = spawn(spec.executablePath, [...spec.executableArgs, "--flowweave-static-graph-measurement", "--run-context", contextPath, "--report", reportPath], {
        env: {
          ...process.env,
          FLOWWEAVE_STATIC_GRAPH_RUN_CONTEXT: contextPath,
          FLOWWEAVE_STATIC_GRAPH_REPORT: reportPath,
          FLOWWEAVE_STATIC_GRAPH_PROCESS_LAUNCH_REQUEST_EPOCH_MS: String(processLaunchRequestedAtEpochMs),
          FLOWWEAVE_STATIC_GRAPH_INSTRUMENTATION_MODE: instrumentationMode
        },
        stdio: ["ignore", stdoutLog.fd, stderrLog.fd],
        windowsHide: true
      });
    } catch (error) {
      void Promise.all([stdoutLog.close(), stderrLog.close()]).then(() => resolveResult(withExternalTiming({
        code: null, signal: null, error: error instanceof Error ? error.message : String(error), timedOut: false
      })), (closeError: unknown) => resolveResult(withExternalTiming({
        code: null, signal: null,
        error: [error instanceof Error ? error.message : String(error), `Could not close measurement process logs: ${closeError instanceof Error ? closeError.message : String(closeError)}`].join("; "),
        timedOut: false
      })));
      return;
    }
    let settled = false;
    let timedOut = false;
    let timeoutEscalated = false;
    let timeoutMessage: string | undefined;
    const finish = (result: Omit<MeasurementProcessResult, "externalStartedAtEpochMs" | "externalEndedAtEpochMs" | "externalDurationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (finalizeTimer) clearTimeout(finalizeTimer);
      void Promise.all([stdoutLog.close(), stderrLog.close()]).then(() => resolveResult(withExternalTiming(result)), (error: unknown) => resolveResult(withExternalTiming({
        ...result,
        error: [result.error, `Could not close measurement process logs: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join("; ")
      })));
    };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finalizeTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutMessage = `Measurement process timed out after ${spec.processTimeoutMs} ms; sent SIGTERM.`;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        timeoutEscalated = true;
        timeoutMessage = `${timeoutMessage} Process ignored SIGTERM; sent SIGKILL after ${spec.killGraceMs} ms.`;
        child.kill("SIGKILL");
        finalizeTimer = setTimeout(() => finish({
          code: null,
          signal: "SIGKILL",
          timedOut: true,
          timeoutEscalated,
          timeoutMessage
        }), 1_000);
      }, spec.killGraceMs);
    }, spec.processTimeoutMs);
    child.once("error", (error) => {
      finish({ code: null, signal: null, error: error.message, timedOut, timeoutEscalated, timeoutMessage });
    });
    child.once("exit", (code, signal) => {
      finish({ code, signal, timedOut, timeoutEscalated, timeoutMessage });
    });
  });
}

function parseContract(value: unknown): Contract {
  if (!isRecord(value)) throw new Error("Incomplete frozen contract: expected a JSON object.");
  const candidate = value;
  if (candidate.schemaVersion !== 1 || candidate.status !== "frozen" || !Number.isInteger(candidate.generationProtocol)) {
    throw new Error("Incomplete frozen contract: schema, frozen status, and generation protocol are required.");
  }
  const samples = parseContractSamples(candidate.samples);
  const supportedScope = parseSupportedScope(candidate.supportedScope);
  const scenarios = parseContractScenarios(candidate.scenarios);
  const qualityGates = parseQualityGates(candidate.qualityGates, supportedScope.languages);
  const resourceBudgets = parseResourceBudgets(candidate.resourceBudgets);
  if (!isRecord(candidate.measurement) || typeof candidate.measurement.method !== "string" || !candidate.measurement.method.trim() ||
    typeof candidate.measurement.version !== "string" || !candidate.measurement.version.trim() || !isSha256(candidate.measurement.sha256)) {
    throw new Error("Incomplete frozen contract: measurement method, version, and SHA-256 are required.");
  }
  if (candidate.osCacheState !== "cleared" && candidate.osCacheState !== "not-cleared" && candidate.osCacheState !== "unknown") {
    throw new Error("Incomplete frozen contract: explicit OS-cache state is required.");
  }
  return {
    schemaVersion: 1,
    status: "frozen",
    generationProtocol: Number(candidate.generationProtocol),
    samples,
    supportedScope,
    scenarios,
    qualityGates,
    resourceBudgets,
    measurement: { method: candidate.measurement.method, version: candidate.measurement.version, sha256: candidate.measurement.sha256 },
    osCacheState: candidate.osCacheState
  };
}

function parseContractSamples(value: unknown): Contract["samples"] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Incomplete frozen contract: sample IDs and splits are required.");
  const samples = value.map((sample) => {
    if (!isRecord(sample) || typeof sample.id !== "string" || !sample.id ||
      (sample.split !== "development" && sample.split !== "holdout") || typeof sample.commit !== "string" || !/^[a-f0-9]{40,64}$/i.test(sample.commit) ||
      typeof sample.treeOid !== "string" || !/^[a-f0-9]{40,64}$/i.test(sample.treeOid)) {
      throw new Error("Incomplete frozen contract: every sample needs an ID, split, pinned commit, and Git tree identity.");
    }
    return { id: sample.id, split: sample.split as CorpusProject["split"], commit: sample.commit, treeOid: sample.treeOid };
  });
  if (new Set(samples.map((sample) => sample.id)).size !== samples.length) throw new Error("Incomplete frozen contract: sample IDs must be unique.");
  return samples;
}

function parseSupportedScope(value: unknown): SupportedScope {
  if (!isRecord(value)) throw new Error("Incomplete frozen contract: supported scope is required.");
  const languages = uniqueStringArray(value.languages);
  const projectKinds = uniqueStringArray(value.projectKinds);
  const sizeBands = uniqueStringArray(value.sizeBands) as ProjectSizeBand[];
  if (!languages.length || !projectKinds.length || !sizeBands.length || sizeBands.some((size) => !["small", "medium", "large"].includes(size))) {
    throw new Error("Incomplete frozen contract: supported languages, project kinds, and size bands are required.");
  }
  return { languages, projectKinds, sizeBands };
}

function parseContractScenarios(value: unknown): Contract["scenarios"] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Incomplete frozen contract: scenario IDs and repetition counts are required.");
  const scenarios = value.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id || !Number.isInteger(entry.repetitions) || Number(entry.repetitions) < 20 ||
      (entry.availability !== "available" && entry.availability !== "incomplete") || !isRecord(entry.performanceBudgets)) {
      throw new Error("Incomplete frozen contract: each scenario needs an ID, availability, repetitions, and performance budgets.");
    }
    const performanceBudgets: Contract["scenarios"][number]["performanceBudgets"] = {};
    for (const sizeBand of ["small", "medium", "large"] as const) {
      const sizeBudgets = entry.performanceBudgets[sizeBand];
      if (!isRecord(sizeBudgets)) throw new Error(`Incomplete frozen contract: missing ${sizeBand} performance budgets.`);
      const metricBudgets: Partial<Record<RequiredMetric, PerformanceBudget>> = {};
      for (const metric of REQUIRED_METRICS) {
        const budget = sizeBudgets[metric];
        if (!isRecord(budget) || !isNonNegativeNumber(budget.p95Max) || !isRecord(budget.baselineP95MsByProject) ||
          !isNonNegativeNumber(budget.baselineMaxRatio) || budget.baselineMaxRatio < 1) {
          throw new Error(`Incomplete frozen contract: ${entry.id}/${sizeBand} requires absolute and baseline-relative budget for ${metric}.`);
        }
        const baselineP95MsByProject: Record<string, number> = {};
        for (const [projectId, baselineP95Ms] of Object.entries(budget.baselineP95MsByProject)) {
          if (!projectId || !isNonNegativeNumber(baselineP95Ms) || baselineP95Ms === 0) {
            throw new Error(`Incomplete frozen contract: ${entry.id}/${sizeBand} has an invalid per-project baseline for ${metric}.`);
          }
          baselineP95MsByProject[projectId] = baselineP95Ms;
        }
        metricBudgets[metric] = { p95Max: budget.p95Max, baselineP95MsByProject, baselineMaxRatio: budget.baselineMaxRatio };
      }
      performanceBudgets[sizeBand] = metricBudgets;
    }
    return {
      id: entry.id,
      repetitions: Number(entry.repetitions),
      availability: entry.availability as RunAvailability,
      performanceBudgets
    };
  });
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) throw new Error("Incomplete frozen contract: scenario IDs must be unique.");
  return scenarios;
}

function parseQualityGates(value: unknown, languages: string[]): Contract["qualityGates"] {
  if (!isRecord(value)) throw new Error("Incomplete frozen contract: quality gates are required.");
  const callPrecisionByLanguage = parseLanguageThresholds(value.callPrecisionByLanguage, languages, "call precision", 0.98, 1);
  const staticCallRecallByLanguage = parseLanguageThresholds(value.staticCallRecallByLanguage, languages, "static-call recall", 0.9, 1);
  if (!isRecord(value.moduleQualityByDimensionMin)) throw new Error("Incomplete frozen contract: all four module-quality dimensions need thresholds.");
  const moduleQualityByDimensionMin = {} as Contract["qualityGates"]["moduleQualityByDimensionMin"];
  for (const dimension of MODULE_QUALITY_DIMENSIONS) {
    const threshold = value.moduleQualityByDimensionMin[dimension];
    if (!isNonNegativeNumber(threshold) || threshold < 4 || threshold > 5) throw new Error(`Incomplete frozen contract: module quality ${dimension} needs a 1-5 scale gate of at least 4.`);
    moduleQualityByDimensionMin[dimension] = threshold;
  }
  const nonNegativeKeys = ["identityErrorsMax", "userDataLossMax", "mixedGenerationMax", "duplicateReviewItemsMax"] as const;
  for (const key of nonNegativeKeys) if (!isNonNegativeNumber(value[key])) throw new Error(`Incomplete frozen contract: missing quality gate ${key}.`);
  if (nonNegativeKeys.some((key) => value[key] !== 0) || !isNonNegativeNumber(value.unresolvedCallRatioMax) || value.unresolvedCallRatioMax > 1 || !isRecord(value.labelEvidenceBySplit)) {
    throw new Error("Incomplete frozen contract: unresolved-call, zero identity/data-loss/mixed-generation/duplicate limits, and split label evidence are required.");
  }
  const development = parseLabelEvidence(value.labelEvidenceBySplit.development, languages, "development");
  const holdout = parseLabelEvidence(value.labelEvidenceBySplit.holdout, languages, "holdout");
  if (development.sha256 === holdout.sha256) throw new Error("Incomplete frozen contract: holdout labels must have an independent dataset hash.");
  if (development.reviewerIds.some((reviewerId) => holdout.reviewerIds.includes(reviewerId))) {
    throw new Error("Incomplete frozen contract: holdout labels require reviewers independent from development labels.");
  }
  return {
    callPrecisionByLanguage,
    staticCallRecallByLanguage,
    moduleQualityByDimensionMin,
    unresolvedCallRatioMax: Number(value.unresolvedCallRatioMax),
    identityErrorsMax: Number(value.identityErrorsMax),
    userDataLossMax: Number(value.userDataLossMax),
    mixedGenerationMax: Number(value.mixedGenerationMax),
    duplicateReviewItemsMax: Number(value.duplicateReviewItemsMax),
    labelEvidenceBySplit: { development, holdout }
  };
}

function parseLabelEvidence(value: unknown, languages: string[], split: string): Contract["qualityGates"]["labelEvidenceBySplit"]["development"] {
  if (!isRecord(value) || !isSha256(value.sha256) || !Array.isArray(value.reviewerIds) || value.reviewerIds.length < 2 ||
    value.reviewerIds.some((reviewer) => typeof reviewer !== "string" || !reviewer.trim()) || new Set(value.reviewerIds).size !== value.reviewerIds.length) {
    throw new Error(`Incomplete frozen contract: ${split} labels require a dataset hash and two independent reviewer IDs.`);
  }
  const eligible = parseLanguageCounts(value.eligibleCallSitesByLanguage, languages, `${split} eligible call sites`);
  const annotated = parseLanguageCounts(value.annotatedCallSitesByLanguage, languages, `${split} annotated call sites`);
  const exhaustive = uniqueStringArray(value.exhaustiveLanguages);
  for (const language of languages) {
    if (annotated[language] > eligible[language] || annotated[language] === 0 ||
      (annotated[language] < 100 && (!exhaustive.includes(language) || annotated[language] !== eligible[language]))) {
      throw new Error(`Incomplete frozen contract: ${split} labels for ${language} require 100 calls or a complete-population annotation.`);
    }
  }
  return { sha256: value.sha256, reviewerIds: value.reviewerIds as string[], eligibleCallSitesByLanguage: eligible, annotatedCallSitesByLanguage: annotated, exhaustiveLanguages: exhaustive };
}

function parseLanguageCounts(value: unknown, languages: string[], description: string): Record<string, number> {
  if (!isRecord(value) || !sameStringSet(Object.keys(value), languages) || Object.values(value).some((count) => !Number.isInteger(count) || Number(count) < 0)) {
    throw new Error(`Incomplete frozen contract: ${description} needs a count for every supported language.`);
  }
  return Object.fromEntries(Object.entries(value).map(([language, count]) => [language, Number(count)]));
}

function parseLanguageThresholds(value: unknown, languages: string[], name: string, minimum: number, maximum: number): Record<string, number> {
  if (!isRecord(value) || !sameStringSet(Object.keys(value), languages) || Object.values(value).some((item) => !isNonNegativeNumber(item) || item < minimum || item > maximum)) {
    throw new Error(`Incomplete frozen contract: ${name} thresholds must cover every supported language.`);
  }
  return value as Record<string, number>;
}

function parseResourceBudgets(value: unknown): Contract["resourceBudgets"] {
  if (!isRecord(value)) throw new Error("Incomplete frozen contract: per-size resource budgets are required.");
  const required: Array<{ metric: OptionalMetric; mode: "max" | "p95Max" }> = [
    { metric: "processTreePeakRssMiB", mode: "max" }, { metric: "firstScreenIpcBytes", mode: "max" },
    { metric: "cacheResidentBytes", mode: "max" }, { metric: "rendererLongTaskCount", mode: "max" },
    { metric: "rendererLongTaskTotalMs", mode: "max" }, { metric: "rendererLongTaskMaxMs", mode: "max" },
    { metric: "cancellationUiResponseMs", mode: "p95Max" }, { metric: "backgroundTaskExitMs", mode: "max" }
  ];
  const budgets: Contract["resourceBudgets"] = {};
  for (const sizeBand of ["small", "medium", "large"] as const) {
    const entry = value[sizeBand];
    if (!isRecord(entry)) throw new Error(`Incomplete frozen contract: missing ${sizeBand} full-process resource budgets.`);
    const parsed: Partial<Record<OptionalMetric, { max?: number; p95Max?: number }>> = {};
    for (const { metric, mode } of required) {
      const rawBudget = entry[metric];
      const valueKey = mode === "max" ? "max" : "p95Max";
      if (!isRecord(rawBudget) || !isNonNegativeNumber(rawBudget[valueKey])) throw new Error(`Incomplete frozen contract: missing ${sizeBand} ${metric} resource budget.`);
      parsed[metric] = mode === "max" ? { max: rawBudget.max as number } : { p95Max: rawBudget.p95Max as number };
    }
    budgets[sizeBand] = parsed;
  }
  return budgets;
}

function validateContractBinding(contract: Contract, corpus: CorpusFile, spec: AcceptanceRunSpec): void {
  const contractSamples = contract.samples.map(({ id, split, commit, treeOid }) => `${id}\u0000${split}\u0000${commit}\u0000${treeOid}`).sort();
  const corpusSamples = corpus.projects.map(({ id, split, sourceRevision, sourceTreeOid }) => `${id}\u0000${split}\u0000${sourceRevision}\u0000${sourceTreeOid}`).sort();
  if (!sameStringArray(contractSamples, corpusSamples)) throw new Error("Acceptance contract sample ID/split/revision set mismatch with corpus.");
  if (!sameStringSet(spec.supportedScope.languages, contract.supportedScope.languages) ||
    !sameStringSet(spec.supportedScope.projectKinds, contract.supportedScope.projectKinds) ||
    !sameStringSet(spec.supportedScope.sizeBands, contract.supportedScope.sizeBands)) {
    throw new Error("Acceptance contract supported scope mismatch with run spec.");
  }
  if (!sameStringSet([...new Set(corpus.projects.flatMap((project) => project.languages))], contract.supportedScope.languages) ||
    !sameStringSet([...new Set(corpus.projects.flatMap((project) => project.projectKinds))], contract.supportedScope.projectKinds) ||
    !sameStringSet([...new Set(corpus.projects.map((project) => project.sizeBand))], contract.supportedScope.sizeBands)) {
    throw new Error("Acceptance contract supported scope does not exactly match corpus coverage.");
  }
  for (const project of corpus.projects) {
    if (project.sizeBand === "unclassified") throw new Error(`Acceptance requires a registered scale stratum: ${project.id}.`);
    if (project.generationProtocol !== contract.generationProtocol || project.languages.some((language) => !contract.supportedScope.languages.includes(language)) ||
      project.projectKinds.some((kind) => !contract.supportedScope.projectKinds.includes(kind)) || !contract.supportedScope.sizeBands.includes(project.sizeBand)) {
      throw new Error(`Acceptance contract scope or generation protocol mismatch for sample ${project.id}.`);
    }
  }
  for (const scenario of contract.scenarios) {
    for (const sizeBand of contract.supportedScope.sizeBands) {
      const expectedProjectIds = corpus.projects.filter((project) => project.sizeBand === sizeBand).map((project) => project.id);
      for (const metric of REQUIRED_METRICS) {
        const budget = scenario.performanceBudgets[sizeBand]?.[metric];
        if (!budget || !sameStringSet(Object.keys(budget.baselineP95MsByProject), expectedProjectIds)) {
          throw new Error(`Acceptance contract needs an exact per-project baseline for ${scenario.id}/${sizeBand}/${metric}.`);
        }
      }
    }
  }
  for (const language of contract.supportedScope.languages) {
    for (const split of ["development", "holdout"] as const) {
      if (!corpus.projects.some((project) => project.languages.includes(language) && project.split === split)) {
        throw new Error(`Acceptance corpus is missing ${split} samples for supported language ${language}.`);
      }
    }
  }
  const specScenarios = [...spec.scenarios].sort((left, right) => left.id.localeCompare(right.id));
  const contractScenarios = [...contract.scenarios].sort((left, right) => left.id.localeCompare(right.id));
  if (specScenarios.length !== contractScenarios.length || specScenarios.some((scenario, index) => {
    const frozen = contractScenarios[index];
    return scenario.id !== frozen.id || scenario.availability !== frozen.availability || spec.repetitions !== frozen.repetitions;
  })) throw new Error("Acceptance contract scenario IDs, availability, or repetition counts mismatch with run spec.");
  if (contractScenarios.some((scenario) => scenario.availability !== "available")) throw new Error("Incomplete frozen contract: all formal-acceptance scenarios must have real fixtures.");
  if (contract.osCacheState !== spec.osCacheState) throw new Error("Acceptance contract OS-cache state mismatch with run spec.");
  if (contract.measurement.method !== spec.measurement.method || contract.measurement.version !== spec.measurement.version || contract.measurement.sha256 !== spec.measurement.sha256) {
    throw new Error("Acceptance contract measurement method/version/hash mismatch with run spec.");
  }
}

function evaluatePerformanceBudgets(runs: RunRecord[], contract: Contract): AcceptanceRunResult["thresholdResults"] {
  const results: AcceptanceRunResult["thresholdResults"] = {};
  for (const scenario of contract.scenarios) {
    for (const sizeBand of contract.supportedScope.sizeBands) {
      const scopedRuns = runs.filter((run) => run.scenarioId === scenario.id && run.sizeBand === sizeBand);
      for (const metric of REQUIRED_METRICS) {
        const budget = scenario.performanceBudgets[sizeBand]?.[metric];
        if (!budget) continue;
        const key = `${scenario.id}/${sizeBand}/${metric}`;
        const projectIds = [...new Set(scopedRuns.map((run) => run.projectId))];
        const perProject: AcceptanceRunResult["thresholdResults"][string]["perProject"] = {};
        for (const projectId of projectIds) {
          const projectValues = scopedRuns.filter((run) => run.projectId === projectId)
            .map((run) => run.metrics[metric]).filter((value): value is number => typeof value === "number");
          const p95 = projectValues.length > 0 ? nearestRank(projectValues, 0.95) : null;
          const baselineP95 = budget.baselineP95MsByProject[projectId];
          const maximum = Math.min(budget.p95Max, baselineP95 * budget.baselineMaxRatio);
          perProject[projectId] = {
            p95,
            sampleCount: projectValues.length,
            plannedCount: scenario.repetitions,
            maximum,
            baselineP95,
            baselineRatioMaximum: budget.baselineMaxRatio,
            passed: projectValues.length === scenario.repetitions && p95 !== null && p95 <= budget.p95Max && p95 <= baselineP95 * budget.baselineMaxRatio
          };
        }
        const projectP95s = Object.values(perProject).map((result) => result.p95).filter((value): value is number => value !== null);
        results[key] = {
          p95: projectP95s.length === 0 ? null : Math.max(...projectP95s),
          sampleCount: Object.values(perProject).reduce((sum, result) => sum + result.sampleCount, 0),
          plannedCount: projectIds.length * scenario.repetitions,
          maximum: budget.p95Max,
          passed: projectIds.length > 0 && Object.values(perProject).length === projectIds.length && Object.values(perProject).every((result) => result.passed),
          perProject
        };
      }
    }
  }
  return results;
}

function evaluateQualityGates(runs: RunRecord[], contract: Contract): AcceptanceRunResult["qualityResults"] {
  const results: AcceptanceRunResult["qualityResults"] = {};
  const gates = contract.qualityGates;
  const labelIdentityPasses = runs.length > 0 && runs.every((run) => {
    if (!isRecord(run.qualityEvidence)) return false;
    const expected = gates.labelEvidenceBySplit[run.split];
    return run.qualityEvidence.labelDatasetSha256 === expected.sha256 && sameStringSetFromUnknown(run.qualityEvidence.reviewerIds, expected.reviewerIds);
  });
  results.labelDatasetIdentity = { observed: labelIdentityPasses ? 1 : null, maximum: 1, passed: labelIdentityPasses };
  for (const language of contract.supportedScope.languages) {
    const languageRuns = runs.filter((run) => run.languages.includes(language));
    const precisionValues = languageRuns.map((run) => qualityLanguageValue(run.qualityEvidence, "callPrecisionByLanguage", language));
    const recallValues = languageRuns.map((run) => qualityLanguageValue(run.qualityEvidence, "staticCallRecallByLanguage", language));
    const precision = meanOrNull(precisionValues);
    const recall = meanOrNull(recallValues);
    results[`callPrecision/${language}`] = { observed: precision, maximum: gates.callPrecisionByLanguage[language], passed: precision !== null && precision >= gates.callPrecisionByLanguage[language] };
    results[`staticCallRecall/${language}`] = { observed: recall, maximum: gates.staticCallRecallByLanguage[language], passed: recall !== null && recall >= gates.staticCallRecallByLanguage[language] };
  }
  for (const dimension of MODULE_QUALITY_DIMENSIONS) {
    const minimum = gates.moduleQualityByDimensionMin[dimension];
    const projectMeans = [...new Set(runs.map((run) => run.projectId))].map((projectId) => {
      const projectRuns = runs.filter((run) => run.projectId === projectId);
      const mean = meanOrNull(projectRuns.map((run) => qualityLanguageValue(run.qualityEvidence, "moduleQualityByDimension", dimension)));
      results[`project/${projectId}/moduleQuality/${dimension}`] = { observed: mean, maximum: minimum, passed: mean !== null && mean >= minimum };
      return mean;
    });
    const worstProjectMean = projectMeans.length > 0 && projectMeans.every((value): value is number => value !== null)
      ? Math.min(...projectMeans as number[])
      : null;
    results[`moduleQuality/${dimension}`] = {
      observed: worstProjectMean,
      maximum: minimum,
      passed: projectMeans.length > 0 && projectMeans.every((value) => value !== null && value >= minimum)
    };
  }
  results.unresolvedCallRatio = compareQuality(runs, "unresolvedCallRatio", "max", gates.unresolvedCallRatioMax);
  results.identityErrors = compareQuality(runs, "identityErrors", "max", gates.identityErrorsMax);
  results.userDataLoss = compareQuality(runs, "userDataLoss", "max", gates.userDataLossMax);
  results.mixedGeneration = compareQuality(runs, "mixedGeneration", "max", gates.mixedGenerationMax);
  results.duplicateReviewItems = compareQuality(runs, "duplicateReviewItems", "max", gates.duplicateReviewItemsMax);
  return results;
}

function evaluateResourceBudgets(runs: RunRecord[], _corpus: CorpusFile, contract: Contract): AcceptanceRunResult["resourceResults"] {
  const results: AcceptanceRunResult["resourceResults"] = {};
  const required: Array<{ metric: OptionalMetric; aggregation: "max" | "p95" }> = [
    { metric: "processTreePeakRssMiB", aggregation: "max" }, { metric: "firstScreenIpcBytes", aggregation: "max" },
    { metric: "cacheResidentBytes", aggregation: "max" }, { metric: "rendererLongTaskCount", aggregation: "max" },
    { metric: "rendererLongTaskTotalMs", aggregation: "max" }, { metric: "rendererLongTaskMaxMs", aggregation: "max" },
    { metric: "cancellationUiResponseMs", aggregation: "p95" }, { metric: "backgroundTaskExitMs", aggregation: "max" }
  ];
  for (const sizeBand of contract.supportedScope.sizeBands) {
    const scopedRuns = runs.filter((run) => run.sizeBand === sizeBand);
    const projectIds = [...new Set(scopedRuns.map((run) => run.projectId))];
    for (const { metric, aggregation } of required) {
      const budget = contract.resourceBudgets[sizeBand]?.[metric];
      const maximum = aggregation === "p95" ? budget?.p95Max : budget?.max;
      if (maximum === undefined) continue;
      const perProject: AcceptanceRunResult["resourceResults"][string]["perProject"] = {};
      for (const projectId of projectIds) {
        const projectValues = scopedRuns.filter((run) => run.projectId === projectId)
          .map((run) => run.metrics[metric]).filter((value): value is number => typeof value === "number");
        const observed = projectValues.length === 0 ? null : aggregation === "p95" ? nearestRank(projectValues, 0.95) : Math.max(...projectValues);
        const plannedCount = contract.scenarios.reduce((sum, scenario) => sum + scenario.repetitions, 0);
        perProject[projectId] = {
          observed,
          sampleCount: projectValues.length,
          plannedCount,
          passed: projectValues.length === plannedCount && observed !== null && observed <= maximum
        };
      }
      const projectObservations = Object.values(perProject).map((result) => result.observed).filter((value): value is number => value !== null);
      results[`${sizeBand}/${metric}`] = {
        observed: projectObservations.length === 0 ? null : Math.max(...projectObservations),
        sampleCount: Object.values(perProject).reduce((sum, result) => sum + result.sampleCount, 0),
        maximum,
        aggregation,
        passed: projectIds.length > 0 && Object.values(perProject).length === projectIds.length && Object.values(perProject).every((result) => result.passed),
        perProject
      };
    }
  }
  return results;
}

function compareQuality(runs: RunRecord[], key: string, mode: "min" | "max", maximum: number): AcceptanceRunResult["qualityResults"][string] {
  const values = runs.map((run) => qualityValue(run.qualityEvidence, key)).filter((value): value is number => value !== null);
  const observed = mode === "min" ? meanOrNull(values) : values.length > 0 ? Math.max(...values) : null;
  return { observed, maximum, passed: values.length === runs.length && observed !== null && (mode === "min" ? observed >= maximum : observed <= maximum) };
}

function qualityLanguageValue(evidence: unknown, key: string, language: string): number | null {
  if (!isRecord(evidence) || !isRecord(evidence[key])) return null;
  const value = evidence[key][language];
  return isNonNegativeNumber(value) ? value : null;
}

function qualityValue(evidence: unknown, key: string): number | null {
  if (!isRecord(evidence) || !isNonNegativeNumber(evidence[key])) return null;
  return evidence[key];
}

function meanOrNull(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === values.length && present.length > 0 ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

function nearestRank(values: number[], percentile: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

function median(values: number[]): number {
  if (!values.length) throw new RangeError("Cannot summarize an empty instrumentation comparison.");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validateSpec(spec: BaselineRunSpec): void {
  if (!isRecord(spec) || !spec.corpusPath || !spec.executablePath || !spec.outputDirectory || !Array.isArray(spec.executableArgs) || !Array.isArray(spec.scenarios) || !spec.scenarios.length || !isRecord(spec.supportedScope) || !isRecord(spec.measurement) || !isRecord(spec.projectCheckouts)) {
    throw new Error("Spec must explicitly include corpus, executable, isolated output directory, private checkout map, executable arguments, and scenarios.");
  }
  if (!Number.isInteger(spec.repetitions) || spec.repetitions < 20) throw new Error("Baseline configuration requires at least 20 repetitions.");
  if (!Number.isFinite(spec.processTimeoutMs) || spec.processTimeoutMs < 1 || !Number.isFinite(spec.killGraceMs) || spec.killGraceMs < 1) throw new Error("Spec requires positive process timeout and SIGKILL grace intervals.");
  if (!new Set(["cleared", "not-cleared", "unknown"]).has(spec.osCacheState)) throw new Error("Spec must state the OS cache condition.");
  if (isAbsolute(spec.outputDirectory) === false) throw new Error("Spec output directory must be an explicit absolute isolated path.");
  if (!uniqueStringArray(spec.supportedScope.languages).length || !uniqueStringArray(spec.supportedScope.projectKinds).length || !uniqueStringArray(spec.supportedScope.sizeBands).length) throw new Error("Spec must state its supported language, project-kind, and size scope.");
  if (!Number.isInteger(spec.generationProtocol) || spec.generationProtocol < 1) throw new Error("Spec must state the generation protocol explicitly.");
  if (typeof spec.measurement.method !== "string" || !spec.measurement.method.trim() || typeof spec.measurement.version !== "string" || !spec.measurement.version.trim() || !isSha256(spec.measurement.sha256)) throw new Error("Spec must bind the measurement method, version, and SHA-256.");
  if (spec.scenarios.some((scenario) => !isRecord(scenario) || typeof scenario.id !== "string" || !scenario.id ||
    (scenario.availability !== "available" && scenario.availability !== "incomplete") || (scenario.availability === "incomplete" && (typeof scenario.reason !== "string" || !scenario.reason)))) {
    throw new Error("Each scenario must have an ID; incomplete scenarios must explain the missing real fixture.");
  }
  for (const scenario of spec.scenarios) {
    if (!STATIC_GRAPH_MEASUREMENT_SCENARIOS.some((id) => id === scenario.id)) throw new Error(`Unsupported measurement scenario: ${scenario.id}.`);
  }
  if (spec.sourceChangesByProject !== undefined && (!isRecord(spec.sourceChangesByProject) || Object.values(spec.sourceChangesByProject).some((change) => !isMeasurementSourceChange(change)))) {
    throw new TypeError("Incremental sourceChangesByProject entries require a safe selected path, a SHA-256 before hash, and explicit UTF-8 afterContent.");
  }
}

async function readCorpus(path: string, spec: BaselineRunSpec): Promise<CorpusFile> {
  const bytes = await readFile(path);
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isRecord(value) || !Array.isArray(value.repositories)) throw new Error("Corpus must use the registered repositories[] evidence schema.");
  const parsedCorpus = value;
  const projectEntries = parsedCorpus.repositories as unknown[];
  if (parsedCorpus.schemaVersion !== 1 || projectEntries.length === 0) throw new Error("Corpus schema is unsupported or has no repositories.");
  if (parsedCorpus.status !== "frozen") throw new Error(`Corpus metadata is not frozen (status=${String(parsedCorpus.status)}); resolve candidate selection before execution.`);
  const selection = parsedCorpus.selection;
  if (!isRecord(selection) || selection.identityFreezeStatus !== "frozen") throw new Error("Corpus selection identities are not frozen.");
  if (!isRecord(parsedCorpus.collectionPolicy) || parsedCorpus.collectionPolicy.holdoutAnalysisOutputsInspected !== false || parsedCorpus.collectionPolicy.holdoutAnalysisRunsPerformed !== false) {
    throw new Error("Corpus holdout analysis outputs or runs are not confirmed sealed before T11.");
  }
  if (!isRecord(selection.perLanguage)) throw new Error("Corpus selection must declare per-language sample counts.");
  const declaredLanguageCounts = Object.entries(selection.perLanguage).map(([language, counts]) => {
    if (!language.trim() || !isRecord(counts) || !isPositiveInteger(counts.total) ||
      !isNonNegativeInteger(counts.development) || !isNonNegativeInteger(counts.holdout)) {
      throw new Error(`Corpus selection has malformed declared counts for language ${language}.`);
    }
    if (counts.total !== counts.development + counts.holdout || counts.total < 2 || counts.development < 1 || counts.holdout < 1) {
      throw new Error(`Corpus language ${language} requires at least two samples, including development and holdout.`);
    }
    return { language, total: counts.total, development: counts.development, holdout: counts.holdout };
  });
  if (declaredLanguageCounts.length === 0) throw new Error("Corpus selection must declare at least one supported language.");
  const projects: CorpusProject[] = [];
  const corpusDirectory = dirname(resolve(path));
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const valueProject of projectEntries) {
    if (!isRecord(valueProject)) throw new Error("Corpus contains a malformed project entry.");
    const project = valueProject;
    if (typeof project.id !== "string" || !project.id || ids.has(project.id)) throw new Error(`Corpus has a missing or duplicate project ID: ${String(project.id)}.`);
    ids.add(project.id);
    if (project.status !== "acquired") throw new Error(`Corpus sample ${project.id} acquisition status is ${String(project.status)}; acquire the pinned source before execution.`);
    if ((project.split !== "development" && project.split !== "holdout") || typeof project.commit !== "string" || !/^[a-f0-9]{40}$/i.test(project.commit)) {
      throw new Error(`Corpus sample ${project.id} lacks its split or pinned 40-character commit.`);
    }
    const canonicalUrl = parseCanonicalRepositoryUrl(project.canonicalUrl, String(project.id));
    if (urls.has(canonicalUrl)) throw new Error(`Corpus sample ${project.id} has a duplicate canonical repository URL.`);
    urls.add(canonicalUrl);
    if (!isRecord(project.commitVerification) || project.commitVerification.status !== "verified") throw new Error(`Corpus sample ${project.id} does not have a verified pinned commit.`);
    if (!isRecord(project.license) || project.license.status !== "verified-primary-license-only" || !isSha256(project.license.contentSha256)) {
      throw new Error(`Corpus sample ${project.id} primary license metadata is unverified.`);
    }
    if (!isRecord(project.acquisition) || project.acquisition.ownerStatus !== "assigned" || typeof project.acquisition.owner !== "string" || !project.acquisition.owner.trim()) {
      throw new Error(`Corpus sample ${project.id} source acquisition owner is unassigned.`);
    }
    const checkoutTreeOid = project.acquisition.checkoutTreeOid;
    if (typeof checkoutTreeOid !== "string" || !/^[a-f0-9]{40}$/i.test(checkoutTreeOid)) {
      throw new Error(`Corpus sample ${project.id} acquisition is missing its registered checkoutTreeOid.`);
    }
    const collectionScope = project.collectionScope;
    if (!isRecord(collectionScope) || collectionScope.status !== "frozen" || !isStringArray(collectionScope.includePaths) || collectionScope.includePaths.length === 0 ||
      !isStringArray(collectionScope.excludePaths) || [...collectionScope.includePaths, ...collectionScope.excludePaths].some((scopePath) => !isSafeScopePath(scopePath))) {
      throw new Error(`Corpus sample ${project.id} collectionScope must use frozen POSIX exact file paths or directory prefixes; glob patterns are unsupported.`);
    }
    const inventory = project.sourceInventory;
    if (!isRecord(inventory) || inventory.status !== "complete" || !isSha256(inventory.contentHash) ||
      !isPositiveInteger(inventory.fileCount) || !isPositiveInteger(inventory.sourceFileCount) || inventory.sourceFileCount > inventory.fileCount ||
      !isPositiveInteger(inventory.sourceBytes) || !isIntegerMap(inventory.languageCounts) || Object.keys(inventory.languageCounts).some((language) => !language.trim()) ||
      typeof inventory.manifestPath !== "string" || !isSafeFilePath(inventory.manifestPath) || typeof inventory.manifestSha256 !== "string" || !isSha256(inventory.manifestSha256) ||
      Object.values(inventory.languageCounts).reduce((sum, count) => sum + count, 0) !== inventory.sourceFileCount) {
      throw new Error(`Corpus sample ${project.id} sourceInventory is pending; acquire and hash source files, counts, bytes, and language composition before execution.`);
    }
    const inventoryEntries = await readInventoryManifest(corpusDirectory, project.id, inventory.manifestPath, inventory.manifestSha256);
    validateInventorySummary(project.id, inventory, inventoryEntries);
    if (!isRecord(project.scale) || project.scale.status !== "frozen" || !["small", "medium", "large"].includes(String(project.scale.stratum)) ||
      typeof project.scale.thresholdContract !== "string" || !project.scale.thresholdContract.trim()) {
      throw new Error(`Corpus sample ${project.id} scale metadata is pending; freeze its measured size stratum and threshold contract before execution.`);
    }
    const roles = uniqueStringArray(project.roles);
    if (!roles.length || typeof project.primaryLanguage !== "string" || !project.primaryLanguage.trim() ||
      !declaredLanguageCounts.some(({ language }) => language === project.primaryLanguage)) throw new Error(`Corpus sample ${project.id} lacks a declared language or repository role.`);
    const languages = [...new Set(inventoryEntries.filter((entry) => entry.kind === "source").map((entry) => entry.language!))].sort();
    if (!languages.includes(project.primaryLanguage)) throw new Error(`Corpus sample ${project.id} primary language is absent from its source inventory.`);
    const checkoutPath = (specProjectPath: unknown): string => {
      if (typeof specProjectPath !== "string" || !isAbsolute(specProjectPath)) throw new Error(`Run spec needs an absolute private projectCheckouts entry for ${project.id}.`);
      return resolve(specProjectPath);
    };
    projects.push({
      id: project.id,
      path: checkoutPath(spec.projectCheckouts[project.id]),
      split: project.split as CorpusProject["split"],
      sourceRevision: project.commit,
      checkoutTreeOid,
      sourceTreeOid: "",
      generationProtocol: spec.generationProtocol,
      language: project.primaryLanguage,
      languages,
      projectKinds: roles,
      sizeBand: project.scale.stratum as ProjectSizeBand,
      selection: {
        sourcePaths: inventoryEntries.filter((entry) => entry.kind === "source").map((entry) => entry.path).sort(),
        configurationPaths: inventoryEntries.filter((entry) => entry.kind === "configuration").map((entry) => entry.path).sort(),
        scopeSha256: collectionScopeSha256(collectionScope.includePaths, collectionScope.excludePaths),
        sourceInventorySha256: inventory.manifestSha256.toLowerCase()
      },
      collectionScope: { includePaths: [...collectionScope.includePaths], excludePaths: [...collectionScope.excludePaths] },
      inventoryEntries
    });
  }
  const corpusLanguages = [...new Set(projects.flatMap((project) => project.languages))];
  if (!sameStringSet(uniqueStringArray(spec.supportedScope.languages), corpusLanguages)) {
    throw new Error("Run spec supported languages do not exactly match source-inventory language coverage.");
  }
  const developmentCount = projects.filter((project) => project.split === "development").length;
  const holdoutCount = projects.filter((project) => project.split === "holdout").length;
  if (projects.length < 12 || developmentCount < 8 || holdoutCount < 4) throw new Error(`Corpus needs at least 12 independent samples (8 development, 4 holdout); found ${projects.length} total, ${developmentCount} development, ${holdoutCount} holdout.`);
  if (selection.repositoryCount !== projects.length || selection.developmentCount !== developmentCount || selection.holdoutCount !== holdoutCount) {
    throw new Error("Corpus frozen selection counts do not match its repository entries.");
  }
  for (const declared of declaredLanguageCounts) {
    const languageProjects = projects.filter((project) => project.language === declared.language);
    const languageDevelopmentCount = languageProjects.filter((project) => project.split === "development").length;
    const languageHoldoutCount = languageProjects.filter((project) => project.split === "holdout").length;
    if (languageProjects.length !== declared.total || languageDevelopmentCount !== declared.development || languageHoldoutCount !== declared.holdout) {
      throw new Error(`Corpus frozen selection counts do not match repository entries for ${declared.language}.`);
    }
  }
  return { schemaVersion: 1, sha256: createHash("sha256").update(bytes).digest("hex"), projects };
}

async function prepareCorpus(spec: BaselineRunSpec): Promise<CorpusFile> {
  const corpus = await readCorpus(spec.corpusPath, spec);
  const projects = await Promise.all(corpus.projects.map(async (project) => {
    if (project.split === "holdout") return { ...project, sourceTreeOid: project.checkoutTreeOid };
    const head = (await execFileAsync("git", ["-C", project.path, "rev-parse", "HEAD"], { maxBuffer: 1024 * 1024 })).stdout.trim();
    const treeOid = (await execFileAsync("git", ["-C", project.path, "rev-parse", "HEAD^{tree}"], { maxBuffer: 1024 * 1024 })).stdout.trim();
    if (head !== project.sourceRevision) throw new Error(`Checkout for ${project.id} is at ${head}; corpus pins ${project.sourceRevision}.`);
    if (treeOid !== project.checkoutTreeOid) throw new Error(`Checkout tree for ${project.id} is ${treeOid}; corpus registers ${project.checkoutTreeOid}.`);
    await validateCheckoutInventory(project);
    return { ...project, sourceTreeOid: treeOid };
  }));
  return { ...corpus, projects };
}

async function readInventoryManifest(corpusDirectory: string, projectId: string, relativeManifestPath: string, expectedSha256: string): Promise<InventoryEntry[]> {
  if (!isSafeFilePath(relativeManifestPath) || !relativeManifestPath.endsWith(".jsonl")) {
    throw new Error(`Corpus sample ${projectId} manifestPath must be a safe relative JSONL path.`);
  }
  const corpusRoot = await realpath(corpusDirectory);
  const manifestPath = await realpath(resolve(corpusRoot, relativeManifestPath));
  if (!isPathInside(corpusRoot, manifestPath)) throw new Error(`Corpus sample ${projectId} manifestPath escapes the corpus directory.`);
  const bytes = await readFile(manifestPath);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(`Corpus sample ${projectId} source-inventory manifest SHA-256 mismatch: registered ${expectedSha256}, found ${actualSha256}.`);
  }
  const lines = bytes.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error(`Corpus sample ${projectId} source-inventory manifest is empty.`);
  const entries: InventoryEntry[] = [];
  const paths = new Set<string>();
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      throw new Error(`Corpus sample ${projectId} manifest line ${index + 1} is invalid JSON: ${description}.`);
    }
    if (!isRecord(value) || typeof value.path !== "string" || !isSafeFilePath(value.path) ||
      (value.kind !== "source" && value.kind !== "configuration" && value.kind !== "license") ||
      (value.mode !== "100644" && value.mode !== "100755") || !isNonNegativeInteger(value.sizeBytes) || !isSha256(value.sha256) ||
      (value.language !== undefined && (typeof value.language !== "string" || !value.language.trim()))) {
      throw new Error(`Corpus sample ${projectId} manifest line ${index + 1} has an invalid path, kind, mode, size, SHA-256, or language.`);
    }
    if (paths.has(value.path)) throw new Error(`Corpus sample ${projectId} manifest repeats path ${value.path}.`);
    paths.add(value.path);
    if (value.kind === "source" && typeof value.language !== "string") throw new Error(`Corpus sample ${projectId} source path ${value.path} has no language.`);
    entries.push({
      path: value.path,
      kind: value.kind,
      mode: value.mode,
      sizeBytes: value.sizeBytes,
      sha256: value.sha256.toLowerCase(),
      language: typeof value.language === "string" ? value.language : undefined
    });
  }
  return entries;
}

function validateInventorySummary(projectId: string, inventory: Record<string, unknown>, entries: InventoryEntry[]): void {
  const sourceEntries = entries.filter((entry) => entry.kind === "source");
  const derivedLanguages = new Map<string, number>();
  for (const entry of sourceEntries) {
    if (!entry.language) throw new Error(`Corpus sample ${projectId} source path ${entry.path} has no language.`);
    derivedLanguages.set(entry.language, (derivedLanguages.get(entry.language) ?? 0) + 1);
  }
  const registeredLanguages = inventory.languageCounts as Record<string, number>;
  if (inventory.fileCount !== entries.length || inventory.sourceFileCount !== sourceEntries.length ||
    inventory.sourceBytes !== sourceEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0) ||
    !sameStringSet(Object.keys(registeredLanguages), [...derivedLanguages.keys()]) ||
    [...derivedLanguages].some(([language, count]) => registeredLanguages[language] !== count)) {
    throw new Error(`Corpus sample ${projectId} sourceInventory summary does not match manifest file count, source count, source bytes, or language counts.`);
  }
}

async function validateCheckoutInventory(project: CorpusProject): Promise<void> {
  const listing = (await execFileAsync("git", ["-C", project.path, "ls-tree", "-r", "-z", "--full-tree", "HEAD"], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  const checkoutFiles = new Map<string, { mode: string; type: string }>();
  for (const record of listing.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error(`Checkout tree for ${project.id} contains an unreadable Git tree entry.`);
    const [mode, type] = record.slice(0, separator).split(" ");
    checkoutFiles.set(record.slice(separator + 1), { mode, type });
  }
  const manifestPaths = new Set(project.inventoryEntries.map((entry) => entry.path));
  const scopedInventoryPaths = [...checkoutFiles.keys()]
    .filter((path) => isIncludedByCollectionScope(path, project.collectionScope))
    .filter(isInventoryCandidatePath)
    .sort();
  if (!sameStringArray(scopedInventoryPaths, [...manifestPaths].sort())) {
    const missing = scopedInventoryPaths.filter((path) => !manifestPaths.has(path));
    const extra = [...manifestPaths].filter((path) => !checkoutFiles.has(path));
    throw new Error(`Checkout inventory paths for ${project.id} do not match the frozen manifest within collectionScope (unregistered=${missing.slice(0, 3).join(",") || "none"}; absent=${extra.slice(0, 3).join(",") || "none"}).`);
  }
  for (const entry of project.inventoryEntries) {
    const treeEntry = checkoutFiles.get(entry.path);
    if (!treeEntry || treeEntry.type !== "blob") throw new Error(`Checkout manifest path ${project.id}/${entry.path} is absent from the pinned Git tree or is not a file.`);
    if (treeEntry.mode !== entry.mode) throw new Error(`Checkout mode mismatch for ${project.id}/${entry.path}: registered ${entry.mode}, found ${treeEntry.mode}.`);
    const fileBytes = await readFile(join(project.path, entry.path));
    const contentSha256 = createHash("sha256").update(fileBytes).digest("hex");
    if (fileBytes.byteLength !== entry.sizeBytes) throw new Error(`Checkout size mismatch for ${project.id}/${entry.path}: registered ${entry.sizeBytes}, found ${fileBytes.byteLength}.`);
    if (contentSha256 !== entry.sha256) throw new Error(`Checkout content SHA-256 mismatch for ${project.id}/${entry.path}: registered ${entry.sha256}, found ${contentSha256}.`);
    const actualLanguage = sourceLanguageForPath(entry.path);
    if (entry.kind === "source" && actualLanguage !== entry.language) throw new Error(`Checkout language mismatch for ${project.id}/${entry.path}: registered ${entry.language}, inferred ${actualLanguage ?? "unsupported"}.`);
    if (entry.kind === "configuration" && !isConfigurationPath(entry.path)) throw new Error(`Checkout manifest kind mismatch for ${project.id}/${entry.path}: expected a configuration file.`);
    if (entry.kind === "license" && !isLicensePath(entry.path)) throw new Error(`Checkout manifest kind mismatch for ${project.id}/${entry.path}: expected a license or notice file.`);
  }
}

function isIncludedByCollectionScope(path: string, scope: CorpusProject["collectionScope"]): boolean {
  const normalizedPath = normalizeScopePath(path);
  const included = scope.includePaths.some((scopePath) => pathMatchesScope(normalizedPath, normalizeScopePath(scopePath)));
  const excluded = scope.excludePaths.some((scopePath) => pathMatchesScope(normalizedPath, normalizeScopePath(scopePath)));
  return included && !excluded;
}

function pathMatchesScope(path: string, scopePath: string): boolean {
  return scopePath === "." || path === scopePath || path.startsWith(`${scopePath}/`);
}

function normalizeScopePath(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  return normalized || ".";
}

function isInventoryCandidatePath(path: string): boolean {
  return sourceLanguageForPath(path) !== undefined || isConfigurationPath(path) || isLicensePath(path);
}

function sourceLanguageForPath(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(extension)) return "TypeScript";
  if (extension === ".py") return "Python";
  if (extension === ".java") return "Java";
  if (extension === ".go") return "Go";
  return undefined;
}

function isConfigurationPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /^(?:package\.json|(?:tsconfig|jsconfig)(?:\.[\w-]+)?\.json|pnpm-workspace\.yaml|pyproject\.toml|setup\.(?:py|cfg)|pom\.xml|gradle(?:-wrapper)?\.properties|[\w.-]+\.gradle(?:\.kts)?|go\.(?:mod|work))$/.test(name);
}

function isLicensePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /^(?:license|licence|copying|notice)(?:[._-].*)?$/i.test(name);
}

function isPathInside(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

async function verifyAutomatedResourceBundle(executablePath: string, boundFiles: Array<{ path: string; sha256: string }>): Promise<void> {
  const manifests = boundFiles.filter((file) => basename(file.path) === "resources-manifest.json");
  if (manifests.length !== 1) throw new Error("Automated engineering must bind exactly one A5 resources-manifest.json.");
  const bundleRoot = resolve(dirname(executablePath), "../..");
  const resourcesRoot = resolve(bundleRoot, "Contents/Resources");
  const resourcesStat = await lstat(resourcesRoot);
  const [realBundleRoot, realResourcesRoot, realExecutablePath, realAppAsarPath] = await Promise.all([
    realpath(bundleRoot), realpath(resourcesRoot), realpath(executablePath), realpath(resolve(resourcesRoot, "app.asar"))
  ]);
  if (!resourcesStat.isDirectory() || resourcesStat.isSymbolicLink() || !isPathInside(realBundleRoot, realResourcesRoot) ||
    !isPathInside(realBundleRoot, realExecutablePath) || !isPathInside(realResourcesRoot, realAppAsarPath)) {
    throw new Error("Automated engineering app Resources, executable, and app.asar must remain inside the real package bundle.");
  }
  const manifest: unknown = JSON.parse(await readFile(manifests[0].path, "utf8"));
  if (!Array.isArray(manifest) || !manifest.length) throw new Error("Automated engineering resources manifest must list packaged files.");
  const registered = new Map<string, string>();
  for (const entry of manifest) {
    if (!isRecord(entry) || typeof entry.path !== "string" || !isSafeFilePath(entry.path) || !entry.path.startsWith("Contents/Resources/") || !isSha256(entry.sha256) || registered.has(entry.path)) {
      throw new Error("Automated engineering resources manifest contains an invalid or duplicate path/hash entry.");
    }
    const path = resolve(bundleRoot, entry.path);
    if (!isPathInside(resourcesRoot, path)) throw new Error(`Automated engineering resource escaped the app Resources directory: ${entry.path}.`);
    registered.set(entry.path, entry.sha256.toLowerCase());
  }
  const actualFiles = await listRegularFiles(resourcesRoot);
  const actualPaths = actualFiles.map((path) => relative(bundleRoot, path).split(sep).join("/"));
  if (!registered.has("Contents/Resources/app.asar") || !sameStringSet([...registered.keys()], actualPaths)) {
    throw new Error("Automated engineering resources manifest must cover every file in the packaged Resources directory.");
  }
  for (const [index, path] of actualFiles.entries()) {
    const relativePath = actualPaths[index];
    const expectedSha256 = registered.get(relativePath);
    if (!expectedSha256) throw new Error(`Automated engineering resource manifest omitted a packaged file: ${relativePath}.`);
    const actualSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
    if (actualSha256 !== expectedSha256) throw new Error(`Automated engineering packaged resource hash mismatch: ${relativePath}.`);
  }
}

async function verifyAutomatedPackageSourceEvidence(executablePath: string, boundFiles: Array<{ path: string; sha256: string }>, boundFileHashes: Map<string, string>): Promise<string> {
  const summaries = boundFiles.filter((file) => basename(file.path) === "summary.json");
  const sourceManifests = boundFiles.filter((file) => basename(file.path) === "source-manifest.json");
  const resourceManifests = boundFiles.filter((file) => basename(file.path) === "resources-manifest.json");
  if (summaries.length !== 1 || sourceManifests.length !== 1 || resourceManifests.length !== 1) {
    throw new Error("Automated engineering must bind the A5 summary, source manifest, and resources manifest.");
  }
  const [summaryBytes, sourceManifestBytes, resourcesManifestBytes] = await Promise.all([
    readFile(summaries[0].path), readFile(sourceManifests[0].path), readFile(resourceManifests[0].path)
  ]);
  const summary: unknown = JSON.parse(summaryBytes.toString("utf8"));
  const sourceManifest: unknown = JSON.parse(sourceManifestBytes.toString("utf8"));
  const bundleRoot = resolve(dirname(executablePath), "../..");
  const sourceManifestSha256 = createHash("sha256").update(sourceManifestBytes).digest("hex");
  const resourcesManifestSha256 = createHash("sha256").update(resourcesManifestBytes).digest("hex");
  if (!isRecord(summary) || !isRecord(summary.artifact) || !isSha256(summary.artifact.bundleTreeSha256) ||
    summary.artifact.bundleTreeSha256 !== await calculateAutomatedAppBundleTreeSha256(bundleRoot)) {
    throw new Error("Automated engineering A5 app bundle tree hash mismatch.");
  }
  if (!isRecord(summary) || summary.status !== "passed" || summary.formalDistribution !== false || summary.notarized !== false ||
    !isRecord(summary.artifact) || resolve(String(summary.artifact.path)) !== bundleRoot ||
    summary.artifact.appAsarSha256 !== boundFileHashes.get(resolve(dirname(executablePath), "../Resources/app.asar")) ||
    summary.artifact.executableSha256 !== boundFileHashes.get(resolve(executablePath)) ||
    !isRecord(summary.sourceManifest) || resolve(String(summary.sourceManifest.path)) !== resolve(sourceManifests[0].path) ||
    summary.sourceManifest.sha256 !== sourceManifestSha256 ||
    !isRecord(summary.resourcesManifest) || resolve(String(summary.resourcesManifest.path)) !== resolve(resourceManifests[0].path) ||
    summary.resourcesManifest.sha256 !== resourcesManifestSha256 || !Array.isArray(sourceManifest)) {
    throw new Error("Automated engineering A5 package summary must bind the tested local package tree and its source/resource manifests.");
  }
  const sourceEntries = new Map<string, string>();
  for (const entry of sourceManifest) {
    if (!isRecord(entry) || typeof entry.path !== "string" || !isSafeFilePath(entry.path) || !isSha256(entry.sha256) || sourceEntries.has(entry.path)) {
      throw new Error("Automated engineering source manifest contains an invalid or duplicate path/hash entry.");
    }
    sourceEntries.set(entry.path, entry.sha256.toLowerCase());
  }
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const path of AUTOMATED_RUNTIME_SOURCE_FILES) {
    const relativePath = relative(sourceRoot, path);
    if (sourceEntries.get(relativePath) !== boundFileHashes.get(resolve(path))) {
      throw new Error(`Automated engineering runtime source differs from the A5 package source manifest: ${relativePath}.`);
    }
  }
  for (const [relativePath, expectedSha256] of sourceEntries) {
    const path = resolve(sourceRoot, ...relativePath.split("/"));
    if (!isPathInside(sourceRoot, path) || resolve(sourceRoot, relative(sourceRoot, path)) !== path) {
      throw new Error(`Automated engineering A5 source manifest path escapes the source root: ${relativePath}.`);
    }
    const [actualPath, stats] = await Promise.all([realpath(path), lstat(path)]);
    if (!isPathInside(sourceRoot, actualPath) || !stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Automated engineering A5 source manifest entry is not a regular in-root file: ${relativePath}.`);
    }
    const actualSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
    if (actualSha256 !== expectedSha256) throw new Error(`Automated engineering source changed after A5 packaging: ${relativePath}.`);
  }
  return summary.artifact.bundleTreeSha256;
}

export async function calculateAutomatedAppBundleTreeSha256(bundleRoot: string): Promise<string> {
  const root = await realpath(bundleRoot);
  const rootStats = await lstat(bundleRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error(`Automated engineering app bundle root is not a real directory: ${bundleRoot}.`);
  const entries: Array<Record<string, string | number>> = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory);
    children.sort();
    for (const name of children) {
      const path = join(directory, name);
      const relativePath = relative(root, path).split(sep).join("/");
      const stats = await lstat(path);
      const mode = stats.mode & 0o777;
      if (stats.isSymbolicLink()) {
        const target = await readlink(path);
        const resolvedTarget = await realpath(path);
        if (!isPathInside(root, resolvedTarget)) throw new Error(`Automated engineering app bundle symlink escapes the package: ${relativePath}.`);
        entries.push({ path: relativePath, kind: "symlink", mode, target });
      } else if (stats.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory", mode });
        await visit(path);
      } else if (stats.isFile()) {
        const bytes = await readFile(path);
        entries.push({ path: relativePath, kind: "file", mode, sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
      } else {
        throw new Error(`Automated engineering app bundle contains a non-regular entry: ${relativePath}.`);
      }
    }
  };
  await visit(root);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

async function checkAutomatedPackageTree(
  spec: Pick<AutomatedEngineeringRunSpec, "executablePath">,
  expectedSha256: string
): Promise<{ unchanged: boolean; actualSha256?: string; error?: string }> {
  const bundleRoot = resolve(dirname(spec.executablePath), "../..");
  try {
    const actualSha256 = await calculateAutomatedAppBundleTreeSha256(bundleRoot);
    return { unchanged: actualSha256 === expectedSha256, actualSha256 };
  } catch (error) {
    return { unchanged: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function listRegularFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Automated engineering app Resources cannot contain unbound symlinks: ${path}.`);
    if (entry.isDirectory()) paths.push(...await listRegularFiles(path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Automated engineering app Resources contain a non-regular entry: ${path}.`);
  }
  return paths;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isIntegerMap(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isNonNegativeInteger);
}

function collectionScopeSha256(includePaths: string[], excludePaths: string[]): string {
  const normalize = (paths: string[]) => paths.map(normalizeScopePath).sort();
  return createHash("sha256").update(JSON.stringify({ includePaths: normalize(includePaths), excludePaths: normalize(excludePaths) })).digest("hex");
}

function projectEvidenceFields(project: CorpusProject): Pick<RunRecord, "languages" | "selection" | "collectionScope"> {
  return {
    languages: [...project.languages],
    selection: {
      sourcePaths: [...project.selection.sourcePaths],
      configurationPaths: [...project.selection.configurationPaths],
      scopeSha256: project.selection.scopeSha256,
      sourceInventorySha256: project.selection.sourceInventorySha256
    },
    collectionScope: {
      includePaths: [...project.collectionScope.includePaths],
      excludePaths: [...project.collectionScope.excludePaths]
    }
  };
}

function parseCanonicalRepositoryUrl(value: unknown, projectId: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Corpus sample ${projectId} has no canonical repository URL.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Corpus sample ${projectId} has an invalid canonical repository URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(`Corpus sample ${projectId} needs a canonical HTTPS repository URL without credentials or query parameters.`);
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  return `https://${url.hostname.toLowerCase()}${pathname}`;
}

function isSafeRepositoryPath(value: string): boolean {
  return value.trim().length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..");
}

function isSafeScopePath(value: string): boolean {
  return isSafeRepositoryPath(value) && value.trim() === value && !/[?*\[\]{}!]/.test(value) &&
    !value.split("/").some((part, index, parts) => part === ".." || part === "." && !(parts.length === 1 && index === 0) || part === "" && index !== parts.length - 1);
}

function isSafeFilePath(value: string): boolean {
  return value.trim() === value && value.length > 0 && !value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function countPlannedRuns(corpus: CorpusFile, spec: BaselineRunSpec, targetSplit: CorpusProject["split"]): number {
  return corpus.projects.filter((project) => project.split === targetSplit).length * spec.scenarios.length * spec.repetitions;
}

function summarizeProductOutcome(runs: RunRecord[]): BaselineRunResult["productOutcome"] {
  const outcomes = new Set(runs.map((run) => run.productOutcome));
  if (outcomes.has("incomplete")) return "incomplete";
  if (outcomes.size === 1) return outcomes.values().next().value ?? "incomplete";
  return "mixed";
}

function formatCollectionError(runs: RunRecord[], resultPath: string, mode: string): string {
  const examples = runs.filter((run) => !run.measurementValid).slice(0, 3).map((run) => `${run.projectId}/${run.scenarioId}/${run.repetition}: ${run.error ?? "invalid measurement"}`);
  return `${mode} collection contains invalid measurements${examples.length ? ` (${examples.join("; ")})` : ""}; inspect ${resultPath}.`;
}

async function writeRunResult(outputDirectory: string, filename: string, result: unknown): Promise<void> {
  await writeFile(join(outputDirectory, filename), `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function writeRunLines(outputDirectory: string, filename: string, runs: RunRecord[]): Promise<void> {
  await writeFile(join(outputDirectory, filename), runs.map((run) => JSON.stringify(run)).join("\n") + "\n", { encoding: "utf8", flag: "wx" });
}

function collectorFailure(
  project: CorpusProject,
  scenarioId: string,
  repetition: number,
  startedAt: string,
  error: string,
  processResult?: MeasurementProcessResult
): RunRecord {
  return {
    projectId: project.id,
    scenarioId,
    repetition,
    language: project.language,
    ...projectEvidenceFields(project),
    sizeBand: project.sizeBand,
    split: project.split,
    measurementValid: false,
    productOutcome: "unknown",
    failureStage: "collector",
    error,
    startedAt,
    endedAt: new Date().toISOString(),
    metrics: {},
    unavailableMetrics: Object.fromEntries(REQUIRED_METRICS.map((metric) => [metric, "Collector did not receive valid evidence for this planned run."])),
    processExitCode: processResult?.code,
    processSignal: processResult?.signal
  };
}

async function persistRunRecord(runDirectory: string, record: RunRecord): Promise<void> {
  await writeFile(join(runDirectory, "run-record.json"), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function isTimestampValue(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNumberMap(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((item) => isNonNegativeNumber(item));
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string" && item.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesNumberRecord(candidate: unknown, expected: Readonly<Record<string, number>>): boolean {
  return isRecord(candidate) && sameStringSet(Object.keys(candidate), Object.keys(expected)) &&
    Object.entries(expected).every(([key, value]) => candidate[key] === value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isProductOutcome(value: unknown): value is ProductOutcome {
  return value === "success" || value === "failure";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function uniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) return [];
  const values = value as string[];
  return new Set(values).size === values.length ? values : [];
}

function sameStringSet(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sameStringArray(sortedLeft, sortedRight);
}

function sameStringSetFromUnknown(value: unknown, expected: string[]): boolean {
  return sameStringSet(uniqueStringArray(value), expected);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function runCli(argv: string[]): Promise<void> {
  const [mode, specFlag, specPath] = argv;
  if (mode === "verify" && specFlag === "--spec" && specPath && argv.length === 3) {
    const verification = await verifyAutomatedEngineeringInputs(JSON.parse(await readFile(resolve(specPath), "utf8")) as AutomatedEngineeringRunSpec);
    process.stdout.write(`${JSON.stringify(verification)}\n`);
    return;
  }
  if (mode === "automated" && specFlag === "--spec" && specPath && argv.length === 3) {
    const result = await collectAutomatedEngineering(JSON.parse(await readFile(resolve(specPath), "utf8")) as AutomatedEngineeringRunSpec);
    process.stdout.write(`${JSON.stringify({ evaluationKind: result.evaluationKind, formalAcceptance: false, measurementValid: result.measurementValid, complete: result.complete, productOutcome: result.productOutcome, thresholdOutcome: result.thresholdOutcome })}\n`);
    if (!result.measurementValid || !result.complete || result.productOutcome !== "success") process.exitCode = 1;
    return;
  }
  if (mode === "compare" && specFlag === "--spec" && specPath && argv.length === 11 &&
    argv[3] === "--project" && argv[4] && argv[5] === "--scenario" && argv[6] && argv[7] === "--pairs" && /^\d+$/.test(argv[8]) &&
    argv[9] === "--output" && argv[10]) {
    const spec = JSON.parse(await readFile(resolve(specPath), "utf8")) as AutomatedEngineeringRunSpec;
    const result = await collectAutomatedInstrumentationComparison(spec, argv[10], argv[4], argv[6], Number(argv[8]));
    process.stdout.write(`${JSON.stringify({
      kind: result.kind,
      comparisonScope: result.comparisonScope,
      projectId: result.projectId,
      scenarioId: result.scenarioId,
      outputDirectory: result.outputDirectory,
      pairCount: result.pairCount,
      measurementValid: result.measurementValid,
      allPairsProductOutcomeMatched: result.allPairsProductOutcomeMatched,
      allPairsSuccessful: result.allPairsSuccessful,
      pairedExternalDurationDeltaMedianMs: result.pairedExternalDurationDeltaMedianMs
    })}\n`);
    if (!result.measurementValid || !result.allPairsProductOutcomeMatched || !result.allPairsSuccessful) process.exitCode = 1;
    return;
  }
  if (mode === "reserved-regression" && specFlag === "--spec" && specPath && argv[3] === "--phase" &&
    (argv[4] === "first-run" && argv.length === 5 || argv[4] === "repair-regression" && argv[5] === "--first-run-report" && argv[6] && argv.length === 7)) {
    const spec = JSON.parse(await readFile(resolve(specPath), "utf8")) as AutomatedEngineeringRunSpec;
    const result = await collectAutomatedReservedRegression(spec, argv[4] as "first-run" | "repair-regression", argv[6]);
    process.stdout.write(`${JSON.stringify({
      kind: result.kind,
      phase: result.phase,
      formalAcceptance: false,
      complete: result.complete,
      measurementValid: result.measurementValid,
      productOutcome: result.productOutcome,
      plannedRuns: result.plannedRuns,
      outputDirectory: result.outputDirectory
    })}\n`);
    if (!result.measurementValid || !result.complete || result.productOutcome !== "success") process.exitCode = 1;
    return;
  }
  if ((mode !== "baseline" && mode !== "accept") || specFlag !== "--spec" || !specPath) {
    throw new Error("Usage: node --import tsx scripts/run-static-graph-acceptance.ts verify --spec <path> | automated --spec <path> | compare --spec <path> --project <development-id> --scenario <id> --pairs <count>=5+ --output <fresh-directory> | reserved-regression --spec <path> --phase first-run | reserved-regression --spec <path> --phase repair-regression --first-run-report <path> | baseline --spec <path> | accept --spec <path>");
  }
  const spec = JSON.parse(await readFile(resolve(specPath), "utf8")) as BaselineRunSpec & Partial<AcceptanceRunSpec>;
  if (mode === "baseline") {
    const result = await collectStaticGraphBaseline(spec);
    process.stdout.write(`${JSON.stringify({ measurementValid: result.measurementValid, complete: result.complete, productOutcome: result.productOutcome })}\n`);
    return;
  }
  const result = await runStaticGraphAcceptance(spec as AcceptanceRunSpec);
  process.stdout.write(`${JSON.stringify({ formalAcceptance: result.formalAcceptance, thresholdOutcome: result.thresholdOutcome })}\n`);
  if (!result.formalAcceptance) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

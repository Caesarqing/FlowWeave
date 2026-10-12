/// <reference types="electron-vite/node" />

import { app, BrowserWindow, nativeImage } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerAgentIpc } from "./ipc/agent.ipc";
import { registerGitIpc } from "./ipc/git.ipc";
import { registerProjectIpc, type ProjectIpcGraphSmokeTestHooks, type ProjectMeasurementObserver } from "./ipc/project.ipc";
import { configureAgentRegistry } from "./services/agent-registry.service";
import { configureProjectRegistry, registerProject, saveProjectWorkspaceSession } from "./services/project-registry.service";
import { getStaticDetailCacheResidentBytes } from "./services/canvas-detail.service";
import {
  isMatchingRenderedGraphWorkspaceReady,
  isMeasurementSourceInventoryEntries,
  createProcessTreeActionRssMeasurement,
  measureCancellation,
  measureStaticGraphDetailUiTimings,
  staticGraphDetailUiTimingIdentity,
  serializedIpcPayloadBytes,
  summarizeRendererLongTasks,
  validateMeasurementSourceInventory,
  type MeasurementSourceInventoryEntry,
  type ProcessTreeActionRssEvidence
} from "./services/static-graph-measurement";
import { generateProject, type GenerationPhaseMeasurement } from "./services/project-generation.service";
import { assertMeasurementOutputIsolatedSync, isMeasurementSourceChange, prepareStaticGraphScenario, primeStaticGraphDetail, resolveStaticGraphDetailRevision, type MeasurementSourceChange, type PreparedStaticGraphScenario } from "./services/static-graph-scenario";
import { hasCanvasProfilerGraphChange } from "../utils/react-profiler";
import type { GraphSmokeTraceEvent } from "../common/graph-smoke-trace";
import { parseGraphSmokeTraceMessage } from "./services/graph-smoke-trace";
import type { ProjectAnalysisEvent, ProjectScanSelection, StaticGraphDetailUiTiming } from "../types";
import { readProjectGenerationManifest, readProjectProtocolCanvas } from "./storage/flowweave-store";
import { configureTransactionAuthorityRoot } from "./storage/transaction-authority";

const execFileAsync = promisify(execFile);

const SMOKE_TEST_ARGUMENT = "--flowweave-smoke-test";
const GRAPH_SMOKE_TEST_ARGUMENT = "--flowweave-graph-smoke-test";
const GENERATION_SMOKE_TEST_ARGUMENT = "--flowweave-generation-smoke-test";
const STATIC_GRAPH_MEASUREMENT_ARGUMENT = "--flowweave-static-graph-measurement";
const SMOKE_TEST_TIMEOUT_MS = 15_000;
const GRAPH_SMOKE_TEST_TIMEOUT_MS = 45_000;
const STATIC_GRAPH_MEASUREMENT_TIMEOUT_MS = 10 * 60 * 1000;
const MAIN_ENTRY_STARTED_ISO = new Date().toISOString();
const REQUIRED_MEASUREMENT_METRICS = [
  "appStartupMs", "projectSelectionMs", "workspaceInteractiveMs", "scanMs", "semanticAnalysisMs",
  "clusteringMs", "layoutMs", "commitMs", "ipcReceiptMs", "clickableGraphMs", "detailReadyMs"
] as const;
const OPTIONAL_MEASUREMENT_METRICS = [
  "lockWaitMs", "snapshotValidationMs", "snapshotParseMs", "snapshotReadMs", "detailIndexMs", "detailIpcRoundTripMs", "detailPanelPresentationMs", "firstScreenIpcBytes", "cacheResidentBytes",
  "rendererLongTaskCount", "rendererLongTaskTotalMs", "rendererLongTaskMaxMs", "processTreePeakRssMiB",
  "selectionToWorkspaceInteractiveMs", "selectionToClickableGraphMs",
  "cancellationUiResponseMs", "backgroundTaskExitMs"
] as const;
const ALL_MEASUREMENT_METRICS = [...REQUIRED_MEASUREMENT_METRICS, ...OPTIONAL_MEASUREMENT_METRICS];
const PROCESS_TREE_RSS_SAMPLE_INTERVAL_MS = 50;
type GraphSmokeDetailRaceControl = ProjectIpcGraphSmokeTestHooks & {
  waitForFirstResponseArrival: () => Promise<string>;
  releaseFirstResponse: () => void;
  waitForFirstResponseRelease: () => Promise<string>;
  readState: () => { heldNodeId: string | null; releaseRequested: boolean; releasedNodeId: string | null };
};
const staticGraphProcessTreeRssMeasurement = process.argv.includes(STATIC_GRAPH_MEASUREMENT_ARGUMENT)
  && process.env.FLOWWEAVE_STATIC_GRAPH_INSTRUMENTATION_MODE === "on"
  ? createProcessTreeActionRssMeasurement(() => app.getAppMetrics(), PROCESS_TREE_RSS_SAMPLE_INTERVAL_MS)
  : undefined;
staticGraphProcessTreeRssMeasurement?.startAction("electron-startup-before-scenario-setup");

function createGraphSmokeDetailRaceControl(): GraphSmokeDetailRaceControl {
  let resolveFirstResponseArrival!: (nodeId: string) => void;
  let resolveFirstResponseRelease!: (nodeId: string) => void;
  let resolveReleaseGate!: () => void;
  let heldNodeId: string | null = null;
  let releasedNodeId: string | null = null;
  let releaseRequested = false;
  const firstResponseArrival = new Promise<string>((resolveArrival) => { resolveFirstResponseArrival = resolveArrival; });
  const firstResponseRelease = new Promise<string>((resolveRelease) => { resolveFirstResponseRelease = resolveRelease; });
  const releaseGate = new Promise<void>((resolveRelease) => { resolveReleaseGate = resolveRelease; });

  return {
    beforeNodeDetailResponse: async (nodeId) => {
      if (heldNodeId !== null) return;
      heldNodeId = nodeId;
      resolveFirstResponseArrival(nodeId);
      await releaseGate;
      releasedNodeId = nodeId;
      resolveFirstResponseRelease(nodeId);
    },
    waitForFirstResponseArrival: () => firstResponseArrival,
    releaseFirstResponse: () => {
      if (releaseRequested) return;
      releaseRequested = true;
      resolveReleaseGate();
    },
    waitForFirstResponseRelease: () => firstResponseRelease,
    readState: () => ({ heldNodeId, releaseRequested, releasedNodeId })
  };
}

export type StaticGraphMeasurementContext = {
  runAttemptId: string;
  projectId: string;
  projectPath: string;
  sourceRevision: string;
  selection: ProjectScanSelection;
  sourceInventoryEntries?: MeasurementSourceInventoryEntry[];
  generationProtocol: number;
  scenarioId: string;
  sourceChange?: MeasurementSourceChange;
  repetition: number;
  osCacheState: "cleared" | "not-cleared" | "unknown";
  measurement: { method: string; version: string; sha256: string };
  instrumentationMode: "on" | "off";
};

export type StaticGraphMeasurementUiSignal =
  | { status: "ready"; generationId: string; userRevision: number }
  | { status: "not-reached"; reason: string };

export type StaticGraphMeasurementReportInput = {
  generationId: string | null;
  currentGenerationId: string | null;
  sourceRevision: string | null;
  currentSourceRevision: string | null;
  userRevision: number | null;
  detailUserRevision: number | null;
  productOutcome: "success" | "failure";
  failureStage?: string;
  error?: string;
  uiReadyEvidence: Record<"workspaceInteractive" | "clickableGraph" | "detailReady", StaticGraphMeasurementUiSignal>;
  metrics: Record<string, number>;
  unavailableMetrics: Record<string, string>;
  qualityEvidence?: Record<string, unknown>;
  startedAt: string;
  endedAt: string;
};

export type StaticGraphMeasurementReport = StaticGraphMeasurementReportInput & {
  schemaVersion: 1;
  generationProtocol: number;
  projectId: string;
  scenarioId: string;
  repetition: number;
  runAttemptId: string;
  measurementMethod: string;
  measurementVersion: string;
  measurementSha256: string;
  instrumentationMode: "on" | "off";
};

export function createStaticGraphMeasurementReport(
  context: StaticGraphMeasurementContext,
  input: StaticGraphMeasurementReportInput
): StaticGraphMeasurementReport {
  if (!isValidTimestamp(input.startedAt) || !isValidTimestamp(input.endedAt) || Date.parse(input.endedAt) < Date.parse(input.startedAt)) {
    throw new TypeError("Static graph measurement report has invalid start/end timestamps.");
  }
  if (input.productOutcome === "failure" && (!input.failureStage || !input.error)) {
    throw new TypeError("Failed static graph measurement reports require a failure stage or error.");
  }
  validateMeasurementMetrics(input.metrics, input.unavailableMetrics);
  validateMeasurementUiEvidence(input.uiReadyEvidence);
  if (input.productOutcome === "success") validateSuccessfulMeasurementIdentity(context, input);
  return {
    schemaVersion: 1,
    generationProtocol: context.generationProtocol,
    projectId: context.projectId,
    scenarioId: context.scenarioId,
    repetition: context.repetition,
    runAttemptId: context.runAttemptId,
    measurementMethod: context.measurement.method,
    measurementVersion: context.measurement.version,
    measurementSha256: context.measurement.sha256,
    instrumentationMode: context.instrumentationMode,
    ...input
  };
}

function validateMeasurementMetrics(metrics: Record<string, number>, unavailableMetrics: Record<string, string>): void {
  for (const metric of Object.keys(metrics)) {
    if (!ALL_MEASUREMENT_METRICS.includes(metric as (typeof ALL_MEASUREMENT_METRICS)[number])) {
      throw new TypeError(`Static graph measurement report has an unknown metric: ${metric}.`);
    }
    if (!Number.isFinite(metrics[metric]) || metrics[metric] < 0) {
      throw new TypeError(`Static graph measurement report has an invalid metric: ${metric}.`);
    }
    if (metric in unavailableMetrics) throw new TypeError(`Static graph metric is both measured and unavailable: ${metric}.`);
  }
  for (const metric of ALL_MEASUREMENT_METRICS) {
    if (!(metric in metrics) && (typeof unavailableMetrics[metric] !== "string" || !unavailableMetrics[metric].trim())) {
      throw new TypeError(`Static graph measurement report has no value or reason for ${metric}.`);
    }
  }
}

function validateMeasurementUiEvidence(
  evidence: StaticGraphMeasurementReportInput["uiReadyEvidence"]
): void {
  for (const milestone of ["workspaceInteractive", "clickableGraph", "detailReady"] as const) {
    const signal = evidence[milestone];
    if (signal.status === "ready") {
      if (!signal.generationId || !Number.isInteger(signal.userRevision) || signal.userRevision < 0) {
        throw new TypeError(`Static graph UI evidence is missing identity for ${milestone}.`);
      }
    } else if (!signal.reason.trim()) {
      throw new TypeError(`Static graph UI evidence is missing an unavailable reason for ${milestone}.`);
    }
  }
}

function validateSuccessfulMeasurementIdentity(
  context: StaticGraphMeasurementContext,
  input: StaticGraphMeasurementReportInput
): void {
  if (!input.generationId || input.currentGenerationId !== input.generationId) {
    throw new Error("Successful static graph measurement requires a matching current generation.");
  }
  if (input.sourceRevision !== context.sourceRevision || input.currentSourceRevision !== input.sourceRevision) {
    throw new Error("Successful static graph measurement requires the pinned current source revision.");
  }
  if (!Number.isInteger(input.userRevision) || input.userRevision === null || input.userRevision < 0 || input.detailUserRevision !== input.userRevision) {
    throw new Error("Successful static graph measurement requires the detail user revision to match the UI user revision.");
  }
  const scanSelection = input.qualityEvidence?.scanSelection;
  if (!isMeasurementRecord(scanSelection) || scanSelection.scopeSha256 !== context.selection.scopeSha256 ||
    scanSelection.sourceInventorySha256 !== context.selection.sourceInventorySha256 ||
    typeof scanSelection.scanFingerprint !== "string" || !scanSelection.scanFingerprint) {
    throw new Error("Successful static graph measurement requires the observed scan to match its frozen source selection.");
  }
  for (const milestone of ["workspaceInteractive", "clickableGraph", "detailReady"] as const) {
    const evidence = input.uiReadyEvidence[milestone];
    if (evidence.status !== "ready" || evidence.generationId !== input.generationId || evidence.userRevision !== input.userRevision) {
      throw new Error(`Successful static graph measurement has mismatched UI identity for ${milestone}.`);
    }
  }
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isMeasurementRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type StaticGraphMeasurementRuntime = {
  context: StaticGraphMeasurementContext;
  metrics: Record<string, number>;
  unavailableMetrics: Record<string, string>;
  phaseMeasurements: GenerationPhaseMeasurement[];
  scanFingerprintsByRequest: Map<string, string>;
  projectId?: string;
  projectPath?: string;
  requestId?: string;
  selectionStartedAt?: number;
  generationId: string | null;
  currentGenerationId: string | null;
  sourceRevision: string | null;
  currentSourceRevision: string | null;
  userRevision: number | null;
  detailUserRevision: number | null;
  processTreeRssEvidence?: ProcessTreeActionRssEvidence;
  uiReadyEvidence: StaticGraphMeasurementReportInput["uiReadyEvidence"];
  workerExitAtEpochMsByRequest: Map<string, number>;
  cancellationStartedAtEpochMsByRequest: Map<string, number>;
  onboardingEvidence?: Record<string, unknown>;
  eventSentAtWallClockMs?: number;
  sourceInventoryVerifiedAtEntry: boolean;
  sourceInventoryVerifiedAtExit: boolean;
  scanFingerprint?: string;
  failureStage?: string;
  error?: string;
};

type StaticGraphPageEvent = {
  status: "completed" | "failed" | "cancelled" | "superseded";
  projectId: string;
  requestId: string;
  receivedAtEpochMs: number;
  receivedAtWallClockMs: number;
  selectionStartedAtEpochMs?: number;
  generationId: string | null;
  userRevision: number | null;
  nodeIds: string[];
  generatedNodeIds: string[];
  message?: string;
};

type StaticGraphPageWorkspace = {
  generationId: string;
  userRevision: number;
  readyAtEpochMs: number;
};

type StaticGraphClickableNode = { id: string; x: number; y: number; clickableAtEpochMs: number };

type StaticGraphDetailResult = {
  panelReady: boolean;
  hasDetail: boolean;
  generationId: string;
  userRevision: number;
  nodeId: string;
  timing?: StaticGraphDetailUiTiming;
  completedAtEpochMs: number;
};

type StaticGraphCancellationResult = {
  requestId: string;
  uiStartedAtEpochMs: number;
  accepted: boolean;
  uiEvent: { requestId: string; status: string; receivedAtEpochMs: number } | null;
};

type StaticGraphLongTaskObservation = { available: boolean; durations: number[]; error?: string };

function measurementOption(option: string, environmentName: string): string {
  const index = process.argv.indexOf(option);
  const value = index >= 0 ? process.argv[index + 1] : process.env[environmentName];
  if (!value || value.startsWith("--")) {
    throw new Error(`Static graph measurement requires ${option} or ${environmentName}.`);
  }
  return value;
}

async function readStaticGraphMeasurementContext(path: string): Promise<StaticGraphMeasurementContext> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isMeasurementRecord(parsed) || typeof parsed.runAttemptId !== "string" || !parsed.runAttemptId ||
    typeof parsed.projectId !== "string" || !parsed.projectId || typeof parsed.projectPath !== "string" || !parsed.projectPath ||
    typeof parsed.sourceRevision !== "string" || !/^[a-f\d]{40,64}$/i.test(parsed.sourceRevision) ||
    !Number.isInteger(parsed.generationProtocol) || !isValidProjectScanSelection(parsed.selection) ||
    !isMeasurementSourceInventoryEntries(parsed.sourceInventoryEntries, parsed.selection) ||
    typeof parsed.scenarioId !== "string" || !parsed.scenarioId ||
    (parsed.sourceChange !== undefined && !isMeasurementSourceChange(parsed.sourceChange)) ||
    !Number.isInteger(parsed.repetition) || Number(parsed.repetition) < 1 ||
    (parsed.osCacheState !== "cleared" && parsed.osCacheState !== "not-cleared" && parsed.osCacheState !== "unknown") ||
    (parsed.instrumentationMode !== "on" && parsed.instrumentationMode !== "off") ||
    !isMeasurementRecord(parsed.measurement) || typeof parsed.measurement.method !== "string" || !parsed.measurement.method.trim() ||
    typeof parsed.measurement.version !== "string" || !parsed.measurement.version.trim() ||
    typeof parsed.measurement.sha256 !== "string" || !/^[a-f\d]{64}$/i.test(parsed.measurement.sha256)) {
    throw new TypeError(`Static graph measurement context is invalid: ${path}`);
  }
  return {
    runAttemptId: parsed.runAttemptId,
    projectId: parsed.projectId,
    projectPath: resolve(parsed.projectPath),
    sourceRevision: parsed.sourceRevision,
    selection: parsed.selection,
    sourceInventoryEntries: parsed.sourceInventoryEntries,
    generationProtocol: Number(parsed.generationProtocol),
    scenarioId: parsed.scenarioId,
    ...(parsed.sourceChange !== undefined ? { sourceChange: parsed.sourceChange } : {}),
    repetition: Number(parsed.repetition),
    osCacheState: parsed.osCacheState,
    measurement: {
      method: parsed.measurement.method,
      version: parsed.measurement.version,
      sha256: parsed.measurement.sha256
    },
    instrumentationMode: parsed.instrumentationMode
  };
}

function isValidProjectScanSelection(value: unknown): value is ProjectScanSelection {
  if (!isMeasurementRecord(value) || !Array.isArray(value.sourcePaths) || value.sourcePaths.length === 0 ||
    !Array.isArray(value.configurationPaths) ||
    typeof value.scopeSha256 !== "string" || !/^[a-f\d]{64}$/i.test(value.scopeSha256) ||
    typeof value.sourceInventorySha256 !== "string" || !/^[a-f\d]{64}$/i.test(value.sourceInventorySha256)) return false;
  const paths = [...value.sourcePaths, ...value.configurationPaths];
  return paths.every((path) => typeof path === "string" && path.trim() === path && path.length > 0 &&
    !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => !part || part === "." || part === "..")) &&
    new Set(paths).size === paths.length;
}

function createStaticGraphMeasurementRuntime(context: StaticGraphMeasurementContext): StaticGraphMeasurementRuntime {
  const unavailableMetrics = Object.fromEntries(ALL_MEASUREMENT_METRICS.map((metric) => [
    metric,
    context.instrumentationMode === "off"
      ? "Instrumentation is off for this comparison arm; internal telemetry was intentionally suppressed."
      : measurementUnavailableReason(metric)
  ]));
  const notObserved = (milestone: string) => ({ status: "not-reached" as const, reason: `The visible app did not establish ${milestone} for the measured generation.` });
  return {
    context,
    metrics: {},
    unavailableMetrics,
    phaseMeasurements: [],
    scanFingerprintsByRequest: new Map(),
    workerExitAtEpochMsByRequest: new Map(),
    cancellationStartedAtEpochMsByRequest: new Map(),
    generationId: null,
    currentGenerationId: null,
    sourceRevision: null,
    currentSourceRevision: null,
    userRevision: null,
    sourceInventoryVerifiedAtEntry: false,
    sourceInventoryVerifiedAtExit: false,
    detailUserRevision: null,
    uiReadyEvidence: {
      workspaceInteractive: notObserved("workspace interactivity"),
      clickableGraph: notObserved("a hit-testable graph node"),
      detailReady: notObserved("a matching ready detail panel")
    }
  };
}

function measurementUnavailableReason(metric: string): string {
  const reasons: Record<string, string> = {
    projectSelectionMs: "The measured UI project-open action did not reach worker dispatch.",
    workspaceInteractiveMs: "No completed generation with matching rendered graph nodes was observed in the UI.",
    scanMs: "The worker did not report a completed scan phase for the measured request.",
    semanticAnalysisMs: "The worker did not report a completed semantic-analysis phase for the measured request.",
    clusteringMs: "The worker did not report a completed static-architecture phase for the measured request.",
    layoutMs: "The worker did not report a completed layout phase for the measured request.",
    commitMs: "The worker did not report a completed locked commit phase for the measured request.",
    ipcReceiptMs: "The matching completed-analysis event was not observed by the renderer listener.",
    clickableGraphMs: "No visible generated graph node passed the page hit-test and input check.",
    selectionToWorkspaceInteractiveMs: "The measured project-open action did not reach the interactive workspace.",
    selectionToClickableGraphMs: "The measured project-open action did not reach a hit-testable graph node.",
    detailReadyMs: "The panel did not become ready and return detail for the measured generation and revision.",
    appStartupMs: "The runner process-launch request did not reach the renderer-loaded startup milestone.",
    lockWaitMs: "No measured generation or detail artifact-lock acquisition was reached.",
    snapshotValidationMs: "No source snapshot or committed static-snapshot validation was reached.",
    snapshotParseMs: "No committed static-snapshot JSON parse was reached in this run.",
    snapshotReadMs: "No committed static-snapshot file read and integrity verification was reached in this run.",
    detailIndexMs: "No cold detail index construction was reached in this run.",
    detailIpcRoundTripMs: "The measured module panel did not return an identity-matched detail IPC response.",
    detailPanelPresentationMs: "The identity-matched detail response did not reach the panel's React commit.",
    firstScreenIpcBytes: "The matching completed analysis event did not include a measurable JSON payload.",
    cacheResidentBytes: "No matching detail lookup completed, so the detail-cache LRU byte count was not sampled.",
    rendererLongTaskCount: "The renderer does not support PerformanceObserver long-task entries.",
    rendererLongTaskTotalMs: "The renderer does not support PerformanceObserver long-task entries.",
    rendererLongTaskMaxMs: "The renderer does not support PerformanceObserver long-task entries.",
    processTreePeakRssMiB: "Electron did not return working-set metrics for its managed processes.",
    cancellationUiResponseMs: "This scenario did not request an analysis cancellation.",
    backgroundTaskExitMs: "This scenario did not cancel a running analysis worker."
  };
  return reasons[metric] ?? `No source measurement exists for ${metric}.`;
}

function recordMeasurementMetric(runtime: StaticGraphMeasurementRuntime, metric: string, value: number): void {
  if (runtime.context.instrumentationMode === "off") return;
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Measured value is invalid for ${metric}: ${value}`);
  runtime.metrics[metric] = value;
  delete runtime.unavailableMetrics[metric];
}

function measureGenerationPhase(runtime: StaticGraphMeasurementRuntime, requestId: string, measurement: GenerationPhaseMeasurement): void {
  if (runtime.requestId !== requestId) return;
  recordMeasurementSample(runtime, measurement);
}

function recordMeasurementSample(runtime: StaticGraphMeasurementRuntime, measurement: GenerationPhaseMeasurement): void {
  runtime.phaseMeasurements.push(measurement);
  const prior = runtime.metrics[measurement.metric] ?? 0;
  recordMeasurementMetric(runtime, measurement.metric, prior + measurement.durationMs);
  if (measurement.outcome === "failed") runtime.failureStage = measurement.metric;
}

function installStaticGraphPageObserver(window: BrowserWindow, instrumentationMode: "on" | "off"): Promise<void> {
  return window.webContents.executeJavaScript(`(() => {
    const isMatchingRenderedGraphWorkspaceReady = ${isMatchingRenderedGraphWorkspaceReady.toString()};
    const collectMetrics = ${JSON.stringify(instrumentationMode === "on")};
    const epochNow = () => collectMetrics ? performance.timeOrigin + performance.now() : 0;
    const state = { collectMetrics, event: null, workspace: null, detailTimings: [], longTaskDurations: [], longTaskObserver: null, longTaskObservationAvailable: false, longTaskObservationError: null };
    window.__flowweaveStaticGraphMeasurement = state;
    document.addEventListener('click', (event) => {
      if (!collectMetrics || state.projectSelectionStartedAtEpochMs !== undefined) return;
      const target = event.target;
      if (target instanceof Element && target.closest('.project-actions .project-action-row button:first-child')) {
        state.projectSelectionStartedAtEpochMs = epochNow();
      }
    }, true);
    try {
      if (collectMetrics && typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        state.longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) state.longTaskDurations.push(entry.duration);
        });
        state.longTaskObserver.observe({ type: 'longtask', buffered: true });
        state.longTaskObservationAvailable = true;
      }
    } catch (error) {
      state.longTaskObserver?.disconnect();
      state.longTaskObserver = null;
      state.longTaskObservationAvailable = false;
      state.longTaskObservationError = error instanceof Error ? error.message : String(error);
    }
    window.flowweave.onProjectAnalysis((event) => {
      const canvas = event.status === 'completed' ? event.result.canvas.canvas : undefined;
      const generationId = canvas?.generation?.requestId ?? null;
      const userRevision = Number.isInteger(canvas?.userRevision) ? canvas.userRevision : null;
      state.event = {
        status: event.status,
        projectId: event.projectId,
        requestId: event.requestId,
        receivedAtEpochMs: epochNow(),
        receivedAtWallClockMs: collectMetrics ? Date.now() : 0,
        ...(state.projectSelectionStartedAtEpochMs === undefined ? {} : { selectionStartedAtEpochMs: state.projectSelectionStartedAtEpochMs }),
        generationId,
        userRevision,
        nodeIds: canvas?.nodes.map((node) => node.id) ?? [],
        generatedNodeIds: canvas?.nodes.filter((node) => node.origin !== 'manual').map((node) => node.id) ?? [],
        ...(event.status === 'failed' ? { message: event.message } : {})
      };
      if (event.status !== 'completed' || !generationId || userRevision === null) return;
      const observeWorkspace = () => {
        const shell = document.querySelector('.canvas-shell');
        const loading = document.querySelector('.canvas-empty-state');
        const renderedIds = [...document.querySelectorAll('.react-flow__node')].map((node) => node.getAttribute('data-id'));
        if (isMatchingRenderedGraphWorkspaceReady({
          generationId,
          userRevision,
          shellGenerationId: shell?.getAttribute('data-generation-id') ?? null,
          shellUserRevision: shell?.getAttribute('data-user-revision') ?? null,
          hasShell: Boolean(shell),
          isLoading: Boolean(loading),
          renderedNodeCount: renderedIds.length
        })) {
          state.workspace = {
            generationId,
            userRevision,
            readyAtEpochMs: epochNow()
          };
          return;
        }
        requestAnimationFrame(observeWorkspace);
      };
      requestAnimationFrame(observeWorkspace);
    });
  })()`);
}

async function readStaticGraphPageEvent(window: BrowserWindow): Promise<StaticGraphPageEvent | null> {
  return window.webContents.executeJavaScript(`window.__flowweaveStaticGraphMeasurement?.event ?? null`) as Promise<StaticGraphPageEvent | null>;
}

async function readStaticGraphPageWorkspace(window: BrowserWindow): Promise<StaticGraphPageWorkspace | null> {
  return window.webContents.executeJavaScript(`window.__flowweaveStaticGraphMeasurement?.workspace ?? null`) as Promise<StaticGraphPageWorkspace | null>;
}

async function readStaticGraphLongTaskObservation(window: BrowserWindow): Promise<StaticGraphLongTaskObservation> {
  return window.webContents.executeJavaScript(`(() => {
    const state = window.__flowweaveStaticGraphMeasurement;
    state?.longTaskObserver?.disconnect();
    return {
      available: state?.longTaskObservationAvailable === true,
      durations: Array.isArray(state?.longTaskDurations) ? state.longTaskDurations : [],
      error: typeof state?.longTaskObservationError === 'string' ? state.longTaskObservationError : undefined
    };
  })()`) as Promise<StaticGraphLongTaskObservation>;
}

async function requestStaticGraphCancellation(window: BrowserWindow, projectId: string, selection: ProjectScanSelection, instrumentationMode: "on" | "off"): Promise<StaticGraphCancellationResult> {
  return window.webContents.executeJavaScript(`(async () => {
    const collectMetrics = ${JSON.stringify(instrumentationMode === "on")};
    const scan = await window.flowweave.scanProject(${JSON.stringify(projectId)}, {
      concurrency: 1,
      selection: ${JSON.stringify(selection)}
    });
    if (scan.canceled || scan.status !== 'analyzing' || !scan.requestId) {
      throw new Error('The cancellation scenario did not start a new analysis worker.');
    }
    const uiStartedAtEpochMs = collectMetrics ? performance.timeOrigin + performance.now() : 0;
    const accepted = await window.flowweave.cancelProjectAnalysis(${JSON.stringify(projectId)});
    const deadline = performance.now() + 10000;
    let uiEvent = null;
    while (performance.now() < deadline) {
      const event = window.__flowweaveStaticGraphMeasurement?.event;
      if (event?.requestId === scan.requestId && event.status === 'cancelled') {
        uiEvent = event;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { requestId: scan.requestId, uiStartedAtEpochMs, accepted, uiEvent };
  })()`) as Promise<StaticGraphCancellationResult>;
}

async function findStaticGraphClickableNode(window: BrowserWindow): Promise<StaticGraphClickableNode | null> {
  return window.webContents.executeJavaScript(`(() => {
    const state = window.__flowweaveStaticGraphMeasurement;
    if (!state?.event || !state?.workspace || state.event.status !== 'completed') return null;
    for (const node of document.querySelectorAll('.react-flow__node:not(.react-flow__node-groupNode)')) {
      const id = node.getAttribute('data-id');
      if (!id || !state.event.generatedNodeIds.includes(id)) continue;
      const rect = node.getBoundingClientRect();
      const x = Math.round((rect.left + rect.right) / 2);
      const y = Math.round((rect.top + rect.bottom) / 2);
      if (rect.width <= 0 || rect.height <= 0 || document.elementFromPoint(x, y)?.closest('.react-flow__node') !== node) continue;
      return { id, x, y, clickableAtEpochMs: performance.timeOrigin + performance.now() };
    }
    return null;
  })()`) as Promise<StaticGraphClickableNode | null>;
}

async function readStaticGraphDetailResult(
  window: BrowserWindow,
  projectId: string,
  generationId: string,
  userRevision: number,
  nodeId: string,
  instrumentationMode: "on" | "off"
): Promise<StaticGraphDetailResult> {
  return window.webContents.executeJavaScript(`(async () => {
    const resolveStaticGraphDetailRevision = ${resolveStaticGraphDetailRevision.toString()};
    const collectMetrics = ${JSON.stringify(instrumentationMode === "on")};
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      const panel = document.querySelector('.module-panel');
      if (panel?.getAttribute('data-detail-state') === 'ready' && panel.getAttribute('data-detail-node-id') === ${JSON.stringify(nodeId)}) {
        const committed = await window.flowweave.readCanvas(${JSON.stringify(projectId)});
        const shell = document.querySelector('.canvas-shell');
        const currentRevision = resolveStaticGraphDetailRevision({
          generationId: ${JSON.stringify(generationId)},
          completionUserRevision: ${userRevision},
          committedGenerationId: committed?.canvas?.generation?.requestId ?? null,
          committedUserRevision: committed?.canvas?.userRevision ?? null,
          renderedGenerationId: shell?.getAttribute('data-generation-id') ?? null,
          renderedUserRevision: shell?.getAttribute('data-user-revision') ?? null
        });
        if (!collectMetrics) return {
          panelReady: true, hasDetail: true, generationId: ${JSON.stringify(generationId)},
          userRevision: currentRevision, nodeId: ${JSON.stringify(nodeId)}, completedAtEpochMs: 0
        };
        const timing = window.__flowweaveStaticGraphMeasurement?.detailTimings?.find((item) =>
          item.projectId === ${JSON.stringify(projectId)} && item.generationId === ${JSON.stringify(generationId)} &&
          item.userRevision === currentRevision && item.nodeId === ${JSON.stringify(nodeId)}
        );
        if (timing) return {
          panelReady: true, hasDetail: true, generationId: timing.generationId, userRevision: timing.userRevision,
          nodeId: timing.nodeId, timing, completedAtEpochMs: timing.panelPresentedAtEpochMs
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('The module detail panel did not reach ready state for the measured generation.');
  })()`) as Promise<StaticGraphDetailResult>;
}

async function clickVisiblePageButton(window: BrowserWindow, selector: string): Promise<boolean> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement) || element.matches(':disabled')) return null;
    const rect = element.getBoundingClientRect();
    const x = Math.round((rect.left + rect.right) / 2);
    const y = Math.round((rect.top + rect.bottom) / 2);
    if (rect.width <= 0 || rect.height <= 0 || document.elementFromPoint(x, y)?.closest('button') !== element) return null;
    return { x, y };
  })()`) as { x: number; y: number } | null;
  if (!point) return false;
  window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  return true;
}

async function waitForWindowLoad(window: BrowserWindow): Promise<void> {
  await new Promise<void>((resolveLoad, rejectLoad) => {
    const timeout = setTimeout(() => rejectLoad(new Error("Renderer did not finish loading within 30 seconds.")), 30_000);
    window.webContents.once("did-finish-load", () => {
      clearTimeout(timeout);
      resolveLoad();
    });
    window.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
      clearTimeout(timeout);
      rejectLoad(new Error(`Renderer failed to load (${errorCode}): ${errorDescription}`));
    });
  });
}

async function markOnboardingCompleteInIsolatedProfile(window: BrowserWindow): Promise<Record<string, unknown>> {
  const uiReadyAt = performance.now();
  let state: Record<string, unknown> | null = null;
  while (performance.now() - uiReadyAt < 30_000) {
    state = await window.webContents.executeJavaScript(`({
      readyState: document.readyState,
      projectActions: Boolean(document.querySelector('.project-actions')),
      canvas: Boolean(document.querySelector('.canvas-shell')),
      onboardingVisible: Boolean(document.querySelector('.onboarding-dialog')),
      storedPreference: localStorage.getItem('flowweave.onboardingSeen')
    })`) as Record<string, unknown>;
    if (state.projectActions === true && state.canvas === true) break;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (state?.projectActions !== true || state.canvas !== true) {
    throw new Error(`Renderer UI did not mount before onboarding setup: ${JSON.stringify(state)}.`);
  }
  if (state.onboardingVisible !== true) return { ...state, action: "already-complete-after-ui-mounted" };

  const buttonSelector = ".onboarding-dialog button.primary-button";
  const clickStartedAt = performance.now();
  let clicked = false;
  while (performance.now() - clickStartedAt < 10_000) {
    clicked = await clickVisiblePageButton(window, buttonSelector);
    if (clicked) break;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (!clicked) throw new Error("The isolated onboarding dialog did not expose a hit-testable completion button.");

  const completedAt = performance.now();
  while (performance.now() - completedAt < 10_000) {
    const completed = await window.webContents.executeJavaScript(`({
      readyState: document.readyState,
      projectActions: Boolean(document.querySelector('.project-actions')),
      canvas: Boolean(document.querySelector('.canvas-shell')),
      onboardingVisible: Boolean(document.querySelector('.onboarding-dialog')),
      storedPreference: localStorage.getItem('flowweave.onboardingSeen')
    })`) as Record<string, unknown>;
    if (completed.onboardingVisible === false && completed.storedPreference === "true") {
      return { ...completed, action: "completed-through-visible-onboarding-button" };
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  const finalState = await window.webContents.executeJavaScript(`({
    onboardingVisible: Boolean(document.querySelector('.onboarding-dialog')),
    storedPreference: localStorage.getItem('flowweave.onboardingSeen')
  })`) as Record<string, unknown>;
  throw new Error(`The visible onboarding action did not complete in the isolated profile: ${JSON.stringify(finalState)}.`);
}

async function waitForProjectSelection(runtime: StaticGraphMeasurementRuntime, window: BrowserWindow): Promise<StaticGraphPageEvent> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < STATIC_GRAPH_MEASUREMENT_TIMEOUT_MS) {
    if (runtime.error) throw new Error(runtime.error);
    const event = await readStaticGraphPageEvent(window);
    if (runtime.requestId && event?.requestId === runtime.requestId && event.status !== "completed") {
      throw new Error(event.message ?? `Project analysis ended with ${event.status}.`);
    }
    if (runtime.requestId && event?.requestId === runtime.requestId && event.status === "completed") return event;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for the visible project analysis event.");
}

async function runStaticGraphMeasurement(processLaunchRequestedAtEpochMs: number, appReadyAtEpochMs: number): Promise<void> {
  const reportPath = resolve(measurementOption("--report", "FLOWWEAVE_STATIC_GRAPH_REPORT"));
  const contextPath = measurementOption("--run-context", "FLOWWEAVE_STATIC_GRAPH_RUN_CONTEXT");
  let context = await readStaticGraphMeasurementContext(contextPath);
  if (process.env.FLOWWEAVE_STATIC_GRAPH_INSTRUMENTATION_MODE !== context.instrumentationMode) {
    throw new Error(`Static graph instrumentation mode does not match the runner context: env=${String(process.env.FLOWWEAVE_STATIC_GRAPH_INSTRUMENTATION_MODE)}, context=${context.instrumentationMode}.`);
  }
  staticGraphProcessTreeRssMeasurement?.finishAction();
  let processTreeRssWindowActive = false;
  const startProcessTreeRssAction = (boundary: string): void => {
    if (!staticGraphProcessTreeRssMeasurement) return;
    staticGraphProcessTreeRssMeasurement.startAction(boundary);
    processTreeRssWindowActive = true;
  };
  const finishProcessTreeRssAction = (): void => {
    if (!staticGraphProcessTreeRssMeasurement || !processTreeRssWindowActive) return;
    processTreeRssWindowActive = false;
    staticGraphProcessTreeRssMeasurement.finishAction();
  };
  const pinnedSourceProjectPath = context.projectPath;
  const runtime = createStaticGraphMeasurementRuntime(context);
  recordMeasurementMetric(runtime, "appStartupMs", appReadyAtEpochMs - processLaunchRequestedAtEpochMs);
  const startedAt = MAIN_ENTRY_STARTED_ISO;
  let window: BrowserWindow | undefined;
  let productOutcome: "success" | "failure" = "failure";
  let currentStage = "sourceInventory";
  let scenarioPreparation: PreparedStaticGraphScenario | undefined;
  let scenarioSetupDurationMs = 0;
  let detailCachePrimed = false;
  let completionEventUserRevision: number | null = null;

  try {
    await validateMeasurementSourceInventory(context.projectPath, context.selection, context.sourceInventoryEntries ?? []);
    runtime.sourceInventoryVerifiedAtEntry = true;
    currentStage = "sourceRevision";
    runtime.sourceRevision = await readGitRevision(context.projectPath);
    if (runtime.sourceRevision !== context.sourceRevision) {
      throw new Error(`Pinned source revision changed before measurement: expected ${context.sourceRevision}, found ${runtime.sourceRevision}.`);
    }
    if (context.generationProtocol !== 7) {
      throw new Error(`Unsupported measurement generation protocol: expected 7, found ${context.generationProtocol}.`);
    }

    currentStage = "scenarioSetup";
    const scenarioSetupStartedAt = context.instrumentationMode === "on" ? performance.now() : 0;
    scenarioPreparation = await prepareStaticGraphScenario({
      projectPath: pinnedSourceProjectPath,
      outputDirectory: join(dirname(reportPath), "scenario-project"),
      scenarioId: context.scenarioId,
      selection: context.selection,
      sourceInventoryEntries: context.sourceInventoryEntries ?? [],
      sourceChange: context.sourceChange
    });
    if (context.instrumentationMode === "on") scenarioSetupDurationMs = performance.now() - scenarioSetupStartedAt;
    context = { ...context, projectPath: scenarioPreparation.projectPath, selection: scenarioPreparation.selection, sourceInventoryEntries: scenarioPreparation.sourceInventoryEntries };
    runtime.context = context;

    currentStage = "appStartup";
    startProcessTreeRssAction("scenario-open-through-clickable-graph");
    configureAgentRegistry(app.getPath("userData"));
    await configureProjectRegistry(app.getPath("userData"));
    registerProjectIpc({
      autoSelectProjectPath: context.projectPath,
      autoScanSelection: context.selection,
      ...(context.instrumentationMode === "on" ? {
        onGenerationMeasurement: (requestId: string, measurement: GenerationPhaseMeasurement) => measureGenerationPhase(runtime, requestId, measurement),
        onMainProcessMeasurement: (measurement: GenerationPhaseMeasurement) => recordMeasurementSample(runtime, measurement)
      } : {}),
      onProjectScanned: (requestId, scanFingerprint) => {
        runtime.scanFingerprintsByRequest.set(requestId, scanFingerprint);
      },
      onProjectSelectionCompleted: (_sender, projectId, projectPath, requestId) => {
        runtime.projectId = projectId;
        runtime.projectPath = projectPath;
        runtime.requestId = requestId;
        if (runtime.selectionStartedAt !== undefined) {
          recordMeasurementMetric(runtime, "projectSelectionMs", performance.now() - runtime.selectionStartedAt);
        }
      },
      onProjectAnalysisEventSent: (_sender, event, sentAtWallClockMs) => {
        if (event.requestId !== runtime.requestId) return;
        runtime.eventSentAtWallClockMs = sentAtWallClockMs;
        if (event.status === "completed" && context.instrumentationMode === "on") {
          try {
            recordMeasurementMetric(runtime, "firstScreenIpcBytes", serializedIpcPayloadBytes(event));
          } catch (error) {
            runtime.failureStage ??= "ipcReceipt";
            runtime.error = `Could not measure first-screen IPC payload: ${formatMeasurementError(error)}`;
          }
        }
        if (event.status === "failed") {
          runtime.failureStage ??= "analysis";
          runtime.error = event.message;
        }
      },
      onProjectAnalysisWorkerExited: (requestId, exitedAtEpochMs) => {
        runtime.workerExitAtEpochMsByRequest.set(requestId, exitedAtEpochMs);
      },
      onProjectAnalysisCancellationRequested: (requestId, startedAtEpochMs) => {
        runtime.cancellationStartedAtEpochMsByRequest.set(requestId, startedAtEpochMs);
      }
    });
    registerAgentIpc();
    registerGitIpc();
    window = createWindow();
    await waitForWindowLoad(window);
    if (context.instrumentationMode === "on") {
      recordMeasurementMetric(runtime, "appStartupMs", Date.now() - processLaunchRequestedAtEpochMs - scenarioSetupDurationMs);
    }
    currentStage = "projectSelection";
    runtime.onboardingEvidence = await markOnboardingCompleteInIsolatedProfile(window);
    await installStaticGraphPageObserver(window, context.instrumentationMode);
    const openButtonSelector = ".project-actions .project-action-row button:first-child";
    const openReadyAt = performance.now();
    let opened = false;
    while (!opened && performance.now() - openReadyAt < 10_000) {
      if (context.instrumentationMode === "on") {
        runtime.selectionStartedAt = performance.now();
      }
      opened = await clickVisiblePageButton(window, openButtonSelector);
      if (!opened) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
    }
    if (!opened) {
      const pageState = await window.webContents.executeJavaScript(`({
        title: document.title,
        text: document.body.innerText.slice(0, 400),
        projectActions: Boolean(document.querySelector('.project-actions')),
        openButton: Boolean(document.querySelector(${JSON.stringify(openButtonSelector)})),
        canvas: Boolean(document.querySelector('.canvas-shell')),
        onboarding: Boolean(document.querySelector('.onboarding-dialog'))
      })`);
      throw new Error(`The visible project-open button could not be hit-tested: ${JSON.stringify(pageState)}`);
    }
    currentStage = "analysis";
    const pageEvent = await waitForProjectSelection(runtime, window);
    if (!runtime.requestId || pageEvent.requestId !== runtime.requestId || pageEvent.status !== "completed" ||
      !pageEvent.generationId || pageEvent.userRevision === null) {
      throw new Error("The renderer completed analysis without generation and user-revision identity.");
    }
    runtime.generationId = pageEvent.generationId;
    completionEventUserRevision = pageEvent.userRevision;
    if (scenarioPreparation.seedGenerationId !== null) {
      const matchesSeed = pageEvent.generationId === scenarioPreparation.seedGenerationId;
      if (context.scenarioId === "incremental-source" ? matchesSeed : !matchesSeed) {
        throw new Error(`Measured ${context.scenarioId} returned the wrong generation relative to its committed setup cache.`);
      }
      if (matchesSeed) {
        for (const metric of ["clusteringMs", "layoutMs", "commitMs"] as const) {
          if (runtime.metrics[metric] !== undefined) throw new Error(`Cached reopen unexpectedly performed ${metric}.`);
          runtime.unavailableMetrics[metric] = "The measured open reused its verified committed generation; this stage was not executed.";
        }
      }
    }
    runtime.scanFingerprint = runtime.scanFingerprintsByRequest.get(pageEvent.requestId);
    if (!runtime.scanFingerprint) throw new Error("The measured generation did not report the frozen source-selection scan fingerprint.");
    runtime.userRevision = pageEvent.userRevision;
    if (runtime.eventSentAtWallClockMs === undefined) {
      throw new Error("The main process did not record the send time for the matching completed event.");
    }
    recordMeasurementMetric(runtime, "ipcReceiptMs", pageEvent.receivedAtWallClockMs - runtime.eventSentAtWallClockMs);

    currentStage = "workspaceInteractive";
    let workspace: StaticGraphPageWorkspace | null = null;
    const workspaceStartedAt = performance.now();
    while (!workspace && performance.now() - workspaceStartedAt < 30_000) {
      workspace = await readStaticGraphPageWorkspace(window);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
    }
    if (!workspace || workspace.generationId !== pageEvent.generationId || workspace.userRevision !== pageEvent.userRevision) {
      throw new Error("The visible workspace did not render a graph node from the measured generation and revision.");
    }
    recordMeasurementMetric(runtime, "workspaceInteractiveMs", workspace.readyAtEpochMs - pageEvent.receivedAtEpochMs);
    const selectionStartedAtEpochMs = pageEvent.selectionStartedAtEpochMs;
    if (context.instrumentationMode === "on" && selectionStartedAtEpochMs === undefined) {
      throw new Error("The renderer did not record the measured project-open click boundary.");
    }
    if (selectionStartedAtEpochMs !== undefined) {
      recordMeasurementMetric(runtime, "selectionToWorkspaceInteractiveMs", workspace.readyAtEpochMs - selectionStartedAtEpochMs);
    }
    runtime.uiReadyEvidence.workspaceInteractive = {
      status: "ready", generationId: workspace.generationId, userRevision: workspace.userRevision
    };

    currentStage = "clickableGraph";
    let clickableNode: StaticGraphClickableNode | null = null;
    const clickableStartedAt = performance.now();
    while (!clickableNode && performance.now() - clickableStartedAt < 10_000) {
      clickableNode = await findStaticGraphClickableNode(window);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
    }
    if (!clickableNode) throw new Error("No visible generated graph node could receive an input event.");
    if (context.instrumentationMode === "on") {
      recordMeasurementMetric(runtime, "clickableGraphMs", clickableNode.clickableAtEpochMs - pageEvent.receivedAtEpochMs);
      if (selectionStartedAtEpochMs === undefined) throw new Error("The renderer did not record the measured project-open click boundary.");
      recordMeasurementMetric(runtime, "selectionToClickableGraphMs", clickableNode.clickableAtEpochMs - selectionStartedAtEpochMs);
    }
    runtime.uiReadyEvidence.clickableGraph = {
      status: "ready", generationId: pageEvent.generationId, userRevision: pageEvent.userRevision
    };
    if (context.scenarioId === "detail-hot") {
      finishProcessTreeRssAction();
      const hotCanvas = await readProjectProtocolCanvas(context.projectPath);
      if (hotCanvas?.generation?.requestId !== pageEvent.generationId || hotCanvas.userRevision === undefined) throw new Error("Hot detail setup lost the current committed identity.");
      await primeStaticGraphDetail(context.projectPath, pageEvent.generationId, hotCanvas.userRevision, clickableNode.id);
      detailCachePrimed = true;
      startProcessTreeRssAction("hot-detail-click-to-ready");
    }
    await window.webContents.executeJavaScript(`if (window.__flowweaveStaticGraphMeasurement) { window.__flowweaveStaticGraphMeasurement.detailTimings = []; window.__flowweaveStaticGraphMeasurement.detailClickStartedAtEpochMs = undefined; }`);
    window.webContents.sendInputEvent({ type: "mouseDown", x: clickableNode.x, y: clickableNode.y, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x: clickableNode.x, y: clickableNode.y, button: "left", clickCount: 1 });

    currentStage = "detailReady";
    const detail = await readStaticGraphDetailResult(window, runtime.projectId ?? "", pageEvent.generationId, pageEvent.userRevision, clickableNode.id, context.instrumentationMode);
    if (!detail.panelReady || !detail.hasDetail || detail.generationId !== pageEvent.generationId ||
      detail.userRevision < pageEvent.userRevision || detail.nodeId !== clickableNode.id) {
      throw new Error("The detail panel response did not match the visible generation, revision, and clicked node.");
    }
    runtime.detailUserRevision = detail.userRevision;
    runtime.userRevision = detail.userRevision;
    runtime.uiReadyEvidence.workspaceInteractive = { ...runtime.uiReadyEvidence.workspaceInteractive, userRevision: detail.userRevision };
    runtime.uiReadyEvidence.clickableGraph = { ...runtime.uiReadyEvidence.clickableGraph, userRevision: detail.userRevision };
    runtime.uiReadyEvidence.detailReady = {
      status: "ready", generationId: detail.generationId, userRevision: detail.userRevision
    };
    if (context.instrumentationMode === "on") recordMeasurementMetric(runtime, "cacheResidentBytes", getStaticDetailCacheResidentBytes());
    if (context.instrumentationMode === "on") {
      if (!detail.timing) throw new Error("Instrumented detail panel omitted its timing evidence.");
      const detailTimings = measureStaticGraphDetailUiTimings(
        staticGraphDetailUiTimingIdentity(runtime.projectId, detail.generationId, detail.userRevision, clickableNode.id),
        detail.timing
      );
      recordMeasurementMetric(runtime, "detailReadyMs", detailTimings.detailReadyMs);
      recordMeasurementMetric(runtime, "detailIpcRoundTripMs", detailTimings.detailIpcRoundTripMs);
      recordMeasurementMetric(runtime, "detailPanelPresentationMs", detailTimings.detailPanelPresentationMs);
    }
    finishProcessTreeRssAction();

    currentStage = "cancellation";
    startProcessTreeRssAction("analysis-cancellation-and-worker-exit");
    const cancellation = await requestStaticGraphCancellation(window, runtime.projectId ?? "", context.selection, context.instrumentationMode);
    if (!cancellation.accepted || !cancellation.uiEvent) {
      throw new Error(`Cancellation was not accepted and observed for request ${cancellation.requestId}.`);
    }
    const workerExitStartedAt = performance.now();
    while (!runtime.workerExitAtEpochMsByRequest.has(cancellation.requestId) && performance.now() - workerExitStartedAt < 10_000) {
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    }
    const exitedAtEpochMs = runtime.workerExitAtEpochMsByRequest.get(cancellation.requestId);
    if (exitedAtEpochMs === undefined) {
      runtime.unavailableMetrics.backgroundTaskExitMs = `Cancelled analysis worker ${cancellation.requestId} did not exit within 10000 ms.`;
      throw new Error(runtime.unavailableMetrics.backgroundTaskExitMs);
    }
    if (context.instrumentationMode === "on") {
      const workerExitStartedAtEpochMs = runtime.cancellationStartedAtEpochMsByRequest.get(cancellation.requestId);
      if (workerExitStartedAtEpochMs === undefined) {
        throw new Error(`Cancellation start timestamp was not recorded for request ${cancellation.requestId}.`);
      }
      const cancellationMetrics = measureCancellation({
        requestId: cancellation.requestId,
        uiStartedAtEpochMs: cancellation.uiStartedAtEpochMs,
        workerExitStartedAtEpochMs,
        uiEvent: cancellation.uiEvent,
        workerExit: { requestId: cancellation.requestId, exitedAtEpochMs }
      });
      recordMeasurementMetric(runtime, "cancellationUiResponseMs", cancellationMetrics.cancellationUiResponseMs);
      recordMeasurementMetric(runtime, "backgroundTaskExitMs", cancellationMetrics.backgroundTaskExitMs);
    }
    finishProcessTreeRssAction();

    const longTaskObservation = context.instrumentationMode === "on"
      ? await readStaticGraphLongTaskObservation(window)
      : { available: false, durations: [] };
    if (longTaskObservation.available) {
      const longTaskSummary = summarizeRendererLongTasks(longTaskObservation.durations);
      recordMeasurementMetric(runtime, "rendererLongTaskCount", longTaskSummary.count);
      recordMeasurementMetric(runtime, "rendererLongTaskTotalMs", longTaskSummary.totalMs);
      recordMeasurementMetric(runtime, "rendererLongTaskMaxMs", longTaskSummary.maxMs);
    } else if (longTaskObservation.error) {
      const reason = `Renderer PerformanceObserver long-task setup failed: ${longTaskObservation.error}`;
      runtime.unavailableMetrics.rendererLongTaskCount = reason;
      runtime.unavailableMetrics.rendererLongTaskTotalMs = reason;
      runtime.unavailableMetrics.rendererLongTaskMaxMs = reason;
    }

    currentStage = "currentIdentity";
    const [manifest, canvas] = await Promise.all([
      readProjectGenerationManifest(context.projectPath),
      readProjectProtocolCanvas(context.projectPath)
    ]);
    runtime.currentGenerationId = manifest?.generationId ?? null;
    if (canvas?.userRevision !== undefined) runtime.userRevision = canvas.userRevision;
    runtime.currentSourceRevision = await readGitRevision(pinnedSourceProjectPath);
    if (runtime.currentGenerationId !== runtime.generationId || canvas?.generation?.requestId !== runtime.generationId ||
      runtime.currentSourceRevision !== context.sourceRevision || runtime.userRevision !== detail.userRevision) {
      throw new Error("Current source, generation, or user revision changed while the UI measurement was running.");
    }
    productOutcome = "success";
    runtime.failureStage = undefined;
    runtime.error = undefined;
  } catch (error) {
    runtime.failureStage = runtime.failureStage ?? currentStage;
    runtime.error = formatMeasurementError(error);
    productOutcome = "failure";
    try {
      finishProcessTreeRssAction();
    } catch (rssError) {
      runtime.error = `${runtime.error}; RSS sampling failed: ${formatMeasurementError(rssError)}`;
    }
  }

  try {
    if (runtime.currentSourceRevision === null) runtime.currentSourceRevision = await readGitRevision(pinnedSourceProjectPath);
    const manifest = await readProjectGenerationManifest(context.projectPath);
    const canvas = await readProjectProtocolCanvas(context.projectPath);
    runtime.currentGenerationId = manifest?.generationId ?? null;
    if (runtime.generationId === null && canvas?.generation?.requestId) runtime.generationId = canvas.generation.requestId;
    if (runtime.userRevision === null && canvas?.userRevision !== undefined) runtime.userRevision = canvas.userRevision;
    await validateMeasurementSourceInventory(context.projectPath, context.selection, context.sourceInventoryEntries ?? []);
    runtime.sourceInventoryVerifiedAtExit = true;
  } catch (error) {
    runtime.error = runtime.error ?? `Could not verify final project identity and source inventory: ${formatMeasurementError(error)}`;
    runtime.failureStage = runtime.failureStage ?? (runtime.sourceInventoryVerifiedAtEntry ? "currentIdentity" : "sourceInventory");
    productOutcome = "failure";
  }

  if (staticGraphProcessTreeRssMeasurement) {
    try {
      const processTreeRss = staticGraphProcessTreeRssMeasurement.readEvidence();
      if (processTreeRss.peakRssMiB > 0) recordMeasurementMetric(runtime, "processTreePeakRssMiB", processTreeRss.peakRssMiB);
      else runtime.unavailableMetrics.processTreePeakRssMiB = "Electron process metrics reported no working-set memory during the measured run.";
      runtime.processTreeRssEvidence = processTreeRss;
    } catch (error) {
      runtime.unavailableMetrics.processTreePeakRssMiB = `Electron process-tree RSS sampling failed: ${formatMeasurementError(error)}`;
      runtime.failureStage ??= "processTreeRss";
      runtime.error = runtime.error ?? runtime.unavailableMetrics.processTreePeakRssMiB;
      productOutcome = "failure";
    }
  }

  const reportInput: StaticGraphMeasurementReportInput = {
    generationId: runtime.generationId,
    currentGenerationId: runtime.currentGenerationId,
    sourceRevision: runtime.sourceRevision,
    currentSourceRevision: runtime.currentSourceRevision,
    userRevision: runtime.userRevision,
    detailUserRevision: runtime.detailUserRevision,
    productOutcome,
    failureStage: runtime.failureStage ?? (productOutcome === "failure" ? "measurement" : undefined),
    error: runtime.error ?? (productOutcome === "failure" ? "Measurement did not establish every required milestone." : undefined),
    uiReadyEvidence: runtime.uiReadyEvidence,
    metrics: runtime.metrics,
    unavailableMetrics: runtime.unavailableMetrics,
    qualityEvidence: {
      measurementEntry: "Visible project-open interaction against the context-pinned project path; native file picker timing is not measured.",
      onboarding: runtime.onboardingEvidence ?? { action: "not-reached" },
      uiRevisionBinding: {
        completionEventUserRevision,
        measuredUserRevision: runtime.userRevision,
        source: "Current committed canvas and rendered shell revalidated at detail readiness; same-generation autosave may advance the completion event revision."
      },
      scenarioPreparation: scenarioPreparation ? {
        ...scenarioPreparation.evidence,
        setupDurationMs: scenarioSetupDurationMs,
        detailCachePrimed,
        preparationExcludedFromMeasuredStages: true,
        sourceRevisionDefinition: "Pinned original checkout HEAD; the incremental change is recorded separately and applied only to the isolated selected-source copy."
      } : { action: "not-reached" },
      generationEventSource: "ProjectAnalysisEvent delivered through the renderer preload API and correlated by requestId.",
      uiIdentitySource: "Completed event identity matched the canvas DOM generation and user revision; a visible graph node, including a synthetic overview group, was present before hit-tested input and matching detail response.",
      sourceInventoryValidation: {
        entryVerified: runtime.sourceInventoryVerifiedAtEntry,
        exitVerified: runtime.sourceInventoryVerifiedAtExit,
        entriesVerified: context.sourceInventoryEntries?.length ?? 0
      },
      phaseMeasurements: runtime.phaseMeasurements,
      phaseMeasurementDefinitions: {
        lockWaitMs: "Sum of measured time waiting to acquire artifact locks; excludes path resolution and lock-held work.",
        snapshotValidationMs: "Sum of SourceSnapshot.validate and committed static-snapshot identity validation durations.",
        snapshotParseMs: "Sum of JSON.parse duration for committed static-snapshot.json; file reads and hash checks are excluded.",
        snapshotReadMs: "Sum of static-snapshot file reads and SHA-256 integrity verification durations.",
        detailIndexMs: "Sum of cold static-detail Map construction durations; explicit hot setup is excluded.",
        detailIpcRoundTripMs: "Measured in the renderer from the selected module's actual detail IPC invocation to its response, excluding the save barrier.",
        detailPanelPresentationMs: "Measured in the renderer from the accepted detail IPC response to the panel's React layout commit."
      },
      cacheResidentBytes: {
        measured: runtime.metrics.cacheResidentBytes !== undefined,
        definition: "Logical UTF-8 serialized detail-index cache weight retained by the detail LRU; this is not JavaScript heap size or process RSS."
      },
      timingBoundaries: {
        appStartupMs: "Runner Date.now process-launch request to main-process Date.now after renderer window load, excluding measured-scenario preparation.",
        projectSelectionMs: "Hit-tested project-open action to the matching project-selection callback.",
        workspaceInteractiveMs: "Matching completed generation event to the rendered interactive workspace.",
        clickableGraphMs: "Matching completed generation event to the first hit-testable graph node.",
        ipcReceiptMs: "Main-process Date.now before event send to renderer Date.now on event receipt; a negative interval invalidates the run.",
        selectionToWorkspaceInteractiveMs: "Renderer click-capture timestamp for project open to the rendered interactive workspace.",
        selectionToClickableGraphMs: "Renderer click-capture timestamp for project open to the first hit-testable graph node."
      },
      firstScreenIpcPayloadEncoding: "UTF-8 JSON byte length of the completed ProjectAnalysisEvent sent to the renderer.",
      processTreeRssSampling: staticGraphProcessTreeRssMeasurement ? {
        source: "app.getAppMetrics workingSetSize summed across Electron-managed processes",
        sampleIntervalMs: PROCESS_TREE_RSS_SAMPLE_INTERVAL_MS,
        actionWindows: runtime.processTreeRssEvidence
      } : { source: "not enabled for this process" },
      scanSelection: {
        scopeSha256: context.selection.scopeSha256,
        sourceInventorySha256: context.selection.sourceInventorySha256,
        sourceFileCount: context.selection.sourcePaths.length,
        configurationFileCount: context.selection.configurationPaths.length,
        scanFingerprint: runtime.scanFingerprint ?? null
      },
      osCacheState: context.osCacheState,
      limitations: Object.values(runtime.unavailableMetrics)
    },
    startedAt,
    endedAt: new Date().toISOString()
  };
  const report = createStaticGraphMeasurementReport(context, reportInput);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  window?.destroy();
  app.exit(0);
}

async function readGitRevision(projectPath: string): Promise<string> {
  const result = await execFileAsync("git", ["-C", projectPath, "rev-parse", "HEAD"], { encoding: "utf8" });
  const revision = result.stdout.trim();
  if (!/^[a-f\d]{40,64}$/i.test(revision)) throw new Error(`Git returned an invalid source revision for ${projectPath}: ${revision}`);
  return revision;
}

function formatMeasurementError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv.includes(GRAPH_SMOKE_TEST_ARGUMENT)) {
  const isolatedUserData = process.env.FLOWWEAVE_GRAPH_SMOKE_USER_DATA;
  if (!isolatedUserData) throw new Error("Graph smoke test requires FLOWWEAVE_GRAPH_SMOKE_USER_DATA.");
  app.setPath("userData", isolatedUserData);
}
if (process.argv.includes(GENERATION_SMOKE_TEST_ARGUMENT)) {
  const isolatedUserData = process.env.FLOWWEAVE_GENERATION_SMOKE_USER_DATA;
  if (!isolatedUserData) throw new Error("Generation smoke test requires FLOWWEAVE_GENERATION_SMOKE_USER_DATA.");
  app.setPath("userData", isolatedUserData);
}
if (process.argv.includes(STATIC_GRAPH_MEASUREMENT_ARGUMENT)) {
  const reportPath = measurementOption("--report", "FLOWWEAVE_STATIC_GRAPH_REPORT");
  const runContextPath = measurementOption("--run-context", "FLOWWEAVE_STATIC_GRAPH_RUN_CONTEXT");
  const runContext: unknown = JSON.parse(readFileSync(runContextPath, "utf8"));
  if (!isMeasurementRecord(runContext) || typeof runContext.projectPath !== "string" || !isAbsolute(runContext.projectPath)) {
    throw new TypeError(`Static graph measurement context has no absolute source checkout path: ${runContextPath}.`);
  }
  const sourceProjectPaths = [runContext.projectPath];
  assertMeasurementOutputIsolatedSync(reportPath, sourceProjectPaths);
  const isolatedUserData = join(dirname(resolve(reportPath)), "user-data");
  assertMeasurementOutputIsolatedSync(isolatedUserData, sourceProjectPaths);
  app.setPath("userData", isolatedUserData);
}

function createWindow(): BrowserWindow {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "flowweave-app-icon.png")
    : join(app.getAppPath(), "logo", "flowweave-app-icon.png");
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    title: "FlowWeave",
    icon: iconPath,
    backgroundColor: "#080a13",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true
    }
  });

  const graphSmokeTraceEnabled = process.argv.includes(GRAPH_SMOKE_TEST_ARGUMENT) &&
    process.env.FLOWWEAVE_GRAPH_SMOKE_REACT_PROFILE === "1";
  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
    if (graphSmokeTraceEnabled) rendererUrl.searchParams.set("flowweave-graph-smoke-trace", "1");
    void window.loadURL(rendererUrl.href);
  } else {
    const rendererPath = join(__dirname, "../renderer/index.html");
    if (graphSmokeTraceEnabled) {
      void window.loadFile(rendererPath, { query: { "flowweave-graph-smoke-trace": "1" } });
    } else {
      void window.loadFile(rendererPath);
    }
  }

  return window;
}

app.whenReady().then(async () => {
  configureTransactionAuthorityRoot(app.getPath("userData"));
  if (process.argv.includes(STATIC_GRAPH_MEASUREMENT_ARGUMENT)) {
    const processLaunchRequestedAtEpochMs = Number(process.env.FLOWWEAVE_STATIC_GRAPH_PROCESS_LAUNCH_REQUEST_EPOCH_MS);
    if (!Number.isSafeInteger(processLaunchRequestedAtEpochMs) || processLaunchRequestedAtEpochMs <= 0 || processLaunchRequestedAtEpochMs > Date.now()) {
      throw new Error("Static graph measurement requires a valid runner process-launch epoch timestamp.");
    }
    const appReadyAtEpochMs = process.env.FLOWWEAVE_STATIC_GRAPH_INSTRUMENTATION_MODE === "on"
      ? Date.now()
      : 0;
    await runStaticGraphMeasurement(processLaunchRequestedAtEpochMs, appReadyAtEpochMs);
    return;
  }
  if (process.platform === "darwin" && app.dock) {
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, "flowweave-app-icon.png")
      : join(app.getAppPath(), "logo", "flowweave-app-icon.png");
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }
  if (process.argv.includes(GENERATION_SMOKE_TEST_ARGUMENT)) {
    await runGenerationSmokeTest();
    return;
  }
  configureAgentRegistry(app.getPath("userData"));
  await configureProjectRegistry(app.getPath("userData"));
  const graphSmokeDetailRaceControl = process.argv.includes(GRAPH_SMOKE_TEST_ARGUMENT) &&
    process.env.FLOWWEAVE_GRAPH_SMOKE_EXPECT === "details-race"
    ? createGraphSmokeDetailRaceControl()
    : undefined;
  const graphSmokePhaseTrace: GraphSmokeTraceEvent[] | undefined = process.argv.includes(GRAPH_SMOKE_TEST_ARGUMENT) &&
    process.env.FLOWWEAVE_GRAPH_SMOKE_REACT_PROFILE === "1"
    ? []
    : undefined;
  const graphSmokeTrace = graphSmokePhaseTrace
    ? (event: GraphSmokeTraceEvent) => graphSmokePhaseTrace.push(event)
    : undefined;
  let graphSmokeProjectId = "";
  if (process.argv.includes(GRAPH_SMOKE_TEST_ARGUMENT)) {
    const fixturePath = process.env.FLOWWEAVE_GRAPH_SMOKE_PROJECT;
    if (!fixturePath) throw new Error("Graph smoke test requires FLOWWEAVE_GRAPH_SMOKE_PROJECT.");
    graphSmokeProjectId = await registerProject(fixturePath);
    const secondProjectPath = process.env.FLOWWEAVE_GRAPH_SMOKE_SECOND_PROJECT;
    const secondProjectId = secondProjectPath ? await registerProject(secondProjectPath) : undefined;
    await saveProjectWorkspaceSession({
      openProjectIds: secondProjectId ? [graphSmokeProjectId, secondProjectId] : [graphSmokeProjectId],
      activeProjectId: graphSmokeProjectId,
      lastPageByProject: { [graphSmokeProjectId]: "canvas" },
      contextsByProject: {}
    });
  }
  registerProjectIpc(undefined, graphSmokeDetailRaceControl, graphSmokeTrace);
  registerAgentIpc();
  registerGitIpc();
  const window = createWindow();
  if (process.argv.includes(GRAPH_SMOKE_TEST_ARGUMENT)) {
    runGraphSmokeTest(window, graphSmokeDetailRaceControl, graphSmokeProjectId, graphSmokePhaseTrace);
    return;
  }
  if (process.argv.includes(SMOKE_TEST_ARGUMENT)) {
    runSmokeTest(window);
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

async function runGenerationSmokeTest(): Promise<void> {
  const projectPath = process.env.FLOWWEAVE_GENERATION_SMOKE_PROJECT;
  const role = process.env.FLOWWEAVE_GENERATION_SMOKE_ROLE;
  const barrier = process.env.FLOWWEAVE_GENERATION_SMOKE_BARRIER;
  const reportPath = process.env.FLOWWEAVE_GENERATION_SMOKE_REPORT;
  if (!projectPath || !reportPath || (role !== "older" && role !== "newer") || (role === "older" && !barrier)) {
    throw new Error("Generation smoke test requires project, report, older/newer role, and an older-process barrier.");
  }
  let reachedBarrier = false;
  const result = await generateProject(projectPath, {
    onProgress: (progress) => {
      if (role !== "older" || reachedBarrier || progress.stage !== "persisting" || !barrier) return;
      reachedBarrier = true;
      writeFileSync(`${barrier}.ready`, String(process.pid));
      while (true) {
        try {
          readFileSync(`${barrier}.release`);
          return;
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    }
  });
  await writeFile(reportPath, `${JSON.stringify({ status: result.status, generation: result.status === "committed" ? result.generation : undefined })}\n`);
  console.log(`FlowWeave packaged generation smoke passed: ${role}=${result.status}.`);
  app.exit(0);
  process.exit(0);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function runSmokeTest(window: BrowserWindow): void {
  const timeout = setTimeout(() => {
    console.error("FlowWeave packaged smoke test timed out.");
    exitSmokeTest(window, 1);
  }, SMOKE_TEST_TIMEOUT_MS);
  window.webContents.once("did-finish-load", () => {
    clearTimeout(timeout);
    console.log("FlowWeave packaged smoke test passed.");
    exitSmokeTest(window, 0);
  });
  window.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
    clearTimeout(timeout);
    console.error("FlowWeave packaged smoke test failed.", {
      errorCode,
      errorDescription
    });
    exitSmokeTest(window, 1);
  });
}

type CanvasViewportSmokeSample = {
  windowWidth: number;
  windowHeight: number;
  stageWidth: number;
  stageHeight: number;
  visibleNodeCount: number;
  overlappingNodePairCount: number;
  edgePaths: number;
  invalidEdgePathCount: number;
  readabilityWarning: boolean;
  readabilityWarningText: string;
  flowZoom: number;
  smallestVisibleTitleFontPx: number | null;
  smallestVisibleBodyFontPx: number | null;
  detailPanelVisible: boolean;
  requiredCanvasControlsReachable: Record<string, boolean>;
};

type GraphSmokeDetailPanelSnapshot = {
  state: string | null;
  title: string | null;
  symbolNames: string[];
  hasAccountSymbol: boolean;
  hasOrderSymbol: boolean;
};

type GraphSmokeDetailsRaceResult = {
  status: "passed";
  elapsedMs: number;
  accountNodeId: string;
  orderNodeId: string;
  heldNodeId: string;
  releasedNodeId: string;
  orderTitle: string;
  beforeRelease: GraphSmokeDetailPanelSnapshot;
  afterRelease: GraphSmokeDetailPanelSnapshot;
};

type GraphSmokeReactProfilerResult = {
  status: "completed" | "failed";
  error?: string;
  reactVersion: string;
  userAgent: string;
  actions: Array<{
    name: string;
    durationMs: number;
    visibleNodeCountBefore: number;
    visibleNodeCountAfter: number;
    visibleNodeIdsBefore: string[];
    visibleNodeIdsAfter: string[];
    visibleEdgeIdsBefore: string[];
    visibleEdgeIdsAfter: string[];
    commitCount: number;
    actualDurationMs: number;
  }>;
  samples: Array<{
    componentId: string;
    phase: "mount" | "update" | "nested-update";
    actualDuration: number;
    baseDuration: number;
    startTime: number;
    commitTime: number;
    action: string;
  }>;
  layoutSnapshots: Array<{
    action: "expand-group" | "collapse-group" | "automatic-layout-refresh";
    status: "persisted";
    layoutMode: "execution" | "dependency";
    userRevision: number;
    positionCount: number;
    handlePositionCount: number;
    matchingPositionCount: number;
    baselineAutoLayoutTopologyFingerprint: string;
    baselineHandleTopologyFingerprint: string;
    autoLayoutTopologyFingerprint: string;
    handleTopologyFingerprint: string;
    runtimeLayoutContext: boolean;
    topologyChanged: boolean;
    collapsedGroups: string[];
    targetGroupPresent?: boolean;
  }>;
};

async function captureGraphSmokeReactProfiler(window: BrowserWindow, projectId: string): Promise<GraphSmokeReactProfilerResult> {
  return window.webContents.executeJavaScript(`(async () => {
    const projectId = ${JSON.stringify(projectId)};
    const layoutStateOnly = ${JSON.stringify(process.env.FLOWWEAVE_GRAPH_SMOKE_LAYOUT_STATE === "1" && process.env.FLOWWEAVE_GRAPH_SMOKE_REACT_PROFILE !== "1")};
    const componentProfile = ${JSON.stringify(process.env.FLOWWEAVE_GRAPH_SMOKE_COMPONENT_PROFILE === "1")};
    const capture = window.__flowweaveReactProfiler;
    const samples = capture?.samples ?? [];
    const visibleGraphIds = () => ({
      nodeIds: [...document.querySelectorAll(".react-flow__node")]
        .filter((node) => getComputedStyle(node).display !== "none")
        .map((node) => node.getAttribute("data-id"))
        .filter(Boolean),
      edgeIds: [...document.querySelectorAll(".react-flow__edge")]
        .filter((edge) => getComputedStyle(edge).display !== "none")
        .map((edge) => edge.getAttribute("data-id"))
        .filter(Boolean)
    });
    const visibleNodeCount = () => visibleGraphIds().nodeIds.length;
    const waitFor = async (predicate, name) => {
      const startedAt = performance.now();
      while (performance.now() - startedAt < 15000) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("React Profiler smoke did not finish action: " + name);
    };
    const samplesFor = (name) => samples.filter((sample) => sample.action === name);
    const actions = [];
    const layoutSnapshots = [];
    const readStoredLayout = async () => {
      const result = await window.flowweave.readCanvas(projectId);
      if (!result || result.mode !== "editable") throw new Error("Graph smoke could not read the persisted Canvas layout.");
      const canvas = result.canvas;
      const layout = canvas.layout;
      const mode = layout.viewMode ?? "execution";
      const positions = layout.autoLayouts[mode] ?? {};
      const handleLayout = layout.autoConnectionHandles?.[mode];
      const autoLayoutTopologyFingerprint = layout.autoLayoutTopologyFingerprints?.[mode];
      const handleTopologyFingerprint = handleLayout?.topologyFingerprint;
      const handlePositions = handleLayout?.positions ?? {};
      const matchingPositionCount = Object.entries(handlePositions).filter(([id, position]) =>
        positions[id]?.x === position.x && positions[id]?.y === position.y
      ).length;
      const handleCount = Object.values(handleLayout?.handles ?? {}).reduce((count, node) =>
        count + node.source.length + node.target.length, 0
      );
      return {
        canvas,
        mode,
        positions,
        handleLayout,
        autoLayoutTopologyFingerprint,
        handleTopologyFingerprint,
        handlePositions,
        matchingPositionCount,
        handleCount
      };
    };
    const waitForStoredLayoutAction = async (action, before, targetGroupNodeId) => {
      const startedAt = performance.now();
      let latest;
      while (performance.now() - startedAt < 15000) {
        latest = await readStoredLayout();
        const autoLayoutTopologyFingerprint = latest.autoLayoutTopologyFingerprint;
        const handleTopologyFingerprint = latest.handleTopologyFingerprint;
        const autoLayoutContext = autoLayoutTopologyFingerprint ? JSON.parse(autoLayoutTopologyFingerprint).context : undefined;
        const runtimeLayoutContext = latest.mode === "dependency" &&
          autoLayoutContext?.projectId === projectId &&
          autoLayoutContext?.generationId === latest.canvas.generation?.requestId &&
          Number.isFinite(autoLayoutContext?.viewport?.width) && autoLayoutContext.viewport.width > 0 &&
          Number.isFinite(autoLayoutContext?.viewport?.height) && autoLayoutContext.viewport.height > 0;
        const topologyChanged = Boolean(autoLayoutTopologyFingerprint && handleTopologyFingerprint &&
          autoLayoutTopologyFingerprint !== before.autoLayoutTopologyFingerprint &&
          handleTopologyFingerprint !== before.handleTopologyFingerprint);
        const targetGroupPresent = targetGroupNodeId === undefined
          ? undefined
          : Object.hasOwn(latest.handlePositions, targetGroupNodeId);
        const matchesExpectedGroupState = action === "expand-group"
          ? targetGroupPresent === false
          : action === "collapse-group"
            ? targetGroupPresent === true
            : true;
        const matchesExpectedLayoutMode = action !== "automatic-layout-refresh" || runtimeLayoutContext;
        if (latest.canvas.userRevision > before.canvas.userRevision && topologyChanged && matchesExpectedGroupState && matchesExpectedLayoutMode &&
          latest.matchingPositionCount === Object.keys(latest.handlePositions).length &&
          latest.handleCount > 0 && Object.keys(latest.positions).length > 0 && Object.keys(latest.handlePositions).length > 0) {
          return {
            action,
            status: "persisted",
            layoutMode: latest.mode,
            userRevision: latest.canvas.userRevision,
            positionCount: Object.keys(latest.positions).length,
            handlePositionCount: Object.keys(latest.handlePositions).length,
            matchingPositionCount: latest.matchingPositionCount,
            baselineAutoLayoutTopologyFingerprint: before.autoLayoutTopologyFingerprint,
            baselineHandleTopologyFingerprint: before.handleTopologyFingerprint,
            autoLayoutTopologyFingerprint,
            handleTopologyFingerprint,
            runtimeLayoutContext,
            topologyChanged,
            collapsedGroups: latest.canvas.layout.collapsedGroups,
            ...(targetGroupPresent === undefined ? {} : { targetGroupPresent })
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Graph smoke did not observe a persisted positions/handles update for " + action + ": " + JSON.stringify({
        userRevision: latest?.canvas.userRevision,
        autoLayoutTopologyFingerprint: latest?.canvas.layout.autoLayoutTopologyFingerprints?.[latest.mode],
        handleTopologyFingerprint: latest?.handleLayout?.topologyFingerprint,
        positionCount: Object.keys(latest?.positions ?? {}).length,
        handlePositionCount: Object.keys(latest?.handlePositions ?? {}).length,
        matchingPositionCount: latest?.matchingPositionCount,
        handleCount: latest?.handleCount,
        collapsedGroups: latest?.canvas.layout.collapsedGroups
      }));
    };
    try {
    const initialStartedAt = samples.find((sample) => sample.action === "initial-render")?.startTime ?? performance.now();
    const initialSamples = samplesFor("initial-render");
    if (capture && initialSamples.length === 0) throw new Error("React Profiler captured no initial CanvasWorkspace commit.");
    const initialGraph = visibleGraphIds();
    actions.push({
      name: "initial-render",
      durationMs: 0,
      visibleNodeCountBefore: 0,
      visibleNodeCountAfter: visibleNodeCount(),
      visibleNodeIdsBefore: [],
      visibleNodeIdsAfter: initialGraph.nodeIds,
      visibleEdgeIdsBefore: [],
      visibleEdgeIdsAfter: initialGraph.edgeIds,
      commitCount: initialSamples.length,
      actualDurationMs: initialSamples.reduce((sum, sample) => sum + sample.actualDuration, 0),
      startedAt: initialStartedAt
    });

    const runAction = async (name, trigger, complete, layoutAction, targetGroupKey) => {
      const beforeGraph = visibleGraphIds();
      const startedAt = performance.now();
      const beforeLayout = layoutAction ? await readStoredLayout() : undefined;
      if (capture) capture.currentAction = name;
      trigger();
      await waitFor(() => complete() && (!capture || samplesFor(name).length > 0), name);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (layoutAction && beforeLayout) layoutSnapshots.push(await waitForStoredLayoutAction(layoutAction, beforeLayout, targetGroupKey));
      const actionSamples = samplesFor(name);
      const afterGraph = visibleGraphIds();
      if (capture) capture.currentAction = "between-actions";
      actions.push({
        name,
        durationMs: performance.now() - startedAt,
        visibleNodeCountBefore: beforeGraph.nodeIds.length,
        visibleNodeCountAfter: afterGraph.nodeIds.length,
        visibleNodeIdsBefore: beforeGraph.nodeIds,
        visibleNodeIdsAfter: afterGraph.nodeIds,
        visibleEdgeIdsBefore: beforeGraph.edgeIds,
        visibleEdgeIdsAfter: afterGraph.edgeIds,
        commitCount: actionSamples.length,
        actualDurationMs: actionSamples.reduce((sum, sample) => sum + sample.actualDuration, 0)
      });
    };

    const firstGroup = document.querySelector(".react-flow__node-groupNode");
    const firstGroupId = firstGroup?.getAttribute("data-id");
    const expandButton = firstGroup?.querySelector("button");
    if (!firstGroupId || !expandButton) throw new Error("React Profiler smoke found no expandable group.");
    const targetGroupNodeId = firstGroupId;
    await runAction("expand-group", () => expandButton.click(), () =>
      ![...document.querySelectorAll(".react-flow__node-groupNode")].some((node) => node.getAttribute("data-id") === firstGroupId) &&
      !document.querySelector(".canvas-flow.layout-pending"), "expand-group", targetGroupNodeId);

    const backButton = document.querySelector(".canvas-view-tools button:has(.lucide-rotate-ccw)");
    if (!(backButton instanceof HTMLButtonElement)) throw new Error("React Profiler smoke found no back-to-overview control.");
    await runAction("collapse-group", () => backButton.click(), () =>
      [...document.querySelectorAll(".react-flow__node-groupNode")].some((node) => node.getAttribute("data-id") === firstGroupId) &&
      !document.querySelector(".canvas-flow.layout-pending"), "collapse-group", targetGroupNodeId);

    const layoutModeSelect = document.querySelectorAll(".canvas-view-tools select")[0];
    if (!(layoutModeSelect instanceof HTMLSelectElement)) throw new Error("React Profiler smoke found no layout-mode selector.");
    const technologySelect = document.querySelectorAll(".canvas-view-tools select")[1];
    if (!(technologySelect instanceof HTMLSelectElement)) throw new Error("React Profiler smoke found no technology filter.");
    const technology = [...technologySelect.options].find((option) => option.value && option.value !== "all");
    if (!technology) throw new Error("React Profiler smoke found no selectable technology value.");
    await runAction("filter-technology", () => {
      technologySelect.value = technology.value;
      technologySelect.dispatchEvent(new Event("change", { bubbles: true }));
    }, () => technologySelect.value === technology.value);

    await runAction("automatic-layout-refresh", () => {
      layoutModeSelect.value = "dependency";
      layoutModeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }, () => layoutModeSelect.value === "dependency", "automatic-layout-refresh");

    if (componentProfile) {
      if (technologySelect.value !== "all") {
        technologySelect.value = "all";
        technologySelect.dispatchEvent(new Event("change", { bubbles: true }));
        await waitFor(() => technologySelect.value === "all" && visibleNodeCount() > 0 &&
          !document.querySelector(".canvas-flow.layout-pending"), "restore-graph-for-component-profile");
      }
      const moduleNode = document.querySelector(".react-flow__node-moduleNode");
      if (!(moduleNode instanceof HTMLElement)) throw new Error("Component profile smoke found no visible module node.");
      await runAction("profile-module-panel", () => moduleNode.click(), () =>
        Boolean(document.querySelector(".module-panel:not(.connection-panel)[data-detail-node-id]")));

      const edge = document.querySelector(".react-flow__edge");
      if (!(edge instanceof SVGGElement)) throw new Error("Component profile smoke found no visible ReactFlow edge.");
      await runAction("profile-connection-panel", () => edge.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window })), () =>
        Boolean(document.querySelector(".connection-panel")));
      for (const componentId of ["CanvasModuleNode", "CanvasGroupNode", "CanvasSmoothStepEdge", "CanvasModulePanel", "CanvasConnectionPanel"]) {
        if (!samples.some((sample) => sample.componentId === componentId)) {
          throw new Error("Component profile smoke captured no samples for " + componentId + ".");
        }
      }
      for (const [action, componentId] of [
        ["profile-module-panel", "CanvasModulePanel"],
        ["profile-connection-panel", "CanvasConnectionPanel"]
      ]) {
        if (!samples.some((sample) => sample.action === action && sample.componentId === componentId)) {
          throw new Error("Component profile smoke captured no " + componentId + " sample during " + action + ".");
        }
      }
    }

    if (layoutStateOnly) {
      return {
        status: "completed",
        reactVersion: capture?.reactVersion ?? "unavailable",
        userAgent: navigator.userAgent,
        actions,
        samples: samples.map((sample) => ({ ...sample })),
        layoutSnapshots
      };
    }

    if (capture) {
      const layoutButton = document.querySelector(".canvas-view-tools button:has(.lucide-layout-grid)");
      if (!(layoutButton instanceof HTMLButtonElement) || layoutButton.disabled) throw new Error("React Profiler smoke found no enabled whole-graph layout control.");
      await runAction("whole-graph-layout", () => layoutButton.click(), () =>
        !layoutButton.disabled && !document.querySelector(".canvas-flow.layout-pending"));
    }
    if (technologySelect.value !== "all") {
      technologySelect.value = "all";
      technologySelect.dispatchEvent(new Event("change", { bubbles: true }));
      const layoutButton = document.querySelector(".canvas-view-tools button:has(.lucide-layout-grid)");
      await waitFor(() => technologySelect.value === "all" && visibleNodeCount() > 0 &&
        !document.querySelector(".canvas-flow.layout-pending") &&
        layoutButton instanceof HTMLButtonElement && !layoutButton.disabled, "clear-smoke-filter");
    }

    return {
      status: "completed",
      reactVersion: capture?.reactVersion ?? "unavailable",
      userAgent: navigator.userAgent,
      actions,
      samples: samples.map((sample) => ({ ...sample })),
      layoutSnapshots
    };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        reactVersion: capture?.reactVersion ?? "unavailable",
        userAgent: navigator.userAgent,
        actions,
        samples: samples.map((sample) => ({ ...sample })),
        layoutSnapshots
      };
    }
  })()`) as Promise<GraphSmokeReactProfilerResult>;
}

function runGraphSmokeTest(
  window: BrowserWindow,
  detailRaceControl: GraphSmokeDetailRaceControl | undefined,
  projectId: string,
  graphSmokePhaseTrace: GraphSmokeTraceEvent[] | undefined
): void {
  const startedAt = performance.now();
  const expected = process.env.FLOWWEAVE_GRAPH_SMOKE_EXPECT;
  if (expected !== "edges" && expected !== "empty" && expected !== "four-languages" && expected !== "save-failure" && expected !== "tab-switch" && expected !== "migration-failure" && expected !== "viewport-only" && expected !== "details-race") {
    throw new Error("Graph smoke test requires FLOWWEAVE_GRAPH_SMOKE_EXPECT=edges, empty, four-languages, save-failure, tab-switch, migration-failure, viewport-only, or details-race.");
  }
  const reportPath = process.env.FLOWWEAVE_GRAPH_SMOKE_REPORT;
  if (!reportPath) throw new Error("Graph smoke test requires FLOWWEAVE_GRAPH_SMOKE_REPORT.");
  type GraphSmokeState = {
    nodes: number;
    nodeIds: string[];
    viewportNodeIds: string[];
    groups: number;
    groupCards: Array<{ id: string | null; text: string; x: number; y: number; opacity: string; visibility: string }>;
    edges: Array<{ id: string; label: string; path: string; markerEnd: string }>;
    edgePaths: number;
    layoutPending: boolean;
    emptyText: string;
    viewMode: string;
    projectStatus: string;
    workspaceVisible: boolean;
    staleBanner: boolean;
    onboardingVisible: boolean;
    modulePanelVisible: boolean;
  };
  let lastState: GraphSmokeState | undefined;
  let workspaceVisibleMs: number | undefined;
  let reactProfilerEvidence: (GraphSmokeReactProfilerResult & {
    appVersion: string;
    electronVersion: string;
    chromeVersion: string;
    nodeVersion: string;
  }) | undefined;
  if (graphSmokePhaseTrace) {
    window.webContents.on("console-message", (_event, _level, message) => {
      try {
        const traceEvent = parseGraphSmokeTraceMessage(message);
        if (traceEvent) graphSmokePhaseTrace.push({ ...traceEvent, observedAtMainMonotonicMs: performance.now() });
      } catch (error) {
        graphSmokePhaseTrace.push({
          source: "main",
          stage: "rendererTrace:invalid",
          monotonicMs: performance.now(),
          error: formatMeasurementError(error)
        });
      }
    });
  }
  const timeout = setTimeout(() => {
    void (async () => {
      let partialProfiler: (GraphSmokeReactProfilerResult & {
        appVersion: string;
        electronVersion: string;
        chromeVersion: string;
        nodeVersion: string;
      }) | undefined;
      if (process.env.FLOWWEAVE_GRAPH_SMOKE_REACT_PROFILE === "1") {
        try {
          const capture = await window.webContents.executeJavaScript(`(() => {
            const capture = window.__flowweaveReactProfiler;
            return capture ? {
              status: "failed",
              error: "Graph smoke timed out before the initial graph and interaction sequence completed.",
              reactVersion: capture.reactVersion,
              userAgent: navigator.userAgent,
              actions: [],
              samples: capture.samples.map((sample) => ({ ...sample }))
            } : {
              status: "failed",
              error: "No React Profiler capture object was present when graph smoke timed out.",
        reactVersion: "unavailable",
        userAgent: navigator.userAgent,
        actions: [],
        samples: [],
        layoutSnapshots: []
            };
          })()`) as GraphSmokeReactProfilerResult;
          partialProfiler = {
            ...capture,
            appVersion: app.getVersion(),
            electronVersion: process.versions.electron,
            chromeVersion: process.versions.chrome,
            nodeVersion: process.versions.node
          };
        } catch (error) {
          console.error("Could not collect partial React Profiler data after graph smoke timeout.", error);
        }
      }
      const report = {
        status: "failed",
        fixture: expected,
        phase: "waiting-for-initial-graph",
        workspaceVisibleMs,
        lastState,
        rendererUrl: window.webContents.getURL(),
        reactProfiler: partialProfiler,
        ...(graphSmokePhaseTrace ? { phaseTrace: graphSmokePhaseTrace } : {}),
        error: { name: "TimeoutError", message: `Graph smoke did not render its initial graph within ${GRAPH_SMOKE_TEST_TIMEOUT_MS} ms.` }
      };
      try {
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        console.error(`FlowWeave graph smoke timeout report written: ${reportPath}.`);
      } catch (error) {
        console.error("Could not write FlowWeave graph smoke timeout report.", error);
      }
      console.error("FlowWeave graph smoke test timed out.", lastState);
      exitSmokeTest(window, 1);
    })().catch((error: unknown) => {
      console.error("FlowWeave graph smoke timeout handling failed.", error);
      exitSmokeTest(window, 1);
    });
  }, GRAPH_SMOKE_TEST_TIMEOUT_MS);
  window.webContents.once("did-finish-load", () => {
    const interval = setInterval(() => {
      void window.webContents.executeJavaScript(`({
        onboardingVisible: (() => {
          const dialog = document.querySelector('.onboarding-dialog');
          if (dialog) dialog.querySelector('button')?.click();
          return Boolean(dialog);
        })(),
        nodes: document.querySelectorAll('.react-flow__node').length,
        nodeIds: [...document.querySelectorAll('.react-flow__node')].map((node) => node.getAttribute('data-id')),
        viewportNodeIds: (() => {
          const stage = document.querySelector('.canvas-flow-stage')?.getBoundingClientRect();
          if (!stage) return [];
          return [...document.querySelectorAll('.react-flow__node')].filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.right > stage.left && rect.left < stage.right && rect.bottom > stage.top && rect.top < stage.bottom;
          }).map((node) => node.getAttribute('data-id'));
        })(),
        groups: document.querySelectorAll('.react-flow__node-groupNode').length,
        groupCards: [...document.querySelectorAll('.react-flow__node-groupNode')].map((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return { id: node.getAttribute('data-id'), text: node.textContent?.slice(0, 60) ?? '', x: rect.x, y: rect.y,
            opacity: style.opacity, visibility: style.visibility };
        }),
        edges: [...document.querySelectorAll('.react-flow__edge')].map((edge) => ({
          id: edge.getAttribute('data-id'),
          label: edge.getAttribute('aria-label'),
          path: edge.querySelector('.react-flow__edge-path')?.getAttribute('d') ?? '',
          markerEnd: edge.querySelector('.react-flow__edge-path')?.getAttribute('marker-end') ?? ''
        })),
        edgePaths: [...document.querySelectorAll('.react-flow__edge-path')].filter((path) => Boolean(path.getAttribute('d'))).length,
        layoutPending: Boolean(document.querySelector('.canvas-layout-pending')),
        emptyText: document.querySelector('.canvas-edge-empty')?.textContent ?? '',
        viewMode: [...document.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'execution'))?.value ?? '',
        projectStatus: document.querySelector('.project-status')?.textContent ?? '',
        workspaceVisible: Boolean(document.querySelector('.canvas-shell')) && !document.querySelector('.onboarding-dialog'),
        staleBanner: Boolean(document.querySelector('.canvas-stale-banner')),
        modulePanelVisible: Boolean(document.querySelector('.module-panel')),
      })`).then(async (state: GraphSmokeState) => {
        lastState = state;
        if (state.workspaceVisible && workspaceVisibleMs === undefined) workspaceVisibleMs = Math.round(performance.now() - startedAt);
        if (state.onboardingVisible) return;
        if (expected === "migration-failure") {
          if (!/failed|失败/i.test(state.projectStatus)) return;
        } else {
          if (state.nodes < 2 || state.layoutPending) return;
          if (state.viewMode !== "execution") throw new Error(`Graph smoke opened unexpected view: ${state.viewMode}`);
          if (state.groupCards.some((card) => card.visibility !== "visible")) return;
        }
        const passed = expected === "migration-failure"
          ? state.nodes === 0 && /failed|失败/i.test(state.projectStatus)
          : expected !== "empty"
          ? state.edgePaths > 0 && state.edges.every((edge) => edge.path && edge.markerEnd && !/NaN|Infinity/.test(edge.path))
          : state.edgePaths === 0 && state.emptyText.includes("No evidenced cross-module relationships");
        if (!passed) return;
        if (state.modulePanelVisible) throw new Error("Graph opened with a module details panel selected by default.");
        clearTimeout(timeout);
        clearInterval(interval);
        const graphRenderedMs = Math.round(performance.now() - startedAt);
        const screenshotPath = process.env.FLOWWEAVE_GRAPH_SMOKE_SCREENSHOT;
        if (screenshotPath) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          await writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());
        }
        const keyboardNavigation = expected === "four-languages"
          ? await verifyKeyboardGroupExpansion(window)
          : undefined;
        const captureLayoutState = process.env.FLOWWEAVE_GRAPH_SMOKE_LAYOUT_STATE === "1";
        const captureReactProfile = process.env.FLOWWEAVE_GRAPH_SMOKE_REACT_PROFILE === "1";
        if (captureLayoutState || captureReactProfile) {
          const capture = await captureGraphSmokeReactProfiler(window, projectId);
          reactProfilerEvidence = {
            ...capture,
            appVersion: app.getVersion(),
            electronVersion: process.versions.electron,
            chromeVersion: process.versions.chrome,
            nodeVersion: process.versions.node
          };
          if (capture.status === "failed") {
            throw new Error(`React Profiler smoke failed after ${capture.actions.length} actions and ${capture.samples.length} commits: ${capture.error ?? "unknown failure"}.`);
          }
          if (captureReactProfile) {
            const filterAction = capture.actions.find((action) => action.name === "filter-technology");
            if (!filterAction || !hasCanvasProfilerGraphChange(
              { nodeIds: filterAction.visibleNodeIdsBefore, edgeIds: filterAction.visibleEdgeIdsBefore },
              { nodeIds: filterAction.visibleNodeIdsAfter, edgeIds: filterAction.visibleEdgeIdsAfter }
            )) {
              const error = "React Profiler smoke technology filter did not change visible node or edge membership.";
              reactProfilerEvidence.status = "failed";
              reactProfilerEvidence.error = error;
              throw new Error(error);
            }
          }
          if (captureLayoutState && !captureReactProfile) {
            await writeFile(reportPath, `${JSON.stringify({
              status: "completed",
              fixture: expected,
              reactProfiler: reactProfilerEvidence,
              ...(graphSmokePhaseTrace ? { phaseTrace: graphSmokePhaseTrace } : {}),
              mainRssMiB: Math.round(process.memoryUsage().rss / 1048576)
            }, null, 2)}\n`, "utf8");
            console.log("FlowWeave persisted layout-state smoke test passed.");
            exitSmokeTest(window, 0);
            return;
          }
        }
        const detailsRace = expected === "details-race"
          ? await verifyGraphSmokeDetailsRace(window, detailRaceControl)
          : undefined;
        const nodeClick = expected === "migration-failure" || expected === "details-race" ? undefined : await window.webContents.executeJavaScript(`new Promise((resolve) => {
          const stage = document.querySelector('.canvas-flow-stage')?.getBoundingClientRect();
          const node = [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-groupNode)')].find((candidate) => {
            if (!stage) return false;
            const rect = candidate.getBoundingClientRect();
            const x = (Math.max(rect.left, stage.left) + Math.min(rect.right, stage.right)) / 2;
            const y = (Math.max(rect.top, stage.top) + Math.min(rect.bottom, stage.bottom)) / 2;
            return rect.right > stage.left && rect.left < stage.right && rect.bottom > stage.top && rect.top < stage.bottom &&
              document.elementFromPoint(x, y)?.closest('.react-flow__node') === candidate;
          });
          if (!node) { resolve({ ready: false }); return; }
          const started = performance.now();
          node.click();
          const interval = setInterval(() => {
            const state = document.querySelector('.module-panel')?.getAttribute('data-detail-state');
            if (state === 'ready' || state === 'error' || performance.now() - started > 7000) {
              clearInterval(interval);
              resolve({ ready: state === 'ready', elapsedMs: Math.round(performance.now() - started) });
            }
          }, 25);
        })`) as { ready: boolean; elapsedMs?: number };
        if (nodeClick?.ready === false) throw new Error("Graph node did not open its module details panel.");
        const viewportSamples = expected === "four-languages" || expected === "viewport-only"
          ? await captureCanvasViewports(window, screenshotPath)
          : [];
        const closeSavedTitle = expected === "edges" ? await verifyCanvasSaveOnClose(window) : undefined;
        const failedSavePreservedEdit = expected === "save-failure" ? await verifyFailedSaveStopsRefresh(window) : undefined;
        const switchSavedTitle = expected === "tab-switch" ? await verifyProjectSwitchSaveBarrier(window) : undefined;
        await writeFile(reportPath, `${JSON.stringify({
          status: "completed",
          fixture: expected,
          ...state,
          workspaceVisibleMs,
          graphRenderedMs,
          nodeClickableMs: detailsRace ? detailsRace.elapsedMs : nodeClick?.ready ? Math.round(performance.now() - startedAt) : undefined,
          detailPanelMs: detailsRace?.elapsedMs ?? nodeClick?.elapsedMs,
          detailsRace,
          closeSavedTitle,
          failedSavePreservedEdit,
          switchSavedTitle,
          keyboardNavigation,
          reactProfiler: reactProfilerEvidence,
          ...(graphSmokePhaseTrace ? { phaseTrace: graphSmokePhaseTrace } : {}),
          viewportSamples,
          mainRssMiB: Math.round(process.memoryUsage().rss / 1048576)
        }, null, 2)}\n`, "utf8");
        console.log(`FlowWeave graph smoke test passed: ${expected}.`);
        exitSmokeTest(window, 0);
      }).catch(async (error: unknown) => {
        clearTimeout(timeout);
        clearInterval(interval);
        console.error("FlowWeave graph smoke test failed.", error);
        try {
          await writeFile(reportPath, `${JSON.stringify({
            status: "failed",
            fixture: expected,
            workspaceVisibleMs,
            lastState,
            detailsRace: expected === "details-race"
              ? { status: "failed", barrier: detailRaceControl?.readState() ?? null }
              : undefined,
            reactProfiler: reactProfilerEvidence,
            ...(graphSmokePhaseTrace ? { phaseTrace: graphSmokePhaseTrace } : {}),
            error: error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { message: String(error) }
          }, null, 2)}\n`, "utf8");
          console.error(`FlowWeave graph smoke failure report written: ${reportPath}.`);
        } catch (reportError) {
          console.error("Could not write FlowWeave graph smoke failure report.", reportError);
        }
        exitSmokeTest(window, 1);
      });
    }, 250);
  });
  window.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
    clearTimeout(timeout);
    console.error("FlowWeave graph smoke test failed.", { errorCode, errorDescription });
    exitSmokeTest(window, 1);
  });
}

async function verifyGraphSmokeDetailsRace(
  window: BrowserWindow,
  control: GraphSmokeDetailRaceControl | undefined
): Promise<GraphSmokeDetailsRaceResult> {
  if (!control) throw new Error("The details-race fixture did not install its graph-smoke-only IPC barrier.");
  const startedAt = performance.now();
  const evidence: {
    checkpoint: string;
    accountNodeId?: string;
    orderNodeId?: string;
    heldNodeId?: string;
    releasedNodeId?: string;
    beforeRelease?: GraphSmokeDetailPanelSnapshot;
    afterRelease?: GraphSmokeDetailPanelSnapshot;
  } = { checkpoint: "project graph lookup" };
  try {
    const projectPath = process.env.FLOWWEAVE_GRAPH_SMOKE_PROJECT;
    if (!projectPath) throw new Error("The details-race fixture has no project path.");
    const canvas = await readProjectProtocolCanvas(projectPath);
    const accountNode = canvas?.nodes.find((node) => node.files.includes("src/features/accounts/account.service.ts"));
    const orderNode = canvas?.nodes.find((node) => node.files.includes("src/features/orders/order.service.ts"));
    if (!accountNode || !orderNode || accountNode.id === orderNode.id || accountNode.title === orderNode.title) {
      throw new Error(`The details-race fixture did not produce two distinct account/order modules: ${JSON.stringify({ accountNode, orderNode })}.`);
    }
    evidence.accountNodeId = accountNode.id;
    evidence.orderNodeId = orderNode.id;
    const visibleNodeIds = await window.webContents.executeJavaScript(`(() => {
      const stage = document.querySelector('.canvas-flow-stage')?.getBoundingClientRect();
      if (!stage) return [];
      return [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-groupNode)')].filter((node) => {
        const rect = node.getBoundingClientRect();
        const x = (Math.max(rect.left, stage.left) + Math.min(rect.right, stage.right)) / 2;
        const y = (Math.max(rect.top, stage.top) + Math.min(rect.bottom, stage.bottom)) / 2;
        return rect.right > stage.left && rect.left < stage.right && rect.bottom > stage.top && rect.top < stage.bottom &&
          document.elementFromPoint(x, y)?.closest('.react-flow__node') === node;
      }).map((node) => node.getAttribute('data-id')).filter((id) => typeof id === 'string');
    })()`) as string[];
    if (!visibleNodeIds.includes(accountNode.id) || !visibleNodeIds.includes(orderNode.id)) {
      throw new Error(`The account/order detail-race nodes are not both hit-testable: ${JSON.stringify({ visibleNodeIds, accountNodeId: accountNode.id, orderNodeId: orderNode.id })}.`);
    }

    evidence.checkpoint = "select account and hold its detail response";
    await clickGraphSmokeModule(window, accountNode.id);
    const heldNodeId = await waitForGraphSmokePromise(
      control.waitForFirstResponseArrival(),
      10_000,
      "first node-detail response arrival",
      () => control.readState()
    );
    evidence.heldNodeId = heldNodeId;
    if (heldNodeId !== accountNode.id) {
      throw new Error(`The held first detail response was not for the selected account module: ${JSON.stringify({ heldNodeId, accountNodeId: accountNode.id })}.`);
    }
    const accountPending = await window.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.module-panel');
      return { state: panel?.getAttribute('data-detail-state') ?? null, title: panel?.querySelector('.hero-card h2')?.textContent?.trim() ?? null };
    })()`) as { state: string | null; title: string | null };
    if (accountPending.state !== "loading" || accountPending.title !== accountNode.title) {
      throw new Error(`The account detail panel did not stay pending while its response was held: ${JSON.stringify(accountPending)}.`);
    }

    evidence.checkpoint = "select order and verify its detail before releasing account";
    await clickGraphSmokeModule(window, orderNode.id);
    const beforeRelease = await readGraphSmokeDetailPanel(
      window,
      orderNode.title,
      "loadAccountDetailRaceMarker",
      "loadOrderDetailRaceMarker",
      10_000
    );
    evidence.beforeRelease = beforeRelease;
    if (!beforeRelease.hasOrderSymbol || beforeRelease.hasAccountSymbol) {
      throw new Error(`The order panel did not show only its unique detail symbol before releasing account: ${JSON.stringify(beforeRelease)}.`);
    }

    evidence.checkpoint = "release the late account response";
    control.releaseFirstResponse();
    const releasedNodeId = await waitForGraphSmokePromise(
      control.waitForFirstResponseRelease(),
      7_000,
      "held node-detail response release",
      () => control.readState()
    );
    evidence.releasedNodeId = releasedNodeId;
    if (releasedNodeId !== accountNode.id) {
      throw new Error(`The released late response identity changed: ${JSON.stringify({ releasedNodeId, accountNodeId: accountNode.id })}.`);
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 300));
    evidence.checkpoint = "verify order remains selected after account response arrives";
    const afterRelease = await readGraphSmokeDetailPanel(
      window,
      orderNode.title,
      "loadAccountDetailRaceMarker",
      "loadOrderDetailRaceMarker",
      7_000
    );
    evidence.afterRelease = afterRelease;
    if (!afterRelease.hasOrderSymbol || afterRelease.hasAccountSymbol ||
      beforeRelease.title !== afterRelease.title || beforeRelease.symbolNames.join("\u0000") !== afterRelease.symbolNames.join("\u0000")) {
      throw new Error(`The late account response changed the current order details: ${JSON.stringify({ beforeRelease, afterRelease })}.`);
    }

    return {
      status: "passed",
      elapsedMs: Math.round(performance.now() - startedAt),
      accountNodeId: accountNode.id,
      orderNodeId: orderNode.id,
      heldNodeId,
      releasedNodeId,
      orderTitle: orderNode.title,
      beforeRelease,
      afterRelease
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Graph smoke details race failed: ${message}; evidence=${JSON.stringify({ ...evidence, barrier: control.readState() })}`, { cause: error });
  } finally {
    control.releaseFirstResponse();
  }
}

async function clickGraphSmokeModule(window: BrowserWindow, nodeId: string): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const targetId = ${JSON.stringify(nodeId)};
    const node = [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-groupNode)')]
      .find((candidate) => candidate.getAttribute('data-id') === targetId);
    const stage = document.querySelector('.canvas-flow-stage')?.getBoundingClientRect();
    if (!node || !stage) return false;
    const rect = node.getBoundingClientRect();
    const x = (Math.max(rect.left, stage.left) + Math.min(rect.right, stage.right)) / 2;
    const y = (Math.max(rect.top, stage.top) + Math.min(rect.bottom, stage.bottom)) / 2;
    if (rect.right <= stage.left || rect.left >= stage.right || rect.bottom <= stage.top || rect.top >= stage.bottom ||
      document.elementFromPoint(x, y)?.closest('.react-flow__node') !== node) return false;
    node.click();
    return true;
  })()`) as boolean;
  if (!clicked) throw new Error(`Graph smoke could not click the hit-testable node ${nodeId}.`);
}

async function readGraphSmokeDetailPanel(
  window: BrowserWindow,
  expectedTitle: string,
  accountSymbol: string,
  orderSymbol: string,
  timeoutMs: number
): Promise<GraphSmokeDetailPanelSnapshot> {
  return window.webContents.executeJavaScript(`(async () => {
    const expectedTitle = ${JSON.stringify(expectedTitle)};
    const accountSymbol = ${JSON.stringify(accountSymbol)};
    const orderSymbol = ${JSON.stringify(orderSymbol)};
    const startedAt = performance.now();
    let latest = { state: null, title: null };
    while (performance.now() - startedAt < ${timeoutMs}) {
      const panel = document.querySelector('.module-panel');
      const state = panel?.getAttribute('data-detail-state') ?? null;
      const title = panel?.querySelector('.hero-card h2')?.textContent?.trim() ?? null;
      latest = { state, title };
      if (panel && state === 'ready' && title === expectedTitle) {
        const filesSection = [...panel.querySelectorAll('.collapsible-card')]
          .find((section) => Boolean(section.querySelector('.module-file-tree')));
        const symbolsSection = filesSection?.nextElementSibling;
        const symbolsHeader = symbolsSection?.querySelector('.collapsible-card-header');
        if (!(symbolsSection instanceof HTMLElement) || !(symbolsHeader instanceof HTMLButtonElement)) {
          throw new Error('Module panel did not render its symbols section after the files section.');
        }
        if (symbolsHeader.getAttribute('aria-expanded') !== 'true') symbolsHeader.click();
        await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame(undefined)));
        const symbolNames = [...symbolsSection.querySelectorAll('.detail-row > strong')]
          .map((element) => element.textContent?.trim() ?? '').filter(Boolean);
        return {
          state,
          title,
          symbolNames,
          hasAccountSymbol: symbolNames.includes(accountSymbol),
          hasOrderSymbol: symbolNames.includes(orderSymbol)
        };
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new Error('Module detail panel did not reach the expected ready state: ' + JSON.stringify({ expectedTitle, latest }));
  })()`) as Promise<GraphSmokeDetailPanelSnapshot>;
}

function waitForGraphSmokePromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  readDiagnostics: () => unknown
): Promise<T> {
  return new Promise<T>((resolveResult, rejectResult) => {
    const timeout = setTimeout(() => {
      rejectResult(new Error(`${label} timed out after ${timeoutMs} ms: ${JSON.stringify(readDiagnostics())}.`));
    }, timeoutMs);
    void promise.then((value) => {
      clearTimeout(timeout);
      resolveResult(value);
    }, (error: unknown) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
  });
}

async function verifyKeyboardGroupExpansion(window: BrowserWindow): Promise<{
  groupNodeId: string;
  expandedFocusedNodeId: string;
  overviewFocusedNodeId: string;
  enterInputDiagnostics: {
    windowFocused: boolean;
    documentHasFocus: boolean;
    events: Array<{
      type: string;
      key: string | null;
      code: string | null;
      targetTag: string | null;
      targetText: string;
      activeNodeId: string | null;
      defaultPrevented: boolean;
      atMs: number;
    }>;
  };
}> {
  if (!window.isVisible()) window.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  window.focus();
  const focusStartedAt = Date.now();
  let documentHasFocus = false;
  while (Date.now() - focusStartedAt < 7000) {
    documentHasFocus = await window.webContents.executeJavaScript(`document.hasFocus()`) as boolean;
    if (window.isFocused() && documentHasFocus) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  if (!window.isFocused() || !documentHasFocus) {
    throw new Error(`Electron graph smoke window did not gain focus before keyboard input: ${JSON.stringify({
      windowFocused: window.isFocused(),
      documentHasFocus,
      windowVisible: window.isVisible(),
      windowFocusable: window.isFocusable(),
      appHidden: process.platform === "darwin" ? app.isHidden() : undefined
    })}.`);
  }
  const groupNodeId = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('.react-flow__node-groupNode button');
    const nodeId = button?.closest('.react-flow__node')?.getAttribute('data-id');
    button?.focus();
    return nodeId;
  })()`) as string | null;
  if (!groupNodeId) throw new Error("Four-language graph smoke has no keyboard-expandable group.");
  const inputState = await window.webContents.executeJavaScript(`(() => {
    const events = [];
    const button = document.querySelector('.react-flow__node-groupNode button');
    const record = (type, event) => events.push({
      type,
      key: typeof event.key === 'string' ? event.key : null,
      code: typeof event.code === 'string' ? event.code : null,
      targetTag: event.target instanceof HTMLElement ? event.target.tagName : null,
      targetText: event.target instanceof HTMLElement ? event.target.textContent?.trim().slice(0, 40) ?? '' : '',
      activeNodeId: document.activeElement?.closest('.react-flow__node')?.getAttribute('data-id') ?? null,
      defaultPrevented: event.defaultPrevented,
      atMs: Math.round(performance.now() * 10) / 10
    });
    document.addEventListener('keydown', (event) => record('keydown', event), true);
    document.addEventListener('keyup', (event) => record('keyup', event), true);
    document.addEventListener('click', (event) => {
      if (event.target instanceof Node && button?.contains(event.target)) record('button-click', event);
    }, true);
    window.__flowweaveGraphSmokeKeyboardEvents = events;
    return {
      documentHasFocus: document.hasFocus(),
      buttonFocused: document.activeElement === button,
      activeTag: document.activeElement?.tagName ?? null,
      activeNodeId: document.activeElement?.closest('.react-flow__node')?.getAttribute('data-id') ?? null
    };
  })()`) as { documentHasFocus: boolean; buttonFocused: boolean; activeTag: string | null; activeNodeId: string | null };
  if (!inputState.buttonFocused) throw new Error(`Group expand button did not receive keyboard focus: ${JSON.stringify(inputState)}.`);
  const windowFocusedBeforeInput = window.isFocused();
  await sendGraphSmokeKeyboardInput(window, "ENTER");
  const focusResult = await window.webContents.executeJavaScript(`new Promise((resolve) => {
    function readFocusState() {
      const active = document.activeElement;
      const group = document.querySelector('.react-flow__node-groupNode');
      return {
        focusedNodeId: active?.closest('.react-flow__node')?.getAttribute('data-id') ?? null,
        activeTag: active?.tagName ?? null,
        activeText: active?.textContent?.trim().slice(0, 80) ?? '',
        activeClass: active?.className ?? '',
        groupStillPresent: Boolean(group),
        groupText: group?.textContent?.trim().slice(0, 120) ?? '',
        visibleNodeIds: [...document.querySelectorAll('.react-flow__node:not([style*="display: none"])')]
          .map((node) => node.getAttribute('data-id')).filter(Boolean).slice(0, 20)
      };
    }
    const started = performance.now();
    const interval = setInterval(() => {
      const state = readFocusState();
      if (state.focusedNodeId && state.focusedNodeId !== ${JSON.stringify(groupNodeId)}) {
        clearInterval(interval);
        resolve(state);
      } else if (performance.now() - started > 7000) {
        clearInterval(interval);
        resolve(state);
      }
    }, 25);
  })`) as { focusedNodeId: string | null };
  if (!focusResult.focusedNodeId || focusResult.focusedNodeId === groupNodeId) {
    const events = await window.webContents.executeJavaScript(`window.__flowweaveGraphSmokeKeyboardEvents ?? []`) as Array<{
      type: string;
      key: string | null;
      code: string | null;
      targetTag: string | null;
      targetText: string;
      activeNodeId: string | null;
      defaultPrevented: boolean;
      atMs: number;
    }>;
    throw new Error(`Keyboard expansion did not move focus into the opened group ${groupNodeId}: ${JSON.stringify({
      focusResult,
      windowFocusedBeforeInput,
      documentHasFocusBeforeInput: inputState.documentHasFocus,
      inputState,
      events
    })}.`);
  }
  const enterEvents = await window.webContents.executeJavaScript(`window.__flowweaveGraphSmokeKeyboardEvents ?? []`) as Array<{
    type: string;
    key: string | null;
    code: string | null;
    targetTag: string | null;
    targetText: string;
    activeNodeId: string | null;
    defaultPrevented: boolean;
    atMs: number;
  }>;
  await sendGraphSmokeKeyboardInput(window, "ESC");
  const returnResult = await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = performance.now();
    const interval = setInterval(() => {
      const active = document.activeElement;
      const focusedNodeId = active?.closest('.react-flow__node')?.getAttribute('data-id') ?? null;
      const groupCard = [...document.querySelectorAll('.react-flow__node-groupNode')]
        .find((node) => node.getAttribute('data-id') === ${JSON.stringify(groupNodeId)});
      const rect = groupCard?.getBoundingClientRect();
      const state = {
        focusedNodeId,
        groupCardVisible: Boolean(groupCard && rect && rect.width > 0 && rect.height > 0),
        expandedGroupCardCount: document.querySelectorAll('.react-flow__node-groupNode').length
      };
      if (state.focusedNodeId === ${JSON.stringify(groupNodeId)} && state.groupCardVisible) {
        clearInterval(interval);
        resolve(state);
      } else if (performance.now() - started > 7000) {
        clearInterval(interval);
        resolve(state);
      }
    }, 25);
  })`) as { focusedNodeId: string | null; groupCardVisible: boolean; expandedGroupCardCount: number };
  if (returnResult.focusedNodeId !== groupNodeId || !returnResult.groupCardVisible) {
    throw new Error(`Escape did not return to overview and restore focus to group ${groupNodeId}: ${JSON.stringify(returnResult)}.`);
  }
  return {
    groupNodeId,
    expandedFocusedNodeId: focusResult.focusedNodeId,
    overviewFocusedNodeId: returnResult.focusedNodeId,
    enterInputDiagnostics: {
      windowFocused: windowFocusedBeforeInput,
      documentHasFocus: inputState.documentHasFocus,
      events: enterEvents
    }
  };
}

async function sendGraphSmokeKeyboardInput(window: BrowserWindow, keyCode: "ENTER" | "ESC"): Promise<void> {
  if (process.env.FLOWWEAVE_GRAPH_SMOKE_NATIVE_KEYBOARD === "1") {
    const keyName = keyCode === "ENTER" ? "Return" : "Escape";
    console.log(`FlowWeave graph smoke is ready for native ${keyName} input.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20_000));
    return;
  }
  window.webContents.sendInputEvent({ type: "keyDown", keyCode });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode });
}

async function captureCanvasViewports(
  window: BrowserWindow,
  baseScreenshotPath: string | undefined
): Promise<Array<CanvasViewportSmokeSample>> {
  const originalSize = window.getSize();
  const sizes = [
    { width: 960, height: 640 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 }
  ];
  const samples: Array<CanvasViewportSmokeSample> = [];
  try {
    for (const size of sizes) {
      window.setSize(size.width, size.height);
      await new Promise((resolve) => setTimeout(resolve, 450));
      const sample = await window.webContents.executeJavaScript(`(() => {
        const stage = document.querySelector('.canvas-flow-stage')?.getBoundingClientRect();
        if (!stage) return undefined;
        const viewport = document.querySelector('.react-flow__viewport');
        const viewportTransform = viewport ? getComputedStyle(viewport).transform : 'none';
        const flowZoom = viewportTransform === 'none' ? 1 : new DOMMatrixReadOnly(viewportTransform).a;
        const controlReachability = (selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
          const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
          const target = document.elementFromPoint(x, y);
          return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 &&
            rect.right <= window.innerWidth && rect.bottom <= window.innerHeight &&
            Boolean(target && (target === element || element.contains(target)));
        };
        const visibleNodes = [...document.querySelectorAll('.react-flow__node')].filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.right > stage.left && rect.left < stage.right && rect.bottom > stage.top && rect.top < stage.bottom;
        });
        const overlappingNodePairCount = visibleNodes.reduce((count, node, index) => {
          const rect = node.getBoundingClientRect();
          return count + visibleNodes.slice(index + 1).filter((other) => {
            const otherRect = other.getBoundingClientRect();
            return Math.min(rect.right, otherRect.right, stage.right) - Math.max(rect.left, otherRect.left, stage.left) > 1 &&
              Math.min(rect.bottom, otherRect.bottom, stage.bottom) - Math.max(rect.top, otherRect.top, stage.top) > 1;
          }).length;
        }, 0);
        const paths = [...document.querySelectorAll('.react-flow__edge-path')].map((path) => path.getAttribute('d') ?? '');
        return {
          stageWidth: Math.round(stage.width),
          stageHeight: Math.round(stage.height),
          visibleNodeCount: visibleNodes.length,
          overlappingNodePairCount,
          edgePaths: paths.filter(Boolean).length,
          invalidEdgePathCount: paths.filter((path) => /NaN|Infinity/.test(path)).length,
          readabilityWarning: Boolean(document.querySelector('.canvas-readability-warning')),
          readabilityWarningText: document.querySelector('.canvas-readability-warning')?.textContent?.trim() ?? '',
          flowZoom,
          smallestVisibleTitleFontPx: (() => {
            const sizes = visibleNodes.flatMap((node) => [...node.querySelectorAll('h3')]
              .map((element) => Number.parseFloat(getComputedStyle(element).fontSize) * flowZoom)
            ).filter(Number.isFinite);
            return sizes.length ? Math.min(...sizes) : null;
          })(),
          smallestVisibleBodyFontPx: (() => {
            const sizes = visibleNodes.flatMap((node) => [...node.querySelectorAll('p')]
              .map((element) => Number.parseFloat(getComputedStyle(element).fontSize) * flowZoom)
            ).filter(Number.isFinite);
            return sizes.length ? Math.min(...sizes) : null;
          })(),
          detailPanelVisible: Boolean(document.querySelector('.module-panel')),
          requiredCanvasControlsReachable: {
            search: controlReachability('.canvas-module-search input'),
            viewMode: controlReachability('.canvas-view-tools select'),
            relationDisplay: controlReachability('.canvas-relation-display > summary'),
            filters: controlReachability('.canvas-filter-display > summary'),
            autoLayout: controlReachability('.canvas-control-auto-layout'),
            canvasNavigation: controlReachability('.react-flow__controls button:not([disabled])')
          }
        };
      })()`) as Omit<CanvasViewportSmokeSample, "windowWidth" | "windowHeight"> | undefined;
      if (!sample || sample.stageWidth < 1 || sample.stageHeight < 1 || sample.visibleNodeCount < 1 ||
        sample.overlappingNodePairCount > 0 || sample.invalidEdgePathCount > 0) {
        throw new Error(`Canvas did not remain navigable after resizing to ${size.width}x${size.height}: ${JSON.stringify(sample)}.`);
      }
      const result = {
        ...sample,
        smallestVisibleTitleFontPx: Number.isFinite(sample.smallestVisibleTitleFontPx) ? sample.smallestVisibleTitleFontPx : null,
        smallestVisibleBodyFontPx: Number.isFinite(sample.smallestVisibleBodyFontPx) ? sample.smallestVisibleBodyFontPx : null,
        windowWidth: size.width,
        windowHeight: size.height
      };
      if (!result.detailPanelVisible) throw new Error(`Details pane disappeared during viewport smoke at ${size.width}x${size.height}.`);
      samples.push(result);
      if (baseScreenshotPath) {
        const viewportScreenshotPath = baseScreenshotPath.replace(/\.png$/i, `-viewport-${size.width}x${size.height}.png`);
        await writeFile(viewportScreenshotPath, (await window.webContents.capturePage()).toPNG());
      }
    }
  } finally {
    window.setSize(originalSize[0], originalSize[1]);
  }
  return samples;
}

async function verifyCanvasSaveOnClose(window: BrowserWindow): Promise<string> {
  const projectPath = process.env.FLOWWEAVE_GRAPH_SMOKE_PROJECT;
  if (!projectPath) throw new Error("Canvas close smoke test has no project path.");
  const edit = await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const input = document.querySelector('.module-panel .module-edit-card input');
    if (!(input instanceof HTMLInputElement)) { resolve({ updated: false }); return; }
    const title = 'Close barrier ' + Date.now();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, title);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => resolve({ title, updated: document.querySelector('.module-panel .hero-card h2')?.textContent === title }), 0);
  })`) as { title?: string; updated: boolean };
  if (!edit.updated || !edit.title) throw new Error("Canvas close smoke could not submit the module edit.");
  await new Promise<void>((resolveClosed, reject) => {
    const timeout = setTimeout(() => reject(new Error("Canvas close save barrier did not finish within 10 seconds.")), 10_000);
    window.once("closed", () => { clearTimeout(timeout); resolveClosed(); });
    window.close();
  });
  const userState = JSON.parse(await readFile(join(projectPath, ".flowweave", "canvas", "user-state.json"), "utf8")) as {
    nodeEdits: Record<string, { title?: string }>;
  };
  if (!Object.values(userState.nodeEdits).some((item) => item.title === edit.title)) {
    throw new Error(`Canvas close save barrier lost the module edit: project ${projectPath}, title ${edit.title}.`);
  }
  return edit.title;
}

async function verifyFailedSaveStopsRefresh(window: BrowserWindow): Promise<boolean> {
  const projectPath = process.env.FLOWWEAVE_GRAPH_SMOKE_PROJECT;
  if (!projectPath) throw new Error("Canvas failed-save smoke test has no project path.");
  const flowweavePath = join(projectPath, ".flowweave");
  const blockedJournal = join(flowweavePath, "transaction.json");
  const beforeManifest = await readFile(join(flowweavePath, "generation.json"), "utf8");
  const beforeUserState = await readFile(join(flowweavePath, "canvas", "user-state.json"), "utf8");
  await mkdir(blockedJournal);
  try {
    const edit = await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const input = document.querySelector('.module-panel .module-edit-card input');
      const refresh = document.querySelector('.project-action-row button:nth-child(2)');
      if (!(input instanceof HTMLInputElement) || !(refresh instanceof HTMLButtonElement)) {
        resolve({ updated: false, refreshed: false }); return;
      }
      const title = 'Failed save ' + Date.now();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, title);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        const updated = document.querySelector('.module-panel .hero-card h2')?.textContent === title;
        refresh.click();
        resolve({ title, updated, refreshed: true });
      }, 0);
    })`) as { title?: string; updated: boolean; refreshed: boolean };
    if (!edit.updated || !edit.refreshed || !edit.title) throw new Error("Canvas failed-save smoke could not submit the edit and refresh.");
    const result = await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const started = performance.now();
      const interval = setInterval(() => {
        const status = document.querySelector('.project-status')?.textContent ?? '';
        if (/failed|失败|error|错误/i.test(status) || performance.now() - started > 7000) {
          clearInterval(interval);
          resolve({ status, title: document.querySelector('.module-panel .hero-card h2')?.textContent ?? '',
            nodes: document.querySelectorAll('.react-flow__node').length });
        }
      }, 25);
    })`) as { status: string; title: string; nodes: number };
    const afterManifest = await readFile(join(flowweavePath, "generation.json"), "utf8");
    const afterUserState = await readFile(join(flowweavePath, "canvas", "user-state.json"), "utf8");
    if (result.title !== edit.title || result.nodes === 0 || !/failed|失败|error|错误/i.test(result.status) ||
      afterManifest !== beforeManifest || afterUserState !== beforeUserState) {
      throw new Error(`Canvas failed-save smoke lost the edit or started a scan: ${JSON.stringify(result)}.`);
    }
    return true;
  } finally {
    await rm(blockedJournal, { recursive: true, force: true });
  }
}

async function verifyProjectSwitchSaveBarrier(window: BrowserWindow): Promise<string> {
  const projectPath = process.env.FLOWWEAVE_GRAPH_SMOKE_PROJECT;
  const secondProjectPath = process.env.FLOWWEAVE_GRAPH_SMOKE_SECOND_PROJECT;
  if (!projectPath || !secondProjectPath) throw new Error("Project-switch smoke test requires two project paths.");
  const flowweavePath = join(projectPath, ".flowweave");
  const blockedJournal = join(flowweavePath, "transaction.json");
  const beforeManifest = await readFile(join(flowweavePath, "generation.json"), "utf8");
  const beforeUserState = await readFile(join(flowweavePath, "canvas", "user-state.json"), "utf8");
  await mkdir(blockedJournal);
  let title: string;
  try {
    const edit = await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const input = document.querySelector('.module-panel .module-edit-card input');
      const secondTab = document.querySelector('.project-tab-list .project-tab:nth-child(2) .project-tab-select');
      if (!(input instanceof HTMLInputElement) || !(secondTab instanceof HTMLButtonElement)) {
        resolve({ updated: false, switched: false }); return;
      }
      const title = 'Switch barrier ' + Date.now();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, title);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        const updated = document.querySelector('.module-panel .hero-card h2')?.textContent === title;
        secondTab.click();
        resolve({ title, updated, switched: true });
      }, 0);
    })`) as { title?: string; updated: boolean; switched: boolean };
    if (!edit.updated || !edit.switched || !edit.title) throw new Error("Project-switch smoke could not submit the edit and switch.");
    title = edit.title;
    const failedSwitch = await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const started = performance.now();
      const interval = setInterval(() => {
        const error = document.querySelector('.workspace-session-error')?.textContent ?? '';
        if (error || performance.now() - started > 7000) {
          clearInterval(interval);
          resolve({ error, activePath: document.querySelector('.project-tab-active .project-tab-select')?.getAttribute('title') ?? '',
            title: document.querySelector('.module-panel .hero-card h2')?.textContent ?? '' });
        }
      }, 25);
    })`) as { error: string; activePath: string; title: string };
    const afterManifest = await readFile(join(flowweavePath, "generation.json"), "utf8");
    const afterUserState = await readFile(join(flowweavePath, "canvas", "user-state.json"), "utf8");
    if (!failedSwitch.error || !failedSwitch.activePath.endsWith("/project") || failedSwitch.title !== title ||
      afterManifest !== beforeManifest || afterUserState !== beforeUserState) {
      throw new Error(`Project-switch save failure changed the active project or discarded the edit: ${JSON.stringify(failedSwitch)}.`);
    }
  } finally {
    await rm(blockedJournal, { recursive: true, force: true });
  }
  const switchResult = await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const secondTab = document.querySelector('.project-tab-list .project-tab:nth-child(2) .project-tab-select');
    if (!(secondTab instanceof HTMLButtonElement)) { resolve({ switched: false, error: 'Missing second tab' }); return; }
    secondTab.click();
    const started = performance.now();
    const interval = setInterval(() => {
      const activePath = document.querySelector('.project-tab-active .project-tab-select')?.getAttribute('title') ?? '';
      if (activePath.endsWith('/second-project') || performance.now() - started > 7000) {
        clearInterval(interval);
        resolve({ switched: activePath.endsWith('/second-project'),
          error: document.querySelector('.workspace-session-error')?.textContent ?? '' });
      }
    }, 25);
  })`) as { switched: boolean; error: string };
  const userState = JSON.parse(await readFile(join(flowweavePath, "canvas", "user-state.json"), "utf8")) as {
    nodeEdits: Record<string, { title?: string }>;
  };
  if (!switchResult.switched || switchResult.error || !Object.values(userState.nodeEdits).some((item) => item.title === title)) {
    throw new Error(`Project-switch save barrier did not persist the edit or clear its resolved error: project ${projectPath}, title ${title}, result ${JSON.stringify(switchResult)}.`);
  }
  return title;
}

function exitSmokeTest(window: BrowserWindow, exitCode: number): never {
  if (!window.isDestroyed()) {
    window.destroy();
  }
  app.exit(exitCode);
  process.exit(exitCode);
}

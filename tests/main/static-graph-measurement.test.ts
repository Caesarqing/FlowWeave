import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { whenReady: () => new Promise(() => undefined), on: () => undefined },
  BrowserWindow: class BrowserWindow {},
  nativeImage: { createFromPath: () => ({}) },
  dialog: { showOpenDialog: vi.fn() },
  shell: {},
  utilityProcess: { fork: vi.fn() },
  ipcMain: { handle: vi.fn() }
}));

import { createStaticGraphMeasurementReport, type StaticGraphMeasurementContext } from "../../src/main/index";
import {
  measureStaticGraphDetailUiTimings,
  staticGraphDetailUiTimingIdentity
} from "../../src/main/services/static-graph-measurement";

const context: StaticGraphMeasurementContext = {
  runAttemptId: "run-001",
  projectId: "D01",
  projectPath: "/tmp/project",
  sourceRevision: "a".repeat(40),
  selection: {
    sourcePaths: ["src/index.ts"],
    configurationPaths: ["package.json"],
    scopeSha256: "c".repeat(64),
    sourceInventorySha256: "d".repeat(64)
  },
  generationProtocol: 7,
  scenarioId: "cold",
  repetition: 1,
  osCacheState: "unknown",
  measurement: { method: "instrumented app events", version: "0.1", sha256: "b".repeat(64) },
  instrumentationMode: "on"
};
const measurementNames = [
  "appStartupMs", "projectSelectionMs", "workspaceInteractiveMs", "scanMs", "semanticAnalysisMs", "clusteringMs",
  "layoutMs", "commitMs", "ipcReceiptMs", "clickableGraphMs", "detailReadyMs", "lockWaitMs", "snapshotValidationMs",
  "snapshotReadMs", "snapshotParseMs", "detailIndexMs", "firstScreenIpcBytes", "cacheResidentBytes", "rendererLongTaskCount", "rendererLongTaskTotalMs",
  "rendererLongTaskMaxMs", "processTreePeakRssMiB", "selectionToWorkspaceInteractiveMs", "selectionToClickableGraphMs", "cancellationUiResponseMs", "backgroundTaskExitMs",
  "detailIpcRoundTripMs", "detailPanelPresentationMs"
];

function unavailableMetrics(measured: string[]): Record<string, string> {
  return Object.fromEntries(measurementNames
    .filter((metric) => !measured.includes(metric))
    .map((metric) => [metric, `${metric} was not measured in this report-builder test.`]));
}

describe("static graph measurement reports", () => {
  it("binds detail timing to the runtime project identity", () => {
    const identity = staticGraphDetailUiTimingIdentity(
      "app-project-uuid",
      "generation-one",
      4,
      "orders"
    );

    expect(identity).toEqual({
      projectId: "app-project-uuid",
      generationId: "generation-one",
      userRevision: 4,
      nodeId: "orders"
    });
    expect(() => staticGraphDetailUiTimingIdentity(undefined, "generation-one", 4, "orders"))
      .toThrow(/runtime project identity/);
  });

  it("separates detail IPC and panel presentation time for the exact project generation, revision, and node", () => {
    const identity = { projectId: "project-one", generationId: "generation-one", userRevision: 4, nodeId: "orders" };
    const observed = {
      ...identity,
      clickStartedAtEpochMs: 90,
      ipcStartedAtEpochMs: 100,
      ipcResponseAtEpochMs: 112,
      panelPresentedAtEpochMs: 118
    };

    expect(measureStaticGraphDetailUiTimings(identity, observed)).toEqual({
      detailReadyMs: 28,
      detailIpcRoundTripMs: 12,
      detailPanelPresentationMs: 6
    });
    for (const mismatch of [
      { ...observed, projectId: "other-project" },
      { ...observed, generationId: "other-generation" },
      { ...observed, userRevision: 5 },
      { ...observed, nodeId: "other-node" }
    ]) {
      expect(() => measureStaticGraphDetailUiTimings(identity, mismatch)).toThrow(/identity/);
    }
    expect(() => measureStaticGraphDetailUiTimings(identity, { ...observed, clickStartedAtEpochMs: 101 }))
      .toThrow(/timestamps/);
    expect(() => measureStaticGraphDetailUiTimings(identity, { ...observed, panelPresentedAtEpochMs: 111 })).toThrow(/timestamps/);
  });

  it("retains matching generation and revision identity in a successful report", () => {
    const detailTiming = measureStaticGraphDetailUiTimings(
      { projectId: context.projectId, generationId: "generation-one", userRevision: 4, nodeId: "orders" },
      { projectId: context.projectId, generationId: "generation-one", userRevision: 4, nodeId: "orders",
        clickStartedAtEpochMs: 90, ipcStartedAtEpochMs: 100, ipcResponseAtEpochMs: 112, panelPresentedAtEpochMs: 118 }
    );
    const report = createStaticGraphMeasurementReport(context, {
      productOutcome: "success",
      generationId: "generation-one",
      currentGenerationId: "generation-one",
      sourceRevision: context.sourceRevision,
      currentSourceRevision: context.sourceRevision,
      userRevision: 4,
      detailUserRevision: 4,
      uiReadyEvidence: {
        workspaceInteractive: { status: "ready", generationId: "generation-one", userRevision: 4 },
        clickableGraph: { status: "ready", generationId: "generation-one", userRevision: 4 },
        detailReady: { status: "ready", generationId: "generation-one", userRevision: 4 }
      },
      metrics: { appStartupMs: 12, workspaceInteractiveMs: 30, detailReadyMs: 4, ...detailTiming },
      unavailableMetrics: unavailableMetrics(["appStartupMs", "workspaceInteractiveMs", "detailReadyMs", ...Object.keys(detailTiming)]),
      qualityEvidence: {
        scanSelection: {
          scopeSha256: context.selection.scopeSha256,
          sourceInventorySha256: context.selection.sourceInventorySha256,
          scanFingerprint: "e".repeat(64)
        }
      },
      startedAt: "2026-10-05T00:00:00.000Z",
      endedAt: "2026-10-05T00:00:01.000Z"
    });

    expect(report).toMatchObject({
      instrumentationMode: "on",
      productOutcome: "success",
      generationId: "generation-one",
      currentGenerationId: "generation-one",
      userRevision: 4,
      detailUserRevision: 4
    });
    expect(report.metrics).toMatchObject({ detailIpcRoundTripMs: 12, detailPanelPresentationMs: 6 });
  });

  it("keeps successful UI identity evidence when optional instrumentation is off", () => {
    const offContext: StaticGraphMeasurementContext = { ...context, instrumentationMode: "off" };
    const report = createStaticGraphMeasurementReport(offContext, {
      productOutcome: "success",
      generationId: "generation-one",
      currentGenerationId: "generation-one",
      sourceRevision: offContext.sourceRevision,
      currentSourceRevision: offContext.sourceRevision,
      userRevision: 4,
      detailUserRevision: 4,
      uiReadyEvidence: {
        workspaceInteractive: { status: "ready", generationId: "generation-one", userRevision: 4 },
        clickableGraph: { status: "ready", generationId: "generation-one", userRevision: 4 },
        detailReady: { status: "ready", generationId: "generation-one", userRevision: 4 }
      },
      metrics: {},
      unavailableMetrics: unavailableMetrics([]),
      qualityEvidence: {
        scanSelection: {
          scopeSha256: offContext.selection.scopeSha256,
          sourceInventorySha256: offContext.selection.sourceInventorySha256,
          scanFingerprint: "e".repeat(64)
        }
      },
      startedAt: "2026-10-05T00:00:00.000Z",
      endedAt: "2026-10-05T00:00:01.000Z"
    });

    expect(report).toMatchObject({
      instrumentationMode: "off",
      productOutcome: "success",
      generationId: "generation-one",
      userRevision: 4,
      detailUserRevision: 4,
      uiReadyEvidence: {
        workspaceInteractive: { status: "ready", generationId: "generation-one", userRevision: 4 },
        clickableGraph: { status: "ready", generationId: "generation-one", userRevision: 4 },
        detailReady: { status: "ready", generationId: "generation-one", userRevision: 4 }
      }
    });
    expect(report.metrics).toEqual({});
    expect(Object.keys(report.unavailableMetrics)).toHaveLength(measurementNames.length);
  });

  it("rejects successful UI evidence from a different generation or user revision", () => {
    const report = {
      productOutcome: "success" as const,
      generationId: "generation-one",
      currentGenerationId: "generation-one",
      sourceRevision: context.sourceRevision,
      currentSourceRevision: context.sourceRevision,
      userRevision: 4,
      detailUserRevision: 3,
      failureStage: undefined,
      error: undefined,
      uiReadyEvidence: {
        workspaceInteractive: { status: "ready" as const, generationId: "generation-one", userRevision: 4 },
        clickableGraph: { status: "ready" as const, generationId: "generation-one", userRevision: 4 },
        detailReady: { status: "ready" as const, generationId: "generation-one", userRevision: 4 }
      },
      metrics: { appStartupMs: 12 },
      unavailableMetrics: unavailableMetrics(["appStartupMs"]),
      qualityEvidence: {
        scanSelection: {
          scopeSha256: context.selection.scopeSha256,
          sourceInventorySha256: context.selection.sourceInventorySha256,
          scanFingerprint: "e".repeat(64)
        }
      },
      startedAt: "2026-10-05T00:00:00.000Z",
      endedAt: "2026-10-05T00:00:01.000Z"
    };

    expect(() => createStaticGraphMeasurementReport(context, report)).toThrow(/detail user revision/);
    expect(() => createStaticGraphMeasurementReport(context, { ...report, detailUserRevision: 4, currentGenerationId: "generation-two" }))
      .toThrow(/current generation/);
  });

  it("preserves failed outcomes and missing metric reasons without substituting zero", () => {
    const report = createStaticGraphMeasurementReport(context, {
      productOutcome: "failure",
      generationId: null,
      currentGenerationId: null,
      sourceRevision: context.sourceRevision,
      currentSourceRevision: null,
      userRevision: null,
      detailUserRevision: null,
      failureStage: "workspaceInteractive",
      error: "The project scan did not produce a generation event.",
      uiReadyEvidence: {
        workspaceInteractive: { status: "not-reached", reason: "No matching generation event reached the UI." },
        clickableGraph: { status: "not-reached", reason: "No matching generation event reached the UI." },
        detailReady: { status: "not-reached", reason: "No matching generation event reached the UI." }
      },
      metrics: { appStartupMs: 12, projectSelectionMs: 3 },
      unavailableMetrics: {
        ...unavailableMetrics(["appStartupMs", "projectSelectionMs"]),
        scanMs: "The worker failed before a completed scan measurement arrived."
      },
      startedAt: "2026-10-05T00:00:00.000Z",
      endedAt: "2026-10-05T00:00:01.000Z"
    });

    expect(report).toMatchObject({ productOutcome: "failure", generationId: null, userRevision: null });
    expect(report.metrics).not.toHaveProperty("scanMs");
    expect(report.unavailableMetrics.scanMs).toMatch(/worker failed/);
  });

  it("requires a stage and error for every failed product run", () => {
    expect(() => createStaticGraphMeasurementReport(context, {
      productOutcome: "failure",
      generationId: null,
      currentGenerationId: null,
      sourceRevision: context.sourceRevision,
      currentSourceRevision: null,
      userRevision: null,
      detailUserRevision: null,
      uiReadyEvidence: {
        workspaceInteractive: { status: "not-reached", reason: "not observed" },
        clickableGraph: { status: "not-reached", reason: "not observed" },
        detailReady: { status: "not-reached", reason: "not observed" }
      },
      metrics: {},
      unavailableMetrics: unavailableMetrics([]),
      startedAt: "2026-10-05T00:00:00.000Z",
      endedAt: "2026-10-05T00:00:01.000Z"
    })).toThrow(/failure stage or error/);
  });
});

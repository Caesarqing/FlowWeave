import { graphNodeShapeIssue, graphEdgeShapeIssue } from "../storage/canvas-shape";
import { app, dialog, shell, utilityProcess, type UtilityProcess, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { PROJECT_CHANNELS } from "../../common/ipc-channels";
import type { GraphSmokeTraceEvent } from "../../common/graph-smoke-trace";
import type {
  AnalysisOperation,
  AnalysisProgressUpdate,
  ActivePage,
  ArchitectureReviewEvent,
  CanvasMigrationReviewRequest,
  CodeflowCanvas,
  CanvasReadResult,
  CodeflowProject,
  FlowWeaveStoredProject,
  ProjectArtifactState,
  ProjectArtifactStatuses,
  ProjectScanOptions,
  ProjectScanSelection,
  ProjectAnalysisEvent,
  RuntimeAgentId,
  SequenceReviewEvent,
  ModificationAcknowledgementScope,
  ModificationSnapshot,
  ProjectWorkspaceSession
} from "../../types";
import {
  analyzeArchitecture,
  readArchitectureMap
} from "../services/architecture-analysis.service";
import { readCommittedAnalysis, registerGenerationRequest, assertArtifactGeneration, type GenerationPhaseMeasurement, type GenerationRequest, type ProjectAnalysisWorkerMessage, type ProjectAnalysisWorkerRequest, type ProjectAnalysisWorkerResult } from "../services/project-generation.service";
import {
  readArchitectureReviewStatus,
  withArchitectureArtifactLock
} from "../services/architecture-review.service";
import { readSequenceReviewStatus } from "../services/sequence-review.service";
import {
  disableProjectAgentConnection,
  enableProjectAgentConnection,
  getProjectAgentConnection,
  getProjectAgentContextPath,
  refreshProjectAgentConnection,
  refreshProjectAgentConnectionIfEnabled
} from "../services/project-agent-connection.service";
import {
  listRegisteredProjects,
  readProjectWorkspaceSession,
  registerProject,
  resolveProjectFile,
  resolveProjectPath,
  restoreRegisteredProject,
  saveProjectWorkspaceSession
} from "../services/project-registry.service";
import { generateSequenceDiagrams, readSequenceDiagrams, reviseSequenceDiagram } from "../services/sequence-diagram.service";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { readJsonArtifact } from "../storage/artifact-store";
import { readProjectProtocolCanvas, readProjectProtocolCanvasForDisplay, readProjectProtocolOverview, readProjectProtocolSnapshot, resolveCanvasMigrationItem, saveProjectProtocolCanvas } from "../storage/flowweave-store";
import { getTransactionAuthorityRoot } from "../storage/transaction-authority";
import { readCanvasNodeDetail, readCanvasEdgeDetail, readGeneratedCanvasGraph } from "../services/canvas-detail.service";
import { writeProjectTextAtomic } from "../storage/project-write-guard";
import { optionalTrimmedString, requireEnum, requireInteger, requireObject, requireSafeId, requireString, requireStringArray } from "./ipc-validation";
import { finishOperation, startOperation, updateOperation } from "../services/operation.service";
import { exportDiagnostics, recordDiagnostic } from "../services/diagnostic.service";
import { writeModificationDocs } from "../services/modification-doc.service";
import { writeCurrentTaskArtifact } from "../services/task-artifact.service";
import {
  acknowledgeModificationChanges,
  readModificationDelta
} from "../services/modification-delta.service";
import { handleIpc } from "./ipc-handler";
import { readRunArtifact } from "../services/run-log.service";

const TOOL_IDS = ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"] as const;
const WORKSPACE_PAGES: ActivePage[] = ["canvas", "structure", "docs", "git-review", "tools"];
const latestScanRequests = new Map<string, string>();
type ActiveProjectAnalysis = { projectId: string; projectPath: string; request: GenerationRequest; scanOptions: ProjectScanOptions; scanFingerprint?: string; senders: Set<WebContents>; operationId: string; process: UtilityProcess; graphSmokeTrace?: ProjectIpcGraphSmokeTrace };
const activeProjectAnalyses = new Map<string, ActiveProjectAnalysis>();
export type ProjectMeasurementObserver = {
  autoSelectProjectPath?: string;
  autoScanSelection?: ProjectScanSelection;
  onGenerationMeasurement?: (requestId: string, measurement: GenerationPhaseMeasurement) => void;
  onMainProcessMeasurement?: (measurement: GenerationPhaseMeasurement) => void;
  onProjectScanned?: (requestId: string, scanFingerprint: string) => void;
  onProjectSelectionCompleted?: (
    sender: WebContents,
    projectId: string,
    projectPath: string,
    requestId: string,
    durationMs: number,
    completedAtEpochMs: number
  ) => void;
  onProjectAnalysisEventSent: (sender: WebContents, event: ProjectAnalysisEvent, sentAtWallClockMs: number) => void;
  onProjectAnalysisWorkerExited?: (requestId: string, exitedAtEpochMs: number) => void;
  onProjectAnalysisCancellationRequested?: (requestId: string, startedAtEpochMs: number) => void;
};
export type ProjectIpcGraphSmokeTestHooks = {
  beforeNodeDetailResponse: (nodeId: string) => Promise<void>;
};
type ProjectIpcGraphSmokeTrace = (event: GraphSmokeTraceEvent) => void;
let projectMeasurementObserver: ProjectMeasurementObserver | undefined;

function reportMainMeasurement(
  metric: GenerationPhaseMeasurement["metric"],
  durationMs: number,
  outcome: GenerationPhaseMeasurement["outcome"]
): void {
  projectMeasurementObserver?.onMainProcessMeasurement?.({ metric, durationMs, outcome });
}

function reportArtifactLockWait(durationMs: number): void {
  reportMainMeasurement("lockWaitMs", durationMs, "completed");
}

function artifactLockWaitCallback(): ((durationMs: number) => void) | undefined {
  return projectMeasurementObserver?.onMainProcessMeasurement ? reportArtifactLockWait : undefined;
}

function reportGraphSmokePhase(
  graphSmokeTrace: ProjectIpcGraphSmokeTrace | undefined,
  stage: string,
  projectId: string,
  requestId: string | undefined,
  error: unknown | undefined
): void {
  if (!graphSmokeTrace) return;
  graphSmokeTrace({
    source: "main",
    stage,
    monotonicMs: performance.now(),
    projectId,
    ...(requestId === undefined ? {} : { requestId }),
    ...(error === undefined ? {} : { error: formatProjectAnalysisError(error) })
  });
}

function reportSnapshotMeasurement(
  metric: "snapshotReadMs" | "snapshotParseMs" | "snapshotValidationMs",
  durationMs: number,
  outcome: "completed" | "failed"
): void {
  reportMainMeasurement(metric, durationMs, outcome);
}

function snapshotMeasurementCallback(): ((
  metric: "snapshotReadMs" | "snapshotParseMs" | "snapshotValidationMs",
  durationMs: number,
  outcome: "completed" | "failed"
) => void) | undefined {
  return projectMeasurementObserver?.onMainProcessMeasurement ? reportSnapshotMeasurement : undefined;
}

export function registerProjectIpc(
  measurementObserver?: ProjectMeasurementObserver,
  graphSmokeTestHooks?: ProjectIpcGraphSmokeTestHooks,
  graphSmokeTrace?: ProjectIpcGraphSmokeTrace
) {
  projectMeasurementObserver = measurementObserver;
  handleIpc(PROJECT_CHANNELS.openProject, async (event, options: unknown) => {
    const measurementsEnabled = projectMeasurementObserver?.onGenerationMeasurement !== undefined;
    const startedAt = measurementsEnabled ? performance.now() : undefined;
    let projectPath = projectMeasurementObserver?.autoSelectProjectPath;
    if (!projectPath) {
      const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open project in FlowWeave" });
      if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
      projectPath = result.filePaths[0];
    }
    const projectId = await registerProject(projectPath);
    const scanOptions = requireScanOptions(PROJECT_CHANNELS.openProject, options);
    const selectedOptions = measurementScanOptions(projectPath, scanOptions);
    const opened = await startProjectAnalysis(projectId, event.sender, selectedOptions);
    if (projectMeasurementObserver?.autoSelectProjectPath && "requestId" in opened) {
      projectMeasurementObserver.onProjectSelectionCompleted?.(
        event.sender,
        projectId,
        "projectPath" in opened ? opened.projectPath : projectPath,
        opened.requestId,
        startedAt === undefined ? 0 : performance.now() - startedAt,
        measurementsEnabled ? performance.timeOrigin + performance.now() : 0
      );
    }
    return opened;
  });

  handleIpc(PROJECT_CHANNELS.listRegisteredProjects, async () => listRegisteredProjects());
  handleIpc(PROJECT_CHANNELS.readRegisteredProject, (_event, projectId: unknown) =>
    readStoredProject(requireString(PROJECT_CHANNELS.readRegisteredProject, projectId, "projectId")));

  handleIpc(PROJECT_CHANNELS.restoreRegisteredProject, async (event, projectId: unknown, options: unknown) => {
    const safeProjectId = requireString(PROJECT_CHANNELS.restoreRegisteredProject, projectId, "projectId");
    reportGraphSmokePhase(graphSmokeTrace, "registryRestore:start", safeProjectId, undefined, undefined);
    try {
      await restoreRegisteredProject(safeProjectId);
    } catch (error) {
      reportGraphSmokePhase(graphSmokeTrace, "registryRestore:failed", safeProjectId, undefined, error);
      throw error;
    }
    reportGraphSmokePhase(graphSmokeTrace, "registryRestore:completed", safeProjectId, undefined, undefined);
    return startProjectAnalysis(safeProjectId, event.sender,
      requireScanOptions(PROJECT_CHANNELS.restoreRegisteredProject, options), graphSmokeTrace);
  });

  handleIpc(PROJECT_CHANNELS.readWorkspaceSession, async () => readProjectWorkspaceSession());

  handleIpc(PROJECT_CHANNELS.saveWorkspaceSession, async (_event, session: unknown) => {
    await saveProjectWorkspaceSession(requireProjectWorkspaceSession(PROJECT_CHANNELS.saveWorkspaceSession, session));
  });

  handleIpc(PROJECT_CHANNELS.scanProject, (event, projectId: unknown, options: unknown) =>
    startProjectAnalysis(
      requireString(PROJECT_CHANNELS.scanProject, projectId, "projectId"),
      event.sender,
      requireScanOptions(PROJECT_CHANNELS.scanProject, options)
    ));

  handleIpc(PROJECT_CHANNELS.cancelProjectAnalysis, (event, projectId: unknown) =>
    cancelProjectAnalysis(requireString(PROJECT_CHANNELS.cancelProjectAnalysis, projectId, "projectId"), event.sender));

  handleIpc(PROJECT_CHANNELS.analyzeArchitectureWithAgent, (event, projectId: unknown, agentId: unknown, timeoutMs: unknown) =>
    analyzeArchitectureForProject(
      requireString(PROJECT_CHANNELS.analyzeArchitectureWithAgent, projectId, "projectId"),
      requireRuntimeAgentId(PROJECT_CHANNELS.analyzeArchitectureWithAgent, agentId),
      event.sender,
      requireOptionalAgentTimeout(PROJECT_CHANNELS.analyzeArchitectureWithAgent, timeoutMs)
    ));

  handleIpc(PROJECT_CHANNELS.readArchitectureMap, (_event, projectId: unknown) =>
    readArchitectureMap(resolveProjectPath(requireString(PROJECT_CHANNELS.readArchitectureMap, projectId, "projectId"))));

  handleIpc(PROJECT_CHANNELS.readCanvasNodeDetail, async (_event, projectId: unknown, generationId: unknown, userRevision: unknown, nodeId: unknown) => {
    const response = await readCanvasNodeDetail(
      resolveProjectPath(requireString(PROJECT_CHANNELS.readCanvasNodeDetail, projectId, "projectId")),
      requireString(PROJECT_CHANNELS.readCanvasNodeDetail, generationId, "generationId"),
      requireInteger(PROJECT_CHANNELS.readCanvasNodeDetail, userRevision, "userRevision", 0, Number.MAX_SAFE_INTEGER),
      requireString(PROJECT_CHANNELS.readCanvasNodeDetail, nodeId, "nodeId"),
      projectMeasurementObserver?.onMainProcessMeasurement ? reportMainMeasurement : undefined
    );
    if (graphSmokeTestHooks) await graphSmokeTestHooks.beforeNodeDetailResponse(response.nodeId);
    return response;
  });
  handleIpc(PROJECT_CHANNELS.readGeneratedCanvasGraph, (_event, projectId: unknown, generationId: unknown) =>
    readGeneratedCanvasGraph(
      resolveProjectPath(requireString(PROJECT_CHANNELS.readGeneratedCanvasGraph, projectId, "projectId")),
      requireString(PROJECT_CHANNELS.readGeneratedCanvasGraph, generationId, "generationId")
    ));
  handleIpc(PROJECT_CHANNELS.readCanvasEdgeDetail, (_event, projectId: unknown, generationId: unknown, userRevision: unknown, edgeId: unknown) =>
    readCanvasEdgeDetail(
      resolveProjectPath(requireString(PROJECT_CHANNELS.readCanvasEdgeDetail, projectId, "projectId")),
      requireString(PROJECT_CHANNELS.readCanvasEdgeDetail, generationId, "generationId"),
      requireInteger(PROJECT_CHANNELS.readCanvasEdgeDetail, userRevision, "userRevision", 0, Number.MAX_SAFE_INTEGER),
      requireString(PROJECT_CHANNELS.readCanvasEdgeDetail, edgeId, "edgeId"),
      projectMeasurementObserver?.onMainProcessMeasurement ? reportMainMeasurement : undefined
    ));

  handleIpc(PROJECT_CHANNELS.generateSequenceDiagrams, (event, projectId: unknown, agentId: unknown, timeoutMs: unknown) =>
    generateSequenceDiagramsForProject(
      requireString(PROJECT_CHANNELS.generateSequenceDiagrams, projectId, "projectId"),
      requireRuntimeAgentId(PROJECT_CHANNELS.generateSequenceDiagrams, agentId),
      event.sender,
      requireOptionalAgentTimeout(PROJECT_CHANNELS.generateSequenceDiagrams, timeoutMs)
    ));

  handleIpc(PROJECT_CHANNELS.reviseSequenceDiagram, (event, projectId: unknown, agentId: unknown, instruction: unknown, timeoutMs: unknown) =>
    reviseSequenceDiagramForProject(
      requireString(PROJECT_CHANNELS.reviseSequenceDiagram, projectId, "projectId"),
      requireRuntimeAgentId(PROJECT_CHANNELS.reviseSequenceDiagram, agentId),
      requireString(PROJECT_CHANNELS.reviseSequenceDiagram, instruction, "instruction"),
      event.sender,
      requireOptionalAgentTimeout(PROJECT_CHANNELS.reviseSequenceDiagram, timeoutMs)
    ));

  handleIpc(PROJECT_CHANNELS.readSequenceDiagrams, (_event, projectId: unknown) =>
    readSequenceDiagrams(resolveProjectPath(requireString(PROJECT_CHANNELS.readSequenceDiagrams, projectId, "projectId"))));

  handleIpc(PROJECT_CHANNELS.generateTaskArtifact, async (_event, projectId: unknown, generationId: unknown, userRevision: unknown) => {
    const safeProjectId = requireString(PROJECT_CHANNELS.generateTaskArtifact, projectId, "projectId");
    const projectPath = resolveProjectPath(safeProjectId);
    const expectedGenerationId = requireString(PROJECT_CHANNELS.generateTaskArtifact, generationId, "generationId");
    const expectedUserRevision = requireInteger(PROJECT_CHANNELS.generateTaskArtifact, userRevision, "userRevision", 0, Number.MAX_SAFE_INTEGER);
    const result = await withArchitectureArtifactLock(projectPath, async () => {
      if (latestScanRequests.has(projectPath)) {
        throw new Error(`Task generation is unavailable while project analysis is in progress: project ${projectPath}`);
      }
      return writeCurrentTaskArtifact(projectPath, expectedGenerationId, expectedUserRevision);
    }, artifactLockWaitCallback());
    await refreshConnectionWithoutFailing(safeProjectId, projectPath);
    return result;
  });

  handleIpc(PROJECT_CHANNELS.readFile, async (_event, projectId: unknown, filePath: unknown) => {
    const requestedPath = requireString(PROJECT_CHANNELS.readFile, filePath, "filePath");
    return readOptionalProjectTextFile(
      await resolveProjectFile(
        requireString(PROJECT_CHANNELS.readFile, projectId, "projectId"),
        requestedPath
      ),
      requestedPath
    );
  });

  handleIpc(PROJECT_CHANNELS.saveDoc, async (_event, projectId: unknown, docId: unknown, content: unknown) => {
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.saveDoc, projectId, "projectId"));
    const safeDocId = requireSafeId(PROJECT_CHANNELS.saveDoc, docId, "docId");
    const docsDir = join(projectPath, FLOWWEAVE_DIR, "docs");
    const docPath = join(docsDir, `${safeDocId}.md`);
    await writeProjectTextAtomic(projectPath, docPath, requireString(PROJECT_CHANNELS.saveDoc, content, "content"));
    return docPath;
  });

  handleIpc(PROJECT_CHANNELS.saveModificationDocs, (_event, projectId: unknown, sequenceInstruction: unknown) =>
    writeModificationDocs(
      resolveProjectPath(requireString(PROJECT_CHANNELS.saveModificationDocs, projectId, "projectId")),
      {
        sequenceInstruction: optionalTrimmedString(
          PROJECT_CHANNELS.saveModificationDocs,
          sequenceInstruction,
          "sequenceInstruction"
        )
      }
    ));

  handleIpc(PROJECT_CHANNELS.readModificationDelta, (_event, projectId: unknown, sequenceInstruction: unknown, canvas: unknown) => {
    const value = canvas === undefined
      ? undefined
      : requireProjectGraph(PROJECT_CHANNELS.readModificationDelta, canvas);
    return readModificationDelta(
      resolveProjectPath(requireString(PROJECT_CHANNELS.readModificationDelta, projectId, "projectId")),
      optionalTrimmedString(
        PROJECT_CHANNELS.readModificationDelta,
        sequenceInstruction,
        "sequenceInstruction"
      ) ?? "",
      value
    );
  });

  handleIpc(PROJECT_CHANNELS.acknowledgeModificationChanges, (_event, projectId: unknown, snapshot: unknown, scope: unknown) =>
    acknowledgeModificationChanges(
      resolveProjectPath(requireString(PROJECT_CHANNELS.acknowledgeModificationChanges, projectId, "projectId")),
      requireModificationSnapshot(PROJECT_CHANNELS.acknowledgeModificationChanges, snapshot),
      requireModificationAcknowledgementScope(PROJECT_CHANNELS.acknowledgeModificationChanges, scope)
    ));

  handleIpc(PROJECT_CHANNELS.readCanvas, async (_event, projectId: unknown) => {
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.readCanvas, projectId, "projectId"));
    return withArchitectureArtifactLock(projectPath, () => readCanvasArtifactState(projectPath), artifactLockWaitCallback());
  });

  handleIpc(PROJECT_CHANNELS.saveCanvas, async (_event, projectId: unknown, canvas: unknown) => {
    const safeProjectId = requireString(PROJECT_CHANNELS.saveCanvas, projectId, "projectId");
    const projectPath = resolveProjectPath(safeProjectId);
    const value = requireProjectGraph(PROJECT_CHANNELS.saveCanvas, canvas);
    if (value.artifactState !== "current") {
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Only a graph from the current project generation can be saved.`);
    }
    for (const node of value.nodes) {
      const override = node.assessment?.risk.override;
      if (override && !override.reason.trim()) {
        throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Risk override for "${node.id}" requires a reason.`);
      }
    }
    const canvasPath = join(projectPath, FLOWWEAVE_DIR, "canvas", "user-state.json");
    const savedPath = await withArchitectureArtifactLock(projectPath, async () => {
      const stored = await readCanvasArtifactState(projectPath);
      if (!stored) throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Project has not been migrated to protocol v7 yet; wait for static analysis to finish.`);
      await assertArtifactGeneration(projectPath, canvasPath, value);
      const protocolSave = await saveProjectProtocolCanvas(projectPath, value);
      if (!protocolSave) throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Project generation changed before protocol v7 user state was saved.`);
      return protocolSave;
    }, artifactLockWaitCallback());
    await refreshConnectionWithoutFailing(safeProjectId, projectPath);
    return savedPath;
  });

  handleIpc(PROJECT_CHANNELS.resolveCanvasMigrationItem, async (_event, projectId: unknown, request: unknown) => {
    const safeProjectId = requireString(PROJECT_CHANNELS.resolveCanvasMigrationItem, projectId, "projectId");
    const projectPath = resolveProjectPath(safeProjectId);
    const reviewRequest = requireCanvasMigrationReviewRequest(PROJECT_CHANNELS.resolveCanvasMigrationItem, request);
    const receipt = await withArchitectureArtifactLock(projectPath, () => resolveCanvasMigrationItem(projectPath, reviewRequest));
    await refreshConnectionWithoutFailing(safeProjectId, projectPath);
    return receipt;
  });

  handleIpc(PROJECT_CHANNELS.exportDiagnostics, (_event, projectId: unknown) =>
    exportDiagnostics(resolveProjectPath(
      requireString(PROJECT_CHANNELS.exportDiagnostics, projectId, "projectId")
    )));

  handleIpc(PROJECT_CHANNELS.getAgentConnection, (_event, projectId: unknown) =>
    getProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.getAgentConnection, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.enableAgentConnection, (_event, projectId: unknown) =>
    enableProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.enableAgentConnection, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.refreshAgentConnection, (_event, projectId: unknown) =>
    refreshProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.refreshAgentConnection, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.disableAgentConnection, (_event, projectId: unknown) =>
    disableProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.disableAgentConnection, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.openAgentConnection, async (_event, projectId: unknown) => {
    const path = getProjectAgentContextPath(resolveProjectPath(requireString(PROJECT_CHANNELS.openAgentConnection, projectId, "projectId")));
    const error = await shell.openPath(path);
    if (error) throw new Error(`Opening FlowWeave Agent context failed: ${error}`);
  });
}

function measurementScanOptions(projectPath: string, options: ProjectScanOptions): ProjectScanOptions {
  const observer = projectMeasurementObserver;
  if (!observer?.autoSelectProjectPath || !observer.autoScanSelection ||
    resolve(projectPath) !== resolve(observer.autoSelectProjectPath)) return options;
  return { ...options, selection: observer.autoScanSelection };
}

async function analyzeArchitectureForProject(
  projectId: string,
  agentId: RuntimeAgentId,
  sender: WebContents,
  timeoutMs: number | undefined
) {
  const projectPath = resolveProjectPath(projectId);
  return runTrackedAnalysis("architecture-analysis", "Preparing architecture analysis.", sender, async (onProgress) => {
    const result = await analyzeArchitecture(await readCommittedProjectArtifact(projectPath), agentId, {
      onProgress,
      projectId,
      timeoutMs,
      onArchitectureReview: (reviewEvent) => sendArchitectureReview(sender, reviewEvent)
    });
    if (result.outcome === "failed") throw new Error(result.error.message);
    return result;
  }, projectId, projectPath);
}

async function generateSequenceDiagramsForProject(
  projectId: string,
  agentId: RuntimeAgentId,
  sender: WebContents,
  timeoutMs: number | undefined
) {
  const projectPath = resolveProjectPath(projectId);
  return runTrackedAnalysis("sequence-analysis", "Preparing sequence diagram analysis.", sender, async (onProgress) => {
    const result = await generateSequenceDiagrams(await readCommittedProjectArtifact(projectPath), agentId, {
      onProgress,
      projectId,
      timeoutMs,
      onSequenceReview: (reviewEvent) => sendSequenceReview(sender, reviewEvent)
    });
    if (result.outcome === "failed") throw new Error(result.error.message);
    return result;
  }, projectId, projectPath);
}

async function readCommittedProjectArtifact(projectPath: string) {
  const committed = await readCommittedAnalysis(projectPath);
  if (!committed) throw new Error(`Static project analysis has not completed: ${projectPath}`);
  return committed.project;
}

async function reviseSequenceDiagramForProject(
  projectId: string,
  agentId: RuntimeAgentId,
  instruction: string,
  sender: WebContents,
  timeoutMs: number | undefined
) {
  const projectPath = resolveProjectPath(projectId);
  return runTrackedAnalysis("sequence-analysis", "Preparing sequence diagram revision.", sender, async (onProgress) => {
    return reviseSequenceDiagram(await readCommittedProjectArtifact(projectPath), agentId, instruction, { onProgress, timeoutMs });
  }, projectId, projectPath);
}

async function registerScanRequest(projectId: string): Promise<GenerationRequest> {
  const projectPath = resolveProjectPath(projectId);
  const request = await registerGenerationRequest(projectPath, randomUUID(), artifactLockWaitCallback());
  latestScanRequests.set(projectPath, request.requestId);
  return request;
}

async function startProjectAnalysis(
  projectId: string,
  sender: WebContents,
  options: ProjectScanOptions,
  graphSmokeTrace?: ProjectIpcGraphSmokeTrace
) {
  const projectPath = resolveProjectPath(projectId);
  for (const analysis of activeProjectAnalyses.values()) {
    if (analysis.senders.has(sender) && analysis.projectPath !== projectPath) detachProjectAnalysisSender(analysis, sender, "cancelled");
  }
  const active = activeProjectAnalyses.get(projectPath);
  if (active && hasSameScanOptions(active.scanOptions, options)) {
    active.senders.add(sender);
    reportGraphSmokePhase(graphSmokeTrace, "analysisReused", projectId, active.request.requestId, undefined);
    return { canceled: false as const, status: "analyzing" as const, projectId, projectPath, projectName: basename(projectPath), requestId: active.request.requestId };
  }
  reportGraphSmokePhase(graphSmokeTrace, "generationRegistration:start", projectId, undefined, undefined);
  let request: GenerationRequest;
  try {
    request = await registerScanRequest(projectId);
  } catch (error) {
    reportGraphSmokePhase(graphSmokeTrace, "generationRegistration:failed", projectId, undefined, error);
    throw error;
  }
  reportGraphSmokePhase(graphSmokeTrace, "generationRegistration:completed", projectId, request.requestId, undefined);
  reportGraphSmokePhase(graphSmokeTrace, "cachedCanvasRead:start", projectId, request.requestId, undefined);
  let cachedCanvas: Awaited<ReturnType<typeof readProjectProtocolCanvasForDisplay>>;
  try {
    cachedCanvas = await withArchitectureArtifactLock(projectPath, () => readProjectProtocolCanvasForDisplay(projectPath), artifactLockWaitCallback());
  } catch (error) {
    reportGraphSmokePhase(graphSmokeTrace, "cachedCanvasRead:failed", projectId, request.requestId, error);
    throw error;
  }
  reportGraphSmokePhase(graphSmokeTrace, "cachedCanvasRead:completed", projectId, request.requestId, undefined);
  const previous = activeProjectAnalyses.get(projectPath);
  if (previous) stopProjectAnalysis(previous, "superseded");
  const started = startOperation("project-scan", "Discovering project files.", projectId);
  notifyProjectAnalysisProgress(sender, projectPath, request, started.operation);
  reportGraphSmokePhase(graphSmokeTrace, "progressDispatched", projectId, request.requestId, undefined);
  launchProjectAnalysis(projectId, sender, options, request, started.operation.operationId, graphSmokeTrace);
  return {
    canceled: false as const,
    status: "analyzing" as const,
    projectId,
    projectPath,
    projectName: basename(projectPath),
    requestId: request.requestId,
    ...(cachedCanvas ? { cachedCanvas } : {})
  };
}

function hasSameScanOptions(left: ProjectScanOptions, right: ProjectScanOptions): boolean {
  if (left.concurrency !== right.concurrency || left.agentPlanTimeoutMs !== right.agentPlanTimeoutMs) return false;
  if (left.selection === undefined || right.selection === undefined) return left.selection === right.selection;
  return left.selection.scopeSha256 === right.selection.scopeSha256 &&
    left.selection.sourceInventorySha256 === right.selection.sourceInventorySha256 &&
    hasSamePaths(left.selection.sourcePaths, right.selection.sourcePaths) &&
    hasSamePaths(left.selection.configurationPaths, right.selection.configurationPaths);
}

function hasSamePaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function launchProjectAnalysis(
  projectId: string,
  sender: WebContents,
  options: ProjectScanOptions,
  request: GenerationRequest,
  operationId: string,
  graphSmokeTrace: ProjectIpcGraphSmokeTrace | undefined
): void {
  const projectPath = resolveProjectPath(projectId);
  if (latestScanRequests.get(projectPath) !== request.requestId) {
    finishOperation(operationId);
    sendProjectAnalysisEvent(sender, { status: "superseded", projectId, requestId: request.requestId });
    reportGraphSmokePhase(graphSmokeTrace, "terminalAnalysisEvent:superseded:sent", projectId, request.requestId, undefined);
    return;
  }
  let worker: UtilityProcess;
  try {
    worker = utilityProcess.fork(join(__dirname, "project-analysis.worker.js"));
  } catch (error) {
    reportGraphSmokePhase(graphSmokeTrace, "workerLaunch:failed", projectId, request.requestId, error);
    void failProjectAnalysis(projectId, projectPath, new Set([sender]), request, operationId, formatProjectAnalysisError(error), graphSmokeTrace);
    return;
  }
  reportGraphSmokePhase(graphSmokeTrace, "workerLaunch:completed", projectId, request.requestId, undefined);
  const analysis: ActiveProjectAnalysis = {
    projectId, projectPath, request, scanOptions: options, senders: new Set([sender]), operationId, process: worker, graphSmokeTrace
  };
  activeProjectAnalyses.set(projectPath, analysis);
  worker.on("message", (value: unknown) => { void handleProjectAnalysisWorkerMessage(analysis, value, graphSmokeTrace); });
  worker.on("exit", (code: number) => {
    reportGraphSmokePhase(graphSmokeTrace, `workerExit:${code}`, projectId, analysis.request.requestId, undefined);
    projectMeasurementObserver?.onProjectAnalysisWorkerExited?.(analysis.request.requestId,
      projectMeasurementObserver?.onGenerationMeasurement ? performance.timeOrigin + performance.now() : 0);
    if (activeProjectAnalyses.get(projectPath) === analysis) {
      void failProjectAnalysis(projectId, projectPath, analysis.senders, request, operationId,
        `Static analysis worker exited before completion (code ${code}).`, graphSmokeTrace);
    }
  });
  try {
    const message: ProjectAnalysisWorkerRequest = {
      request,
      scanOptions: options,
      measurementsEnabled: projectMeasurementObserver?.onGenerationMeasurement !== undefined,
      transactionAuthorityRoot: getTransactionAuthorityRoot()
    };
    worker.postMessage(message);
  } catch (error) {
    reportGraphSmokePhase(graphSmokeTrace, "workerPostMessage:failed", projectId, request.requestId, error);
    void failProjectAnalysis(projectId, projectPath, analysis.senders, request, operationId, formatProjectAnalysisError(error), graphSmokeTrace);
  }
}

async function handleProjectAnalysisWorkerMessage(
  analysis: ActiveProjectAnalysis,
  value: unknown,
  graphSmokeTrace: ProjectIpcGraphSmokeTrace | undefined
): Promise<void> {
  if (activeProjectAnalyses.get(analysis.projectPath) !== analysis) return;
  if (!isProjectAnalysisWorkerMessage(value) || value.requestId !== analysis.request.requestId) {
    reportGraphSmokePhase(graphSmokeTrace, "workerMessage:invalid", analysis.projectId, analysis.request.requestId,
      new Error(`Unexpected worker message for request ${analysis.request.requestId}.`));
    await failProjectAnalysis(analysis.projectId, analysis.projectPath, analysis.senders, analysis.request, analysis.operationId,
      `Static analysis worker returned an invalid message for request ${analysis.request.requestId}.`, graphSmokeTrace);
    return;
  }
  reportGraphSmokePhase(graphSmokeTrace, `workerMessage:${value.type}`, analysis.projectId, value.requestId,
    value.type === "failure" ? new Error(value.message) : undefined);
  if (value.type === "scanned") {
    if (typeof value.scanFingerprint !== "string" || value.scanFingerprint.length === 0) {
      await failProjectAnalysis(analysis.projectId, analysis.projectPath, analysis.senders, analysis.request, analysis.operationId,
        `Static analysis worker returned an invalid scan fingerprint for request ${analysis.request.requestId}.`, graphSmokeTrace);
      return;
    }
    analysis.scanFingerprint = value.scanFingerprint;
    projectMeasurementObserver?.onProjectScanned?.(analysis.request.requestId, value.scanFingerprint);
    return;
  }
  if (value.type === "progress") {
    notifyAnalysisSubscribers(analysis, updateOperation(analysis.operationId, value.progress));
    return;
  }
  if (value.type === "measurement") {
    if (!projectMeasurementObserver?.onGenerationMeasurement) return;
    if (!isGenerationPhaseMeasurement(value.measurement)) {
      await failProjectAnalysis(analysis.projectId, analysis.projectPath, analysis.senders, analysis.request, analysis.operationId,
        `Static analysis worker returned an invalid generation measurement for request ${analysis.request.requestId}.`, graphSmokeTrace);
      return;
    }
    projectMeasurementObserver.onGenerationMeasurement(analysis.request.requestId, value.measurement);
    return;
  }
  if (value.type === "failure") {
    await failProjectAnalysis(analysis.projectId, analysis.projectPath, analysis.senders, analysis.request, analysis.operationId, value.message, graphSmokeTrace);
    return;
  }
  if (value.result.status === "superseded") {
    finishActiveProjectAnalysis(analysis);
    sendAnalysisSubscribers(analysis, { status: "superseded", projectId: analysis.projectId, requestId: analysis.request.requestId });
    reportGraphSmokePhase(graphSmokeTrace, "terminalAnalysisEvent:superseded:sent", analysis.projectId, analysis.request.requestId, undefined);
    return;
  }
  try {
    const result = await committedProjectAnalysisResult(analysis.projectId, value.result);
    reportGraphSmokePhase(graphSmokeTrace, "analysisCommit:completed", analysis.projectId, analysis.request.requestId, undefined);
    notifyAnalysisSubscribers(analysis, updateOperation(analysis.operationId, {
      stage: "completed", completed: result.project.summary.totalFiles, total: result.project.summary.totalFiles,
      failed: 0, message: "Project scan completed."
    }));
    finishActiveProjectAnalysis(analysis);
    sendAnalysisSubscribers(analysis, { status: "completed", projectId: analysis.projectId, requestId: analysis.request.requestId, result });
    reportGraphSmokePhase(graphSmokeTrace, "terminalAnalysisEvent:completed:sent", analysis.projectId, analysis.request.requestId, undefined);
  } catch (error) {
    reportGraphSmokePhase(graphSmokeTrace, "analysisCommit:failed", analysis.projectId, analysis.request.requestId, error);
    await failProjectAnalysis(analysis.projectId, analysis.projectPath, analysis.senders, analysis.request, analysis.operationId, formatProjectAnalysisError(error), graphSmokeTrace);
  }
}

async function committedProjectAnalysisResult(projectId: string, generated: Exclude<ProjectAnalysisWorkerResult, { status: "superseded" }>): Promise<import("../../types").ProjectAnalysisCommittedResult> {
  const { written, generation, scanFingerprint, localArchitectureInputFingerprint } = generated;
  const projectPath = resolveProjectPath(projectId);
  const committed = await withArchitectureArtifactLock(projectPath, async () => {
    const [canvasValue, overview] = await Promise.all([
      readProjectProtocolCanvasForDisplay(projectPath),
      readProjectProtocolOverview(projectPath)
    ]);
    if (!canvasValue || !overview) {
      throw new Error(`Committed protocol v7 overview is incomplete: project ${projectPath}, generation ${generation.requestId}`);
    }
    const project = overview.project ?? (await readProjectProtocolSnapshot(projectPath, snapshotMeasurementCallback()))?.project;
    if (!project) throw new Error(`Committed protocol v7 project is missing: project ${projectPath}, generation ${generation.requestId}`);
    if (canvasValue.generation?.requestId !== generation.requestId || canvasValue.scanFingerprint !== scanFingerprint ||
      overview.generationId !== generation.requestId) {
      throw new Error(`Committed overview generation changed before notification: project ${projectPath}, expected ${generation.requestId}`);
    }
    return { project, canvas: canvasValue, overview };
  }, artifactLockWaitCallback());
  const { project, canvas, overview } = committed;
  const artifacts: ProjectArtifactStatuses = {
    project: "current", canvas: "current", task: "missing", context: "missing",
    architecture: overview.architectureInputFingerprint === localArchitectureInputFingerprint ? "current" : "stale",
    sequences: await artifactStateForFingerprint(project.rootPath, "sequence-diagrams.json", scanFingerprint)
  };
  const architectureFingerprints = { scanFingerprint, inputFingerprint: localArchitectureInputFingerprint };
  const architectureReview = await readArchitectureReviewStatus(project.rootPath, architectureFingerprints);
  const sequenceReview = await readSequenceReviewStatus(project.rootPath, scanFingerprint);
  return {
    canceled: false, status: "committed", generation, projectId, scanFingerprint, artifacts,
    architectureReview, sequenceReview, project, canvas: { mode: "editable", canvas },
    relationDiagnostics: overview.relationDiagnostics ?? [], written
  };
}

async function failProjectAnalysis(
  projectId: string,
  projectPath: string,
  senders: ReadonlySet<WebContents>,
  request: GenerationRequest,
  operationId: string,
  message: string,
  graphSmokeTrace: ProjectIpcGraphSmokeTrace | undefined
): Promise<void> {
  const latest = await withArchitectureArtifactLock(projectPath, () =>
    readJsonArtifact(join(projectPath, FLOWWEAVE_DIR, "generation-request.json")), artifactLockWaitCallback()) as { requestId?: string } | undefined;
  const analysis = activeProjectAnalyses.get(projectPath);
  if (latest?.requestId !== request.requestId) {
    if (analysis?.request.requestId === request.requestId) finishActiveProjectAnalysis(analysis);
    else finishOperation(operationId);
    sendProjectAnalysisEventToAll(senders, { status: "superseded", projectId, requestId: request.requestId });
    reportGraphSmokePhase(graphSmokeTrace, "terminalAnalysisEvent:superseded:sent", projectId, request.requestId, undefined);
    return;
  }
  const operation = updateOperation(operationId, {
    stage: "failed", completed: 0, total: 0, failed: 1, message
  });
  notifyProjectAnalysisProgressToAll(senders, projectPath, request, operation);
  await recordDiagnostic(projectPath, { category: "scan", code: "project-scan-failed", message, context: { projectId, requestId: request.requestId } });
  if (analysis?.request.requestId === request.requestId) finishActiveProjectAnalysis(analysis);
  else finishOperation(operationId);
  sendProjectAnalysisEventToAll(senders, { status: "failed", projectId, requestId: request.requestId, message });
  reportGraphSmokePhase(graphSmokeTrace, "terminalAnalysisEvent:failed:sent", projectId, request.requestId, new Error(message));
}

async function cancelProjectAnalysis(projectId: string, sender: WebContents): Promise<boolean> {
  const projectPath = resolveProjectPath(projectId);
  const analysis = activeProjectAnalyses.get(projectPath);
  if (!analysis || !analysis.senders.has(sender)) return false;
  if (projectMeasurementObserver?.onProjectAnalysisCancellationRequested) {
    projectMeasurementObserver.onProjectAnalysisCancellationRequested(
      analysis.request.requestId,
      performance.timeOrigin + performance.now()
    );
  }
  detachProjectAnalysisSender(analysis, sender, "cancelled");
  return true;
}

function stopProjectAnalysis(analysis: ActiveProjectAnalysis, status: "cancelled" | "superseded"): void {
  if (activeProjectAnalyses.get(analysis.projectPath) !== analysis) return;
  activeProjectAnalyses.delete(analysis.projectPath);
  if (latestScanRequests.get(analysis.projectPath) === analysis.request.requestId) latestScanRequests.delete(analysis.projectPath);
  analysis.process.kill();
  finishOperation(analysis.operationId);
  sendAnalysisSubscribers(analysis, { status, projectId: analysis.projectId, requestId: analysis.request.requestId });
  if (analysis.senders.size > 0) {
    reportGraphSmokePhase(analysis.graphSmokeTrace, `terminalAnalysisEvent:${status}:sent`, analysis.projectId, analysis.request.requestId, undefined);
  }
}

function detachProjectAnalysisSender(analysis: ActiveProjectAnalysis, sender: WebContents, status: "cancelled" | "superseded"): void {
  if (!analysis.senders.delete(sender)) return;
  sendProjectAnalysisEvent(sender, { status, projectId: analysis.projectId, requestId: analysis.request.requestId });
  reportGraphSmokePhase(analysis.graphSmokeTrace, `terminalAnalysisEvent:${status}:sent`, analysis.projectId, analysis.request.requestId, undefined);
  if (analysis.senders.size === 0) stopProjectAnalysis(analysis, status);
}

function notifyAnalysisSubscribers(analysis: ActiveProjectAnalysis, operation: AnalysisOperation): void {
  notifyProjectAnalysisProgressToAll(analysis.senders, analysis.projectPath, analysis.request, operation);
}

function sendAnalysisSubscribers(analysis: ActiveProjectAnalysis, event: ProjectAnalysisEvent): void {
  sendProjectAnalysisEventToAll(analysis.senders, event);
}

function finishActiveProjectAnalysis(analysis: ActiveProjectAnalysis): void {
  if (activeProjectAnalyses.get(analysis.projectPath) !== analysis) return;
  activeProjectAnalyses.delete(analysis.projectPath);
  if (latestScanRequests.get(analysis.projectPath) === analysis.request.requestId) latestScanRequests.delete(analysis.projectPath);
  analysis.process.kill();
  finishOperation(analysis.operationId);
}

function notifyProjectAnalysisProgress(sender: WebContents, projectPath: string, request: GenerationRequest, operation: AnalysisOperation): void {
  if (!sender.isDestroyed() && latestScanRequests.get(projectPath) === request.requestId) {
    sender.send(PROJECT_CHANNELS.operationProgress, { ...operation, requestId: request.requestId });
  }
}

function notifyProjectAnalysisProgressToAll(senders: ReadonlySet<WebContents>, projectPath: string, request: GenerationRequest, operation: AnalysisOperation): void {
  for (const sender of senders) notifyProjectAnalysisProgress(sender, projectPath, request, operation);
}

function sendProjectAnalysisEvent(sender: WebContents, event: ProjectAnalysisEvent): void {
  if (!sender.isDestroyed()) {
    const sentAtWallClockMs = projectMeasurementObserver?.onGenerationMeasurement ? Date.now() : 0;
    sender.send(PROJECT_CHANNELS.analysisResult, event);
    projectMeasurementObserver?.onProjectAnalysisEventSent(sender, event, sentAtWallClockMs);
  }
}

function sendProjectAnalysisEventToAll(senders: ReadonlySet<WebContents>, event: ProjectAnalysisEvent): void {
  for (const sender of senders) sendProjectAnalysisEvent(sender, event);
}

function formatProjectAnalysisError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProjectAnalysisWorkerMessage(value: unknown): value is ProjectAnalysisWorkerMessage {
  return typeof value === "object" && value !== null && "type" in value &&
    (value.type === "scanned" || value.type === "progress" || value.type === "measurement" || value.type === "result" || value.type === "failure") &&
    "requestId" in value && typeof value.requestId === "string";
}

function isGenerationPhaseMeasurement(value: unknown): value is GenerationPhaseMeasurement {
  if (!isRecord(value) || typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
      (value.outcome !== "completed" && value.outcome !== "failed")) return false;
  return ["scanMs", "semanticAnalysisMs", "clusteringMs", "layoutMs", "commitMs", "lockWaitMs", "snapshotReadMs", "snapshotValidationMs", "snapshotParseMs", "detailIndexMs"]
    .includes(String(value.metric));
}

function sendArchitectureReview(sender: WebContents, event: ArchitectureReviewEvent): void {
  if (!sender.isDestroyed()) {
    sender.send(PROJECT_CHANNELS.architectureReview, event);
  }
}

function sendSequenceReview(sender: WebContents, event: SequenceReviewEvent): void {
  if (!sender.isDestroyed()) {
    sender.send(PROJECT_CHANNELS.sequenceReview, event);
  }
}

function requireScanOptions(channel: string, value: unknown): ProjectScanOptions {
  const options = requireObject(channel, value, "options");
  return {
    concurrency: requireInteger(channel, options.concurrency, "concurrency", 1, 128),
    agentPlanTimeoutMs: options.agentPlanTimeoutMs === undefined
      ? undefined
      : requireInteger(channel, options.agentPlanTimeoutMs, "agentPlanTimeoutMs", 60_000, 120 * 60 * 1000)
  };
}

function requireOptionalAgentTimeout(channel: string, value: unknown): number | undefined {
  return value === undefined
    ? undefined
    : requireInteger(channel, value, "timeoutMs", 60_000, 120 * 60 * 1000);
}

async function runTrackedAnalysis<T>(
  kind: AnalysisOperation["kind"],
  message: string,
  sender: WebContents,
  task: (onProgress: (progress: AnalysisProgressUpdate) => void) => Promise<T>,
  projectId: string,
  projectPath: string
): Promise<T> {
  const started = startOperation(kind, message, projectId);
  const notify = (operation: AnalysisOperation) => {
    if (!sender.isDestroyed()) sender.send(PROJECT_CHANNELS.operationProgress, operation);
  };
  notify(started.operation);
  try {
    const result = await task((progress) => notify(updateOperation(started.operation.operationId, progress)));
    notify(updateOperation(started.operation.operationId, {
      stage: "completed",
      completed: 1,
      total: 1,
      failed: 0,
      message: "Analysis completed."
    }));
    return result;
  } catch (error) {
    notify(updateOperation(started.operation.operationId, {
      stage: "failed",
      completed: 0,
      total: 1,
      failed: 1,
      message: error instanceof Error ? error.message : String(error)
    }));
    await recordDiagnostic(projectPath, {
      category: "analysis",
      code: `${kind}-failed`,
      message: error instanceof Error ? error.message : String(error),
      context: { kind }
    });
    throw error;
  } finally {
    finishOperation(started.operation.operationId);
  }
}

/** Caller holds the project write lock, so a read cannot observe half a generation. */
async function readCanvasArtifactState(projectPath: string): Promise<CanvasReadResult | undefined> {
  const current = await readProjectProtocolCanvas(projectPath);
  if (!current) return undefined;
  const issue = canvasArtifactShapeIssue(current);
  if (issue) throw new Error(`FlowWeave committed graph overview is invalid and was preserved: project ${projectPath}: ${issue}`);
  return { mode: "editable", canvas: current };
}

async function readDisplayCanvasArtifactState(projectPath: string): Promise<CanvasReadResult | undefined> {
  const current = await readProjectProtocolCanvasForDisplay(projectPath);
  if (!current) return undefined;
  const issue = canvasArtifactShapeIssue(current);
  if (issue) throw new Error(`FlowWeave committed graph overview is invalid and was preserved: project ${projectPath}: ${issue}`);
  return { mode: "editable", canvas: current };
}

export function canvasArtifactShapeIssue(value: unknown): string | undefined {
  if (!isRecord(value)) return "canvas must be an object";
  if ("version" in value) return "legacy Canvas versions are accepted only by the one-time migration path";
  for (const field of ["id", "title", "projectPath", "generatedAt"] as const) {
    if (typeof value[field] !== "string") return `${field} must be a string`;
  }
  if (value.userRevision !== undefined && (!Number.isInteger(value.userRevision) || Number(value.userRevision) < 0)) return "userRevision must be a non-negative integer";
  if (!Array.isArray(value.nodes)) return "nodes must be an array";
  if (!Array.isArray(value.edges)) return "edges must be an array";
  for (const [index, node] of value.nodes.entries()) {
    const issue = graphNodeShapeIssue(node, `nodes[${index}]`);
    if (issue) return issue;
  }
  for (const [index, edge] of value.edges.entries()) {
    const issue = graphEdgeShapeIssue(edge, `edges[${index}]`);
    if (issue) return issue;
  }
  if (value.orphanedEdges !== undefined) {
    if (!Array.isArray(value.orphanedEdges)) return "orphanedEdges must be an array";
    for (const [index, edge] of value.orphanedEdges.entries()) {
      const issue = graphEdgeShapeIssue(edge, `orphanedEdges[${index}]`);
      if (issue) return issue;
    }
  }
  if (value.migrationPendingItems !== undefined) {
    if (!Array.isArray(value.migrationPendingItems)) return "migrationPendingItems must be an array";
    for (const [index, item] of value.migrationPendingItems.entries()) {
      if (!isRecord(item)) return `migrationPendingItems[${index}] must be an object`;
      if (!enumHas(item.kind, ["node", "edge"])) return `migrationPendingItems[${index}].kind is invalid`;
      if (![1, 2, 3, 4, 7].includes(Number(item.sourceVersion))) return `migrationPendingItems[${index}].sourceVersion is invalid`;
      if (item.sourceId !== undefined && typeof item.sourceId !== "string") return `migrationPendingItems[${index}].sourceId must be a string`;
      if (typeof item.reason !== "string" || !item.reason.trim()) return `migrationPendingItems[${index}].reason must be a non-empty string`;
      if (!("raw" in item)) return `migrationPendingItems[${index}].raw is required`;
    }
  }
  return undefined;
}

function enumHas(value: unknown, options: readonly string[]): boolean {
  return typeof value === "string" && options.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStoredProject(projectId: string): Promise<FlowWeaveStoredProject | undefined> {
  const projectPath = resolveProjectPath(projectId);
  const stored = await withArchitectureArtifactLock(projectPath, async () => {
    const overview = await readProjectProtocolOverview(projectPath);
    if (!overview) return undefined;
    const project = overview.project ?? (await readProjectProtocolSnapshot(projectPath, snapshotMeasurementCallback()))?.project;
    if (!project) throw new Error(`Committed protocol v7 project is missing: ${projectPath}`);
    const canvas = await readDisplayCanvasArtifactState(projectPath);
    if (!canvas) return undefined;
    return { project, canvas, overview };
  }, artifactLockWaitCallback());
  if (!stored) return undefined;
  const { project, canvas, overview } = stored;
  const scanFingerprint = project.scanFingerprint ?? canvas.canvas.scanFingerprint ?? "";
  const inputFingerprint = overview.architectureInputFingerprint ?? (await readProjectProtocolSnapshot(projectPath, snapshotMeasurementCallback()))?.localArchitecture.metadata?.inputFingerprint;
  return {
    projectId, project, canvas, generation: project.generation, scanFingerprint,
    artifacts: {
      project: "current", canvas: "current",
      task: await artifactStateForFingerprint(projectPath, "tasks/current.task.json", scanFingerprint),
      context: await artifactStateForFile(projectPath, "context/file-tree.md"),
      architecture: inputFingerprint ? "current" : "missing",
      sequences: await artifactStateForFingerprint(projectPath, "sequence-diagrams.json", scanFingerprint)
    },
    architectureReview: await readArchitectureReviewStatus(projectPath, { scanFingerprint, inputFingerprint: inputFingerprint ?? "" }),
    sequenceReview: await readSequenceReviewStatus(projectPath, scanFingerprint),
    relationDiagnostics: overview.relationDiagnostics ?? []
  };
}

async function artifactStateForFingerprint(projectPath: string, fileName: string, fingerprint: string): Promise<ProjectArtifactState> {
  try {
    const artifact = JSON.parse(await readFile(join(projectPath, FLOWWEAVE_DIR, fileName), "utf8")) as {
      inputFingerprint?: string;
      source?: string;
      metadata?: { inputFingerprint?: string };
    };
    return (artifact.metadata?.inputFingerprint ?? artifact.inputFingerprint) === fingerprint ? "current" : "stale";
  } catch (error) {
    return isMissing(error) ? "missing" : "failed";
  }
}

async function artifactStateForFile(projectPath: string, fileName: string): Promise<ProjectArtifactState> {
  try {
    await readFile(join(projectPath, FLOWWEAVE_DIR, fileName), "utf8");
    return "stale";
  } catch (error) {
    return isMissing(error) ? "missing" : "failed";
  }
}

async function refreshConnectionWithoutFailing(projectId: string, projectPath: string) {
  try {
    await refreshProjectAgentConnectionIfEnabled(projectPath);
  } catch (error) {
    console.warn("FlowWeave Agent connection refresh failed.", {
      projectId,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

function requireRuntimeAgentId(channel: string, value: unknown): RuntimeAgentId {
  if (typeof value === "string" && value.startsWith("custom:") && value.length > 7) return value as RuntimeAgentId;
  return requireEnum(channel, value, "agentId", TOOL_IDS);
}

export function requireProjectGraph(channel: string, value: unknown): CodeflowCanvas {
  const canvas = requireObject(channel, value, "canvas") as Partial<CodeflowCanvas>;
  const issue = canvasArtifactShapeIssue(canvas);
  if (issue) throw new Error(`[${channel}] Canvas is invalid: ${issue}`);
  return canvas as CodeflowCanvas;
}

function requireCanvasMigrationReviewRequest(channel: string, value: unknown): CanvasMigrationReviewRequest {
  const request = requireObject(channel, value, "request");
  const item = requireObject(channel, request.item, "request.item");
  const kind = requireEnum(channel, item.kind, "request.item.kind", ["node-edit", "edge", "migration-pending"] as const);
  const action = requireEnum(channel, request.action, "request.action", ["rebind", "keep", "discard"] as const);
  const parsed: CanvasMigrationReviewRequest = {
    generationId: requireString(channel, request.generationId, "request.generationId"),
    userRevision: requireInteger(channel, request.userRevision, "request.userRevision", 0, Number.MAX_SAFE_INTEGER),
    item: { kind, id: requireString(channel, item.id, "request.item.id") },
    action,
    ...(optionalTrimmedString(channel, request.targetNodeId, "request.targetNodeId") ? {
      targetNodeId: optionalTrimmedString(channel, request.targetNodeId, "request.targetNodeId")
    } : {}),
    ...(optionalTrimmedString(channel, request.sourceNodeId, "request.sourceNodeId") ? {
      sourceNodeId: optionalTrimmedString(channel, request.sourceNodeId, "request.sourceNodeId")
    } : {})
  };
  if (action === "rebind" && kind === "node-edit" && !parsed.targetNodeId) {
    throw new Error(`[${channel}] Node edit rebind requires request.targetNodeId.`);
  }
  if (action === "rebind" && kind === "edge" && (!parsed.sourceNodeId || !parsed.targetNodeId)) {
    throw new Error(`[${channel}] Relationship rebind requires request.sourceNodeId and request.targetNodeId.`);
  }
  return parsed;
}

function requireModificationSnapshot(channel: string, value: unknown): ModificationSnapshot {
  const snapshot = requireObject(channel, value, "snapshot") as Partial<ModificationSnapshot>;
  if (!snapshot.canvas || !Array.isArray(snapshot.canvas.modules) || !Array.isArray(snapshot.canvas.relations)) {
    throw new Error(`[${channel}] Modification snapshot must include Canvas modules and relations.`);
  }
  return snapshot as ModificationSnapshot;
}

function requireModificationAcknowledgementScope(
  channel: string,
  value: unknown
): ModificationAcknowledgementScope {
  const scope = requireObject(channel, value, "scope") as Partial<ModificationAcknowledgementScope>;
  if (scope.kind === "all" || scope.kind === "sequence") return { kind: scope.kind };
  if (scope.kind === "module-guidance" && "moduleId" in scope) {
    return {
      kind: "module-guidance",
      moduleId: requireString(channel, scope.moduleId, "scope.moduleId")
    };
  }
  throw new Error(`[${channel}] Unsupported modification acknowledgement scope.`);
}

export function requireProjectWorkspaceSession(channel: string, value: unknown): ProjectWorkspaceSession {
  const session = requireObject(channel, value, "session");
  const openProjectIds = requireStringArray(channel, session.openProjectIds, "session.openProjectIds");
  const activeProjectId = session.activeProjectId === undefined
    ? undefined
    : requireString(channel, session.activeProjectId, "session.activeProjectId");
  const pages = requireObject(channel, session.lastPageByProject, "session.lastPageByProject");
  const lastPageByProject: ProjectWorkspaceSession["lastPageByProject"] = {};
  for (const [projectId, page] of Object.entries(pages)) {
    lastPageByProject[requireString(channel, projectId, "session.lastPageByProject key")] = requireEnum(
      channel,
      page,
      "session.lastPageByProject",
      WORKSPACE_PAGES
    );
  }
  const contexts = session.contextsByProject === undefined
    ? {}
    : requireObject(channel, session.contextsByProject, "session.contextsByProject");
  const contextsByProject: ProjectWorkspaceSession["contextsByProject"] = {};
  for (const [projectId, value] of Object.entries(contexts)) {
    const context = requireObject(channel, value, "session.contextsByProject value");
    const safeProjectId = requireString(channel, projectId, "session.contextsByProject key");
    contextsByProject[safeProjectId] = {
      activePage: requireEnum(channel, context.activePage, "session.context.activePage", WORKSPACE_PAGES),
      expandedPaths: requireStringArray(channel, context.expandedPaths, "session.context.expandedPaths"),
      selectedNodeId: requireWorkspaceText(channel, context.selectedNodeId, "session.context.selectedNodeId"),
      selectedAgentId: requireString(channel, context.selectedAgentId, "session.context.selectedAgentId") as import("../../types").AgentId,
      executionMode: requireEnum(channel, context.executionMode, "session.context.executionMode", ["plan", "execute"] as const),
      selectedRunId: requireWorkspaceText(channel, context.selectedRunId, "session.context.selectedRunId"),
      runArtifactTab: requireEnum(channel, context.runArtifactTab, "session.context.runArtifactTab", ["prompt", "plan", "log", "result"] as const),
      checkpointId: requireWorkspaceText(channel, context.checkpointId, "session.context.checkpointId")
    };
  }
  return { openProjectIds, activeProjectId, lastPageByProject, contextsByProject };
}

function requireWorkspaceText(channel: string, value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`[${channel}] Invalid "${name}": expected a string.`);
  }
  return value;
}

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function readOptionalProjectTextFile(resolvedPath: string, requestedPath: string): Promise<string | undefined> {
  try {
    return await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (isMissing(error) && isOptionalFlowWeaveDocPath(requestedPath)) return undefined;
    throw error;
  }
}

function isOptionalFlowWeaveDocPath(filePath: string): boolean {
  return /^\.flowweave\/docs\/[A-Za-z0-9_-]+\.(md|json)$/.test(filePath);
}

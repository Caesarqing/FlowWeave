import { useEffect, useRef, useState } from "react";
import { GRAPH_SMOKE_TRACE_PREFIX } from "../common/graph-smoke-trace";
import type {
  AnalysisOperation,
  ArchitectureReviewEvent,
  ArchitectureReviewStatus,
  FlowWeaveProjectOpenResult,
  FlowWeaveStoredProject,
  GraphEdge,
  GraphNode,
  ProjectAnalysisCommittedResult,
  LocalGenerationStatus,
  ProjectArtifactStatuses,
  ProjectFileNode,
  RuntimeAgentId
} from "../types";
import { useI18n } from "../utils/i18n";
import { usePreferencesStore } from "../stores/preferences.store";
import { useProjectStore } from "../stores/project.store";
import { createAsyncRequestGuard } from "../utils/async-request-guard";

export function useProjectActions({
  maxRenderedTreeRows,
  projectId,
  projectFiles,
  scanFingerprint,
  flushCurrentCanvas,
  architectureReview,
  localGenerationStatus,
  loadInitialStaticGraph,
  setIsProjectLoading,
  setLastRunStatus,
  setProjectLabel,
  setProjectId,
  setProjectPath,
  setScanFingerprint,
  setRelationDiagnostics,
  setArtifactStatuses,
  setArchitectureReview,
  setLocalGenerationStatus,
  setSequenceReview,
  setProjectStatus,
  onProjectOpenStarted,
  onProjectOpened,
  onProjectAnalysisFinished
}: {
  maxRenderedTreeRows: number;
  projectId: string;
  projectFiles: ProjectFileNode[];
  scanFingerprint: string;
  flushCurrentCanvas: () => Promise<void>;
  architectureReview: ArchitectureReviewStatus;
  localGenerationStatus: LocalGenerationStatus;
  loadInitialStaticGraph: (
    nodes: GraphNode[],
    edges: GraphEdge[],
    files: ProjectFileNode[],
    layout?: import("../types").CanvasLayoutState,
    orphanedEdges?: GraphEdge[],
    metadata?: Pick<import("../types").CodeflowCanvas, "generation" | "generatedAt" | "groups" | "quality" | "orphanedNodeEdits" | "migrationPendingItems" | "preservedCounts">
  ) => void;
  setIsProjectLoading: (value: boolean) => void;
  setLastRunStatus: (value: string) => void;
  setProjectLabel: (value: string) => void;
  setProjectId: (value: string) => void;
  setProjectPath: (value: string) => void;
  setScanFingerprint: (value: string) => void;
  setRelationDiagnostics: (value: import("../types").ArchitectureRelationDiagnostic[]) => void;
  setArtifactStatuses: (
    value: ProjectArtifactStatuses | ((current?: ProjectArtifactStatuses) => ProjectArtifactStatuses | undefined)
  ) => void;
  setArchitectureReview: (
    value: ArchitectureReviewStatus | ((current: ArchitectureReviewStatus) => ArchitectureReviewStatus)
  ) => void;
  setLocalGenerationStatus: (value: LocalGenerationStatus) => void;
  setSequenceReview: (
    value: import("../types").SequenceReviewStatus |
      ((current: import("../types").SequenceReviewStatus) => import("../types").SequenceReviewStatus)
  ) => void;
  setProjectStatus: (value: string) => void;
  onProjectOpenStarted?: () => void;
  onProjectOpened?: (result: ProjectAnalysisCommittedResult |
    Extract<FlowWeaveProjectOpenResult, { status: "analyzing" }>) => void;
  onProjectAnalysisFinished?: (projectId: string) => void;
}) {
  const { t } = useI18n();
  const scanConcurrency = usePreferencesStore((state) => state.scanConcurrency);
  const agentPlanTimeoutMinutes = usePreferencesStore((state) => state.agentPlanTimeoutMinutes);
  const agentPlanTimeoutMs = agentPlanTimeoutMinutes * 60 * 1000;
  const [operation, setOperation] = useState<AnalysisOperation | null>(null);
  const acceptsNewProjectScan = useRef(false);
  const architectureReviewRef = useRef(architectureReview);
  const requestGuard = useRef(createAsyncRequestGuard()).current;
  const activeAnalysisRequest = useRef<{ localRequestId: number; requestId: string } | undefined>(undefined);
  const onProjectOpenedRef = useRef(onProjectOpened);
  const onProjectAnalysisFinishedRef = useRef(onProjectAnalysisFinished);
  onProjectOpenedRef.current = onProjectOpened;
  onProjectAnalysisFinishedRef.current = onProjectAnalysisFinished;

  useEffect(() => {
    requestGuard.activate();
    return () => requestGuard.invalidate();
  }, [requestGuard]);

  useEffect(() => {
    architectureReviewRef.current = architectureReview;
  }, [architectureReview]);

  useEffect(() => {
    if (!window.flowweave) {
      return undefined;
    }

    return window.flowweave.onOperationProgress((nextOperation) => {
      if (nextOperation.kind === "sequence-analysis") return;
      if (nextOperation.projectId !== projectId && !(acceptsNewProjectScan.current && nextOperation.kind === "project-scan")) return;
      setOperation(nextOperation);
      setProjectStatus(t("operation.progress", {
        stage: t(`operation.stage.${nextOperation.stage}`),
        completed: nextOperation.completed,
        total: nextOperation.total
      }));
    });
  }, [projectId, setProjectStatus, t]);

  useEffect(() => {
    if (!window.flowweave) return undefined;
    return window.flowweave.onProjectAnalysis((event) => {
      const active = activeAnalysisRequest.current;
      traceGraphSmokeRestorePhase(
        `renderer.analysisEvent.${event.status}:received`,
        active?.localRequestId,
        event.projectId,
        event.requestId,
        undefined
      );
      if (!active) {
        traceGraphSmokeRestorePhase(`renderer.analysisEvent.${event.status}:ignored-no-active-request`, undefined, event.projectId, event.requestId, undefined);
        return;
      }
      if (active.requestId !== event.requestId) {
        traceGraphSmokeRestorePhase(`renderer.analysisEvent.${event.status}:ignored-request-id`, active.localRequestId, event.projectId, event.requestId, undefined);
        return;
      }
      if (!requestGuard.isCurrent(active.localRequestId)) {
        traceGraphSmokeRestorePhase(`renderer.analysisEvent.${event.status}:ignored-stale-request`, active.localRequestId, event.projectId, event.requestId, undefined);
        return;
      }
      activeAnalysisRequest.current = undefined;
      acceptsNewProjectScan.current = false;
      if (event.status === "completed") {
        if (useProjectStore.getState().projectId !== event.projectId) {
          traceGraphSmokeRestorePhase("renderer.analysisEvent.completed:ignored-project", active.localRequestId, event.projectId, event.requestId, undefined);
          onProjectAnalysisFinishedRef.current?.(event.projectId);
          return;
        }
        traceGraphSmokeRestorePhase("renderer.applyProjectOpenResult:start", active.localRequestId, event.projectId, event.requestId, undefined);
        void applyProjectOpenResult(event.result, active.localRequestId)
          .then(() => {
            traceGraphSmokeRestorePhase("renderer.applyProjectOpenResult:completed", active.localRequestId, event.projectId, event.requestId, undefined);
          })
          .catch((error: unknown) => {
            traceGraphSmokeRestorePhase("renderer.applyProjectOpenResult:failed", active.localRequestId, event.projectId, event.requestId, error);
            const message = t("status.projectAnalysisFailed", { error: formatErrorMessage(error) });
            setProjectStatus(message);
            setLastRunStatus(message);
          })
          .finally(() => {
            if (requestGuard.isCurrent(active.localRequestId)) {
              setIsProjectLoading(false);
              onProjectAnalysisFinishedRef.current?.(event.projectId);
            }
          });
      } else {
        onProjectAnalysisFinishedRef.current?.(event.projectId);
        if (useProjectStore.getState().projectId !== event.projectId) {
          traceGraphSmokeRestorePhase(`renderer.analysisEvent.${event.status}:ignored-project`, active.localRequestId, event.projectId, event.requestId, undefined);
          return;
        }
        const message = event.status === "failed"
          ? t("status.projectAnalysisFailed", { error: event.message })
          : event.status === "cancelled" ? t("status.analysisCancelled") : t("status.analysisSuperseded");
        setProjectStatus(message);
        setLastRunStatus(message);
        setIsProjectLoading(false);
        traceGraphSmokeRestorePhase(`renderer.analysisEvent.${event.status}:applied`, active.localRequestId, event.projectId, event.requestId, undefined);
      }
    });
  }, [requestGuard, setIsProjectLoading, setLastRunStatus, setProjectStatus, t]);

  useEffect(() => {
    if (!window.flowweave) return undefined;
    return window.flowweave.onArchitectureReview((event) => {
      if (!shouldApplyArchitectureReviewEvent(event, projectId, scanFingerprint, architectureReviewRef.current)) return;
      architectureReviewRef.current = event.status;
      setArchitectureReview(event.status);
    });
  }, [
    projectId,
    scanFingerprint,
    setArchitectureReview,
    setProjectStatus
  ]);

  async function applyProjectOpenResult(result: FlowWeaveProjectOpenResult, requestId: number) {
    if (!requestGuard.isCurrent(requestId)) return;
    if (result.canceled) {
      setProjectStatus(t("status.cancelRead"));
      setLastRunStatus(t("status.cancelRead"));
      return;
    }
    if (result.status === "superseded" || result.status === "analyzing") return;

    const persistedCanvas = result.canvas;
    const canvas = persistedCanvas?.canvas;
    const inferredModules = canvas.nodes;
    const inferredEdges = canvas.edges;
    setProjectLabel(result.project.projectName);
    setProjectId(result.projectId);
    setProjectPath(result.project.rootPath);
    setScanFingerprint(result.scanFingerprint);
    setRelationDiagnostics(result.relationDiagnostics);
    setArtifactStatuses(result.artifacts);
    architectureReviewRef.current = result.architectureReview;
    setArchitectureReview(result.architectureReview);
    setLocalGenerationStatus(
      result.architectureReview.state === "missing" || result.architectureReview.state === "stale"
        ? "idle"
        : "local-ready"
    );
    setSequenceReview(result.sequenceReview);
    loadInitialStaticGraph(inferredModules, inferredEdges, result.project.files, canvas.layout, canvas.orphanedEdges, canvas);

    const truncateNote = result.project.summary.truncated
      ? t("status.projectTruncated", { count: result.project.summary.displayedEntries ?? maxRenderedTreeRows })
      : "";
    const pendingMigrationCount = canvas.preservedCounts?.pending ?? canvas.migrationPendingItems?.length ?? 0;
    const migrationNote = pendingMigrationCount > 0 ? t("status.migrationPending", { count: pendingMigrationCount }) : "";
    const message = t("status.projectRead", { files: result.project.summary.totalFiles, modules: inferredModules.length, note: `${truncateNote}${migrationNote}` });
    setProjectStatus(message);
    setLastRunStatus(message);
    onProjectOpenedRef.current?.(result);
  }

  function trackProjectAnalysis(
    result: Extract<FlowWeaveProjectOpenResult, { status: "analyzing" }>,
    localRequestId: number
  ) {
    activeAnalysisRequest.current = { localRequestId, requestId: result.requestId };
    acceptsNewProjectScan.current = true;
    setProjectLabel(result.projectName);
    setProjectId(result.projectId);
    setProjectPath(result.projectPath);
  }

  function applyNewProjectAnalysisStart(
    result: Extract<FlowWeaveProjectOpenResult, { status: "analyzing" }>,
    localRequestId: number
  ) {
    trackProjectAnalysis(result, localRequestId);
    setScanFingerprint("");
    setRelationDiagnostics([]);
    setArtifactStatuses({ project: "missing", canvas: "missing", task: "missing", context: "missing", architecture: "missing", sequences: "missing" });
    architectureReviewRef.current = { state: "missing" };
    setArchitectureReview({ state: "missing" });
    setSequenceReview({ state: "missing" });
    const cachedCanvas = result.cachedCanvas;
    if (cachedCanvas) {
      setScanFingerprint(cachedCanvas.scanFingerprint ?? "");
      setArtifactStatuses({ project: "stale", canvas: "stale", task: "missing", context: "missing", architecture: "stale", sequences: "stale" });
      loadInitialStaticGraph(
        cachedCanvas.nodes,
        cachedCanvas.edges,
        [],
        cachedCanvas.layout,
        cachedCanvas.orphanedEdges,
        cachedCanvas
      );
    } else {
      setScanFingerprint("");
      loadInitialStaticGraph([], [], []);
    }
    const message = t("status.analyzingProject");
    setProjectStatus(message);
    setLastRunStatus(message);
    onProjectOpenedRef.current?.(result);
  }

  function applyStoredProject(stored: FlowWeaveStoredProject) {
    const canvas = stored.canvas.canvas;
    const modules = canvas.nodes;
    setProjectLabel(stored.project.projectName);
    setProjectId(stored.projectId);
    setProjectPath(stored.project.rootPath);
    setScanFingerprint(stored.scanFingerprint);
    setRelationDiagnostics(stored.relationDiagnostics);
    setArtifactStatuses({ ...stored.artifacts, project: "stale", canvas: "stale", architecture: "stale" });
    architectureReviewRef.current = stored.architectureReview;
    setArchitectureReview(stored.architectureReview);
    setLocalGenerationStatus(
      stored.architectureReview.state === "missing" || stored.architectureReview.state === "stale"
        ? "idle"
        : "local-ready"
    );
    setSequenceReview(stored.sequenceReview);
    loadInitialStaticGraph(
      modules,
      canvas.edges,
      stored.project.files,
      canvas.layout,
      canvas.orphanedEdges,
      canvas
    );
    const message = t("status.rescanning");
    setProjectStatus(message);
    setLastRunStatus(message);
  }

  async function openProject() {
    if (!window.flowweave) {
      const message = t("status.browserNoOpen");
      setProjectStatus(message);
      setLastRunStatus(message);
      return;
    }

    const requestId = requestGuard.begin();
    let analysisStarted = false;
    acceptsNewProjectScan.current = true;
    setLocalGenerationStatus("idle");
    setIsProjectLoading(true);
    setProjectStatus(t("status.openingPicker"));
    try {
      await flushCurrentCanvas();
      if (!requestGuard.isCurrent(requestId)) return;
      onProjectOpenStarted?.();
      const result = await window.flowweave.openProject({
        concurrency: scanConcurrency,
        agentPlanTimeoutMs
      });
      if (!requestGuard.isCurrent(requestId)) return;
      if (result.canceled) {
        await applyProjectOpenResult(result, requestId);
      } else if (result.status === "analyzing") {
        applyNewProjectAnalysisStart(result, requestId);
        analysisStarted = true;
      } else {
        await applyProjectOpenResult(result, requestId);
      }
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      const message = t("status.readFailed", { error: formatErrorMessage(error) });
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      if (requestGuard.isCurrent(requestId) && !analysisStarted) {
        acceptsNewProjectScan.current = false;
        setIsProjectLoading(false);
      }
    }
  }

  async function restoreProject(projectToRestoreId: string) {
    if (!window.flowweave) {
      const message = t("status.browserNoOpen");
      setProjectStatus(message);
      setLastRunStatus(message);
      return;
    }

    const requestId = requestGuard.begin();
    let analysisStarted = false;
    acceptsNewProjectScan.current = true;
    setLocalGenerationStatus("idle");
    setIsProjectLoading(true);
    setProjectStatus(t("status.rescanning"));
    try {
      traceGraphSmokeRestorePhase("renderer.restore.flush:start", requestId, projectToRestoreId, undefined, undefined);
      try {
        await flushCurrentCanvas();
      } catch (error) {
        traceGraphSmokeRestorePhase("renderer.restore.flush:failed", requestId, projectToRestoreId, undefined, error);
        throw error;
      }
      traceGraphSmokeRestorePhase("renderer.restore.flush:completed", requestId, projectToRestoreId, undefined, undefined);
      if (!requestGuard.isCurrent(requestId)) {
        traceGraphSmokeRestorePhase("renderer.restore.guardAfterFlush:stale", requestId, projectToRestoreId, undefined, undefined);
        return;
      }
      traceGraphSmokeRestorePhase("renderer.restore.onProjectOpenStarted:start", requestId, projectToRestoreId, undefined, undefined);
      onProjectOpenStarted?.();
      traceGraphSmokeRestorePhase("renderer.restore.onProjectOpenStarted:completed", requestId, projectToRestoreId, undefined, undefined);
      traceGraphSmokeRestorePhase("renderer.restore.readRegisteredProject:start", requestId, projectToRestoreId, undefined, undefined);
      let stored: FlowWeaveStoredProject | undefined;
      try {
        stored = await window.flowweave.readRegisteredProject(projectToRestoreId);
      } catch (error) {
        traceGraphSmokeRestorePhase("renderer.restore.readRegisteredProject:failed", requestId, projectToRestoreId, undefined, error);
        throw error;
      }
      traceGraphSmokeRestorePhase("renderer.restore.readRegisteredProject:completed", requestId, projectToRestoreId, undefined, undefined);
      if (!requestGuard.isCurrent(requestId)) return;
      if (stored) applyStoredProject(stored);
      traceGraphSmokeRestorePhase("renderer.restore.restoreRegisteredProject:start", requestId, projectToRestoreId, undefined, undefined);
      let result: FlowWeaveProjectOpenResult;
      try {
        result = await window.flowweave.restoreRegisteredProject(projectToRestoreId, {
          concurrency: scanConcurrency,
          agentPlanTimeoutMs
        });
      } catch (error) {
        traceGraphSmokeRestorePhase("renderer.restore.restoreRegisteredProject:failed", requestId, projectToRestoreId, undefined, error);
        throw error;
      }
      traceGraphSmokeRestorePhase(
        "renderer.restore.restoreRegisteredProject:completed",
        requestId,
        projectToRestoreId,
        "requestId" in result ? result.requestId : undefined,
        undefined
      );
      if (!requestGuard.isCurrent(requestId)) return;
      if (!result.canceled && result.status === "analyzing") {
        trackProjectAnalysis(result, requestId);
        onProjectOpened?.(result);
        setProjectStatus(t("status.refreshingProject"));
        setLastRunStatus(t("status.refreshingProject"));
        analysisStarted = true;
      } else {
        await applyProjectOpenResult(result, requestId);
      }
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      const message = t("status.rescanFailed", { error: formatErrorMessage(error) });
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      if (requestGuard.isCurrent(requestId) && !analysisStarted) {
        acceptsNewProjectScan.current = false;
        setIsProjectLoading(false);
      }
    }
  }

  async function refreshProject() {
    if (!window.flowweave) {
      const message = t("status.browserNoRescan");
      setProjectStatus(message);
      setLastRunStatus(message);
      return;
    }

    if (!projectId) {
      await openProject();
      return;
    }

    const requestId = requestGuard.begin();
    let analysisStarted = false;
    setLocalGenerationStatus("idle");
    setIsProjectLoading(true);
    acceptsNewProjectScan.current = true;
    setProjectStatus(t("status.rescanning"));
    try {
      await flushCurrentCanvas();
      if (!requestGuard.isCurrent(requestId)) return;
      const result = await window.flowweave.scanProject(projectId, {
        concurrency: scanConcurrency,
        agentPlanTimeoutMs
      });
      if (!requestGuard.isCurrent(requestId)) return;
      if (!result.canceled && result.status === "analyzing") {
        trackProjectAnalysis(result, requestId);
        setArtifactStatuses((current) => current ? { ...current, canvas: "stale" } : current);
        setProjectStatus(t("status.refreshingProject"));
        setLastRunStatus(t("status.refreshingProject"));
        analysisStarted = true;
      } else {
        await applyProjectOpenResult(result, requestId);
      }
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      const message = t("status.rescanFailed", { error: formatErrorMessage(error) });
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      if (requestGuard.isCurrent(requestId) && !analysisStarted) {
        acceptsNewProjectScan.current = false;
        setIsProjectLoading(false);
      }
    }
  }

  async function analyzeProject(agentId: RuntimeAgentId) {
    if (!window.flowweave || !projectId) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }

    if (isArchitectureUpdateDisabled(localGenerationStatus, architectureReviewRef.current, agentId)) return;

    const requestId = requestGuard.begin();
    setLocalGenerationStatus("generating");
    setIsProjectLoading(true);
    setProjectStatus(t("status.generatingGraph"));
    try {
      await flushCurrentCanvas();
      if (!requestGuard.isCurrent(requestId)) return;
      const result = await window.flowweave.analyzeArchitectureWithAgent(projectId, agentId, agentPlanTimeoutMs);
      if (!requestGuard.isCurrent(requestId)) return;
      if (result.outcome === "failed") {
        throw new Error(`${result.error.agentId} run ${result.error.runId ?? "unknown"}: ${result.error.message}`);
      }
      setLocalGenerationStatus(result.localGenerationStatus);
      setArchitectureReview((current) => {
        const next = mergeArchitectureReviewResult(current, result.review);
        architectureReviewRef.current = next;
        return next;
      });
      setArtifactStatuses((current) => current ? {
        ...current,
        architecture: "current"
      } : current);
      const message = result.warning
        ? t("status.analysisLocalWarning", {
            count: result.graph.nodes.length,
            agent: result.warning.agentId,
            error: result.warning.message
          })
        : t("status.analysisComplete", { count: result.graph.nodes.length });
      setProjectStatus(message);
      setLastRunStatus(message);
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      const staticArchitectureIsCurrent = useProjectStore.getState().artifactStatuses?.architecture === "current";
      setLocalGenerationStatus(staticArchitectureIsCurrent ? "local-ready" : "failed");
      if (!staticArchitectureIsCurrent) {
        setArtifactStatuses((current) => current ? { ...current, architecture: "stale" } : current);
      }
      const message = t("status.analysisFailed", { error: formatErrorMessage(error) });
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      if (requestGuard.isCurrent(requestId)) setIsProjectLoading(false);
    }
  }

  return { openProject, restoreProject, refreshProject, analyzeProject, operation };
}

export function isArchitectureUpdateDisabled(
  localGenerationStatus: LocalGenerationStatus,
  review: ArchitectureReviewStatus,
  selectedAgentId: RuntimeAgentId
): boolean {
  return localGenerationStatus === "generating" ||
    (review.state === "reviewing" && review.agentId === selectedAgentId);
}

export function mergeArchitectureReviewResult(
  current: ArchitectureReviewStatus,
  result: ArchitectureReviewStatus
): ArchitectureReviewStatus {
  if (current.reviewId !== result.reviewId) return result;
  if ((current.state === "reviewed" || current.state === "review-failed") && result.state === "reviewing") {
    return current;
  }
  if (current.state === "reviewing" && current.runId && !result.runId) {
    return { ...result, runId: current.runId };
  }
  return result;
}

export function shouldApplyLocalArchitectureResult(
  result: ArchitectureReviewStatus,
  current: ArchitectureReviewStatus
): boolean {
  return !(current.reviewId === result.reviewId && current.state === "reviewed");
}

export function shouldApplyArchitectureReviewEvent(
  event: ArchitectureReviewEvent,
  projectId: string,
  scanFingerprint: string,
  current: ArchitectureReviewStatus
): boolean {
  if (event.projectId !== projectId || event.scanFingerprint !== scanFingerprint) return false;
  if (!current.reviewId || current.reviewId === event.reviewId) return true;
  if (event.status.state !== "reviewing") return false;
  if (!current.startedAt || !event.status.startedAt) return false;
  return Date.parse(event.status.startedAt) > Date.parse(current.startedAt);
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function traceGraphSmokeRestorePhase(
  stage: string,
  localRequestId: number | undefined,
  projectId: string,
  requestId: string | undefined,
  error: unknown | undefined
): void {
  if (!new URLSearchParams(window.location.search).has("flowweave-graph-smoke-trace")) return;
  console.info(`${GRAPH_SMOKE_TRACE_PREFIX}${JSON.stringify({
    source: "renderer",
    stage,
    monotonicMs: performance.now(),
    projectId,
    ...(localRequestId === undefined ? {} : { localRequestId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(error === undefined ? {} : { error: formatErrorMessage(error) })
  })}`);
}

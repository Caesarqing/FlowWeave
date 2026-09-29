import { useEffect, useRef, useState } from "react";
import type {
  AnalysisOperation,
  ArchitectureReviewEvent,
  ArchitectureReviewStatus,
  FlowWeaveProjectOpenResult,
  FlowWeaveStoredProject,
  GraphEdge,
  GraphNode,
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
  architectureReview,
  localGenerationStatus,
  loadInitialStaticGraph,
  adoptReviewedProjectGraph,
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
  legacyCanvasReadOnly,
  setLegacyCanvasReadOnly,
  onProjectOpenStarted,
  onProjectOpened
}: {
  maxRenderedTreeRows: number;
  projectId: string;
  projectFiles: ProjectFileNode[];
  scanFingerprint: string;
  architectureReview: ArchitectureReviewStatus;
  localGenerationStatus: LocalGenerationStatus;
  loadInitialStaticGraph: (
    nodes: GraphNode[],
    edges: GraphEdge[],
    files: ProjectFileNode[],
    layout?: import("../types").CanvasLayoutState,
    orphanedEdges?: GraphEdge[],
    metadata?: Pick<import("../types").CodeflowCanvas, "generation" | "groups" | "quality" | "orphanedNodeEdits">
  ) => void;
  adoptReviewedProjectGraph: (nodes: GraphNode[], edges: GraphEdge[], files: ProjectFileNode[]) => boolean;
  setIsProjectLoading: (value: boolean) => void;
  setLegacyCanvasReadOnly: (value: boolean) => void;
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
  onProjectOpened?: (result: Extract<FlowWeaveProjectOpenResult, { graph: { nodes: GraphNode[]; edges: GraphEdge[] } }>) => void;
  legacyCanvasReadOnly: boolean;
}) {
  const { t } = useI18n();
  const scanConcurrency = usePreferencesStore((state) => state.scanConcurrency);
  const agentPlanTimeoutMinutes = usePreferencesStore((state) => state.agentPlanTimeoutMinutes);
  const agentPlanTimeoutMs = agentPlanTimeoutMinutes * 60 * 1000;
  const [operation, setOperation] = useState<AnalysisOperation | null>(null);
  const acceptsNewProjectScan = useRef(false);
  const architectureReviewRef = useRef(architectureReview);
  const requestGuard = useRef(createAsyncRequestGuard()).current;

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
    return window.flowweave.onArchitectureReview((event) => {
      if (legacyCanvasReadOnly) return;
      if (!shouldApplyArchitectureReviewEvent(event, projectId, scanFingerprint, architectureReviewRef.current)) return;
      if (isReviewedGraphAdoptionEvent(event)) {
        const adopted = adoptReviewedProjectGraph(event.graph.nodes, event.graph.edges, projectFiles);
        if (!adopted) return;
        setArtifactStatuses((current) => current ? { ...current, architecture: "current" } : current);
      }
      architectureReviewRef.current = event.status;
      setArchitectureReview(event.status);
    });
  }, [
    projectId,
    legacyCanvasReadOnly,
    projectFiles,
    adoptReviewedProjectGraph,
    scanFingerprint,
    setArchitectureReview,
    setArtifactStatuses,
    setProjectStatus,
    t
  ]);

  async function applyProjectOpenResult(result: FlowWeaveProjectOpenResult, requestId: number) {
    if (!requestGuard.isCurrent(requestId)) return;
    if (result.canceled) {
      setProjectStatus(t("status.cancelRead"));
      setLastRunStatus(t("status.cancelRead"));
      return;
    }
    if (result.status === "superseded") return;

    const persistedCanvas = await window.flowweave?.readCanvas(result.projectId);
    if (!requestGuard.isCurrent(requestId)) return;
    const canvas = persistedCanvas?.canvas;
    const inferredModules = canvas?.nodes ?? result.graph.nodes;
    const inferredEdges = canvas?.edges ?? result.graph.edges;
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
    setLegacyCanvasReadOnly(persistedCanvas?.mode === "legacy-readonly");
    loadInitialStaticGraph(inferredModules, inferredEdges, result.project.files, canvas?.layout, canvas?.orphanedEdges, canvas);

    const truncateNote = result.project.summary.truncated
      ? t("status.projectTruncated", { count: result.project.summary.displayedEntries ?? maxRenderedTreeRows })
      : "";
    const message = t("status.projectRead", { files: result.project.summary.totalFiles, modules: inferredModules.length, note: truncateNote });
    setProjectStatus(message);
    setLastRunStatus(message);
    onProjectOpened?.(result);
  }

  function applyStoredProject(stored: FlowWeaveStoredProject) {
    const canvas = stored.canvas.canvas;
    const readOnly = stored.canvas.mode === "legacy-readonly";
    const modules = canvas.nodes;
    setProjectLabel(stored.project.projectName);
    setProjectId(stored.projectId);
    setProjectPath(stored.project.rootPath);
    setScanFingerprint(stored.scanFingerprint);
    setRelationDiagnostics(stored.relationDiagnostics);
    setArtifactStatuses(stored.artifacts);
    architectureReviewRef.current = stored.architectureReview;
    setArchitectureReview(stored.architectureReview);
    setLocalGenerationStatus(
      stored.architectureReview.state === "missing" || stored.architectureReview.state === "stale"
        ? "idle"
        : "local-ready"
    );
    setSequenceReview(stored.sequenceReview);
    setLegacyCanvasReadOnly(readOnly);
    loadInitialStaticGraph(
      modules,
      canvas.edges,
      stored.project.files,
      canvas.layout,
      canvas.orphanedEdges,
      canvas
    );
    const message = readOnly ? t("status.legacyCanvasReadOnly") : t("status.rescanning");
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

    onProjectOpenStarted?.();
    const requestId = requestGuard.begin();
    acceptsNewProjectScan.current = true;
    setLocalGenerationStatus("idle");
    setIsProjectLoading(true);
    setProjectStatus(t("status.openingPicker"));
    try {
      const result = await window.flowweave.openProject({
        concurrency: scanConcurrency,
        agentPlanTimeoutMs
      });
      await applyProjectOpenResult(result, requestId);
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      const message = t("status.readFailed", { error: formatErrorMessage(error) });
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      if (requestGuard.isCurrent(requestId)) {
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

    onProjectOpenStarted?.();
    const requestId = requestGuard.begin();
    acceptsNewProjectScan.current = true;
    setLocalGenerationStatus("idle");
    setIsProjectLoading(true);
    setProjectStatus(t("status.rescanning"));
    try {
      const stored = await window.flowweave.readRegisteredProject(projectToRestoreId);
      if (!requestGuard.isCurrent(requestId)) return;
      if (stored) applyStoredProject(stored);
      const result = await window.flowweave.restoreRegisteredProject(projectToRestoreId, {
        concurrency: scanConcurrency,
        agentPlanTimeoutMs
      });
      await applyProjectOpenResult(result, requestId);
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      const key = useProjectStore.getState().legacyCanvasReadOnly
        ? "status.legacyCanvasRescanFailed"
        : "status.rescanFailed";
      const message = t(key, { error: formatErrorMessage(error) });
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      if (requestGuard.isCurrent(requestId)) {
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
    setLocalGenerationStatus("idle");
    setIsProjectLoading(true);
    acceptsNewProjectScan.current = true;
    setProjectStatus(t("status.rescanning"));
    try {
      const result = await window.flowweave.scanProject(projectId, {
        concurrency: scanConcurrency,
        agentPlanTimeoutMs
      });
      await applyProjectOpenResult(result, requestId);
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      const key = useProjectStore.getState().legacyCanvasReadOnly
        ? "status.legacyCanvasRescanFailed"
        : "status.rescanFailed";
      const message = t(key, { error: formatErrorMessage(error) });
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      if (requestGuard.isCurrent(requestId)) {
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

    if (legacyCanvasReadOnly || isArchitectureUpdateDisabled(localGenerationStatus, architectureReviewRef.current, agentId)) return;

    const requestId = requestGuard.begin();
    setLocalGenerationStatus("generating");
    setIsProjectLoading(true);
    setProjectStatus(t("status.generatingGraph"));
    try {
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

export function isReviewedGraphAdoptionEvent(
  event: ArchitectureReviewEvent
): event is ArchitectureReviewEvent & { graph: { nodes: GraphNode[]; edges: GraphEdge[] } } {
  return event.status.state === "reviewed" &&
    event.presentationPhase === "reviewed" &&
    event.graph !== undefined;
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

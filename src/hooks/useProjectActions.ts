import { useEffect, useRef, useState } from "react";
import type {
  AnalysisOperation,
  ArchitectureReviewEvent,
  ArchitectureReviewStatus,
  FlowWeaveProjectOpenResult,
  GraphEdge,
  GraphNode,
  ProjectArtifactStatuses,
  ProjectFileNode,
  RuntimeAgentId
} from "../types";
import { useI18n } from "../utils/i18n";
import { usePreferencesStore } from "../stores/preferences.store";
import { createAsyncRequestGuard } from "../utils/async-request-guard";

export function useProjectActions({
  maxRenderedTreeRows,
  projectId,
  projectFiles,
  scanFingerprint,
  architectureReview,
  replaceProjectGraph,
  setIsProjectLoading,
  setLastRunStatus,
  setProjectLabel,
  setProjectId,
  setProjectPath,
  setScanFingerprint,
  setArtifactStatuses,
  setArchitectureReview,
  setSequenceReview,
  setProjectStatus,
  onProjectOpenStarted,
  onProjectOpened
}: {
  maxRenderedTreeRows: number;
  projectId: string;
  projectFiles: ProjectFileNode[];
  scanFingerprint: string;
  architectureReview: ArchitectureReviewStatus;
  replaceProjectGraph: (
    nodes: GraphNode[],
    edges: GraphEdge[],
    files: ProjectFileNode[],
    layout?: import("../types").CanvasLayoutState
  ) => void;
  setIsProjectLoading: (value: boolean) => void;
  setLastRunStatus: (value: string) => void;
  setProjectLabel: (value: string) => void;
  setProjectId: (value: string) => void;
  setProjectPath: (value: string) => void;
  setScanFingerprint: (value: string) => void;
  setArtifactStatuses: (
    value: ProjectArtifactStatuses | ((current?: ProjectArtifactStatuses) => ProjectArtifactStatuses | undefined)
  ) => void;
  setArchitectureReview: (
    value: ArchitectureReviewStatus | ((current: ArchitectureReviewStatus) => ArchitectureReviewStatus)
  ) => void;
  setSequenceReview: (
    value: import("../types").SequenceReviewStatus |
      ((current: import("../types").SequenceReviewStatus) => import("../types").SequenceReviewStatus)
  ) => void;
  setProjectStatus: (value: string) => void;
  onProjectOpenStarted?: () => void;
  onProjectOpened?: (result: Exclude<FlowWeaveProjectOpenResult, { canceled: true }>) => void;
}) {
  const { t } = useI18n();
  const scanConcurrency = usePreferencesStore((state) => state.scanConcurrency);
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
      if (!shouldApplyArchitectureReviewEvent(event, projectId, scanFingerprint, architectureReviewRef.current)) return;
      architectureReviewRef.current = event.status;
      setArchitectureReview(event.status);
      if (event.status.state === "reviewed" && event.graph) {
        replaceProjectGraph(event.graph.nodes, event.graph.edges, projectFiles);
        setArtifactStatuses((current) => current ? { ...current, architecture: "current" } : current);
        setProjectStatus(t("status.analysisReviewed", { agent: event.status.agentId ?? "" }));
      } else if (event.status.state === "review-failed") {
        setProjectStatus(t("status.analysisReviewFailed", {
          error: event.status.error?.message ?? t("artifact.unavailable")
        }));
      } else if (event.status.state === "reviewing" && event.status.message) {
        setProjectStatus(event.status.message);
      }
    });
  }, [
    projectId,
    projectFiles,
    replaceProjectGraph,
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

    const persistedCanvas = await window.flowweave?.readCanvas(result.projectId);
    if (!requestGuard.isCurrent(requestId)) return;
    const inferredModules = persistedCanvas?.nodes ?? result.graph.nodes;
    const inferredEdges = persistedCanvas?.edges ?? result.graph.edges;
    setProjectLabel(result.project.projectName);
    setProjectId(result.projectId);
    setProjectPath(result.project.rootPath);
    setScanFingerprint(result.scanFingerprint);
    setArtifactStatuses(result.artifacts);
    architectureReviewRef.current = result.architectureReview;
    setArchitectureReview(result.architectureReview);
    setSequenceReview(result.sequenceReview);
    replaceProjectGraph(inferredModules, inferredEdges, result.project.files, persistedCanvas?.layout);

    const truncateNote = result.project.summary.truncated
      ? t("status.projectTruncated", { count: result.project.summary.displayedEntries ?? maxRenderedTreeRows })
      : "";
    const message = t("status.projectRead", { files: result.project.summary.totalFiles, modules: inferredModules.length, note: truncateNote });
    setProjectStatus(message);
    setLastRunStatus(message);
    onProjectOpened?.(result);
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
    setIsProjectLoading(true);
    setProjectStatus(t("status.openingPicker"));
    try {
      const result = await window.flowweave.openProject({
        concurrency: scanConcurrency
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
    setIsProjectLoading(true);
    setProjectStatus(t("status.rescanning"));
    try {
      const result = await window.flowweave.restoreRegisteredProject(projectToRestoreId, {
        concurrency: scanConcurrency
      });
      await applyProjectOpenResult(result, requestId);
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      const message = t("status.rescanFailed", { error: formatErrorMessage(error) });
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
    setIsProjectLoading(true);
    acceptsNewProjectScan.current = true;
    setProjectStatus(t("status.rescanning"));
    try {
      const result = await window.flowweave.scanProject(projectId, {
        concurrency: scanConcurrency
      });
      await applyProjectOpenResult(result, requestId);
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      const message = t("status.rescanFailed", { error: formatErrorMessage(error) });
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

    const requestId = requestGuard.begin();
    setIsProjectLoading(true);
    setProjectStatus(t("status.generatingGraph"));
    try {
      const result = await window.flowweave.analyzeArchitectureWithAgent(projectId, agentId);
      if (!requestGuard.isCurrent(requestId)) return;
      if (result.outcome === "failed") {
        throw new Error(`${result.error.agentId} run ${result.error.runId ?? "unknown"}: ${result.error.message}`);
      }
      replaceProjectGraph(result.graph.nodes, result.graph.edges, projectFiles);
      setArchitectureReview((current) => {
        const next = current.reviewId === result.review.reviewId && current.state === "reviewed"
          ? current
          : result.review;
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
      const message = t("status.analysisFailed", { error: formatErrorMessage(error) });
      setProjectStatus(message);
      setLastRunStatus(message);
    } finally {
      if (requestGuard.isCurrent(requestId)) setIsProjectLoading(false);
    }
  }

  return { openProject, restoreProject, refreshProject, analyzeProject, operation };
}

export function shouldApplyArchitectureReviewEvent(
  event: ArchitectureReviewEvent,
  projectId: string,
  scanFingerprint: string,
  current: ArchitectureReviewStatus
): boolean {
  if (event.projectId !== projectId || event.scanFingerprint !== scanFingerprint) return false;
  if (event.status.state === "reviewing") return true;
  return !current.reviewId || current.reviewId === event.reviewId;
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

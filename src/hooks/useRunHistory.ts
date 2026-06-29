import { useEffect } from "react";
import { useAgentStore } from "../stores/agents.store";
import { useGitStore } from "../stores/git.store";
import { useNavigationStore } from "../stores/navigation.store";
import { useProjectStore } from "../stores/project.store";
import { useRunsStore } from "../stores/runs.store";
import type { ToolRunSummary } from "../types";
import { useI18n } from "../utils/i18n";

export function useRunHistory(projectId: string) {
  const { t } = useI18n();
  const selectedRunId = useRunsStore((state) => state.selectedRunId);
  const selectedRunArtifact = useRunsStore((state) => state.selectedRunArtifact);
  const setActivePage = useNavigationStore((state) => state.setActivePage);
  const setArchitectureReview = useProjectStore((state) => state.setArchitectureReview);
  const setArtifactStatuses = useProjectStore((state) => state.setArtifactStatuses);
  const setSequenceReview = useProjectStore((state) => state.setSequenceReview);
  const setDiff = useGitStore((state) => state.setDiff);
  const setIsRunsLoading = useRunsStore((state) => state.setIsRunsLoading);
  const setLastRunStatus = useAgentStore((state) => state.setLastRunStatus);
  const setRuns = useRunsStore((state) => state.setRuns);
  const setSelectedRunArtifact = useRunsStore((state) => state.setSelectedRunArtifact);
  const setSelectedRunId = useRunsStore((state) => state.setSelectedRunId);

  async function selectRun(runId: string) {
    if (!window.flowweave || !projectId) return;
    setSelectedRunId(runId);
    try {
      setSelectedRunArtifact(await window.flowweave.readToolRun(projectId, runId));
    } catch (error) {
      setSelectedRunArtifact(undefined);
      setLastRunStatus(t("status.runArtifactFailed", { error: formatErrorMessage(error) }));
    }
  }

  async function refreshRuns(selectRunId?: string) {
    if (!window.flowweave || !projectId) return;
    setIsRunsLoading(true);
    try {
      const nextRuns = await window.flowweave.listToolRuns(projectId);
      setRuns(nextRuns);
      const preferredRunId = selectRunId || selectedRunId;
      const nextRunId = nextRuns.some((run) => run.id === preferredRunId) ? preferredRunId : nextRuns[0]?.id || "";
      if (nextRunId) await selectRun(nextRunId);
      else {
        setSelectedRunId("");
        setSelectedRunArtifact(undefined);
      }
    } catch (error) {
      setLastRunStatus(t("status.runHistoryFailed", { error: formatErrorMessage(error) }));
    } finally {
      setIsRunsLoading(false);
    }
  }

  async function openGitReviewFromRun() {
    setActivePage("git-review");
    if (!window.flowweave || !projectId) return;
    try {
      setDiff(await window.flowweave.gitDiff(projectId, selectedRunArtifact?.summary.checkpointId));
    } catch (error) {
      setLastRunStatus(t("status.gitDiffFailed", { error: formatErrorMessage(error) }));
    }
  }

  async function applySelectedRunArtifact() {
    if (!window.flowweave || !projectId || !selectedRunId) return;
    try {
      const summary = await window.flowweave.applyRunArtifact(projectId, selectedRunId);
      setLastRunStatus(summary.artifactAdoption?.message ?? t("agent.applyRunArtifactComplete"));
      syncAppliedRunArtifactStatus(summary, setArtifactStatuses, setArchitectureReview, setSequenceReview);
      await refreshRuns(selectedRunId);
    } catch (error) {
      setLastRunStatus(t("agent.applyRunArtifactFailed", { error: formatErrorMessage(error) }));
    }
  }

  async function openSelectedRunBridge() {
    if (!window.flowweave || !projectId || !selectedRunId) return;
    try {
      await window.flowweave.openRunBridge(projectId, selectedRunId);
    } catch (error) {
      setLastRunStatus(t("agent.openRunBridgeFailed", { error: formatErrorMessage(error) }));
    }
  }

  useEffect(() => {
    void refreshRuns();
  }, [projectId]);

  return { applySelectedRunArtifact, openGitReviewFromRun, openSelectedRunBridge, refreshRuns, selectRun };
}

function syncAppliedRunArtifactStatus(
  summary: ToolRunSummary,
  setArtifactStatuses: ReturnType<typeof useProjectStore.getState>["setArtifactStatuses"],
  setArchitectureReview: ReturnType<typeof useProjectStore.getState>["setArchitectureReview"],
  setSequenceReview: ReturnType<typeof useProjectStore.getState>["setSequenceReview"]
) {
  if (summary.purpose !== "artifact-analysis") return;
  if (summary.artifactAdoption?.status !== "applied") return;
  const completedAt = summary.artifactAdoption.appliedAt ?? summary.completedAt;

  if (summary.artifactTarget === "architecture-map") {
    setArtifactStatuses((current) => current ? { ...current, architecture: "current" } : current);
    setArchitectureReview({
      state: "reviewed",
      reviewId: summary.reviewId,
      scanFingerprint: summary.scanFingerprint,
      agentId: summary.toolId,
      runId: summary.id,
      completedAt
    });
    return;
  }

  if (summary.artifactTarget === "sequence-diagrams" || summary.artifactTarget === "sequence-revision") {
    setArtifactStatuses((current) => current ? { ...current, sequences: "current" } : current);
    setSequenceReview({
      state: "reviewed",
      reviewId: summary.reviewId,
      scanFingerprint: summary.scanFingerprint,
      agentId: summary.toolId,
      runId: summary.id,
      completedAt
    });
  }
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

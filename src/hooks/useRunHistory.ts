import { useEffect } from "react";
import { useAgentStore } from "../stores/agents.store";
import { useGitStore } from "../stores/git.store";
import { useNavigationStore } from "../stores/navigation.store";
import { useRunsStore } from "../stores/runs.store";
import { useI18n } from "../utils/i18n";

export function useRunHistory(projectId: string) {
  const { t } = useI18n();
  const selectedRunId = useRunsStore((state) => state.selectedRunId);
  const selectedRunArtifact = useRunsStore((state) => state.selectedRunArtifact);
  const setActivePage = useNavigationStore((state) => state.setActivePage);
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

  useEffect(() => {
    void refreshRuns();
  }, [projectId]);

  return { openGitReviewFromRun, refreshRuns, selectRun };
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

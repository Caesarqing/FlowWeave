import { useState } from "react";
import { DiffViewer } from "./DiffViewer";
import { useGitStore } from "../stores/git.store";
import { useRunsStore } from "../stores/runs.store";
import { cn } from "../utils/classnames";
import { useI18n } from "../utils/i18n";
import { WorkspaceLayout } from "./WorkspaceLayout";
import { Button } from "./Button";
import { RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";

export function GitReviewWorkspace({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const diff = useGitStore((state) => state.diff);
  const checkpointId = useGitStore((state) => state.checkpointId);
  const activeRun = useRunsStore((state) => state.selectedRunArtifact?.summary);
  const setDiff = useGitStore((state) => state.setDiff);
  const setCheckpointId = useGitStore((state) => state.setCheckpointId);
  const [status, setStatus] = useState(() => t("git.status"));

  async function refreshDiff() {
    if (!window.flowweave || !projectId) {
      setStatus(t("git.needDesktop"));
      return;
    }
    const result = await window.flowweave.gitDiff(projectId, activeRun?.checkpointId);
    setDiff(result);
    setStatus(result.isRepo ? t("git.readFiles", { count: result.changedFiles.length }) : t("git.notRepo"));
  }

  async function createCheckpoint() {
    if (!window.flowweave || !projectId) {
      setStatus(t("git.needDesktop"));
      return;
    }
    try {
      const id = await window.flowweave.gitCheckpoint(projectId);
      setCheckpointId(id);
      setStatus(`Checkpoint: ${id}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function rollback() {
    if (!window.flowweave || !projectId || !checkpointId) {
      setStatus(t("git.needCheckpoint"));
      return;
    }
    try {
      await window.flowweave.gitRollback(projectId, checkpointId);
      setStatus(t("git.rollbackDone", { id: checkpointId }));
      await refreshDiff();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  const reviewPanel = (
    <section className="workspace-column">
        <div className="panel-header"><span>Git Review</span></div>
        <p className="project-status">{status}</p>
        <div className="module-card">
          <h3>{t("git.activeRun")}</h3>
          <p>{activeRun ? `${activeRun.id} · ${activeRun.toolId} · ${activeRun.status}` : t("git.noActiveRun")}</p>
          <p>{activeRun?.checkpointId ? `Checkpoint: ${activeRun.checkpointId}` : t("git.noCheckpoint")}</p>
        </div>
        <div className={cn("bridge-state", diff?.safety.level ?? "ok")}>Safety: {diff?.safety.level ?? "unknown"}</div>
        <div className="file-list">
          {diff?.changedFiles.map((file) => (
            <div className="file-pill" key={file.path}>
              <span>{file.status}</span>
              <span>{file.path}</span>
            </div>
          ))}
        </div>
    </section>
  );

  return (
    <WorkspaceLayout
      actions={(
        <>
          <Button icon={<RefreshCw size={14} />} variant="secondary" onClick={() => void refreshDiff()}>{t("git.refresh")}</Button>
          <Button icon={<ShieldCheck size={14} />} variant="secondary" onClick={() => void createCheckpoint()}>{t("git.createCheckpoint")}</Button>
          <Button disabled={!checkpointId} icon={<RotateCcw size={14} />} variant="danger" onClick={() => void rollback()}>Rollback</Button>
        </>
      )}
      className="workspace-page git-workspace"
      left={reviewPanel}
      leftWidth="300px"
      page="git-review"
      status={status}
      title={t("git.diff")}
    >
      <section className="workspace-main">
        <DiffViewer patch={diff?.patch ?? ""} />
      </section>
    </WorkspaceLayout>
  );
}

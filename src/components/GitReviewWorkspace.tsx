import { useState } from "react";
import { DiffViewer } from "./DiffViewer";
import { useWorkspaceStore } from "../stores/workspace.store";
import { cn } from "../utils/classnames";
import { useI18n } from "../utils/i18n";

export function GitReviewWorkspace({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const diff = useWorkspaceStore((state) => state.diff);
  const checkpointId = useWorkspaceStore((state) => state.checkpointId);
  const activeRun = useWorkspaceStore((state) => state.selectedRunArtifact?.summary);
  const setDiff = useWorkspaceStore((state) => state.setDiff);
  const setCheckpointId = useWorkspaceStore((state) => state.setCheckpointId);
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

  return (
    <main className="workspace-page git-workspace">
      <section className="workspace-column">
        <div className="panel-header"><span>Git Review</span></div>
        <button className="ghost-button" type="button" onClick={refreshDiff}>{t("git.refresh")}</button>
        <button className="ghost-button" type="button" onClick={() => void createCheckpoint()}>{t("git.createCheckpoint")}</button>
        <button className="ghost-button" disabled={!checkpointId} type="button" onClick={() => void rollback()}>Rollback</button>
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
      <section className="workspace-main">
        <div className="panel-header"><span>{t("git.diff")}</span></div>
        <DiffViewer patch={diff?.patch ?? ""} />
      </section>
    </main>
  );
}

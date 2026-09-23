import { useState } from "react";
import { DiffViewer } from "./DiffViewer";
import { useGitStore } from "../stores/git.store";
import { usePreferencesStore } from "../stores/preferences.store";
import { useRunsStore } from "../stores/runs.store";
import { cn } from "../utils/classnames";
import { useI18n } from "../utils/i18n";
import { WorkspaceLayout } from "./WorkspaceLayout";
import { Button } from "./Button";
import { RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import type { GitRollbackPreview } from "../types";

const unpreviewableReasonKeys: Record<string, string> = {
  "Binary or non-UTF-8 file.": "git.unpreviewable.binary",
  "File exceeds the 1 MiB preview limit.": "git.unpreviewable.large",
  "Untracked files exceed the 10 MiB total preview limit.": "git.unpreviewable.total",
  "Not a regular file.": "git.unpreviewable.special"
};

export function GitReviewWorkspace({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const diff = useGitStore((state) => state.diff);
  const checkpointId = useGitStore((state) => state.checkpointId);
  const activeRun = useRunsStore((state) => state.selectedRunArtifact?.summary);
  const setDiff = useGitStore((state) => state.setDiff);
  const setCheckpointId = useGitStore((state) => state.setCheckpointId);
  const scanConcurrency = usePreferencesStore((state) => state.scanConcurrency);
  const agentPlanTimeoutMinutes = usePreferencesStore((state) => state.agentPlanTimeoutMinutes);
  const [status, setStatus] = useState(() => t("git.status"));
  const [rollbackPreview, setRollbackPreview] = useState<GitRollbackPreview>();
  const [rollbackPending, setRollbackPending] = useState(false);

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
      setStatus(t("git.checkpoint", { id }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function prepareRollback() {
    if (!window.flowweave || !projectId || !checkpointId) {
      setStatus(t("git.needCheckpoint"));
      return;
    }
    try {
      setRollbackPreview(await window.flowweave.gitRollbackPreview(projectId, checkpointId));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function confirmRollback() {
    if (!window.flowweave || !projectId || !rollbackPreview || rollbackPending) return;
    setRollbackPending(true);
    try {
      await window.flowweave.gitRollback(projectId, rollbackPreview.checkpointId, rollbackPreview.previewId);
      setRollbackPreview(undefined);
      setStatus(t("git.rollbackDone", { id: rollbackPreview.checkpointId }));
      await window.flowweave.scanProject(projectId, {
        concurrency: scanConcurrency,
        agentPlanTimeoutMs: agentPlanTimeoutMinutes * 60 * 1000
      });
      await refreshDiff();
    } catch (error) {
      setRollbackPreview(undefined);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRollbackPending(false);
    }
  }

  const reviewPanel = (
    <section className="workspace-column">
        <div className="panel-header"><span>{t("git.review")}</span></div>
        <p className="project-status">{status}</p>
        <div className="module-card">
          <h3>{t("git.activeRun")}</h3>
          <p>{activeRun ? `${activeRun.id} · ${activeRun.toolId} · ${activeRun.status}` : t("git.noActiveRun")}</p>
          <p>{activeRun?.checkpointId ? t("git.checkpoint", { id: activeRun.checkpointId }) : t("git.noCheckpoint")}</p>
        </div>
        <div className={cn("bridge-state", diff?.safety.level ?? "ok")}>
          {t("git.safety", { level: t(`git.safetyLevel.${diff?.safety.level ?? "unknown"}`) })}
        </div>
        <div className="file-list">
          {diff?.changedFiles.map((file) => (
            <div className="file-pill" key={file.path}>
              <span>{file.status}</span>
              <span>{file.path}</span>
            </div>
          ))}
        </div>
        {diff?.unpreviewableFiles.length ? (
          <div className="git-unpreviewable-list">
            <strong>{t("git.unpreviewableTitle")}</strong>
            {diff.unpreviewableFiles.map((file) => (
              <p key={file.path}><code>{file.path}</code> · {t(unpreviewableReasonKeys[file.reason] ?? "git.unpreviewable.special")}</p>
            ))}
          </div>
        ) : null}
    </section>
  );

  return (
    <>
    <WorkspaceLayout
      actions={(
        <>
          <Button icon={<RefreshCw size={14} />} variant="secondary" onClick={() => void refreshDiff()}>{t("git.refresh")}</Button>
          <Button icon={<ShieldCheck size={14} />} variant="secondary" onClick={() => void createCheckpoint()}>{t("git.createCheckpoint")}</Button>
          <Button disabled={!checkpointId} icon={<RotateCcw size={14} />} variant="danger" onClick={() => void prepareRollback()}>{t("git.rollback")}</Button>
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
    {rollbackPreview ? (
      <div className="onboarding-backdrop" role="presentation">
        <section className="onboarding-dialog rollback-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="rollback-preview-title">
          <h1 id="rollback-preview-title">{t("git.rollbackPreviewTitle")}</h1>
          <p>{t("git.rollbackPreviewExpires", { time: new Date(rollbackPreview.expiresAt).toLocaleTimeString() })}</p>
          <div className="rollback-preview-section">
            <strong>{t("git.rollbackTracked", { count: rollbackPreview.trackedFilesToRestore.length })}</strong>
            <ul>{rollbackPreview.trackedFilesToRestore.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          </div>
          <div className="rollback-preview-section">
            <strong>{t("git.rollbackUntracked", { count: rollbackPreview.untrackedFilesToDelete.length })}</strong>
            <ul>{rollbackPreview.untrackedFilesToDelete.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          </div>
          <div className="rollback-preview-section">
            <strong>{t("git.rollbackCheckpointFiles", { count: rollbackPreview.checkpointUntrackedFilesToRestore.length })}</strong>
            <ul>{rollbackPreview.checkpointUntrackedFilesToRestore.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          </div>
          <p>{t("git.rollbackPreserved", { paths: rollbackPreview.preservedPaths.join(", ") })}</p>
          <div className="rollback-preview-actions">
            <Button disabled={rollbackPending} variant="secondary" onClick={() => setRollbackPreview(undefined)}>{t("git.cancel")}</Button>
            <Button disabled={rollbackPending} variant="danger" icon={<RotateCcw size={14} />} onClick={() => void confirmRollback()}>{t("git.confirmRollback")}</Button>
          </div>
        </section>
      </div>
    ) : null}
    </>
  );
}

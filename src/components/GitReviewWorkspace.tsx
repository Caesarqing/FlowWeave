import { useState } from "react";
import { DiffViewer } from "./DiffViewer";
import { useGitStore } from "../stores/git.store";

export function GitReviewWorkspace({ projectPath }: { projectPath: string }) {
  const diff = useGitStore((state) => state.diff);
  const checkpointId = useGitStore((state) => state.checkpointId);
  const setDiff = useGitStore((state) => state.setDiff);
  const setCheckpointId = useGitStore((state) => state.setCheckpointId);
  const [status, setStatus] = useState("点击刷新读取 Git diff。");

  async function refreshDiff() {
    if (!window.flowweave || !projectPath) {
      setStatus("请使用桌面版并先打开一个 Git 项目。");
      return;
    }
    const result = await window.flowweave.gitDiff(projectPath);
    setDiff(result);
    setStatus(result.isRepo ? `读取到 ${result.changedFiles.length} 个变更文件。` : "当前项目不是 Git 仓库。");
  }

  async function createCheckpoint() {
    if (!window.flowweave || !projectPath) {
      setStatus("请使用桌面版并先打开一个 Git 项目。");
      return;
    }
    try {
      const id = await window.flowweave.gitCheckpoint(projectPath);
      setCheckpointId(id);
      setStatus(`Checkpoint 已创建：${id}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function rollback() {
    if (!window.flowweave || !projectPath || !checkpointId) {
      setStatus("请先创建或选择 checkpoint。");
      return;
    }
    try {
      await window.flowweave.gitRollback(projectPath, checkpointId);
      setStatus(`已回滚：${checkpointId}`);
      await refreshDiff();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="workspace-page git-workspace">
      <section className="workspace-column">
        <div className="panel-header"><span>Git Review</span></div>
        <button className="ghost-button" type="button" onClick={refreshDiff}>刷新 Diff</button>
        <button className="ghost-button" type="button" onClick={() => void createCheckpoint()}>创建 Checkpoint</button>
        <button className="ghost-button" disabled={!checkpointId} type="button" onClick={() => void rollback()}>Rollback</button>
        <p className="project-status">{status}</p>
        <div className={`bridge-state ${diff?.safety.level ?? "ok"}`}>Safety: {diff?.safety.level ?? "unknown"}</div>
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
        <div className="panel-header"><span>Diff</span></div>
        <DiffViewer patch={diff?.patch ?? ""} />
      </section>
    </main>
  );
}

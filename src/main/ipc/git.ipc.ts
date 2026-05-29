import { ipcMain } from "electron";
import { GIT_CHANNELS } from "../../common/ipc-channels";
import { checkSafety } from "../services/safety-check.service";
import { createCheckpoint, getChangedFiles, getDiff, getGitStatus, restoreCheckpoint } from "../services/git.service";

export function registerGitIpc() {
  ipcMain.handle(GIT_CHANNELS.status, async (_event, projectPath: string) => {
    return getGitStatus(projectPath);
  });

  ipcMain.handle(GIT_CHANNELS.diff, async (_event, projectPath: string, checkpointId?: string) => {
    const [patch, changedFiles] = await Promise.all([getDiff(projectPath, checkpointId), getChangedFiles(projectPath)]);
    return {
      isRepo: (await getGitStatus(projectPath)).isRepo,
      patch,
      changedFiles,
      safety: checkSafety(changedFiles)
    };
  });

  ipcMain.handle(GIT_CHANNELS.checkpoint, async (_event, projectPath: string) => {
    return createCheckpoint(projectPath);
  });

  ipcMain.handle(GIT_CHANNELS.rollback, async (_event, projectPath: string, checkpointId: string) => {
    await restoreCheckpoint(projectPath, checkpointId);
  });
}

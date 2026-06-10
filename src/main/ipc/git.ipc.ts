import { ipcMain } from "electron";
import { GIT_CHANNELS } from "../../common/ipc-channels";
import { checkSafety } from "../services/safety-check.service";
import { createCheckpoint, getChangedFiles, getDiff, getGitStatus, restoreCheckpoint } from "../services/git.service";
import { resolveProjectPath } from "../services/project-registry.service";
import { requireString } from "./ipc-validation";

export function registerGitIpc() {
  ipcMain.handle(GIT_CHANNELS.status, async (_event, projectId: unknown) => {
    return getGitStatus(resolveProjectPath(requireString(GIT_CHANNELS.status, projectId, "projectId")));
  });

  ipcMain.handle(GIT_CHANNELS.diff, async (_event, projectId: unknown, checkpointId?: unknown) => {
    const projectPath = resolveProjectPath(requireString(GIT_CHANNELS.diff, projectId, "projectId"));
    const safeCheckpointId = checkpointId === undefined ? undefined : requireString(GIT_CHANNELS.diff, checkpointId, "checkpointId");
    const [patch, changedFiles] = await Promise.all([getDiff(projectPath, safeCheckpointId), getChangedFiles(projectPath)]);
    return {
      isRepo: (await getGitStatus(projectPath)).isRepo,
      patch,
      changedFiles,
      safety: checkSafety(changedFiles)
    };
  });

  ipcMain.handle(GIT_CHANNELS.checkpoint, async (_event, projectId: unknown) => {
    return createCheckpoint(resolveProjectPath(requireString(GIT_CHANNELS.checkpoint, projectId, "projectId")));
  });

  ipcMain.handle(GIT_CHANNELS.rollback, async (_event, projectId: unknown, checkpointId: unknown) => {
    await restoreCheckpoint(
      resolveProjectPath(requireString(GIT_CHANNELS.rollback, projectId, "projectId")),
      requireString(GIT_CHANNELS.rollback, checkpointId, "checkpointId")
    );
  });
}

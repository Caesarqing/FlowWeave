import { GIT_CHANNELS } from "../../common/ipc-channels";
import { checkSafety } from "../services/safety-check.service";
import {
  createCheckpoint,
  getChangedFiles,
  getDiffResult,
  getGitStatus,
  getRollbackPreview,
  restoreCheckpoint
} from "../services/git.service";
import { resolveProjectPath } from "../services/project-registry.service";
import { requireString } from "./ipc-validation";
import { handleIpc } from "./ipc-handler";

export function registerGitIpc() {
  handleIpc(GIT_CHANNELS.status, async (_event, projectId: unknown) => {
    return getGitStatus(resolveProjectPath(requireString(GIT_CHANNELS.status, projectId, "projectId")));
  });

  handleIpc(GIT_CHANNELS.diff, async (_event, projectId: unknown, checkpointId?: unknown) => {
    const projectPath = resolveProjectPath(requireString(GIT_CHANNELS.diff, projectId, "projectId"));
    const safeCheckpointId = checkpointId === undefined ? undefined : requireString(GIT_CHANNELS.diff, checkpointId, "checkpointId");
    const [diff, changedFiles] = await Promise.all([getDiffResult(projectPath, safeCheckpointId), getChangedFiles(projectPath)]);
    return {
      isRepo: (await getGitStatus(projectPath)).isRepo,
      patch: diff.patch,
      changedFiles,
      unpreviewableFiles: diff.unpreviewableFiles,
      safety: checkSafety(changedFiles)
    };
  });

  handleIpc(GIT_CHANNELS.checkpoint, async (_event, projectId: unknown) => {
    return createCheckpoint(resolveProjectPath(requireString(GIT_CHANNELS.checkpoint, projectId, "projectId")));
  });

  handleIpc(GIT_CHANNELS.rollbackPreview, async (_event, projectId: unknown, checkpointId: unknown) => {
    return getRollbackPreview(
      resolveProjectPath(requireString(GIT_CHANNELS.rollbackPreview, projectId, "projectId")),
      requireString(GIT_CHANNELS.rollbackPreview, checkpointId, "checkpointId")
    );
  });

  handleIpc(GIT_CHANNELS.rollback, async (_event, projectId: unknown, checkpointId: unknown, previewId: unknown) => {
    await restoreCheckpoint(
      resolveProjectPath(requireString(GIT_CHANNELS.rollback, projectId, "projectId")),
      requireString(GIT_CHANNELS.rollback, checkpointId, "checkpointId"),
      requireString(GIT_CHANNELS.rollback, previewId, "previewId")
    );
  });
}

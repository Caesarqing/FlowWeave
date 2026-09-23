import type { ToolRunResult } from "../../types";
import { expirePendingAgentInboxRun, readRunArtifact } from "./run-log.service";

export type WaitForArtifactRunResponseOptions = {
  pollIntervalMs: number;
};

export async function waitForArtifactRunResponse(
  projectPath: string,
  initial: ToolRunResult,
  options: WaitForArtifactRunResponseOptions
): Promise<ToolRunResult> {
  if (initial.status !== "pending") return initial;
  const startedAt = Date.parse(initial.startedAt);
  const deadline = Number.isFinite(initial.timeoutMs) && !Number.isNaN(startedAt)
    ? startedAt + Number(initial.timeoutMs)
    : undefined;
  while (true) {
    if (deadline !== undefined && Date.now() >= deadline) {
      await expirePendingAgentInboxRun(projectPath, initial.id);
    }
    const artifact = await readRunArtifact(projectPath, initial.id);
    if (artifact.summary.status !== "pending") {
      const result = JSON.parse(artifact.result) as Partial<ToolRunResult>;
      return {
        ...initial,
        status: artifact.summary.status,
        completedAt: artifact.summary.completedAt,
        summary: artifact.summary.summary,
        outputText: artifact.plan,
        artifactAdoption: artifact.summary.artifactAdoption,
        failure: result.failure,
        terminationReason: result.terminationReason
      };
    }
    const remainingMs = deadline === undefined ? options.pollIntervalMs : deadline - Date.now();
    await sleep(Math.max(1, Math.min(options.pollIntervalMs, remainingMs)));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

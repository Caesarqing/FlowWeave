import type { ArtifactAdoption, ToolRunResult } from "../../types";
import { readRunArtifact, updateRunArtifactAdoption } from "./run-log.service";

export type ArtifactRunLateState = {
  softTimedOutAt: string;
  message: string;
};

export type WaitForArtifactRunResponseOptions = {
  softTimeoutMs: number;
  signal: AbortSignal | undefined;
  pollIntervalMs: number;
  onLate: (state: ArtifactRunLateState) => Promise<void>;
};

export async function waitForArtifactRunResponse(
  projectPath: string,
  initial: ToolRunResult,
  options: WaitForArtifactRunResponseOptions
): Promise<ToolRunResult> {
  if (initial.status !== "pending") return initial;
  const startedAt = Date.now();
  let lateMarked = false;
  while (true) {
    if (options.signal?.aborted) {
      return {
        ...initial,
        status: "failed",
        summary: `Agent review was canceled while waiting for Agent Inbox response.json: ${initial.id}`
      };
    }

    await sleep(options.pollIntervalMs);
    const artifact = await readRunArtifact(projectPath, initial.id);
    if (artifact.summary.status !== "pending") {
      return {
        ...initial,
        status: artifact.summary.status,
        completedAt: artifact.summary.completedAt,
        summary: artifact.summary.summary,
        outputText: artifact.plan,
        artifactAdoption: artifact.summary.artifactAdoption
      };
    }

    if (!lateMarked && Date.now() - startedAt >= options.softTimeoutMs) {
      lateMarked = true;
      const late = lateAdoption(initial);
      await updateRunArtifactAdoption(projectPath, initial.id, late);
      await options.onLate({
        softTimedOutAt: new Date().toISOString(),
        message: late.message
      });
    }
  }
}

function lateAdoption(result: ToolRunResult): ArtifactAdoption {
  return {
    status: "late",
    message: `Agent Inbox response is taking longer than expected; still waiting for ${result.id}.`
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

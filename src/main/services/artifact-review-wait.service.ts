import type { ToolRunResult } from "../../types";
import { readRunArtifact } from "./run-log.service";

export type WaitForArtifactRunResponseOptions = {
  pollIntervalMs: number;
};

export async function waitForArtifactRunResponse(
  projectPath: string,
  initial: ToolRunResult,
  options: WaitForArtifactRunResponseOptions
): Promise<ToolRunResult> {
  if (initial.status !== "pending") return initial;
  while (true) {
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
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

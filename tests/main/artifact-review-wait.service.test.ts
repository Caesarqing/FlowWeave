import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { waitForArtifactRunResponse } from "../../src/main/services/artifact-review-wait.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import type { ToolRunResult } from "../../src/types";

describe("artifact-review-wait.service", () => {
  it("marks pending desktop artifact runs late without failing the run", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-artifact-wait-"));
    const runId = "run-1782571875406";
    const runDir = join(projectPath, FLOWWEAVE_DIR, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "prompt.md"), "Prompt", "utf8");
    await writeFile(join(runDir, "plan.md"), "Pending", "utf8");
    await writeFile(join(runDir, "agent.log"), "Log", "utf8");
    const pendingRun: ToolRunResult = {
      id: runId,
      projectId: "project-1",
      toolId: "codex-desktop",
      status: "pending",
      projectPath,
      startedAt: "2026-06-27T00:00:00.000Z",
      completedAt: "2026-06-27T00:00:00.000Z",
      executionMode: "plan",
      purpose: "artifact-analysis",
      artifactTarget: "architecture-map",
      scanFingerprint: "scan-test",
      reviewId: "review-test",
      events: [],
      artifactAdoption: {
        status: "pending",
        message: `Waiting for Codex Desktop response for ${runId}.`
      }
    };
    await writeFile(join(runDir, "result.json"), JSON.stringify(pendingRun), "utf8");
    const controller = new AbortController();
    const lateEvents: string[] = [];

    const result = await waitForArtifactRunResponse(projectPath, pendingRun, {
      softTimeoutMs: 1,
      signal: controller.signal,
      pollIntervalMs: 1,
      onLate: async (late) => {
        lateEvents.push(late.message);
        controller.abort();
      }
    });
    const stored = JSON.parse(await readFile(join(runDir, "result.json"), "utf8")) as ToolRunResult;

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("canceled");
    expect(lateEvents[0]).toContain(runId);
    expect(stored.status).toBe("pending");
    expect(stored.artifactAdoption).toMatchObject({
      status: "late",
      message: expect.stringContaining(runId)
    });
  });
});

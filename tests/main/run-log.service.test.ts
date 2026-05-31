import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startToolPlan } from "../../src/main/services/agent-run.service";
import { listRunSummaries, readRunArtifact } from "../../src/main/services/run-log.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";

describe("run-log.service", () => {
  it("lists run summaries newest first", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-runs-"));
    await writeRunResult(projectPath, "run-old", "2026-05-27T00:00:00.000Z");
    await writeRunResult(projectPath, "run-new", "2026-05-28T00:00:00.000Z");

    const summaries = await listRunSummaries(projectPath);

    expect(summaries.map((summary) => summary.id)).toEqual(["run-new", "run-old"]);
    expect(summaries[0]).toMatchObject({
      toolId: "mock",
      status: "completed",
      executionMode: "plan"
    });
  });

  it("reads fixed run artifacts from a run directory", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-run-artifact-"));
    await writeRunResult(projectPath, "run-1", "2026-05-28T00:00:00.000Z");

    const artifact = await readRunArtifact(projectPath, "run-1");

    expect(artifact.summary.id).toBe("run-1");
    expect(artifact.prompt).toContain("Prompt for run-1");
    expect(artifact.plan).toContain("Plan for run-1");
    expect(artifact.log).toContain("Log for run-1");
    expect(artifact.result).toContain('"id": "run-1"');
  });

  it("rejects invalid run ids", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-run-invalid-"));

    await expect(readRunArtifact(projectPath, "../outside")).rejects.toThrow("Invalid FlowWeave run id");
  });

  it("exposes artifacts written by startToolPlan", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-run-start-"));
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });

    const result = await startToolPlan({
      projectPath,
      toolId: "mock",
      prompt: "Review auth module.",
      executionMode: "plan"
    });

    const summaries = await listRunSummaries(projectPath);
    const artifact = await readRunArtifact(projectPath, result.id);

    expect(summaries[0].id).toBe(result.id);
    expect(artifact.prompt).toContain("Review auth module.");
    expect(artifact.plan).toContain("Mock plan");
    expect(artifact.result).toContain('"toolId": "mock"');
  });
});

async function writeRunResult(projectPath: string, runId: string, startedAt: string) {
  const runDir = join(projectPath, FLOWWEAVE_DIR, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "prompt.md"), `Prompt for ${runId}\n`, "utf8");
  await writeFile(join(runDir, "plan.md"), `Plan for ${runId}\n`, "utf8");
  await writeFile(join(runDir, "agent.log"), `Log for ${runId}\n`, "utf8");
  await writeFile(
    join(runDir, "result.json"),
    `${JSON.stringify(
      {
        id: runId,
        toolId: "mock",
        status: "completed",
        executionMode: "plan",
        projectPath,
        startedAt,
        completedAt: startedAt,
        summary: `Summary for ${runId}`,
        events: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startToolPlan } from "../../src/main/services/agent-run.service";
import { registerProject } from "../../src/main/services/project-registry.service";
import { listRunSummaries, readRunArtifact } from "../../src/main/services/run-log.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import { readArchitectureReviewStatus, writeArchitectureReviewStatus } from "../../src/main/services/architecture-review.service";
import {
  getAgentInboxRequestPath,
  getAgentInboxResponsePath,
  writeAgentInboxRequest
} from "../../src/main/services/agent-inbox.service";

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
    const projectId = await registerProject(projectPath);

    const result = await startToolPlan({
      projectId,
      toolId: "mock",
      prompt: "Review auth module.",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    const summaries = await listRunSummaries(projectPath);
    const artifact = await readRunArtifact(projectPath, result.id);

    expect(summaries[0].id).toBe(result.id);
    expect(artifact.prompt).toContain("Review auth module.");
    expect(artifact.plan).toContain("Mock plan");
    expect(artifact.result).toContain('"toolId": "mock"');
  });

  it("imports failed Agent Inbox artifact responses as rejected review failures", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-run-failed-inbox-"));
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });
    const projectId = await registerProject(projectPath);
    const runId = "run-failed-inbox";
    await writePendingRunResult(projectPath, runId, projectId, {
      purpose: "artifact-analysis",
      artifactTarget: "architecture-map",
      scanFingerprint: "scan-1",
      inputFingerprint: "input-1",
      reviewId: "review-1"
    });
    await writeArchitectureReviewStatus(projectPath, {
      state: "reviewing",
      projectId,
      artifactTarget: "architecture-map",
      reviewId: "review-1",
      scanFingerprint: "scan-1",
      inputFingerprint: "input-1",
      agentId: "codex-desktop"
    });
    await writeAgentInboxRequest({
      id: runId,
      projectId,
      projectPath,
      prompt: "Return architecture JSON.",
      executionMode: "plan",
      purpose: "artifact-analysis",
      artifactTarget: "architecture-map",
      scanFingerprint: "scan-1",
      inputFingerprint: "input-1",
      reviewId: "review-1"
    }, "codex-desktop");
    await writeFile(getAgentInboxResponsePath(projectPath, runId), JSON.stringify({
      protocolVersion: 2,
      runId,
      projectId,
      status: "failed",
      summary: "Agent could not inspect project.",
      content: "",
      completedAt: "2026-08-07T00:00:00.000Z",
      error: { code: "agent-error", message: "Tool crashed during analysis." }
    }), "utf8");

    const summaries = await listRunSummaries(projectPath);
    const review = await readArchitectureReviewStatus(projectPath, { scanFingerprint: "scan-1", inputFingerprint: "input-1" });

    expect(summaries[0]).toMatchObject({
      id: runId,
      status: "failed",
      summary: "Tool crashed during analysis.",
      artifactAdoption: {
        status: "rejected",
        message: "Tool crashed during analysis."
      }
    });
    expect(review).toMatchObject({
      state: "review-failed",
      reviewId: "review-1",
      runId,
      error: {
        code: "invalid-output",
        message: "Tool crashed during analysis."
      }
    });
  });

  it("records malformed Agent Inbox responses as failed runs and preserves invalid response text", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-run-malformed-inbox-"));
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });
    const projectId = await registerProject(projectPath);
    const runId = "run-malformed-inbox";
    await writePendingRunResult(projectPath, runId, projectId, {
      purpose: "artifact-analysis",
      artifactTarget: "architecture-map",
      scanFingerprint: "scan-1",
      reviewId: "review-1"
    });
    await writeAgentInboxRequest({
      id: runId,
      projectId,
      projectPath,
      prompt: "Return architecture JSON.",
      executionMode: "plan",
      purpose: "artifact-analysis",
      artifactTarget: "architecture-map",
      scanFingerprint: "scan-1",
      reviewId: "review-1"
    }, "codex-desktop");
    await writeFile(getAgentInboxResponsePath(projectPath, runId), "{not valid json", "utf8");

    const summaries = await listRunSummaries(projectPath);

    expect(summaries[0]).toMatchObject({
      id: runId,
      status: "failed",
      artifactAdoption: {
        status: "rejected",
        message: expect.stringContaining("Expected property name")
      }
    });
    await expect(readFile(getAgentInboxRequestPath(projectPath, runId), "utf8")).resolves.toContain(`"runId": "${runId}"`);
    await expect(readFile(getAgentInboxResponsePath(projectPath, runId), "utf8")).resolves.toBe("{not valid json");
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

async function writePendingRunResult(
  projectPath: string,
  runId: string,
  projectId: string,
  overrides: {
    purpose: "implementation-plan" | "artifact-analysis";
    artifactTarget?: "architecture-map" | "sequence-diagrams" | "sequence-revision";
    scanFingerprint?: string;
    inputFingerprint?: string;
    reviewId?: string;
  }
) {
  const runDir = join(projectPath, FLOWWEAVE_DIR, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "prompt.md"), `Prompt for ${runId}\n`, "utf8");
  await writeFile(join(runDir, "plan.md"), "", "utf8");
  await writeFile(join(runDir, "agent.log"), "", "utf8");
  await writeFile(
    join(runDir, "result.json"),
    `${JSON.stringify(
      {
        id: runId,
        projectId,
        toolId: "codex-desktop",
        status: "pending",
        executionMode: "plan",
        projectPath,
        startedAt: "2026-08-07T00:00:00.000Z",
        completedAt: "2026-08-07T00:00:00.000Z",
        events: [],
        artifactAdoption: overrides.purpose === "artifact-analysis"
          ? { status: "pending", message: "Waiting for Agent Inbox response." }
          : { status: "not-applicable", message: "Run is not an artifact-analysis run." },
        ...overrides
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

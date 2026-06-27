import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import { buildRunPrompt, startToolPlan } from "../../src/main/services/agent-run.service";
import { registerProject } from "../../src/main/services/project-registry.service";
import { listRunSummaries, readRunArtifact } from "../../src/main/services/run-log.service";

describe("agent-run.service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not append implementation-plan instructions to artifact analysis prompts", () => {
    expect(buildRunPrompt("Return architecture JSON.", "plan", "artifact-analysis")).toBe("Return architecture JSON.");
    expect(buildRunPrompt("Implement auth.", "execute", "implementation-plan")).toBe("Implement auth.");
    expect(buildRunPrompt("Review auth.", "plan", "implementation-plan")).toContain("Do not edit files.");
  });

  it("generates prompt, plan, log, and result files with the mock tool", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-run-"));
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });
    const projectId = await registerProject(projectPath);

    const result = await startToolPlan({
      projectId,
      toolId: "mock",
      prompt: "Review auth module.",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    expect(result.status).toBe("completed");
    expect(result.executionMode).toBe("plan");
    await expect(readFile(result.promptPath ?? "", "utf8")).resolves.toContain("Review auth module.");
    await expect(readFile(result.planPath ?? "", "utf8")).resolves.toContain("Mock plan");
    await expect(readFile(result.logPath ?? "", "utf8")).resolves.toContain("Plan generated");
    await expect(readFile(result.resultPath ?? "", "utf8")).resolves.toContain('"toolId": "mock"');
  });

  it("writes desktop bridge responses into run artifacts", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-desktop-run-"));
    const runId = "run-1700000000000";
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });
    const projectId = await registerProject(projectPath);
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);

    setTimeout(() => {
      const bridgeDir = join(projectPath, FLOWWEAVE_DIR, "agent-bridge", runId);
      void mkdir(bridgeDir, { recursive: true }).then(() =>
        writeFile(
          join(bridgeDir, "response.json"),
          JSON.stringify({
            runId,
            projectId,
            status: "completed",
            summary: "desktop response",
            content: "# Desktop Run Plan",
            completedAt: "2026-06-09T12:00:00.000Z"
          }),
          "utf8"
        )
      );
    }, 20);

    const result = await startToolPlan({
      projectId,
      toolId: "codex-desktop",
      prompt: "Review desktop bridge.",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    expect(result.status).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const summaries = await listRunSummaries(projectPath);
    const artifact = await readRunArtifact(projectPath, result.id);
    expect(summaries[0].status).toBe("completed");
    expect(artifact.plan).toContain("Desktop Run Plan");
    expect(artifact.result).toContain('"toolId": "codex-desktop"');
  });

  it("imports desktop bridge response.md for implementation-plan runs", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-desktop-md-run-"));
    const runId = "run-1700000000001";
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });
    const projectId = await registerProject(projectPath);
    vi.spyOn(Date, "now").mockReturnValue(1700000000001);

    setTimeout(() => {
      const bridgeDir = join(projectPath, FLOWWEAVE_DIR, "agent-bridge", runId);
      void mkdir(bridgeDir, { recursive: true }).then(() =>
        writeFile(join(bridgeDir, "response.md"), "# Desktop Markdown Plan", "utf8")
      );
    }, 20);

    const result = await startToolPlan({
      projectId,
      toolId: "codex-desktop",
      prompt: "Review desktop bridge markdown.",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    expect(result.status).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const artifact = await readRunArtifact(projectPath, result.id);
    expect(artifact.summary.status).toBe("completed");
    expect(artifact.plan).toContain("Desktop Markdown Plan");
  });
});

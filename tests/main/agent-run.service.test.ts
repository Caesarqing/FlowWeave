import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import { startToolPlan } from "../../src/main/services/agent-run.service";

describe("agent-run.service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates prompt, plan, log, and result files with the mock tool", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-run-"));
    await mkdir(join(projectPath, FLOWWEAVE_DIR), { recursive: true });

    const result = await startToolPlan({
      projectPath,
      toolId: "mock",
      prompt: "Review auth module.",
      executionMode: "plan"
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
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);

    setTimeout(() => {
      const bridgeDir = join(projectPath, FLOWWEAVE_DIR, "agent-bridge", runId);
      void mkdir(bridgeDir, { recursive: true }).then(() =>
        writeFile(
          join(bridgeDir, "response.json"),
          JSON.stringify({ status: "completed", summary: "desktop response", plan: "# Desktop Run Plan" }),
          "utf8"
        )
      );
    }, 20);

    const result = await startToolPlan({
      projectPath,
      toolId: "codex-desktop",
      prompt: "Review desktop bridge.",
      executionMode: "plan"
    });

    expect(result.status).toBe("completed");
    await expect(readFile(result.planPath ?? "", "utf8")).resolves.toContain("Desktop Run Plan");
    await expect(readFile(result.resultPath ?? "", "utf8")).resolves.toContain('"toolId": "codex-desktop"');
  });
});

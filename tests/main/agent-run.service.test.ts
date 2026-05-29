import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import { startToolPlan } from "../../src/main/services/agent-run.service";

describe("agent-run.service", () => {
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
});

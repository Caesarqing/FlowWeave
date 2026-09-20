import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportDiagnostics,
  readDiagnostics,
  recordDiagnostic
} from "../../src/main/services/diagnostic.service";
import { recordAgentRunFailure } from "../../src/main/services/agent-run.service";

describe("diagnostic.service", () => {
  it("keeps a bounded raw diagnostic history and exports it", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-diagnostics-"));
    for (let index = 0; index < 105; index += 1) {
      await recordDiagnostic(root, {
        category: "analysis",
        code: `failure-${index}`,
        message: `OPENAI_API_KEY=not-a-real-openai-key failure ${index}`,
        context: { index }
      });
    }

    const history = await readDiagnostics(root);
    const exportPath = await exportDiagnostics(root);
    const exported = await readFile(exportPath, "utf8");

    expect(history).toHaveLength(100);
    expect(history[0].code).toBe("failure-5");
    expect(exported).toContain("not-a-real-openai-key");
  });

  it("records failed Agent runs without persisting prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-agent-diagnostics-"));

    await recordAgentRunFailure(root, {
      id: "run-1",
      toolId: "mock",
      status: "failed",
      projectPath: root,
      startedAt: "2026-06-12T00:00:00.000Z",
      completedAt: "2026-06-12T00:00:01.000Z",
      executionMode: "plan",
      purpose: "implementation-plan",
      attempts: 2,
      terminationReason: "failed",
      events: [{
        type: "stderr",
        content: "OPENAI_API_KEY=not-a-real-openai-key unavailable",
        timestamp: "2026-06-12T00:00:01.000Z"
      }]
    });

    const [record] = await readDiagnostics(root);
    expect(record.category).toBe("agent");
    expect(record.context).toMatchObject({ runId: "run-1", attempts: 2 });
    expect(record.message).toContain("not-a-real-openai-key");
    expect(JSON.stringify(record)).not.toContain("prompt");
  });
});

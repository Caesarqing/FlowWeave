import { describe, expect, it } from "vitest";
import { MockAgentAdapter } from "../../src/main/agents/mock.adapter";

describe("mock.adapter", () => {
  it("detects the built-in mock adapter", async () => {
    const adapter = new MockAgentAdapter();

    await expect(adapter.detect()).resolves.toMatchObject({
      toolId: "mock",
      available: true,
      method: "mock"
    });
  });

  it("runs a mock plan with execution mode metadata", async () => {
    const adapter = new MockAgentAdapter();
    const result = await adapter.runPlan({
      id: "run-1",
      projectPath: "/tmp/project",
      prompt: "Plan only.",
      executionMode: "plan"
    });

    expect(result.status).toBe("completed");
    expect(result.executionMode).toBe("plan");
    expect(result.events.some((event) => event.type === "stdout")).toBe(true);
  });
});

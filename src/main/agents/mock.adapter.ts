import type { ToolAdapter, ToolRunEvent, ToolRunRequest, ToolRunResult } from "./agent-adapter";
import { nowIso } from "./time";

export class MockAgentAdapter implements ToolAdapter {
  id = "mock" as const;
  name = "Mock Tool";
  kind = "mock" as const;

  async detect() {
    return {
      toolId: this.id,
      available: true,
      method: "mock" as const,
      commandPath: "built-in",
      version: "mock",
      message: "Built-in mock tool is available."
    };
  }

  async runPlan(request: ToolRunRequest, onEvent?: (event: ToolRunEvent) => void): Promise<ToolRunResult> {
    const startedAt = nowIso();
    const events: ToolRunEvent[] = [
      { type: "status", status: "running", timestamp: startedAt },
      { type: "stdout", content: `Mock plan for ${request.projectPath}`, timestamp: nowIso() },
      { type: "stdout", content: "Plan generated without file changes.", timestamp: nowIso() },
      { type: "status", status: "completed", timestamp: nowIso() }
    ];

    events.forEach((event) => onEvent?.(event));

    return {
      id: request.id,
      toolId: this.id,
      status: "completed",
      projectPath: request.projectPath,
      startedAt,
      completedAt: nowIso(),
      exitCode: 0,
      executionMode: request.executionMode,
      summary: "Mock plan generated.",
      events
    };
  }
}

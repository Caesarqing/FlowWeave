import { describe, expect, it } from "vitest";
import type { ToolAdapter, ToolRunRequest, ToolRunResult } from "../../src/types";
import { executeAgentWithPolicy, resetAgentExecutionStateForTests } from "../../src/main/services/agent-execution.service";

describe("agent-execution.service", () => {
  it("times out an Agent that honors the abort signal", async () => {
    const result = await executeAgentWithPolicy(abortAwareAdapter(), request("plan"), {
      timeoutMs: 120,
      maxOutputBytes: 1024,
      retryCount: 0,
      retryDelayMs: 0
    });

    expect(result.status).toBe("failed");
    expect(result.terminationReason).toBe("timeout");
    expect(result.attempts).toBe(1);
  });

  it("retries only transient failures", async () => {
    let calls = 0;
    const adapter: ToolAdapter = {
      id: "mock",
      name: "Transient",
      kind: "mock",
      detect: async () => ({ toolId: "mock", available: true, method: "mock" }),
      runPlan: async (runRequest) => {
        calls += 1;
        return result(runRequest, calls === 1 ? "failed" : "completed", calls === 1 ? "HTTP 429 rate limit" : "ok");
      }
    };

    const execution = await executeAgentWithPolicy(adapter, request("plan"), {
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      retryCount: 1,
      retryDelayMs: 0
    });

    expect(calls).toBe(2);
    expect(execution.status).toBe("completed");
    expect(execution.attempts).toBe(2);
    expect(execution.events).toContainEqual(expect.objectContaining({
      type: "status",
      message: expect.stringContaining("Retrying transient Agent failure")
    }));
  });

  it("classifies provider failures written to stdout and does not retry authentication errors", async () => {
    let calls = 0;
    const adapter: ToolAdapter = {
      id: "mock",
      name: "Provider failure",
      kind: "mock",
      detect: async () => ({ toolId: "mock", available: true, method: "mock" }),
      runPlan: async (runRequest) => {
        calls += 1;
        return {
          ...result(runRequest, "failed", "API Error: AppIdNoAuthError"),
          events: [{
            type: "stdout",
            content: "API Error: AppIdNoAuthError",
            timestamp: "2026-06-10T00:00:01.000Z"
          }]
        };
      }
    };

    const execution = await executeAgentWithPolicy(adapter, request("plan"), {
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      retryCount: 1,
      retryDelayMs: 0
    });

    expect(calls).toBe(1);
    expect(execution.outputText).toContain("AppIdNoAuthError");
    expect(execution.failure).toMatchObject({
      code: "authentication",
      transient: false,
      source: "stdout"
    });
  });

  it("retries connection failures written to stdout once", async () => {
    let calls = 0;
    const adapter: ToolAdapter = {
      id: "mock",
      name: "Connection failure",
      kind: "mock",
      detect: async () => ({ toolId: "mock", available: true, method: "mock" }),
      runPlan: async (runRequest) => {
        calls += 1;
        const status = calls === 1 ? "failed" : "completed";
        return {
          ...result(runRequest, status, calls === 1 ? "ConnectionRefused" : "ok"),
          events: [{
            type: "stdout",
            content: calls === 1 ? "ConnectionRefused" : "ok",
            timestamp: "2026-06-10T00:00:01.000Z"
          }]
        };
      }
    };

    const execution = await executeAgentWithPolicy(adapter, request("plan"), {
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      retryCount: 1,
      retryDelayMs: 0
    });

    expect(calls).toBe(2);
    expect(execution.status).toBe("completed");
    expect(execution.outputText).toBe("ok");
  });

  it("rejects concurrent write executions for the same project", async () => {
    resetAgentExecutionStateForTests();
    const adapter = abortAwareAdapter();
    const first = executeAgentWithPolicy(adapter, request("execute"), {
      timeoutMs: 150,
      maxOutputBytes: 1024,
      retryCount: 0,
      retryDelayMs: 0
    });

    await expect(executeAgentWithPolicy(adapter, request("execute"), {
      timeoutMs: 150,
      maxOutputBytes: 1024,
      retryCount: 0,
      retryDelayMs: 0
    })).rejects.toThrow("already running");
    await first;
  });

  it("limits concurrent read executions for the same project", async () => {
    resetAgentExecutionStateForTests();
    const adapter = abortAwareAdapter();
    const first = executeAgentWithPolicy(adapter, request("plan"), policy());
    const second = executeAgentWithPolicy(adapter, request("plan"), policy());

    await expect(executeAgentWithPolicy(adapter, request("plan"), policy()))
      .rejects.toThrow("read execution limit");
    await Promise.all([first, second]);
  });
});

function policy() {
  return {
    timeoutMs: 150,
    maxOutputBytes: 1024,
    retryCount: 0,
    retryDelayMs: 0
  };
}

function request(executionMode: "plan" | "execute"): ToolRunRequest {
  return {
    id: "run-test",
    projectId: "project-test",
    projectPath: "/tmp/flowweave-agent-execution",
    prompt: "test",
    executionMode,
    purpose: "implementation-plan"
  };
}

function abortAwareAdapter(): ToolAdapter {
  return {
    id: "mock",
    name: "Abort aware",
    kind: "mock",
    detect: async () => ({ toolId: "mock", available: true, method: "mock" }),
    runPlan: (runRequest) => new Promise((resolve) => {
      runRequest.signal?.addEventListener("abort", () => {
        resolve({
          ...result(runRequest, "failed", "aborted"),
          terminationReason: runRequest.signal?.reason === "timeout" ? "timeout" : "canceled"
        });
      }, { once: true });
    })
  };
}

function result(
  requestValue: ToolRunRequest,
  status: ToolRunResult["status"],
  content: string
): ToolRunResult {
  return {
    id: requestValue.id,
    toolId: "mock",
    status,
    projectPath: requestValue.projectPath,
    startedAt: "2026-06-10T00:00:00.000Z",
    completedAt: "2026-06-10T00:00:01.000Z",
    executionMode: requestValue.executionMode,
    purpose: requestValue.purpose,
    events: [{ type: status === "failed" ? "stderr" : "stdout", content, timestamp: "2026-06-10T00:00:01.000Z" }]
  };
}

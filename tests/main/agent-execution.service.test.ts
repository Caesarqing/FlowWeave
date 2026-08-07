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
    expect(result.failure?.code).toBe("timeout");
    expect(result.attempts).toBe(1);
  });

  it("classifies silent SIGTERM exit 143 as a timeout-style termination", async () => {
    const adapter: ToolAdapter = {
      id: "mock",
      name: "Silent SIGTERM",
      kind: "mock",
      detect: async () => ({ toolId: "mock", available: true, method: "mock" }),
      runPlan: async (runRequest) => ({
        id: runRequest.id,
        toolId: "mock",
        status: "failed",
        projectPath: runRequest.projectPath,
        startedAt: "2026-06-10T00:00:00.000Z",
        completedAt: "2026-06-10T00:02:00.000Z",
        exitCode: 143,
        executionMode: runRequest.executionMode,
        purpose: runRequest.purpose,
        events: [],
        durationMs: 120_000,
        terminationReason: "failed"
      })
    };

    const execution = await executeAgentWithPolicy(adapter, request("plan"), {
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      retryCount: 0,
      retryDelayMs: 0
    });

    expect(execution.failure).toMatchObject({
      code: "timeout",
      transient: false,
      message: expect.stringContaining("SIGTERM")
    });
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
      source: "stdout",
      suggestedActions: expect.arrayContaining([
        expect.stringContaining("provider gateway credentials")
      ])
    });
  });

  it("classifies HTTP 500 provider failures as transient provider errors", async () => {
    const adapter: ToolAdapter = {
      id: "mock",
      name: "Provider 500",
      kind: "mock",
      detect: async () => ({ toolId: "mock", available: true, method: "mock" }),
      runPlan: async (runRequest) => result(runRequest, "failed", "API Error: HTTP 500 service unavailable")
    };

    const execution = await executeAgentWithPolicy(adapter, request("plan"), {
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      retryCount: 0,
      retryDelayMs: 0
    });

    expect(execution.failure).toMatchObject({
      code: "provider",
      transient: true
    });
  });

  it("classifies model_not_found gateway failures as model availability errors", async () => {
    const adapter: ToolAdapter = {
      id: "mock",
      name: "Gateway model failure",
      kind: "mock",
      detect: async () => ({ toolId: "mock", available: true, method: "mock" }),
      runPlan: async (runRequest) => result(runRequest, "failed", "503 model_not_found: No available channel for model deepseek-v4-pro")
    };

    const execution = await executeAgentWithPolicy(adapter, request("plan"), {
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      retryCount: 0,
      retryDelayMs: 0
    });

    expect(execution.failure).toMatchObject({
      code: "model-not-found",
      message: expect.stringContaining("model_not_found")
    });
  });

  it("classifies repeated reconnect output as a connection failure", async () => {
    const adapter: ToolAdapter = {
      id: "mock",
      name: "Reconnect failure",
      kind: "mock",
      detect: async () => ({ toolId: "mock", available: true, method: "mock" }),
      runPlan: async (runRequest) => result(runRequest, "failed", "ERROR: Reconnecting... 5/5")
    };

    const execution = await executeAgentWithPolicy(adapter, request("plan"), {
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      retryCount: 0,
      retryDelayMs: 0
    });

    expect(execution.failure).toMatchObject({
      code: "connection",
      message: expect.stringContaining("Reconnecting")
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

  it("uses the default plan retry count for transient failures", async () => {
    let calls = 0;
    const adapter: ToolAdapter = {
      id: "mock",
      name: "Default retry",
      kind: "mock",
      detect: async () => ({ toolId: "mock", available: true, method: "mock" }),
      runPlan: async (runRequest) => {
        calls += 1;
        return result(runRequest, calls === 3 ? "completed" : "failed", calls === 3 ? "ok" : "ConnectionRefused");
      }
    };

    const execution = await executeAgentWithPolicy(adapter, request("plan"), {
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      retryDelayMs: 0
    });

    expect(calls).toBe(3);
    expect(execution.status).toBe("completed");
    expect(execution.attempts).toBe(3);
    expect(execution.events.filter((event) => event.type === "status" && event.message?.includes("Retrying transient Agent failure"))).toHaveLength(2);
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

  it("queues concurrent read executions for the same project", async () => {
    resetAgentExecutionStateForTests();
    let active = 0;
    let maxActive = 0;
    const adapter = delayedAdapter(() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return () => {
        active -= 1;
      };
    });
    const first = executeAgentWithPolicy(adapter, request("plan", "run-1"), policy(1000));
    const second = executeAgentWithPolicy(adapter, request("plan", "run-2"), policy(1000));
    const third = executeAgentWithPolicy(adapter, request("plan", "run-3"), policy(1000));

    const results = await Promise.all([first, second, third]);

    expect(results).toHaveLength(3);
    expect(maxActive).toBe(1);
    expect(results.every((result) => result.status === "completed")).toBe(true);
  });

  it("allows concurrent read executions for different projects", async () => {
    resetAgentExecutionStateForTests();
    let active = 0;
    let maxActive = 0;
    const adapter = delayedAdapter(() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return () => {
        active -= 1;
      };
    });
    const first = executeAgentWithPolicy(adapter, request("plan", "run-1", "/tmp/flowweave-agent-execution-a"), policy(1000));
    const second = executeAgentWithPolicy(adapter, request("plan", "run-2", "/tmp/flowweave-agent-execution-b"), policy(1000));

    const results = await Promise.all([first, second]);

    expect(results).toHaveLength(2);
    expect(maxActive).toBe(2);
    expect(results.every((result) => result.status === "completed")).toBe(true);
  });
});

function policy(timeoutMs = 150) {
  return {
    timeoutMs,
    maxOutputBytes: 1024,
    retryCount: 0,
    retryDelayMs: 0
  };
}

function request(
  executionMode: "plan" | "execute",
  id = "run-test",
  projectPath = "/tmp/flowweave-agent-execution"
): ToolRunRequest {
  return {
    id,
    projectId: "project-test",
    projectPath,
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

function delayedAdapter(onStart: () => () => void): ToolAdapter {
  return {
    id: "mock",
    name: "Delayed",
    kind: "mock",
    detect: async () => ({ toolId: "mock", available: true, method: "mock" }),
    runPlan: async (runRequest) => {
      const release = onStart();
      await new Promise((resolve) => setTimeout(resolve, 30));
      release();
      return result(runRequest, "completed", "ok");
    }
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

import { describe, expect, it } from "vitest";
import { shouldBroadcastFlowWeaveError, throwIfRunCanceled } from "../../src/main/services/flowweave-error.service";

describe("flowweave-error.service", () => {
  it("converts canceled Agent results into a structured cancellation error", () => {
    const controller = new AbortController();
    controller.abort("user-canceled");

    expect(() => throwIfRunCanceled({ terminationReason: "canceled" }, "Architecture analysis", controller.signal)).toThrow(
      expect.objectContaining({
        code: "operation-canceled",
        category: "canceled"
      })
    );
  });

  it("does not reject non-canceled Agent results", () => {
    expect(() => throwIfRunCanceled({ terminationReason: "failed" }, "Architecture analysis", undefined)).not.toThrow();
  });

  it("treats an Agent-side canceled result as a normal failure unless the user canceled the operation", () => {
    expect(() => throwIfRunCanceled({ terminationReason: "canceled" }, "Sequence analysis", undefined)).not.toThrow();
  });

  it("does not broadcast expected cancellation errors to the global error center", () => {
    expect(shouldBroadcastFlowWeaveError({
      code: "operation-canceled",
      category: "canceled",
      message: "Sequence analysis was canceled.",
      context: {},
      suggestedActions: []
    })).toBe(false);
    expect(shouldBroadcastFlowWeaveError({
      code: "agent-operation-failed",
      category: "agent",
      message: "Connection refused.",
      context: {},
      suggestedActions: []
    })).toBe(true);
  });
});

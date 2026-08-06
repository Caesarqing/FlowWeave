import { afterEach, describe, expect, it } from "vitest";
import {
  cancelOperation,
  finishOperation,
  resetOperationsForTests,
  startOperation,
  updateOperation
} from "../../src/main/services/operation.service";

describe("operation.service", () => {
  afterEach(() => {
    resetOperationsForTests();
  });

  it("tracks progress and aborts the active operation on cancellation", () => {
    const started = startOperation("project-scan", "Discovering files.", "project-a");
    const progress = updateOperation(started.operation.operationId, {
      stage: "parsing",
      completed: 4,
      total: 10,
      failed: 1,
      message: "Parsing project files."
    });

    expect(progress).toMatchObject({
      projectId: "project-a",
      stage: "parsing",
      completed: 4,
      total: 10,
      failed: 1
    });

    const canceled = cancelOperation(started.operation.operationId);

    expect(started.signal.aborted).toBe(true);
    expect(started.signal.reason).toBe("user-canceled");
    expect(canceled).toMatchObject({
      stage: "canceled",
      completed: 4,
      total: 10,
      failed: 1
    });
  });

  it("rejects malformed and completed operation identifiers", () => {
    expect(() => cancelOperation("invalid")).toThrow("Invalid FlowWeave operation id");

    const started = startOperation("sequence-analysis", "Analyzing sequences.", "project-a");
    finishOperation(started.operation.operationId);

    expect(() => cancelOperation(started.operation.operationId)).toThrow("FlowWeave operation not found");
  });
});

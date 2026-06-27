import { describe, expect, it } from "vitest";
import { shouldApplySequenceReviewEvent } from "../../src/hooks/useSequenceDiagramState";
import type { SequenceReviewEvent, SequenceReviewStatus } from "../../src/types";

describe("sequence review event filtering", () => {
  it("accepts the active review and rejects stale project, scan, and review events", () => {
    const current: SequenceReviewStatus = {
      state: "reviewing",
      reviewId: "review-new",
      scanFingerprint: "scan-1"
    };

    expect(shouldApplySequenceReviewEvent(event("project-1", "review-new", "scan-1"), "project-1", "scan-1", current)).toBe(true);
    expect(shouldApplySequenceReviewEvent(event("project-2", "review-new", "scan-1"), "project-1", "scan-1", current)).toBe(false);
    expect(shouldApplySequenceReviewEvent(event("project-1", "review-new", "scan-old"), "project-1", "scan-1", current)).toBe(false);
    expect(shouldApplySequenceReviewEvent(event("project-1", "review-old", "scan-1"), "project-1", "scan-1", current)).toBe(false);
    expect(shouldApplySequenceReviewEvent(event("project-1", "review-next", "scan-1", "reviewing"), "project-1", "scan-1", current)).toBe(true);
  });
});

function event(
  projectId: string,
  reviewId: string,
  scanFingerprint: string,
  state: SequenceReviewStatus["state"] = "reviewed"
): SequenceReviewEvent {
  return {
    projectId,
    reviewId,
    scanFingerprint,
    status: { state, reviewId, scanFingerprint }
  };
}

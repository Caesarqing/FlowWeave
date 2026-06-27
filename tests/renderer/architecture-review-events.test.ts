import { describe, expect, it } from "vitest";
import { shouldApplyArchitectureReviewEvent } from "../../src/hooks/useProjectActions";
import type { ArchitectureReviewEvent, ArchitectureReviewStatus } from "../../src/types";

describe("architecture review event filtering", () => {
  it("accepts a new reviewing event and rejects stale completion events", () => {
    const current: ArchitectureReviewStatus = {
      state: "reviewing",
      reviewId: "review-new",
      scanFingerprint: "scan-1"
    };

    expect(shouldApplyArchitectureReviewEvent(
      reviewEvent("review-new", "scan-1", "reviewed"),
      "project-1",
      "scan-1",
      current
    )).toBe(true);
    expect(shouldApplyArchitectureReviewEvent(
      reviewEvent("review-old", "scan-1", "reviewed"),
      "project-1",
      "scan-1",
      current
    )).toBe(false);
    expect(shouldApplyArchitectureReviewEvent(
      reviewEvent("review-next", "scan-1", "reviewing"),
      "project-1",
      "scan-1",
      current
    )).toBe(true);
    expect(shouldApplyArchitectureReviewEvent(
      reviewEvent("review-new", "scan-old", "reviewed"),
      "project-1",
      "scan-1",
      current
    )).toBe(false);
  });
});

function reviewEvent(
  reviewId: string,
  scanFingerprint: string,
  state: ArchitectureReviewStatus["state"]
): ArchitectureReviewEvent {
  return {
    projectId: "project-1",
    reviewId,
    scanFingerprint,
    status: { state, reviewId, scanFingerprint }
  };
}

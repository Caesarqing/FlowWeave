import { describe, expect, it } from "vitest";
import {
  isArchitectureUpdateDisabled,
  mergeArchitectureReviewResult,
  isReviewedGraphAdoptionEvent,
  shouldApplyLocalArchitectureResult,
  shouldApplyArchitectureReviewEvent
} from "../../src/hooks/useProjectActions";
import type { ArchitectureReviewEvent, ArchitectureReviewStatus } from "../../src/types";

describe("architecture review event filtering", () => {
  it("accepts a new reviewing event and rejects stale completion events", () => {
    const current: ArchitectureReviewStatus = {
      state: "reviewing",
      reviewId: "review-new",
      scanFingerprint: "scan-1",
      startedAt: "2026-09-20T00:00:02.000Z"
    };

    expect(shouldApplyArchitectureReviewEvent(
      reviewEvent("review-new", "scan-1", "reviewed"),
      "project-1",
      "scan-1",
      current
    )).toBe(true);
    expect(shouldApplyArchitectureReviewEvent(
      reviewEvent("review-old", "scan-1", "reviewed", "2026-09-20T00:00:00.000Z"),
      "project-1",
      "scan-1",
      current
    )).toBe(false);
    expect(shouldApplyArchitectureReviewEvent(
      reviewEvent("review-next", "scan-1", "reviewing", "2026-09-20T00:00:03.000Z"),
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

  it("accepts a fast subsequent review after the previous review is reconciled", () => {
    const previousReview: ArchitectureReviewStatus = {
      state: "reviewed",
      reviewId: "review-old",
      startedAt: "2026-09-20T00:00:02.000Z"
    };
    const nextReview = reviewEvent("review-new", "scan-1", "reviewing", "2026-09-20T00:00:03.000Z");

    expect(shouldApplyArchitectureReviewEvent(
      nextReview,
      "project-1",
      "scan-1",
      previousReview
    )).toBe(true);

    const completion = reviewEvent("review-new", "scan-1", "reviewed", "2026-09-20T00:00:03.000Z");
    expect(shouldApplyArchitectureReviewEvent(
      completion,
      "project-1",
      "scan-1",
      nextReview.status
    )).toBe(true);
    expect(mergeArchitectureReviewResult(completion.status, nextReview.status)).toBe(completion.status);
  });

  it("blocks only the same active review and local graph generation", () => {
    const reviewing: ArchitectureReviewStatus = {
      state: "reviewing",
      reviewId: "review-1",
      agentId: "mock"
    };

    expect(isArchitectureUpdateDisabled("generating", reviewing, "mock")).toBe(true);
    expect(isArchitectureUpdateDisabled("local-ready", reviewing, "mock")).toBe(true);
    expect(isArchitectureUpdateDisabled("local-ready", reviewing, "codex-local")).toBe(false);
  });

  it("keeps a terminal review event received before the local result response", () => {
    const failed: ArchitectureReviewStatus = {
      state: "review-failed",
      reviewId: "review-1",
      runId: "run-1"
    };
    const initial: ArchitectureReviewStatus = {
      state: "reviewing",
      reviewId: "review-1"
    };

    expect(mergeArchitectureReviewResult(failed, initial)).toBe(failed);
  });

  it("does not replace a reviewed graph with the older local IPC snapshot", () => {
    const result: ArchitectureReviewStatus = { state: "reviewing", reviewId: "review-1" };
    const reviewed: ArchitectureReviewStatus = { state: "reviewed", reviewId: "review-1" };
    const failed: ArchitectureReviewStatus = { state: "review-failed", reviewId: "review-1" };

    expect(shouldApplyLocalArchitectureResult(result, reviewed)).toBe(false);
    expect(shouldApplyLocalArchitectureResult(result, failed)).toBe(true);
  });

  it("adopts only a mechanically reviewed graph in the reviewed presentation phase", () => {
    const localEvent = { ...reviewEvent("review-1", "scan-1", "reviewed"), presentationPhase: "local-static" as const };
    const reviewedEvent = { ...reviewEvent("review-1", "scan-1", "reviewed"), presentationPhase: "reviewed" as const, graph: { nodes: [], edges: [] } };

    expect(isReviewedGraphAdoptionEvent(localEvent)).toBe(false);
    expect(isReviewedGraphAdoptionEvent(reviewedEvent)).toBe(true);
  });
});

function reviewEvent(
  reviewId: string,
  scanFingerprint: string,
  state: ArchitectureReviewStatus["state"],
  startedAt?: string
): ArchitectureReviewEvent {
  return {
    projectId: "project-1",
    reviewId,
    scanFingerprint,
    status: { state, reviewId, scanFingerprint, startedAt }
  };
}

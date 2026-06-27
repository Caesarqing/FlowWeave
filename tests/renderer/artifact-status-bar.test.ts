import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtifactStatusBar } from "../../src/components/ArtifactStatusBar";
import type { ArchitectureReviewStatus, ProjectArtifactStatuses, SequenceReviewStatus } from "../../src/types";

describe("ArtifactStatusBar", () => {
  it("keeps the Agent-reviewed module graph status visible when every artifact is current", () => {
    const statuses: ProjectArtifactStatuses = {
      project: "current",
      canvas: "current",
      task: "current",
      context: "current",
      architecture: "current",
      sequences: "current"
    };
    const architectureReview: ArchitectureReviewStatus = {
      state: "reviewed",
      reviewId: "review-1",
      scanFingerprint: "scan-1",
      agentId: "codex-local",
      runId: "run-1",
      completedAt: "2026-06-25T00:00:00.000Z",
      diff: {
        modules: { added: 1, removed: 0, modified: 2 },
        relationships: { added: 0, removed: 1, modified: 0 }
      }
    };

    const html = renderToStaticMarkup(createElement(ArtifactStatusBar, {
      architectureReview,
      scanFingerprint: "scan-1",
      statuses
    }));

    expect(html).toContain("Agent reviewed");
    expect(html).toContain("codex-local");
    expect(html).toContain("run-1");
    expect(html).toContain("1 added");
    expect(html).toContain("2 modified");
  });

  it("shows only abnormal artifacts in the compact summary and all states in details", () => {
    const statuses: ProjectArtifactStatuses = {
      project: "current",
      canvas: "stale",
      task: "current",
      context: "current",
      architecture: "missing",
      sequences: "failed"
    };
    const architectureReview: ArchitectureReviewStatus = {
      state: "review-failed",
      reviewId: "review-2",
      scanFingerprint: "scan-2",
      agentId: "codex-local",
      error: {
        code: "quality-rejected",
        message: "Evidence coverage is too low."
      }
    };

    const html = renderToStaticMarkup(createElement(ArtifactStatusBar, {
      architectureReview,
      onRetryArchitectureReview: () => undefined,
      scanFingerprint: "scan-2",
      statuses
    }));
    const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));

    expect(summary.match(/artifact-status-/g)).toHaveLength(3);
    expect(summary).toContain("artifact-status-stale");
    expect(summary).toContain("artifact-status-failed");
    expect(summary).toContain("artifact-status-review-failed");
    expect(summary).not.toContain("artifact-status-current");
    expect(html).toContain("Review failed");
    expect(html).toContain("Evidence coverage is too low.");
    expect(html).toContain("Retry review");
    expect(html).toContain("scan-2");
  });

  it("keeps the Agent-reviewed sequence diagram status visible when every artifact is current", () => {
    const statuses: ProjectArtifactStatuses = {
      project: "current",
      canvas: "current",
      task: "current",
      context: "current",
      architecture: "current",
      sequences: "current"
    };
    const sequenceReview: SequenceReviewStatus = {
      state: "reviewing",
      reviewId: "sequence-review-1",
      scanFingerprint: "scan-1",
      agentId: "claude-code",
      runId: "run-sequence-1",
      startedAt: "2026-06-26T02:42:27.000Z"
    };

    const html = renderToStaticMarkup(createElement(ArtifactStatusBar, {
      scanFingerprint: "scan-1",
      sequenceReview,
      statuses
    }));
    const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));

    expect(summary).toContain("Architectural sequence diagram");
    expect(summary).toContain("Agent reviewing");
    expect(html).toContain("claude-code");
    expect(html).toContain("run-sequence-1");
  });
});

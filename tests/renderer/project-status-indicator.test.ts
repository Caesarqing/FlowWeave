import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildProjectStatusViewModel,
  ProjectStatusIndicator,
  type ProjectStatusInput
} from "../../src/components/ProjectStatusIndicator";
import type { ProjectArtifactStatuses } from "../../src/types";

describe("ProjectStatusIndicator", () => {
  it("keeps usable static artifacts available when sequence AI review fails", () => {
    const model = buildProjectStatusViewModel(statusInput({
      sequenceReview: { state: "review-failed", scanFingerprint: "scan-1", error: { code: "agent-failed", message: "Sequence review could not write its response." } }
    }));
    expect(model.kind).toBe("review-warning");
    expect(model.items).toContainEqual(expect.objectContaining({
      key: "sequences", kind: "review-warning", action: "update-sequences", error: "Sequence review could not write its response."
    }));
  });
  it("keeps the static architecture ready when a sequence artifact is stale", () => {
    const model = buildProjectStatusViewModel(statusInput({
      statuses: artifactStatuses({ sequences: "stale" }),
      sequenceReview: { state: "local", scanFingerprint: "scan-1" }
    }));

    expect(model).toEqual({
      kind: "stale",
      items: [
        { key: "architecture", kind: "ready" },
        { key: "sequences", kind: "stale", source: "local", action: "update-sequences" }
      ]
    });
  });

  it("shows the local graph as usable while Agent review runs in the background", () => {
    const model = buildProjectStatusViewModel(statusInput({
      architectureReview: {
        state: "reviewing",
        reviewId: "review-1",
        scanFingerprint: "scan-1",
        inputFingerprint: "input-1",
        agentId: "mock"
      }
    }));

    expect(model).toEqual({
      kind: "reviewing",
      items: [{
        key: "architecture",
        kind: "reviewing",
        source: "local",
        activity: "agent-enhancing"
      }]
    });
  });

  it("treats missing optional diagrams as neutral pending work", () => {
    const model = buildProjectStatusViewModel(statusInput({
      statuses: artifactStatuses({ architecture: "missing", sequences: "missing" }),
      architectureReview: { state: "missing", scanFingerprint: "scan-1" },
      sequenceReview: { state: "missing", scanFingerprint: "scan-1" }
    }));

    expect(model.kind).toBe("pending");
    expect(model.items).toEqual([
      { key: "architecture", kind: "pending", action: "update-architecture" },
      { key: "sequences", kind: "pending", action: "update-sequences" }
    ]);
  });

  it("prioritizes failures over checking and checking over stale artifacts", () => {
    const failed = buildProjectStatusViewModel(statusInput({
      isProjectLoading: true,
      statuses: artifactStatuses({ canvas: "failed", sequences: "stale" })
    }));
    const checking = buildProjectStatusViewModel(statusInput({
      isProjectLoading: true,
      statuses: artifactStatuses({ sequences: "stale" })
    }));

    expect(failed.kind).toBe("failed");
    expect(checking.kind).toBe("checking");
  });

  it("shows a ready summary without detailed items when every artifact is current", () => {
    expect(buildProjectStatusViewModel(statusInput({}))).toEqual({
      kind: "ready",
      items: []
    });
  });

  it("shows AI Reviewed only when the current architecture was reviewed", () => {
    expect(buildProjectStatusViewModel(statusInput({
      architectureReview: { state: "reviewed", scanFingerprint: "scan-1", inputFingerprint: "input-1" }
    })).kind).toBe("reviewed");
  });

  it("renders a native compact popover without diagnostic identifiers", () => {
    const markup = renderToStaticMarkup(createElement(ProjectStatusIndicator, {
      ...statusInput({
        statuses: artifactStatuses({ sequences: "stale" }),
        sequenceReview: { state: "local", scanFingerprint: "scan-1" }
      }),
      onRefreshProject: () => undefined,
      onUpdateArchitecture: () => undefined,
      onUpdateSequences: () => undefined
    }));

    expect(markup).toContain("project-status-trigger");
    expect(markup).toContain('popover="auto"');
    expect(markup).toContain("Architectural sequence diagram");
    expect(markup).toContain("Update");
    expect(markup).not.toContain("Module graph");
    expect(markup).not.toContain("scan-1");
  });

  it("labels reviewing as Agent enhancement rather than generic checking", () => {
    const markup = renderToStaticMarkup(createElement(ProjectStatusIndicator, {
      ...statusInput({
        architectureReview: {
          state: "reviewing",
          reviewId: "review-1",
          scanFingerprint: "scan-1",
          inputFingerprint: "input-1",
          agentId: "mock"
        }
      }),
      onRefreshProject: () => undefined,
      onUpdateArchitecture: () => undefined,
      onUpdateSequences: () => undefined
    }));

    expect(markup).toContain("Agent reviewing");
  });

  it("keeps a current static architecture available after Agent review fails", () => {
    const input = statusInput({
      architectureReview: {
        state: "review-failed",
        scanFingerprint: "scan-1",
        inputFingerprint: "input-1",
        error: { message: "Agent timed out", code: "agent-failed" }
      }
    });
    const model = buildProjectStatusViewModel(input);

    expect(model.kind).toBe("review-warning");
    expect(model.items).toContainEqual(expect.objectContaining({
      key: "architecture",
      kind: "review-warning",
      action: "update-architecture",
      error: "Agent timed out"
    }));
    const markup = renderToStaticMarkup(createElement(ProjectStatusIndicator, {
      ...input,
      onRefreshProject: () => undefined,
      onUpdateArchitecture: () => undefined,
      onUpdateSequences: () => undefined
    }));
    expect(markup).toContain("Static Ready · AI Review Failed");
    expect(markup).toContain("Agent timed out");
    expect(markup).toContain("Retry");
  });

  it("disables architecture and sequence review actions for a legacy read-only canvas", () => {
    const markup = renderToStaticMarkup(createElement(ProjectStatusIndicator, {
      ...statusInput({
        statuses: artifactStatuses({ canvas: "stale", architecture: "stale", sequences: "stale" }),
        architectureReview: { state: "stale", scanFingerprint: "scan-1" },
        sequenceReview: { state: "stale", scanFingerprint: "scan-1" }
      }),
      readOnly: true,
      onRefreshProject: () => undefined,
      onUpdateArchitecture: () => undefined,
      onUpdateSequences: () => undefined
    }));

    expect(markup.match(/<button disabled=""/g)).toHaveLength(2);
    expect(markup).toContain(">Rescan</button>");
  });

  it("shows a genuinely stale architecture as stale even when review failed", () => {
    const model = buildProjectStatusViewModel(statusInput({
      statuses: artifactStatuses({ architecture: "stale" }),
      architectureReview: {
        state: "review-failed",
        error: { code: "agent-failed", message: "Agent timed out" }
      }
    }));

    expect(model.items.find((item) => item.key === "architecture")?.kind).toBe("stale");
  });
});

function artifactStatuses(
  overrides: Partial<ProjectArtifactStatuses>
): ProjectArtifactStatuses {
  return {
    project: "current",
    canvas: "current",
    task: "current",
    context: "current",
    architecture: "current",
    sequences: "current",
    ...overrides
  };
}

function statusInput(overrides: Partial<ProjectStatusInput>): ProjectStatusInput {
  return {
    isProjectLoading: false,
    statuses: artifactStatuses({}),
    architectureReview: { state: "local", scanFingerprint: "scan-1" },
    sequenceReview: { state: "local", scanFingerprint: "scan-1" },
    ...overrides
  };
}

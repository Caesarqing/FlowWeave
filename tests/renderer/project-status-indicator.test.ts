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
  it("shows one stale sequence state when a local review conflicts with a stale artifact", () => {
    const model = buildProjectStatusViewModel(statusInput({
      statuses: artifactStatuses({ sequences: "stale" }),
      sequenceReview: { state: "local", scanFingerprint: "scan-1" }
    }));

    expect(model).toEqual({
      kind: "stale",
      items: [{
        key: "sequences",
        kind: "stale",
        source: "local",
        action: "update-sequences"
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

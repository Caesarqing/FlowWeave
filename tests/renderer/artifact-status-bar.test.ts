import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtifactStatusBar } from "../../src/components/ArtifactStatusBar";
import type { ProjectArtifactStatuses } from "../../src/types";

describe("ArtifactStatusBar", () => {
  it("hides when every artifact is current", () => {
    const statuses: ProjectArtifactStatuses = {
      project: "current",
      canvas: "current",
      task: "current",
      context: "current",
      architecture: "current",
      sequences: "current"
    };

    expect(renderToStaticMarkup(createElement(ArtifactStatusBar, { scanFingerprint: "scan-1", statuses }))).toBe("");
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

    const html = renderToStaticMarkup(createElement(ArtifactStatusBar, { scanFingerprint: "scan-2", statuses }));
    const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));

    expect(summary.match(/artifact-status-/g)).toHaveLength(3);
    expect(summary).toContain("artifact-status-stale");
    expect(summary).toContain("artifact-status-missing");
    expect(summary).toContain("artifact-status-failed");
    expect(summary).not.toContain("artifact-status-current");
    expect(html).toContain("scan-2");
  });
});

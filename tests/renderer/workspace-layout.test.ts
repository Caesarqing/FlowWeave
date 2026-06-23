import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceLayout } from "../../src/components/WorkspaceLayout";
import { parseWorkspacePanels } from "../../src/stores/preferences.store";

const styles = normalizeLineEndings(readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8"));

describe("workspace panel preferences", () => {
  it("keeps collapse state isolated by page and panel side", () => {
    const preferences = parseWorkspacePanels(JSON.stringify({
      canvas: { left: true, right: false },
      structure: { left: false, right: true },
      tools: { left: true, right: true }
    }));

    expect(preferences.canvas).toEqual({ left: true, right: false });
    expect(preferences.structure).toEqual({ left: false, right: true });
    expect(preferences.docs).toEqual({ left: false, right: false });
    expect(preferences.tools).toEqual({ left: true, right: true });
  });

  it("recovers from invalid or partial persisted values", () => {
    expect(parseWorkspacePanels("not-json").canvas).toEqual({ left: false, right: false });
    expect(parseWorkspacePanels(JSON.stringify({
      docs: { left: "yes", right: true }
    })).docs).toEqual({ left: false, right: true });
  });

  it("keeps panel controls in the shared workspace header", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceLayout, {
      left: createElement("aside", null, "left"),
      page: "docs",
      right: createElement("aside", null, "right"),
      title: "Documents",
      children: createElement("section", null, "editor")
    }));

    const header = html.slice(html.indexOf('<header class="workspace-header">'), html.indexOf("</header>"));
    expect(header).toContain("workspace-panel-toggle left");
    expect(header).toContain("workspace-panel-toggle right");
    expect(html).not.toContain("workspace-panel-restore");
  });

  it("keeps workspace pages in normal flex layout", () => {
    expect(styles).toContain(".workspace-host {\n  display: flex;\n  flex: 1 1 0;");
    expect(styles).toContain(".workspace-host > * {\n  position: relative;\n  flex: 1 1 0;");
    expect(styles).not.toContain(".workspace-host > * {\n  position: absolute;");
  });

  it("keeps the application header below the macOS window edge", () => {
    expect(styles).toContain("min-height: 58px;\n  padding: 7px 14px 5px;");
  });

  it("shows full centered canvas tools only when both panels are collapsed", () => {
    expect(styles.match(/^\.canvas-view-tools \{/gm)).toHaveLength(1);
    expect(styles).toContain(".canvas-view-tools {\n  position: relative;");
    expect(styles).toContain(".canvas-view-tools-content {\n  display: flex;");
    expect(styles).toContain("margin-inline: auto;");
    expect(styles).toContain(".workspace-layout:not(.left-panel-collapsed) .canvas-tool-label");
    expect(styles).toContain(".workspace-layout:not(.right-panel-collapsed) .canvas-tool-label");
  });

  it("keeps canvas side panels in the grid on narrow desktop windows", () => {
    expect(styles).toContain(".workspace-layout.has-right-panel:not(.right-panel-collapsed) {\n  grid-template-columns: minmax(0, 1fr) var(--workspace-right-width);");
    expect(styles).toContain(".workspace-layout-panel,\n.workspace-layout-main {\n  container-name: workspace-main;\n  container-type: inline-size;\n  position: relative;");
  });
});

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

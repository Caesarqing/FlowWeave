// @vitest-environment happy-dom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffViewer } from "../../src/components/DiffViewer";

describe("DiffViewer", () => {
  it("shows an accessible empty message without a fake diff line", () => {
    const markup = renderToStaticMarkup(createElement(DiffViewer, {
      emptyMessage: "No changes found.",
      patch: " \n"
    }));

    expect(markup).toBe('<div class="diff-empty-state" role="status">No changes found.</div>');
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CanvasStalePreviewBanner } from "../../src/components/CanvasWorkspace";

describe("CanvasStalePreviewBanner", () => {
  it("labels the cached graph timestamp and its pending verification read-only state", () => {
    const generatedAt = "2026-10-05T02:00:00.000Z";
    const markup = renderToStaticMarkup(createElement(CanvasStalePreviewBanner, { generatedAt }));

    expect(markup).toContain('data-preview-state="pending-verification"');
    expect(markup).toContain('aria-readonly="true"');
    expect(markup).toContain("Read-only preview · pending verification");
    expect(markup).toContain(`dateTime="${generatedAt}"`);
    expect(markup).toContain(new Date(generatedAt).toLocaleString());
  });
});

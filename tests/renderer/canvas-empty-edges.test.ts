import { describe, expect, it } from "vitest";
import { canvasEmptyEdgeReason } from "../../src/components/CanvasWorkspace";

describe("Canvas empty edge explanation", () => {
  it("distinguishes absent evidence, hidden views, and active filters", () => {
    expect(canvasEmptyEdgeReason(0, 0, 0, 0)).toBeUndefined();
    expect(canvasEmptyEdgeReason(2, 0, 0, 0)).toBe("none");
    expect(canvasEmptyEdgeReason(2, 1, 0, 0)).toBe("view");
    expect(canvasEmptyEdgeReason(2, 1, 1, 0)).toBe("filters");
    expect(canvasEmptyEdgeReason(2, 1, 1, 0, 0)).toBe("collapsed");
    expect(canvasEmptyEdgeReason(2, 1, 1, 1)).toBeUndefined();
  });
});

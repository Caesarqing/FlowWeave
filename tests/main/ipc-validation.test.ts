import { describe, expect, it } from "vitest";
import { optionalTrimmedString } from "../../src/main/ipc/ipc-validation";

describe("optionalTrimmedString", () => {
  it("normalizes missing and blank strings to undefined", () => {
    expect(optionalTrimmedString("test", undefined, "instruction")).toBeUndefined();
    expect(optionalTrimmedString("test", "", "instruction")).toBeUndefined();
    expect(optionalTrimmedString("test", "   ", "instruction")).toBeUndefined();
  });

  it("trims non-empty strings and rejects non-string values", () => {
    expect(optionalTrimmedString("test", " revise flow ", "instruction")).toBe("revise flow");
    expect(() => optionalTrimmedString("test", 42, "instruction")).toThrow(
      '[test] Invalid "instruction": expected a string when provided.'
    );
  });
});

import { describe, expect, it } from "vitest";
import { buildCursorAppOpenArgs, buildCursorCliOpenArgs } from "../../src/main/agents/cursor.adapter";

describe("cursor.adapter", () => {
  it("builds Cursor CLI open args", () => {
    expect(buildCursorCliOpenArgs("/tmp/project")).toEqual(["/tmp/project"]);
  });

  it("builds macOS Cursor app open args", () => {
    expect(buildCursorAppOpenArgs("/Applications/Cursor.app", "/tmp/project")).toEqual([
      "-a",
      "/Applications/Cursor.app",
      "/tmp/project"
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildCursorAppOpenArgs,
  buildCursorCliOpenArgs,
  cursorDesktopPlatformSupport
} from "../../src/main/agents/cursor.adapter";

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

  it("uses the Cursor desktop app only on macOS", () => {
    expect(cursorDesktopPlatformSupport("darwin")).toEqual({ supported: true });
    expect(cursorDesktopPlatformSupport("win32")).toEqual({
      supported: false,
      message: "Cursor CLI was not found. Install the Cursor CLI to use Cursor on Windows."
    });
  });
});

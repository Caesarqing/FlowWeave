import { describe, expect, it } from "vitest";
import { buildCodexPlanArgs } from "../../src/main/agents/codex-local.adapter";

describe("codex-local.adapter", () => {
  it("builds read-only Codex plan args", () => {
    expect(
      buildCodexPlanArgs({
        executionMode: "plan",
        lastMessagePath: "/tmp/project/.flowweave/runs/run-1/last-message.md",
        projectPath: "/tmp/project"
      })
    ).toEqual([
      "exec",
      "--cd",
      "/tmp/project",
      "--sandbox",
      "read-only",
      "--output-last-message",
      "/tmp/project/.flowweave/runs/run-1/last-message.md",
      "-"
    ]);
  });

  it("does not include unsupported approval flags", () => {
    expect(
      buildCodexPlanArgs({
        executionMode: "plan",
        lastMessagePath: "/tmp/last.md",
        projectPath: "/tmp/project"
      })
    ).not.toEqual(expect.arrayContaining(["--ask-for-approval", "never"]));
  });

  it("inserts the model before exec options", () => {
    expect(
      buildCodexPlanArgs({
        executionMode: "plan",
        lastMessagePath: "/tmp/last.md",
        model: "gpt-5",
        projectPath: "/tmp/project"
      }).slice(0, 3)
    ).toEqual(["exec", "--model", "gpt-5"]);
  });

  it("builds writable Codex args only for execute mode", () => {
    expect(
      buildCodexPlanArgs({
        executionMode: "execute",
        lastMessagePath: "/tmp/last.md",
        projectPath: "/tmp/project"
      })
    ).toContain("workspace-write");
  });
});

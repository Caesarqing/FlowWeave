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
      "--skip-git-repo-check",
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

  it("isolates non-interactive runs from user MCP and rule configuration", () => {
    const args = buildCodexPlanArgs({
      executionMode: "plan",
      lastMessagePath: "/tmp/last.md",
      projectPath: "/tmp/project",
      isolated: true
    });

    expect(args).toEqual(expect.arrayContaining([
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules"
    ]));
  });

  it("inserts the model before exec options", () => {
    expect(
      buildCodexPlanArgs({
        executionMode: "plan",
        lastMessagePath: "/tmp/last.md",
        model: "gpt-5",
        projectPath: "/tmp/project"
      }).slice(0, 4)
    ).toEqual(["exec", "--model", "gpt-5", "--skip-git-repo-check"]);
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

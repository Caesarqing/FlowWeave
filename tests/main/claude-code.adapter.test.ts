import { describe, expect, it } from "vitest";
import { buildClaudeArgs, buildClaudeDryRunArgs, buildClaudeDryRunPrompt } from "../../src/main/agents/claude-code.adapter";

describe("claude-code.adapter", () => {
  it("builds Claude Code dry-run args in plan mode", () => {
    expect(buildClaudeDryRunArgs("sonnet")).toEqual([
      "--print",
      "--permission-mode",
      "plan",
      "--output-format",
      "text",
      "--no-session-persistence",
      "--model",
      "sonnet"
    ]);
  });

  it("adds a no-edit dry-run instruction to the prompt", () => {
    const prompt = buildClaudeDryRunPrompt("Review the auth module.");

    expect(prompt).toContain("Review the auth module.");
    expect(prompt).toContain("Do not edit files.");
  });

  it("uses acceptEdits only for execute mode", () => {
    expect(buildClaudeArgs("execute")).toContain("acceptEdits");
  });
});

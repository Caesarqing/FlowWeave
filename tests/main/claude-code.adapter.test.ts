import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, buildClaudeArgs, buildClaudeDryRunArgs, buildClaudeDryRunPrompt } from "../../src/main/agents/claude-code.adapter";

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

  it("uses structured JSON output for artifact analysis", () => {
    expect(buildClaudeArgs("plan", undefined, "artifact-analysis")).toEqual(expect.arrayContaining([
      "--output-format",
      "json"
    ]));
  });

  it("sends large prompts through stdin instead of command arguments", async () => {
    const originalPath = process.env.PATH;
    const binRoot = await mkdtemp(join(tmpdir(), "flowweave-claude-stdin-"));
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-claude-project-"));
    const commandPath = join(binRoot, "claude");
    await writeFile(commandPath, [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then echo 'claude-test 1.0'; exit 0; fi",
      "input=$(cat)",
      "printf '%s' \"${#input}\""
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);
    process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
    try {
      const prompt = "x".repeat(220_000);
      const result = await new ClaudeCodeAdapter().runPlan({
        id: "run-large-prompt",
        projectId: "project-large-prompt",
        projectPath,
        prompt,
        executionMode: "plan",
        purpose: "implementation-plan"
      });

      expect(result.status).toBe("completed");
      expect(result.events).toContainEqual(expect.objectContaining({
        type: "stdout",
        content: String(prompt.length)
      }));
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

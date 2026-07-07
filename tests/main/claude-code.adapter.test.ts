import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, buildClaudeArgs, buildClaudeDryRunArgs, buildClaudeDryRunPrompt } from "../../src/main/agents/claude-code.adapter";
import { createNodeCliFixture } from "./test-cli-fixture";

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
    const commandPath = await createNodeCliFixture(binRoot, "claude", [
      "if (process.argv.includes('--version')) { console.log('claude-test 1.0'); process.exit(0); }",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => { process.stdout.write(String(input.length)); });"
    ].join("\n"), process.platform);
    process.env.PATH = `${binRoot}${delimiter}${originalPath ?? ""}`;
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

  it("reports Claude CLI health without exposing credential values", async () => {
    const originalPath = process.env.PATH;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const binRoot = await mkdtemp(join(tmpdir(), "flowweave-claude-health-"));
    await createNodeCliFixture(binRoot, "claude", [
      "if (process.argv.includes('--version')) { console.log('claude-test 2.0'); process.exit(0); }",
      "process.stdout.write('ok');"
    ].join("\n"), process.platform);
    process.env.PATH = `${binRoot}${delimiter}${originalPath ?? ""}`;
    process.env.ANTHROPIC_API_KEY = "sk-ant-flowweave-secret";
    process.env.ANTHROPIC_BASE_URL = "https://provider.example";
    try {
      const health = await new ClaudeCodeAdapter().healthCheck({ runModelProbe: true });
      const serialized = JSON.stringify(health);

      expect(health.agentId).toBe("claude-code");
      expect(health.severity).toBe("warning");
      expect(serialized).toContain("ANTHROPIC_API_KEY");
      expect(serialized).not.toContain("sk-ant-flowweave-secret");
      expect(health.checks).toContainEqual(expect.objectContaining({
        id: "claude-provider",
        status: "warning"
      }));
      expect(health.checks).toContainEqual(expect.objectContaining({
        id: "claude-model-probe",
        status: "passed"
      }));
    } finally {
      process.env.PATH = originalPath;
      restoreEnv("ANTHROPIC_API_KEY", originalApiKey);
      restoreEnv("ANTHROPIC_BASE_URL", originalBaseUrl);
    }
  });

  it("does not run Claude model probe unless explicitly requested", async () => {
    const originalPath = process.env.PATH;
    const binRoot = await mkdtemp(join(tmpdir(), "flowweave-claude-no-probe-"));
    await createNodeCliFixture(binRoot, "claude", [
      "if (process.argv.includes('--version')) { console.log('claude-test 2.0'); process.exit(0); }",
      "process.stderr.write('unexpected probe');",
      "process.exit(7);"
    ].join("\n"), process.platform);
    process.env.PATH = `${binRoot}${delimiter}${originalPath ?? ""}`;
    try {
      const health = await new ClaudeCodeAdapter().healthCheck();

      expect(health.checks.some((check) => check.id === "claude-model-probe")).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

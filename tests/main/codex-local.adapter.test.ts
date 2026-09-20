import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexLocalAdapter, buildCodexPlanArgs } from "../../src/main/agents/codex-local.adapter";
import { createNodeCliFixture } from "./test-cli-fixture";

describe("codex-local.adapter", () => {
  const originalPath = process.env.PATH;

  beforeEach(() => {
    process.env.PATH = originalPath;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

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

  it("reports Codex command and version readiness", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "flowweave-codex-bin-"));
    await createNodeCliFixture(binDir, "codex", [
      "if (process.argv.includes('--version')) { console.error('could not create PATH aliases'); console.log('codex-test 1.0'); process.exit(0); }",
      "if (process.argv[2] === 'exec' && process.argv.includes('--help')) {",
      "  console.log('Usage: codex exec [OPTIONS] [PROMPT]');",
      "  console.log('--cd <DIR> --sandbox <MODE> --output-last-message <FILE> stdin');",
      "  process.exit(0);",
      "}",
      "process.exit(0);"
    ].join("\n"), process.platform);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const health = await new CodexLocalAdapter().healthCheck();

    expect(health.checks).toContainEqual(expect.objectContaining({ id: "codex-command", status: "passed" }));
  });

  it("does not run Codex model probe unless explicitly requested", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "flowweave-codex-bin-"));
    await createNodeCliFixture(binDir, "codex", [
      "if (process.argv.includes('--version')) { console.log('codex-test 1.0'); process.exit(0); }",
      "if (process.argv[2] === 'exec' && process.argv.includes('--help')) {",
      "  console.log('Usage: codex exec [OPTIONS] [PROMPT] stdin --cd --sandbox --output-last-message');",
      "  process.exit(0);",
      "}",
      "process.exit(7);"
    ].join("\n"), process.platform);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const health = await new CodexLocalAdapter().healthCheck();

    expect(health.checks.some((check) => check.id === "codex-model-probe")).toBe(false);
  });

});

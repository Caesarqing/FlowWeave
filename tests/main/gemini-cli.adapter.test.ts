import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeminiCliAdapter, buildGeminiArgs, buildGeminiPrompt } from "../../src/main/agents/gemini-cli.adapter";
import { createNodeCliFixture } from "./test-cli-fixture";

describe("gemini-cli.adapter", () => {
  const originalPath = process.env.PATH;

  beforeEach(() => {
    process.env.PATH = originalPath;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("builds model args when a model is provided", () => {
    expect(buildGeminiArgs("plan", "gemini-2.5-pro")).toEqual([
      "--approval-mode",
      "plan",
      "--model",
      "gemini-2.5-pro"
    ]);
  });

  it("adds dry-run guidance in plan mode", () => {
    expect(buildGeminiPrompt("Inspect auth.", "plan")).toContain("Do not edit files.");
    expect(buildGeminiPrompt("Inspect auth.", "execute")).toBe("Inspect auth.");
  });

  it("runs Gemini CLI through stdin", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "flowweave-gemini-bin-"));
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-gemini-project-"));
    const scriptPath = await createNodeCliFixture(binDir, "gemini", [
      "if (process.argv.includes('--version')) { console.log('gemini-test 1.0'); process.exit(0); }",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  console.log('# Gemini Plan');",
      "  if (input.includes('Analyze billing')) console.log('received prompt');",
      "});"
    ].join("\n"), process.platform);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
    const adapter = new GeminiCliAdapter();

    const detection = await adapter.detect();
    expect(detection).toMatchObject({
      available: true,
      version: "gemini-test 1.0"
    });
    expect(detection.commandPath).toBeDefined();
    await expect(realpath(detection.commandPath ?? "")).resolves.toBe(await realpath(scriptPath));

    const result = await adapter.runPlan({
      id: "run-gemini",
      projectId: "project-00000000-0000-0000-0000-000000000000",
      projectPath,
      prompt: "Analyze billing",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    expect(result.status).toBe("completed");
    expect(result.events.map((event) => ("content" in event ? event.content : "")).join("\n")).toContain("received prompt");
  });
});

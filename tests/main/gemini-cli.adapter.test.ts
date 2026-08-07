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

  it("runs Gemini CLI through the Agent Inbox", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "flowweave-gemini-bin-"));
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-gemini-project-"));
    const scriptPath = await createNodeCliFixture(binDir, "gemini", [
      "if (process.argv.includes('--version')) { console.log('gemini-test 1.0'); process.exit(0); }",
      "const { mkdir, readFile, writeFile } = require('node:fs/promises');",
      "const { dirname } = require('node:path');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', async () => {",
      "  if (input.includes('Agent Inbox')) console.log('received inbox instruction');",
      "  const request = JSON.parse(await readFile('.flowweave/agent-inbox/current/request.json', 'utf8'));",
      "  await mkdir(dirname(request.responsePath), { recursive: true });",
      "  await writeFile(request.responsePath, JSON.stringify({",
      "    protocolVersion: 2,",
      "    runId: request.runId,",
      "    projectId: request.projectId,",
      "    status: 'completed',",
      "    summary: 'Gemini plan complete.',",
      "    content: '# Gemini Plan',",
      "    completedAt: new Date().toISOString()",
      "  }, null, 2), 'utf8');",
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
    expect(result.outputText).toContain("# Gemini Plan");
    expect(result.events.map((event) => ("content" in event ? event.content : "")).join("\n")).toContain("received inbox instruction");
  });

  it("reports Gemini model probe failures without running project writes", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "flowweave-gemini-bin-"));
    await createNodeCliFixture(binDir, "gemini", [
      "if (process.argv.includes('--version')) { console.log('gemini-test 1.0'); process.exit(0); }",
      "console.error('model_not_found: no available channel for model');",
      "process.exit(1);"
    ].join("\n"), process.platform);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const health = await new GeminiCliAdapter().healthCheck({ runModelProbe: true });

    expect(health.severity).toBe("error");
    expect(health.checks).toContainEqual(expect.objectContaining({
      id: "gemini-model-probe",
      status: "failed",
      message: expect.stringContaining("model-not-found")
    }));
  });

  it("does not run Gemini model probe unless explicitly requested", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "flowweave-gemini-bin-"));
    await createNodeCliFixture(binDir, "gemini", [
      "if (process.argv.includes('--version')) { console.log('gemini-test 1.0'); process.exit(0); }",
      "process.exit(7);"
    ].join("\n"), process.platform);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const health = await new GeminiCliAdapter().healthCheck();

    expect(health.checks.some((check) => check.id === "gemini-model-probe")).toBe(false);
  });
});

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeminiCliAdapter, buildGeminiArgs, buildGeminiPrompt } from "../../src/main/agents/gemini-cli.adapter";

describe("gemini-cli.adapter", () => {
  const originalPath = process.env.PATH;

  beforeEach(() => {
    process.env.PATH = originalPath;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("builds model args when a model is provided", () => {
    expect(buildGeminiArgs("gemini-2.5-pro")).toEqual(["--model", "gemini-2.5-pro"]);
  });

  it("adds dry-run guidance in plan mode", () => {
    expect(buildGeminiPrompt("Inspect auth.", "plan")).toContain("Do not edit files.");
    expect(buildGeminiPrompt("Inspect auth.", "execute")).toBe("Inspect auth.");
  });

  it("runs Gemini CLI through stdin", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "flowweave-gemini-bin-"));
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-gemini-project-"));
    const scriptPath = join(binDir, "gemini");
    await writeFile(
      scriptPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then",
        "  echo \"gemini-test 1.0\"",
        "  exit 0",
        "fi",
        "input=$(cat)",
        "echo \"# Gemini Plan\"",
        "echo \"$input\" | grep -q \"Analyze billing\" && echo \"received prompt\""
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 }
    );
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    const adapter = new GeminiCliAdapter();

    await expect(adapter.detect()).resolves.toMatchObject({
      available: true,
      commandPath: scriptPath,
      version: "gemini-test 1.0"
    });

    const result = await adapter.runPlan({
      id: "run-gemini",
      projectPath,
      prompt: "Analyze billing",
      executionMode: "plan"
    });

    expect(result.status).toBe("completed");
    expect(result.events.map((event) => ("content" in event ? event.content : "")).join("\n")).toContain("received prompt");
  });
});

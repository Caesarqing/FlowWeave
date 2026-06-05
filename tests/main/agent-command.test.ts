import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCommandSearchPaths, getCommandCandidates, resolveCandidate, resolveCandidateFromSearchPaths, resolveToolCommand } from "../../src/main/agents/agent-command";

describe("agent-command", () => {
  it("resolves the built-in mock command", async () => {
    await expect(resolveToolCommand("mock")).resolves.toEqual({
      commandPath: "built-in",
      installed: true,
      version: "mock"
    });
  });

  it("returns undefined for missing absolute candidates", async () => {
    await expect(resolveCandidate("/definitely/not/a/flowweave/tool")).resolves.toBeUndefined();
  });

  it("resolves existing absolute candidates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flowweave-command-"));
    const file = join(dir, "tool");
    await writeFile(file, "#!/bin/sh\n", { mode: 0o755 });

    await expect(resolveCandidate(file)).resolves.toBe(file);
  });

  it("includes Cursor code command aliases", () => {
    expect(getCommandCandidates("cursor")).toEqual(expect.arrayContaining([
      "code",
      "/usr/local/bin/code",
      "/opt/homebrew/bin/code",
      "/Applications/Cursor.app/Contents/Resources/app/bin/code"
    ]));
  });

  it("includes Gemini CLI candidates", () => {
    expect(getCommandCandidates("gemini-cli")).toEqual(expect.arrayContaining([
      "gemini",
      "/usr/local/bin/gemini",
      "/opt/homebrew/bin/gemini"
    ]));
  });

  it("keeps desktop agents on app detection instead of CLI candidate lookup", () => {
    expect(getCommandCandidates("claude-desktop")).toEqual([]);
    expect(getCommandCandidates("codex-desktop")).toEqual([]);
  });

  it("searches common GUI app command paths when PATH is sparse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flowweave-common-command-"));
    const file = join(dir, "custom-agent");
    await writeFile(file, "#!/bin/sh\n", { mode: 0o755 });

    await expect(resolveCandidateFromSearchPaths("custom-agent", [dir])).resolves.toBe(file);
  });

  it("includes user local bin in command search paths", () => {
    expect(buildCommandSearchPaths("/Users/dev")).toEqual(expect.arrayContaining([
      "/Users/dev/.local/bin",
      "/Users/dev/bin"
    ]));
  });
});

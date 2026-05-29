import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCandidate, resolveToolCommand } from "../../src/main/agents/agent-command";

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
});

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareCommandInvocation } from "../../src/main/agents/command-invocation";

describe("command-invocation", () => {
  it("keeps native executables unchanged", async () => {
    await expect(prepareCommandInvocation("C:\\tools\\agent.exe", ["--version"], "win32")).resolves.toEqual({
      commandPath: "C:\\tools\\agent.exe",
      args: ["--version"]
    });
  });

  it("resolves an npm Windows command shim without enabling a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-win-shim-"));
    const scriptPath = join(root, "node_modules", "agent", "cli.js");
    const shimPath = join(root, "agent.cmd");
    await writeFile(
      shimPath,
      `@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%" "%dp0%\\node_modules\\agent\\cli.js" %*\r\n`,
      "utf8"
    );

    await expect(prepareCommandInvocation(shimPath, ["--version"], "win32")).resolves.toEqual({
      commandPath: process.execPath,
      args: [scriptPath, "--version"]
    });
  });

  it("rejects an unknown Windows script instead of invoking a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-win-unsafe-shim-"));
    const shimPath = join(root, "agent.bat");
    await writeFile(shimPath, "@echo off\r\necho unsupported\r\n", "utf8");

    await expect(prepareCommandInvocation(shimPath, [], "win32")).rejects.toThrow(
      "cannot be executed without a shell"
    );
  });
});

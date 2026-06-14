import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function createNodeCliFixture(
  binRoot: string,
  commandName: string,
  source: string,
  platform: NodeJS.Platform
): Promise<string> {
  const scriptName = `${commandName}-fixture.cjs`;
  const scriptPath = join(binRoot, scriptName);
  await writeFile(scriptPath, source, "utf8");

  if (platform === "win32") {
    const commandPath = join(binRoot, `${commandName}.cmd`);
    await writeFile(commandPath, `@ECHO off\r\n"%dp0%\\${scriptName}" %*\r\n`, "utf8");
    return commandPath;
  }

  const commandPath = join(binRoot, commandName);
  await writeFile(commandPath, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

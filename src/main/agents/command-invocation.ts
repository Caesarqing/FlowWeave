import { readFile } from "node:fs/promises";
import { dirname, extname, join, win32 } from "node:path";

export type CommandInvocation = {
  commandPath: string;
  args: string[];
};

export async function prepareCommandInvocation(
  commandPath: string,
  args: string[],
  platform: NodeJS.Platform
): Promise<CommandInvocation> {
  const extension = platform === "win32" ? win32.extname(commandPath).toLowerCase() : extname(commandPath).toLowerCase();
  if (platform !== "win32" || (extension !== ".cmd" && extension !== ".bat")) {
    return { commandPath, args };
  }

  const content = await readFile(commandPath, "utf8");
  const scriptMatch = /["']?(?:%~dp0|%dp0%)[\\/]([^"\r\n]+?\.(?:cjs|js|mjs))["']?\s+%\*/i.exec(content);
  if (!scriptMatch) {
    throw new Error(`Windows command script ${commandPath} cannot be executed without a shell.`);
  }

  const scriptPath = join(dirname(commandPath), ...scriptMatch[1].split(/[\\/]/));
  return {
    commandPath: process.execPath,
    args: [scriptPath, ...args]
  };
}

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

const SMOKE_ARGUMENT = "--flowweave-smoke-test";
const SMOKE_TIMEOUT_MS = 30_000;
const root = process.cwd();
const overridePath = process.env.FLOWWEAVE_PACKAGED_EXECUTABLE;
const candidates = overridePath ? [overridePath] : packagedExecutableCandidates(root, process.platform, process.arch);
const executablePath = await firstExistingPath(candidates);

if (!executablePath) {
  throw new Error(`FlowWeave packaged executable was not found. Checked: ${candidates.join(", ")}`);
}

await runSmoke(executablePath);

function packagedExecutableCandidates(rootPath, platform, architecture) {
  if (platform === "win32") {
    const architectureDirectories = architecture === "arm64"
      ? ["win-arm64-unpacked", "win-unpacked"]
      : ["win-unpacked", "win-x64-unpacked"];
    return architectureDirectories.map((directory) => join(rootPath, "release", directory, "FlowWeave.exe"));
  }
  if (platform === "darwin") {
    return [
      join(rootPath, "release", `mac-${architecture}`, "FlowWeave.app", "Contents", "MacOS", "FlowWeave"),
      join(rootPath, "release", "mac-arm64", "FlowWeave.app", "Contents", "MacOS", "FlowWeave"),
      join(rootPath, "release", "mac", "FlowWeave.app", "Contents", "MacOS", "FlowWeave")
    ];
  }
  throw new Error(`Packaged smoke testing is not configured for ${platform}.`);
}

async function firstExistingPath(paths) {
  for (const path of paths) {
    const exists = await access(path).then(() => true).catch(() => false);
    if (exists) return path;
  }
  return undefined;
}

function runSmoke(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [SMOKE_ARGUMENT], {
      stdio: "inherit",
      windowsHide: true
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Packaged smoke test timed out after ${SMOKE_TIMEOUT_MS}ms: ${executable}`));
    }, SMOKE_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Packaged smoke test failed with exit code ${code ?? "none"} and signal ${signal ?? "none"}.`));
    });
  });
}

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ToolRunRequest } from "../../src/types";
import { runSpawnedAgent } from "../../src/main/agents/spawn-agent-process";

describe("spawn-agent-process", () => {
  it("times out and terminates the spawned process tree", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-agent-timeout-"));
    const pidPath = join(projectPath, "child.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[1], String(child.pid));",
      "setInterval(() => {}, 1000);"
    ].join("\n");
    const request = {
      id: "run-timeout",
      projectId: "project-timeout",
      projectPath,
      prompt: "sleep",
      executionMode: "plan",
      purpose: "implementation-plan",
      timeoutMs: 80
    } as ToolRunRequest;

    const result = await runSpawnedAgent({
      toolId: "mock",
      commandPath: process.execPath,
      args: ["-e", script, pidPath],
      request
    });

    expect(result.status).toBe("failed");
    expect(result.terminationReason).toBe("timed-out");
    const childPid = Number(await readFile(pidPath, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(() => process.kill(childPid, 0)).toThrow();
  }, 5000);

  it.skipIf(process.platform === "win32")("keeps the kill escalation after the root exits when a descendant ignores SIGTERM", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-agent-timeout-stubborn-"));
    const pidPath = join(projectPath, "child.pid");
    const readyPath = join(projectPath, "child.ready");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const childScript = 'process.on(\"SIGTERM\", () => {}); require(\"node:fs\").writeFileSync(process.argv[1], \"ready\"); setInterval(() => {}, 1000);';",
      "const child = spawn(process.execPath, ['-e', childScript, process.argv[2]], { stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[1], String(child.pid));",
      "setInterval(() => {}, 1000);"
    ].join("\n");
    const request = {
      id: "run-timeout-stubborn",
      projectId: "project-timeout-stubborn",
      projectPath,
      prompt: "sleep",
      executionMode: "plan",
      purpose: "implementation-plan",
      timeoutMs: 1000
    } as ToolRunRequest;

    const resultPromise = runSpawnedAgent({
      toolId: "mock",
      commandPath: process.execPath,
      args: ["-e", script, pidPath, readyPath],
      request
    });
    const childPid = Number(await waitForTextFile(pidPath));
    await waitForTextFile(readyPath);
    try {
      const result = await resultPromise;
      expect(result.terminationReason).toBe("timed-out");
      expect(await waitForProcessExit(childPid)).toBe(true);
    } finally {
      terminateTestProcess(childPid);
    }
  }, 15000);

  it.skipIf(process.platform === "win32")("reports when a descendant process group cannot be confirmed stopped", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-agent-timeout-kill-failure-"));
    const rootPidPath = join(projectPath, "root.pid");
    const pidPath = join(projectPath, "child.pid");
    const readyPath = join(projectPath, "child.ready");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.argv[1], String(process.pid));",
      "const childScript = 'process.on(\"SIGTERM\", () => {}); require(\"node:fs\").writeFileSync(process.argv[1], \"ready\"); setInterval(() => {}, 1000);';",
      "const child = spawn(process.execPath, ['-e', childScript, process.argv[3]], { stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[2], String(child.pid));",
      "setInterval(() => {}, 1000);"
    ].join("\n");
    const request = {
      id: "run-timeout-kill-failure",
      projectId: "project-timeout-kill-failure",
      projectPath,
      prompt: "sleep",
      executionMode: "plan",
      purpose: "implementation-plan",
      timeoutMs: 1000
    } as ToolRunRequest;
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (typeof pid === "number" && pid < 0 && signal === "SIGKILL") {
        throw Object.assign(new Error("simulated process group permission failure"), { code: "EPERM" });
      }
      return originalKill(pid, signal);
    });
    let rootPid: number | undefined;
    let childPid: number | undefined;

    try {
      const resultPromise = runSpawnedAgent({
        toolId: "mock",
        commandPath: process.execPath,
        args: ["-e", script, rootPidPath, pidPath, readyPath],
        request
      });
      rootPid = Number(await waitForTextFile(rootPidPath));
      childPid = Number(await waitForTextFile(pidPath));
      await waitForTextFile(readyPath);

      const result = await resultPromise;

      expect(result.failure).toMatchObject({ code: "process" });
      expect(result.failure?.message).toContain("Could not confirm process group");
    } finally {
      killSpy.mockRestore();
      if (rootPid !== undefined) terminateTestProcessGroup(rootPid, originalKill);
      if (childPid !== undefined) terminateTestProcess(childPid);
    }
  }, 12000);

  it.skipIf(process.platform === "win32")("bounds cleanup when a descendant escapes the process group and holds output pipes open", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-agent-timeout-escaped-child-"));
    const pidPath = join(projectPath, "child.pid");
    const readyPath = join(projectPath, "child.ready");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const childScript = 'process.on(\"SIGTERM\", () => {}); require(\"node:fs\").writeFileSync(process.argv[1], \"ready\"); setInterval(() => {}, 1000);';",
      "const child = spawn(process.execPath, ['-e', childScript, process.argv[2]], { detached: true, stdio: 'inherit' });",
      "fs.writeFileSync(process.argv[1], String(child.pid));",
      "setInterval(() => {}, 1000);"
    ].join("\n");
    const request = {
      id: "run-timeout-escaped-child",
      projectId: "project-timeout-escaped-child",
      projectPath,
      prompt: "sleep",
      executionMode: "plan",
      purpose: "implementation-plan",
      timeoutMs: 80
    } as ToolRunRequest;
    const originalKill = process.kill.bind(process);
    let childPid: number | undefined;

    const resultPromise = runSpawnedAgent({
      toolId: "mock",
      commandPath: process.execPath,
      args: ["-e", script, pidPath, readyPath],
      request
    });
    try {
      childPid = Number(await waitForTextFile(pidPath));
      await waitForTextFile(readyPath);
      const finishedBeforeCleanup = await Promise.race([
        resultPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000))
      ]);
      expect(finishedBeforeCleanup).toBe(true);
      const result = await resultPromise;
      expect(result.failure).toMatchObject({ code: "process" });
      expect(result.failure?.message).toContain("Could not confirm");
    } finally {
      if (childPid !== undefined) {
        try {
          originalKill(childPid, "SIGKILL");
        } catch (error) {
          if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH") throw error;
        }
      }
    }
  }, 12000);

  it.skipIf(process.platform !== "win32")("force terminates Windows descendants before returning a timeout", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-agent-timeout-windows-"));
    const pidPath = join(projectPath, "child.pid");
    const readyPath = join(projectPath, "child.ready");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const childScript = 'const fs = require(\"node:fs\"); fs.writeFileSync(process.argv[1], \"ready\"); setInterval(() => fs.writeFileSync(process.argv[1], String(Date.now())), 20);';",
      "const child = spawn(process.execPath, ['-e', childScript, process.argv[2]], { stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[1], String(child.pid));",
      "setInterval(() => {}, 1000);"
    ].join("\n");
    const request = {
      id: "run-timeout-windows",
      projectId: "project-timeout-windows",
      projectPath,
      prompt: "sleep",
      executionMode: "plan",
      purpose: "implementation-plan",
      timeoutMs: 1000
    } as ToolRunRequest;

    const resultPromise = runSpawnedAgent({
      toolId: "mock",
      commandPath: process.execPath,
      args: ["-e", script, pidPath, readyPath],
      request
    });
    const childPid = Number(await waitForTextFile(pidPath));
    await waitForTextFile(readyPath);
    try {
      const result = await resultPromise;
      expect(result.terminationReason).toBe("timed-out");
      const heartbeatAtReturn = await readFile(readyPath, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await readFile(readyPath, "utf8")).toBe(heartbeatAtReturn);
      expect(await waitForProcessExit(childPid)).toBe(true);
    } finally {
      terminateTestProcess(childPid);
    }
  }, 15000);
});

async function waitForTextFile(path: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for test file: ${path}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isProcessAlive(pid);
}

function terminateTestProcess(pid: number): void {
  try {
    process.kill(pid, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
}

function terminateTestProcessGroup(
  processGroupId: number,
  kill: typeof process.kill
): void {
  try {
    kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
}

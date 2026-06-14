import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSpawnedAgent, safeAgentEnvironment } from "../../src/main/agents/spawn-agent-process";

describe("spawn-agent-process", () => {
  it("terminates a process when output exceeds the configured limit", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-output-limit-"));
    const result = await runSpawnedAgent({
      toolId: "mock",
      commandPath: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000);"],
      request: {
        id: "output-limit",
        projectId: "project-output-limit",
        projectPath,
        prompt: "test",
        executionMode: "plan",
        purpose: "implementation-plan",
        maxOutputBytes: 1024
      }
    });

    expect(result.status).toBe("failed");
    expect(result.outputTruncated).toBe(true);
    expect(result.terminationReason).toBe("output-limit");
  });

  it("passes only the credential required by the selected built-in Agent", () => {
    const source = {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "anthropic-secret",
      ANTHROPIC_BASE_URL: "https://provider.example",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      OPENAI_API_KEY: "openai-secret",
      OPENAI_BASE_URL: "https://openai.example",
      CODEX_HOME: "/tmp/codex",
      GEMINI_API_KEY: "gemini-secret",
      GOOGLE_API_KEY: "google-secret",
      GOOGLE_CLOUD_PROJECT: "project"
    };

    expect(safeAgentEnvironment(source, "codex-local")).toEqual({
      PATH: "/bin",
      OPENAI_API_KEY: "openai-secret",
      OPENAI_BASE_URL: "https://openai.example",
      CODEX_HOME: "/tmp/codex"
    });
    expect(safeAgentEnvironment(source, "claude-code")).toMatchObject({
      ANTHROPIC_API_KEY: "anthropic-secret",
      ANTHROPIC_BASE_URL: "https://provider.example",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token"
    });
    expect(safeAgentEnvironment(source, "gemini-cli")).toMatchObject({
      GEMINI_API_KEY: "gemini-secret",
      GOOGLE_API_KEY: "google-secret",
      GOOGLE_CLOUD_PROJECT: "project"
    });
    expect(safeAgentEnvironment(source, "custom:test")).toEqual({ PATH: "/bin" });
  });

  it("terminates the complete spawned process group on cancellation", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-process-tree-"));
    const childPidPath = join(projectPath, "child.pid");
    const controller = new AbortController();
    const execution = runSpawnedAgent({
      toolId: "mock",
      commandPath: process.execPath,
      args: [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
          "setInterval(() => {}, 1000);"
        ].join("")
      ],
      request: {
        id: "process-tree-cancel",
        projectId: "project-process-tree",
        projectPath,
        prompt: "test",
        executionMode: "plan",
        purpose: "implementation-plan",
        signal: controller.signal
      }
    });
    await waitForFile(childPidPath);
    const childPid = Number(await readFile(childPidPath, "utf8"));
    controller.abort("user-canceled");
    const result = await execution;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(result.terminationReason).toBe("canceled");
    expect(() => process.kill(childPid, 0)).toThrow();
  });
});

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for child process pid file: ${path}`);
}

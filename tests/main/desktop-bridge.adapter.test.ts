import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDesktopAppOpenArgs,
  buildDesktopBridgeRequest,
  DesktopBridgeAdapter,
  getDesktopBridgeDir,
  readDesktopBridgeResponse
} from "../../src/main/agents/desktop-bridge.adapter";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";

describe("desktop-bridge.adapter", () => {
  it("builds desktop app open args with the project path", () => {
    expect(buildDesktopAppOpenArgs("/Applications/Codex.app", "/tmp/project")).toEqual([
      "-a",
      "/Applications/Codex.app",
      "/tmp/project"
    ]);
  });

  it("writes bridge request files and reads response.json into the run plan", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-desktop-bridge-"));
    const runId = "run-desktop-response";
    await mkdir(join(projectPath, FLOWWEAVE_DIR, "runs", runId), { recursive: true });
    const bridgeDir = getDesktopBridgeDir(projectPath, runId);
    const adapter = new DesktopBridgeAdapter({
      id: "codex-desktop",
      name: "Codex Desktop Test",
      appPath: "/definitely/not/Codex.app",
      responseTimeoutMs: 1_000,
      pollIntervalMs: 10
    });

    setTimeout(() => {
      void writeFile(
        join(bridgeDir, "response.json"),
        JSON.stringify({ status: "completed", summary: "bridge completed", plan: "# Desktop Plan\n\nBridge response." }),
        "utf8"
      );
    }, 20);

    const result = await adapter.runPlan({
      id: runId,
      projectPath,
      prompt: "Inspect the project.",
      executionMode: "plan"
    });

    expect(result.status).toBe("completed");
    await expect(readFile(join(bridgeDir, "request.json"), "utf8")).resolves.toContain('"agentId": "codex-desktop"');
    await expect(readFile(join(bridgeDir, "prompt.md"), "utf8")).resolves.toContain("Inspect the project.");
    await expect(readFile(join(bridgeDir, "instructions.md"), "utf8")).resolves.toContain("response.json");
    await expect(readFile(result.planPath ?? "", "utf8")).resolves.toContain("Bridge response.");
  });

  it("prefers response.json over response.md", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-desktop-response-"));
    const bridgeDir = getDesktopBridgeDir(projectPath, "run-response-precedence");
    await mkdir(bridgeDir, { recursive: true });
    await writeFile(join(bridgeDir, "response.md"), "# Markdown Plan", "utf8");
    await writeFile(
      join(bridgeDir, "response.json"),
      JSON.stringify({ status: "completed", summary: "json summary", plan: "# Json Plan" }),
      "utf8"
    );

    const response = await readDesktopBridgeResponse(bridgeDir);

    expect(response).toMatchObject({ summary: "json summary", plan: "# Json Plan" });
  });

  it("times out as failed while preserving bridge artifacts", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-desktop-timeout-"));
    const runId = "run-desktop-timeout";
    await mkdir(join(projectPath, FLOWWEAVE_DIR, "runs", runId), { recursive: true });
    const adapter = new DesktopBridgeAdapter({
      id: "claude-desktop",
      name: "Claude Desktop Test",
      appPath: "/definitely/not/Claude.app",
      responseTimeoutMs: 20,
      pollIntervalMs: 5
    });

    const result = await adapter.runPlan({
      id: runId,
      projectPath,
      prompt: "Create a plan.",
      executionMode: "plan"
    });

    const bridgeDir = getDesktopBridgeDir(projectPath, runId);
    expect(result.status).toBe("failed");
    await expect(readFile(join(bridgeDir, "request.json"), "utf8")).resolves.toContain('"agentId": "claude-desktop"');
    await expect(readFile(result.planPath ?? "", "utf8")).resolves.toContain("Desktop Bridge Pending");
  });

  it("exposes project, prompt, instructions, skill, and plugin references in request metadata", () => {
    const request = buildDesktopBridgeRequest({
      request: {
        id: "run-metadata",
        projectPath: "/tmp/project",
        prompt: "Prompt",
        executionMode: "plan"
      },
      agentId: "claude-desktop",
      promptPath: "/tmp/project/.flowweave/agent-bridge/run-metadata/prompt.md",
      instructionsPath: "/tmp/project/.flowweave/agent-bridge/run-metadata/instructions.md"
    });

    expect(request.skills.map((skill) => skill.kind)).toEqual([
      "project",
      "prompt",
      "instructions",
      "skill-root",
      "plugin-root"
    ]);
  });
});

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

  it("writes bridge request files and returns pending immediately", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-desktop-bridge-"));
    const runId = "run-desktop-response";
    await mkdir(join(projectPath, FLOWWEAVE_DIR, "runs", runId), { recursive: true });
    const bridgeDir = getDesktopBridgeDir(projectPath, runId);
    const adapter = new DesktopBridgeAdapter({
      id: "codex-desktop",
      name: "Codex Desktop Test",
      appPath: "/definitely/not/Codex.app"
    });

    const result = await adapter.runPlan({
      id: runId,
      projectId: "project-00000000-0000-0000-0000-000000000000",
      projectPath,
      prompt: "Inspect the project.",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    expect(result.status).toBe("pending");
    await expect(readFile(join(bridgeDir, "request.json"), "utf8")).resolves.toContain('"agentId": "codex-desktop"');
    await expect(readFile(join(bridgeDir, "prompt.md"), "utf8")).resolves.toContain("Inspect the project.");
    await expect(readFile(join(bridgeDir, "instructions.md"), "utf8")).resolves.toContain("response.json");
  });

  it("prefers response.json over response.md", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-desktop-response-"));
    const bridgeDir = getDesktopBridgeDir(projectPath, "run-response-precedence");
    await mkdir(bridgeDir, { recursive: true });
    await writeFile(join(bridgeDir, "response.md"), "# Markdown Plan", "utf8");
    await writeFile(
      join(bridgeDir, "response.json"),
      JSON.stringify({ status: "completed", summary: "json summary", content: "# Json Plan" }),
      "utf8"
    );

    const response = await readDesktopBridgeResponse(bridgeDir);

    expect(response).toMatchObject({ summary: "json summary", content: "# Json Plan" });
  });

  it("does not time out pending runs", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-desktop-timeout-"));
    const runId = "run-desktop-timeout";
    await mkdir(join(projectPath, FLOWWEAVE_DIR, "runs", runId), { recursive: true });
    const adapter = new DesktopBridgeAdapter({
      id: "claude-desktop",
      name: "Claude Desktop Test",
      appPath: "/definitely/not/Claude.app"
    });

    const result = await adapter.runPlan({
      id: runId,
      projectId: "project-00000000-0000-0000-0000-000000000000",
      projectPath,
      prompt: "Create a plan.",
      executionMode: "plan",
      purpose: "implementation-plan"
    });

    const bridgeDir = getDesktopBridgeDir(projectPath, runId);
    expect(result.status).toBe("pending");
    await expect(readFile(join(bridgeDir, "request.json"), "utf8")).resolves.toContain('"agentId": "claude-desktop"');
  });

  it("exposes project, prompt, instructions, skill, and plugin references in request metadata", () => {
    const request = buildDesktopBridgeRequest({
      request: {
        id: "run-metadata",
        projectId: "project-00000000-0000-0000-0000-000000000000",
        projectPath: "/tmp/project",
        prompt: "Prompt",
        executionMode: "plan",
        purpose: "implementation-plan"
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

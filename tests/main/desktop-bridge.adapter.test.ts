import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDesktopAppOpenArgs,
  buildDesktopBridgeInstructions,
  DesktopBridgeAdapter,
  desktopBridgePlatformSupport,
  getCodexDesktopAppPathCandidates,
  getDesktopBridgeDir
} from "../../src/main/agents/desktop-bridge.adapter";
import { getAgentInboxRequestPath } from "../../src/main/services/agent-inbox.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";

describe("desktop-bridge.adapter", () => {
  it("reports desktop agents as macOS-only", () => {
    expect(desktopBridgePlatformSupport("darwin")).toEqual({ supported: true });
    expect(desktopBridgePlatformSupport("win32")).toEqual({
      supported: false,
      message: "Desktop Agent Inbox is only supported on macOS. Use the CLI integration on Windows."
    });
  });

  it("builds desktop app open args with the project path", () => {
    expect(buildDesktopAppOpenArgs("/Applications/Codex.app", "/tmp/project")).toEqual([
      "-a",
      "/Applications/Codex.app",
      "/tmp/project"
    ]);
  });

  it("prefers ChatGPT.app while retaining Codex.app as a Codex Desktop fallback", () => {
    expect(getCodexDesktopAppPathCandidates()).toEqual([
      "/Applications/ChatGPT.app",
      "/Applications/Codex.app"
    ]);
  });

  it("writes an Agent Inbox request and returns pending immediately", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-agent-inbox-desktop-"));
    const runId = "run-desktop-response";
    await mkdir(join(projectPath, FLOWWEAVE_DIR, "runs", runId), { recursive: true });
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
    await expect(readFile(getAgentInboxRequestPath(projectPath), "utf8")).resolves.toContain('"protocolVersion": 2');
    await expect(readFile(getAgentInboxRequestPath(projectPath), "utf8")).resolves.toContain('"agentId": "codex-desktop"');
  });

  it("uses Agent Inbox instructions for artifact analysis", () => {
    const instructions = buildDesktopBridgeInstructions("Codex Desktop Test", "plan", "artifact-analysis");

    expect(instructions).toContain("FlowWeave Agent Inbox Instructions");
    expect(instructions).toContain("protocol v2");
    expect(instructions).toContain("responsePath");
    expect(instructions).not.toContain("pending-requests.json");
  });

  it("maps legacy open helper to the current inbox folder", () => {
    expect(getDesktopBridgeDir("/tmp/project", "run-1")).toBe("/tmp/project/.flowweave/agent-inbox/current");
  });
});

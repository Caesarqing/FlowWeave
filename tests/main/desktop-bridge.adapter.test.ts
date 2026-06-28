import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDesktopAppOpenArgs,
  buildDesktopBridgeInstructions,
  buildDesktopBridgeRequest,
  DesktopBridgeAdapter,
  desktopBridgePlatformSupport,
  getDesktopBridgeDir,
  readDesktopBridgeResponse
} from "../../src/main/agents/desktop-bridge.adapter";
import { readDesktopBridgePendingManifest } from "../../src/main/services/desktop-bridge-manifest.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";

describe("desktop-bridge.adapter", () => {
  it("reports desktop bridges as macOS-only", () => {
    expect(desktopBridgePlatformSupport("darwin")).toEqual({ supported: true });
    expect(desktopBridgePlatformSupport("win32")).toEqual({
      supported: false,
      message: "Desktop Agent bridge is only supported on macOS. Use the CLI integration on Windows."
    });
  });

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
    const manifest = await readDesktopBridgePendingManifest(projectPath);
    expect(manifest.requests).toEqual([
      expect.objectContaining({
        runId,
        projectId: "project-00000000-0000-0000-0000-000000000000",
        agentId: "codex-desktop",
        status: "pending",
        responsePath: join(bridgeDir, "response.json")
      })
    ]);
  });

  it("records multiple concurrent pending bridge requests in the manifest", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-desktop-multi-"));
    const adapter = new DesktopBridgeAdapter({
      id: "codex-desktop",
      name: "Codex Desktop Test",
      appPath: "/definitely/not/Codex.app"
    });
    await Promise.all(["run-desktop-1", "run-desktop-2"].map(async (runId) => {
      await mkdir(join(projectPath, FLOWWEAVE_DIR, "runs", runId), { recursive: true });
      await adapter.runPlan({
        id: runId,
        projectId: "project-00000000-0000-0000-0000-000000000000",
        projectPath,
        prompt: `Inspect ${runId}.`,
        executionMode: "plan",
        purpose: "artifact-analysis",
        artifactTarget: runId.endsWith("1") ? "architecture-map" : "sequence-diagrams",
        scanFingerprint: "scan-test",
        reviewId: `review-${runId}`
      });
    }));

    const manifest = await readDesktopBridgePendingManifest(projectPath);

    expect(manifest.requests).toHaveLength(2);
    expect(manifest.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "run-desktop-1",
        artifactTarget: "architecture-map",
        scanFingerprint: "scan-test",
        reviewId: "review-run-desktop-1"
      }),
      expect.objectContaining({
        runId: "run-desktop-2",
        artifactTarget: "sequence-diagrams",
        scanFingerprint: "scan-test",
        reviewId: "review-run-desktop-2"
      })
    ]));
  });

  it("requires structured response.json for artifact analysis bridge runs", () => {
    const instructions = buildDesktopBridgeInstructions("Codex Desktop Test", "plan", "artifact-analysis");

    expect(instructions).toContain("Artifact analysis requires response.json");
    expect(instructions).toContain("Do not answer only in chat");
    expect(instructions).not.toContain("or response.md with the plan markdown");
  });

  it("appends custom bridge instructions for desktop agents", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-desktop-custom-"));
    const runId = "run-desktop-custom";
    await mkdir(join(projectPath, FLOWWEAVE_DIR, "runs", runId), { recursive: true });
    const bridgeDir = getDesktopBridgeDir(projectPath, runId);
    const adapter = new DesktopBridgeAdapter({
      id: "custom:local-desktop-agent",
      name: "Local Desktop Agent",
      appPath: "/definitely/not/Local.app",
      bridgeInstructions: "Use the project context and keep the response concise."
    });

    await adapter.runPlan({
      id: runId,
      projectId: "project-00000000-0000-0000-0000-000000000000",
      projectPath,
      prompt: "Inspect the project.",
      executionMode: "plan",
      purpose: "artifact-analysis"
    });

    await expect(readFile(join(bridgeDir, "instructions.md"), "utf8")).resolves.toContain("Use the project context");
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
        purpose: "artifact-analysis",
        artifactTarget: "architecture-map",
        scanFingerprint: "scan-test",
        reviewId: "review-test"
      },
      agentId: "claude-desktop",
      bridgeDir: "/tmp/project/.flowweave/agent-bridge/run-metadata",
      promptPath: "/tmp/project/.flowweave/agent-bridge/run-metadata/prompt.md",
      instructionsPath: "/tmp/project/.flowweave/agent-bridge/run-metadata/instructions.md",
      responsePath: "/tmp/project/.flowweave/agent-bridge/run-metadata/response.json",
      createdAt: "2026-06-27T00:00:00.000Z"
    });

    expect(request.skills.map((skill) => skill.kind)).toEqual([
      "project",
      "prompt",
      "instructions",
      "skill-root",
      "plugin-root"
    ]);
    expect(request).toMatchObject({
      artifactTarget: "architecture-map",
      scanFingerprint: "scan-test",
      reviewId: "review-test",
      responsePath: "/tmp/project/.flowweave/agent-bridge/run-metadata/response.json"
    });
  });
});

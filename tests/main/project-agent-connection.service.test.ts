import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodeflowCanvas, CodeflowProject } from "../../src/types";
import {
  disableProjectAgentConnection,
  enableProjectAgentConnection,
  getProjectAgentConnection,
  getProjectAgentConnectionForPlatform,
  refreshProjectAgentConnection,
  refreshProjectAgentConnectionForPlatform,
  refreshProjectAgentConnectionIfEnabled
} from "../../src/main/services/project-agent-connection.service";

describe("project Agent connection", () => {
  it("starts with confirmation required and generates all project-native entries", async () => {
    const projectPath = await createProject();

    expect(await getProjectAgentConnection(projectPath)).toMatchObject({ state: "disabled", needsConfirmation: true });

    const status = await enableProjectAgentConnection(projectPath);

    expect(status.state).toBe("ready");
    expect(status.platforms).toEqual(["codex", "claude", "gemini", "cursor"]);
    await expectFileToContain(join(projectPath, ".flowweave", "agent-context.md"), ".flowweave/project.json");
    await expectFileToContain(join(projectPath, ".flowweave", "agent-context.md"), "Agent Inbox Protocol v2");
    const context = await readFile(join(projectPath, ".flowweave", "agent-context.md"), "utf8");
    expect(context).toContain("responsePath");
    expect(context).not.toMatch(/(?<!agent-)response\.json/);
    expect(context).not.toMatch(/(?<!agent-)request\.json/);
    expect(context.length).toBeLessThan(4_000);
    expect(context).toContain(`Project root: ${projectPath}`);
    expect(context).toContain("Scan fingerprint: fixture-scan-fingerprint");
    expect(context).toContain(".flowweave/project.json (schema v1)");
    expect(context).toContain(".flowweave/canvas/main.canvas.json (schema v5)");
    expect(context).not.toContain("## Canvas Modules");
    expect(context).not.toContain("## Canvas Relationships");
    expect(context).not.toContain("## File Tree");
    expect(context).not.toContain("API Module");
    await expectFileToContain(join(projectPath, "AGENTS.md"), "<!-- flowweave:start -->");
    await expectFileToContain(join(projectPath, "AGENTS.md"), "protocolVersion");
    await expectFileToContain(join(projectPath, "AGENTS.md"), "agent-response.json");
    await expectFileToContain(join(projectPath, "AGENTS.md"), "Do not edit `.flowweave/architecture-review.json`");
    await expectFileToContain(join(projectPath, "CLAUDE.md"), ".flowweave/agent-context.md");
    await expectFileToContain(join(projectPath, "GEMINI.md"), ".flowweave/agent-context.md");
    await expectFileToContain(join(projectPath, ".cursor", "rules", "flowweave.mdc"), "alwaysApply: true");
  });

  it("preserves user instructions and refreshes one managed block without duplication", async () => {
    const projectPath = await createProject();
    const agentsPath = join(projectPath, "AGENTS.md");
    await writeFile(agentsPath, "# User Instructions\n\nKeep this text.\n", "utf8");

    await enableProjectAgentConnection(projectPath);
    await refreshProjectAgentConnection(projectPath);

    const content = await readFile(agentsPath, "utf8");
    expect(content).toContain("# User Instructions");
    expect(content).toContain("Keep this text.");
    expect(markerCount(content, "<!-- flowweave:start -->")).toBe(1);
    expect(markerCount(content, "<!-- flowweave:end -->")).toBe(1);
  });

  it("rejects malformed markers before writing any connection files", async () => {
    const projectPath = await createProject();
    const agentsPath = join(projectPath, "AGENTS.md");
    await writeFile(agentsPath, "<!-- flowweave:start -->\nBroken block\n", "utf8");

    await expect(enableProjectAgentConnection(projectPath)).rejects.toThrow("malformed or duplicated");
    await expect(fileExists(join(projectPath, ".flowweave", "agent-context.md"))).resolves.toBe(false);
    await expect(readFile(agentsPath, "utf8")).resolves.toBe("<!-- flowweave:start -->\nBroken block\n");
  });

  it("reports the host instruction file that makes an enabled connection stale", async () => {
    const projectPath = await createProject();
    await enableProjectAgentConnection(projectPath);
    const geminiPath = join(projectPath, "GEMINI.md");
    await writeFile(geminiPath, "<!-- flowweave:start -->\nBroken block\n", "utf8");

    const status = await getProjectAgentConnection(projectPath);

    expect(status.state).toBe("needs-refresh");
    expect(status.missingFiles).toEqual([geminiPath]);
  });

  it("scopes readiness to one platform while preserving aggregate connection status", async () => {
    const projectPath = await createProject();
    await enableProjectAgentConnection(projectPath);
    const geminiPath = join(projectPath, "GEMINI.md");
    await writeFile(geminiPath, "<!-- flowweave:start -->\nBroken block\n", "utf8");

    const codexStatus = await getProjectAgentConnectionForPlatform(projectPath, "codex");
    const geminiStatus = await getProjectAgentConnectionForPlatform(projectPath, "gemini");
    const aggregateStatus = await getProjectAgentConnection(projectPath);

    expect(codexStatus.state).toBe("ready");
    expect(geminiStatus.state).toBe("needs-refresh");
    expect(geminiStatus.missingFiles).toEqual([geminiPath]);
    expect(aggregateStatus.state).toBe("needs-refresh");
    expect(aggregateStatus.missingFiles).toEqual([geminiPath]);
  });

  it("refreshes one platform without reading or rewriting another platform block", async () => {
    const projectPath = await createProject();
    await enableProjectAgentConnection(projectPath);
    const geminiPath = join(projectPath, "GEMINI.md");
    const cursorPath = join(projectPath, ".cursor", "rules", "flowweave.mdc");
    const originalGemini = "<!-- flowweave:start -->\nBroken Gemini block\n";
    await writeFile(geminiPath, originalGemini, "utf8");
    await rm(cursorPath);

    const refreshed = await refreshProjectAgentConnectionForPlatform(projectPath, "cursor");
    const cursorStatus = await getProjectAgentConnectionForPlatform(projectPath, "cursor");
    const geminiStatus = await getProjectAgentConnectionForPlatform(projectPath, "gemini");

    expect(refreshed.state).toBe("ready");
    expect(cursorStatus.state).toBe("ready");
    expect(geminiStatus.state).toBe("needs-refresh");
    expect(geminiStatus.missingFiles).toEqual([geminiPath]);
    await expect(readFile(geminiPath, "utf8")).resolves.toBe(originalGemini);
    await expectFileToContain(cursorPath, "alwaysApply: true");
  });

  it("disconnects by removing only FlowWeave-managed content", async () => {
    const projectPath = await createProject();
    const agentsPath = join(projectPath, "AGENTS.md");
    await writeFile(agentsPath, "# User Instructions\n\nKeep this text.\n", "utf8");
    await enableProjectAgentConnection(projectPath);

    const status = await disableProjectAgentConnection(projectPath);

    expect(status.state).toBe("disabled");
    await expect(readFile(agentsPath, "utf8")).resolves.toBe("# User Instructions\n\nKeep this text.\n");
    await expect(fileExists(join(projectPath, "CLAUDE.md"))).resolves.toBe(false);
    await expect(fileExists(join(projectPath, "GEMINI.md"))).resolves.toBe(false);
    await expect(fileExists(join(projectPath, ".cursor", "rules", "flowweave.mdc"))).resolves.toBe(false);
    await expect(fileExists(join(projectPath, ".flowweave", "agent-context.md"))).resolves.toBe(false);
  });

  it("does not refresh the context when an artifact only changes generatedAt", async () => {
    const projectPath = await createProject();
    await enableProjectAgentConnection(projectPath);
    const canvasPath = join(projectPath, ".flowweave", "canvas", "main.canvas.json");
    const contextPath = join(projectPath, ".flowweave", "agent-context.md");
    const originalContext = await readFile(contextPath, "utf8");
    const canvas = createCanvas(projectPath, "API Module");
    canvas.generatedAt = "2030-01-01T00:00:00.000Z";
    await writeJson(canvasPath, canvas);

    expect((await getProjectAgentConnection(projectPath)).state).toBe("ready");
    await expect(readFile(contextPath, "utf8")).resolves.toBe(originalContext);
  });

  it("requires refresh when the scan fingerprint, protocol, or managed block changes", async () => {
    const projectPath = await createProject();
    await enableProjectAgentConnection(projectPath);
    const projectArtifactPath = join(projectPath, ".flowweave", "project.json");
    const projectArtifact = JSON.parse(await readFile(projectArtifactPath, "utf8")) as CodeflowProject;
    projectArtifact.scanFingerprint = "changed-scan-fingerprint";
    await writeJson(projectArtifactPath, projectArtifact);

    expect((await getProjectAgentConnection(projectPath)).state).toBe("needs-refresh");

    await refreshProjectAgentConnection(projectPath);
    const contextPath = join(projectPath, ".flowweave", "agent-context.md");
    const context = await readFile(contextPath, "utf8");
    await writeFile(contextPath, context.replace("Agent Inbox Protocol v2", "Agent Inbox Protocol v1"), "utf8");

    expect((await getProjectAgentConnection(projectPath)).state).toBe("needs-refresh");

    await refreshProjectAgentConnection(projectPath);
    const agentsPath = join(projectPath, "AGENTS.md");
    const agents = await readFile(agentsPath, "utf8");
    await writeFile(agentsPath, agents.replace("verify behavior against source code", "trust the generated context"), "utf8");

    expect((await getProjectAgentConnection(projectPath)).state).toBe("needs-refresh");
  });

  it("reports context with an old project root as needing refresh", async () => {
    const projectPath = await createProject();
    await enableProjectAgentConnection(projectPath);
    const contextPath = join(projectPath, ".flowweave", "agent-context.md");
    const context = await readFile(contextPath, "utf8");
    await writeFile(contextPath, context.replace(`Project root: ${projectPath}`, "Project root: /old/flowweave/path"), "utf8");
    const canvasPath = join(projectPath, ".flowweave", "canvas", "main.canvas.json");
    const canvas = JSON.parse(await readFile(canvasPath, "utf8")) as Record<string, unknown>;
    canvas.version = 1;
    const legacyCanvas = `${JSON.stringify(canvas)}\n`;
    const sequencePath = join(projectPath, ".flowweave", "sequence-diagrams.json");
    const legacySequence = JSON.stringify({ version: 1, generatedAt: new Date().toISOString() });
    await writeFile(canvasPath, legacyCanvas, "utf8");
    await writeFile(sequencePath, legacySequence, "utf8");

    const status = await getProjectAgentConnection(projectPath);

    expect(status.state).toBe("needs-refresh");
    expect(status.message).toContain("context root is stale");

    const refreshed = await refreshProjectAgentConnection(projectPath);

    expect(refreshed.state).toBe("ready");
    await expectFileToContain(contextPath, `Project root: ${projectPath}`);
    await expectFileToContain(contextPath, ".flowweave/canvas/main.canvas.json (schema v1)");
    await expectFileToContain(contextPath, ".flowweave/sequence-diagrams.json (schema v1)");
    await expect(readFile(canvasPath, "utf8")).resolves.toBe(legacyCanvas);
    await expect(readFile(sequencePath, "utf8")).resolves.toBe(legacySequence);
  });

  it("preserves legacy connector artifacts until their manifests are migrated", async () => {
    const projectPath = await createProject();
    const connectorsPath = join(projectPath, ".flowweave", "agent-connectors");
    await mkdir(join(connectorsPath, "skills", "codex"), { recursive: true });
    await writeFile(join(connectorsPath, "codex.md"), "# Codex FlowWeave connector\n\nFlowWeave connector context: old\n", "utf8");
    await writeFile(join(connectorsPath, "context.md"), "FlowWeave connector context: old\n", "utf8");
    await writeFile(join(connectorsPath, "skills", "codex", "SKILL.md"), "Read .flowweave/agent-connectors/codex.md\n", "utf8");
    await writeFile(join(connectorsPath, "custom.md"), "User content\n", "utf8");

    await enableProjectAgentConnection(projectPath);
    await refreshProjectAgentConnection(projectPath);

    await expect(readFile(join(connectorsPath, "codex.md"), "utf8")).resolves.toContain("FlowWeave connector context: old");
    await expect(readFile(join(connectorsPath, "context.md"), "utf8")).resolves.toBe("FlowWeave connector context: old\n");
    await expect(readFile(join(connectorsPath, "skills", "codex", "SKILL.md"), "utf8"))
      .resolves.toBe("Read .flowweave/agent-connectors/codex.md\n");
    await expect(readFile(join(connectorsPath, "custom.md"), "utf8")).resolves.toBe("User content\n");
  });
});

async function createProject() {
  const projectPath = await mkdtemp(join(tmpdir(), "flowweave-agent-connection-"));
  await mkdir(join(projectPath, ".flowweave", "canvas"), { recursive: true });
  await mkdir(join(projectPath, ".flowweave", "context"), { recursive: true });
  await mkdir(join(projectPath, ".flowweave", "tasks"), { recursive: true });

  const project: CodeflowProject = {
    version: 1,
    projectName: "Fixture Project",
    rootPath: projectPath,
    generatedAt: new Date().toISOString(),
    git: { isRepo: true, branch: "main" },
    summary: {
      totalFiles: 2,
      totalFolders: 1,
      languages: { TypeScript: 2 }
    },
    files: [],
    scanFingerprint: "fixture-scan-fingerprint"
  };
  await writeJson(join(projectPath, ".flowweave", "project.json"), project);
  await writeJson(join(projectPath, ".flowweave", "canvas", "main.canvas.json"), createCanvas(projectPath, "API Module"));
  await writeFile(join(projectPath, ".flowweave", "context", "file-tree.md"), "# Project File Tree\n\n- src/\n", "utf8");
  await writeFile(join(projectPath, ".flowweave", "tasks", "main.task.md"), "# Task\n", "utf8");
  return projectPath;
}

function createCanvas(projectPath: string, title: string): CodeflowCanvas {
  return {
    version: 5,
    id: "main",
    title: "Main Canvas",
    projectPath,
    generatedAt: new Date().toISOString(),
    nodes: [
      {
        id: "api",
        title,
        subtitle: "HTTP entry",
        kind: "module",
        nodeType: "api",
        risk: "normal",
        description: "Accepts requests.",
        files: ["src/api.ts"],
        guidanceDraft: "",
        status: "mapped",
        x: 0,
        y: 0
      }
    ],
    edges: []
  };
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function expectFileToContain(filePath: string, expected: string) {
  expect(await readFile(filePath, "utf8")).toContain(expected);
}

async function fileExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function markerCount(content: string, marker: string) {
  return content.split(marker).length - 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

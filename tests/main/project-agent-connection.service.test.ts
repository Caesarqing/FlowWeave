import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodeflowCanvas, CodeflowProject } from "../../src/types";
import {
  disableProjectAgentConnection,
  enableProjectAgentConnection,
  getProjectAgentConnection,
  refreshProjectAgentConnection,
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
    await expectFileToContain(join(projectPath, ".flowweave", "agent-context.md"), "You may modify project files");
    await expectFileToContain(join(projectPath, "AGENTS.md"), "<!-- flowweave:start -->");
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

  it("reports stale artifacts and refreshes the context when enabled", async () => {
    const projectPath = await createProject();
    await enableProjectAgentConnection(projectPath);
    const canvasPath = join(projectPath, ".flowweave", "canvas", "main.canvas.json");
    const canvas = createCanvas(projectPath, "Updated Module");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeJson(canvasPath, canvas);

    expect((await getProjectAgentConnection(projectPath)).state).toBe("needs-refresh");

    await refreshProjectAgentConnectionIfEnabled(projectPath);

    expect((await getProjectAgentConnection(projectPath)).state).toBe("ready");
    await expectFileToContain(join(projectPath, ".flowweave", "agent-context.md"), "Updated Module");
  });

  it("reports context with an old project root as needing refresh", async () => {
    const projectPath = await createProject();
    await enableProjectAgentConnection(projectPath);
    const contextPath = join(projectPath, ".flowweave", "agent-context.md");
    const context = await readFile(contextPath, "utf8");
    await writeFile(contextPath, context.replace(`Project root: ${projectPath}`, "Project root: /old/flowweave/path"), "utf8");

    const status = await getProjectAgentConnection(projectPath);

    expect(status.state).toBe("needs-refresh");
    expect(status.message).toContain("context root is stale");
  });

  it("removes recognized legacy agent connector artifacts during refresh", async () => {
    const projectPath = await createProject();
    const connectorsPath = join(projectPath, ".flowweave", "agent-connectors");
    await mkdir(join(connectorsPath, "skills", "codex"), { recursive: true });
    await writeFile(join(connectorsPath, "codex.md"), "# Codex FlowWeave connector\n\nFlowWeave connector context: old\n", "utf8");
    await writeFile(join(connectorsPath, "context.md"), "FlowWeave connector context: old\n", "utf8");
    await writeFile(join(connectorsPath, "skills", "codex", "SKILL.md"), "Read .flowweave/agent-connectors/codex.md\n", "utf8");
    await writeFile(join(connectorsPath, "custom.md"), "User content\n", "utf8");

    await enableProjectAgentConnection(projectPath);
    await refreshProjectAgentConnection(projectPath);

    await expect(fileExists(join(connectorsPath, "codex.md"))).resolves.toBe(false);
    await expect(fileExists(join(connectorsPath, "context.md"))).resolves.toBe(false);
    await expect(fileExists(join(connectorsPath, "skills", "codex", "SKILL.md"))).resolves.toBe(false);
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
    files: []
  };
  await writeJson(join(projectPath, ".flowweave", "project.json"), project);
  await writeJson(join(projectPath, ".flowweave", "canvas", "main.canvas.json"), createCanvas(projectPath, "API Module"));
  await writeFile(join(projectPath, ".flowweave", "context", "file-tree.md"), "# Project File Tree\n\n- src/\n", "utf8");
  await writeFile(join(projectPath, ".flowweave", "tasks", "main.task.md"), "# Task\n", "utf8");
  return projectPath;
}

function createCanvas(projectPath: string, title: string): CodeflowCanvas {
  return {
    version: 1,
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

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { graphEdges, graphNodes } from "../../src/data";
import {
  buildAgentConnectorMarkdown,
  buildConnectorContext,
  writeAgentConnectors
} from "../../src/main/services/agent-connector.service";
import type { CodeflowProject } from "../../src/main/storage/schemas";

describe("agent-connector.service", () => {
  it("writes project connector context, agent instructions, and skill templates", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "flowweave-connectors-"));
    const project = createProjectFixture(rootPath);

    const result = await writeAgentConnectors({
      project,
      modules: graphNodes,
      edges: graphEdges,
      canvasPath: join(rootPath, ".flowweave", "canvas", "main.canvas.json"),
      taskMarkdownPath: join(rootPath, ".flowweave", "tasks", "task.md"),
      taskJsonPath: join(rootPath, ".flowweave", "tasks", "task.json"),
      contextFileTreePath: join(rootPath, ".flowweave", "context", "file-tree.md")
    });

    const contextJson = await readFile(result.contextJsonPath, "utf8");
    const codex = await readFile(result.codexPath, "utf8");
    const claude = await readFile(result.claudePath, "utf8");
    const gemini = await readFile(result.geminiPath, "utf8");
    const cursor = await readFile(result.cursorPath, "utf8");
    const codexSkill = await readFile(join(result.connectorDir, "skills", "codex", "SKILL.md"), "utf8");

    expect(JSON.parse(contextJson)).toMatchObject({
      version: 1,
      projectName: "connector-api",
      projectPath: rootPath
    });
    expect(codex).toContain("You may modify project files directly");
    expect(codex).toContain("Git diff");
    expect(claude).toContain("Claude");
    expect(gemini).toContain("Gemini");
    expect(cursor).toContain("Cursor");
    expect(codexSkill).toContain("flowweave-codex-connector");
  });

  it("builds connector markdown with FlowWeave artifact paths and module boundaries", () => {
    const context = buildConnectorContext({
      project: createProjectFixture("/tmp/connector-api"),
      modules: graphNodes,
      edges: graphEdges
    });

    const markdown = buildAgentConnectorMarkdown("codex", context);

    expect(markdown).toContain("/tmp/connector-api/.flowweave/agent-connectors/context.json");
    expect(markdown).toContain("Canvas:");
    expect(markdown).toContain("Current Modules");
    expect(markdown).toContain("Do not edit .flowweave artifacts");
  });
});

function createProjectFixture(rootPath: string): CodeflowProject {
  return {
    version: 1,
    projectName: "connector-api",
    rootPath,
    generatedAt: "2026-06-05T00:00:00.000Z",
    git: { isRepo: true },
    summary: { totalFiles: 2, totalFolders: 1, languages: { TypeScript: 2 } },
    files: [
      {
        id: "src",
        name: "src",
        path: "src",
        type: "folder",
        depth: 0,
        children: [
          {
            id: "src/index.ts",
            name: "index.ts",
            path: "src/index.ts",
            type: "file",
            depth: 1,
            language: "TypeScript"
          }
        ]
      }
    ]
  };
}

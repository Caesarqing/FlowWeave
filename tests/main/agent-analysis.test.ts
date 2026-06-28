import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeProject, buildAnalysisPrompt } from "../../src/main/services/agent-analysis.service";
import { configureAgentRegistry, saveCustomAgent } from "../../src/main/services/agent-registry.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import type { CodeflowProject } from "../../src/types";

describe("agent-analysis.service", () => {
  it("builds an analysis prompt from project metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-analysis-prompt-"));
    await mkdir(join(root, "src/auth"), { recursive: true });
    await writeFile(join(root, "src/auth/index.ts"), "export const auth = true;\n");
    const prompt = await buildAnalysisPrompt(projectFixture(root));

    expect(prompt).toContain("ProjectStructureFacts");
    expect(prompt).toContain("Return this exact JSON shape");
    expect(prompt).toContain("src/auth/index.ts");
  });

  it("uses mock agent analysis and writes .flowweave artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-analysis-"));
    await mkdir(join(root, "src/auth"), { recursive: true });
    await writeFile(join(root, "src/auth/index.ts"), "export const auth = true;\n");
    await writeProjectScan(root);

    const result = await analyzeProject(projectFixture(root), "mock");

    expect(result.source).toBe("agent");
    expect(result.graph.nodes.length).toBeGreaterThan(0);
    expect(result.moduleMap.modules[0].files).toContain("src/auth/index.ts");
  });

  it("reports local source when project analysis returns a local semantic graph", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "flowweave-analysis-local-agent-"));
    const root = await mkdtemp(join(tmpdir(), "flowweave-analysis-local-"));
    const scriptPath = join(configRoot, "architecture-agent.mjs");
    await mkdir(join(root, "src/auth"), { recursive: true });
    await writeFile(join(root, "src/auth/index.ts"), "export const auth = true;\n");
    await writeProjectScan(root);
    configureAgentRegistry(configRoot);
    await writeFile(
      scriptPath,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ architectureStyle: 'layered service', modules: [], relationships: [] }));",
        "});"
      ].join("\n"),
      "utf8"
    );
    const agent = await saveCustomAgent({
      name: "Local Analysis Agent",
      command: process.execPath,
      args: [scriptPath]
    });

    const result = await analyzeProject(projectFixture(root), agent.id);

    expect(result.source).toBe("local");
    expect(result.graph.nodes.length).toBeGreaterThan(0);
  });
});

function projectFixture(rootPath: string): CodeflowProject {
  return {
    version: 1,
    projectName: "analysis-fixture",
    rootPath,
    generatedAt: "2026-05-27T00:00:00.000Z",
    scanFingerprint: "scan-test",
    git: { isRepo: false },
    summary: { totalFiles: 1, totalFolders: 2, languages: { TypeScript: 1 } },
    files: [
      {
        id: "src",
        name: "src",
        path: "src",
        type: "folder",
        depth: 0,
        children: [
          {
            id: "src/auth",
            name: "auth",
            path: "src/auth",
            type: "folder",
            depth: 1,
            children: [
              {
                id: "src/auth/index.ts",
                name: "index.ts",
                path: "src/auth/index.ts",
                type: "file",
                depth: 2,
                language: "TypeScript"
              }
            ]
          }
        ]
      }
    ]
  };
}

async function writeProjectScan(rootPath: string) {
  await mkdir(join(rootPath, FLOWWEAVE_DIR), { recursive: true });
  await writeFile(join(rootPath, FLOWWEAVE_DIR, "project.json"), JSON.stringify({ scanFingerprint: "scan-test" }), "utf8");
}

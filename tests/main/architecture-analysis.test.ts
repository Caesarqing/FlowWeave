import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeArchitecture,
  architectureMapToGraph,
  buildArchitecturePrompt,
  parseArchitectureJson,
  readArchitectureMap
} from "../../src/main/services/architecture-analysis.service";
import { configureAgentRegistry, saveCustomAgent } from "../../src/main/services/agent-registry.service";
import { listRunSummaries } from "../../src/main/services/run-log.service";
import { buildProjectStructureFacts } from "../../src/main/services/structure-extractor.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import type { CodeflowProject } from "../../src/types";

describe("architecture-analysis.service", () => {
  it("builds an architecture prompt from structure facts", async () => {
    const root = await createFixtureFiles();
    const facts = await buildProjectStructureFacts(projectFixture(root));
    const prompt = buildArchitecturePrompt(facts);

    expect(prompt).toContain("functional architecture module map");
    expect(prompt).toContain("ProjectStructureFacts");
    expect(prompt).toContain("src/api/user.controller.ts");
    expect(prompt).toContain("Use only the supplied ProjectStructureFacts");
    expect(prompt).toContain("human-readable explanation");
    expect(prompt).toContain("fileRoles");
    expect(prompt).toContain("workflow");
    expect(prompt).toContain("Do not invent files, symbols, calls, endpoints, databases, queues, or third-party systems");
  });

  it("parses agent JSON into canvas graph with symbols and evidence", async () => {
    const root = await createFixtureFiles();
    const project = projectFixture(root);
    const facts = await buildProjectStructureFacts(project);
    const map = parseArchitectureJson(
      JSON.stringify({
        architectureStyle: "layered service",
        modules: [
          {
            id: "user-api",
            title: "User API",
            category: "api-boundary",
            role: "Receives user requests.",
            description: "HTTP boundary for user flows.",
            files: ["src/api/user.controller.ts"],
            fileRoles: [{ path: "src/api/user.controller.ts", role: "Routes user requests." }],
            symbols: [{ name: "loadUser", kind: "function", filePath: "src/api/user.controller.ts", role: "request handler" }],
            evidence: [{ filePath: "src/api/user.controller.ts", symbol: "loadUser", detail: "exports handler" }],
            risk: "normal",
            confidence: 0.9
          },
          {
            id: "user-service",
            title: "User Service",
            category: "domain-service",
            role: "Coordinates user logic.",
            description: "Business logic for user flows.",
            files: ["src/service/user.service.ts"],
            fileRoles: [{ path: "src/service/user.service.ts", role: "Business service." }],
            symbols: [{ name: "UserService", kind: "class", filePath: "src/service/user.service.ts", role: "service" }],
            evidence: [{ filePath: "src/service/user.service.ts", symbol: "UserService", detail: "class declaration" }],
            risk: "normal"
          }
        ],
        relationships: [
          {
            source: "user-api",
            target: "user-service",
            relation: "calls",
            description: "Controller calls service.",
            evidence: [{ filePath: "src/api/user.controller.ts", detail: "imports service" }]
          }
        ]
      }),
      project,
      facts
    );

    expect(map?.modules[0].symbols[0].name).toBe("loadUser");
    const graph = architectureMapToGraph(map!);
    expect(graph.nodes[0]).toMatchObject({ id: "user-api", nodeType: "api", category: "api-boundary" });
    expect(graph.edges[0]).toMatchObject({ relation: "calls", guidanceNote: "Controller calls service." });
  });

  it("persists validated mock architecture artifacts", async () => {
    const root = await createFixtureFiles();
    const project = projectFixture(root);
    const facts = await buildProjectStructureFacts(project);

    expect(parseArchitectureJson("not json", project, facts)).toBeUndefined();

    const result = await analyzeArchitecture(project, "mock");
    const stored = await readArchitectureMap(root);
    const fileInsights = await readFile(join(root, FLOWWEAVE_DIR, "file-insights.json"), "utf8");

    expect(result.outcome).toBe("generated");
    if (result.outcome !== "generated") throw new Error(result.error.message);
    expect(result.graph.nodes.length).toBeGreaterThan(0);
    expect(stored?.modules.length).toBeGreaterThan(0);
    expect(stored?.metadata?.agentId).toBe("mock");
    expect(fileInsights).toContain("src/api/user.controller.ts");
  });

  it("rejects custom agents without a verifiable read-only analysis mode", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "flowweave-architecture-agent-"));
    const root = await createFixtureFiles();
    const scriptPath = join(configRoot, "architecture-agent.mjs");
    configureAgentRegistry(configRoot);
    await writeFile(
      scriptPath,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({",
        "    architectureStyle: 'layered service',",
        "    modules: [{",
        "      id: 'user-api',",
        "      title: 'User API',",
        "      category: 'api-boundary',",
        "      role: 'Receives user requests.',",
        "      description: 'HTTP boundary for user flows.',",
        "      files: ['src/api/user.controller.ts'],",
        "      fileRoles: [{ path: 'src/api/user.controller.ts', role: 'Routes user requests.' }],",
        "      symbols: [{ name: 'loadUser', kind: 'function', filePath: 'src/api/user.controller.ts', role: 'request handler' }],",
        "      evidence: [{ filePath: 'src/api/user.controller.ts', symbol: 'loadUser', detail: 'exports handler' }],",
        "      risk: 'normal',",
        "      confidence: 0.92",
        "    }],",
        "    relationships: []",
        "  }));",
        "});"
      ].join("\n"),
      "utf8"
    );
    const agent = await saveCustomAgent({
      name: "Architecture JSON Agent",
      command: process.execPath,
      args: [scriptPath]
    });

    const result = await analyzeArchitecture(projectFixture(root), agent.id);
    const summaries = await listRunSummaries(root);

    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") throw new Error("Expected analysis failure.");
    expect(result.error.message).toContain("verifiable read-only");
    expect(summaries).toHaveLength(0);
  });
});

async function createFixtureFiles() {
  const root = await mkdtemp(join(tmpdir(), "flowweave-architecture-"));
  await mkdir(join(root, "src/api"), { recursive: true });
  await mkdir(join(root, "src/service"), { recursive: true });
  await writeFile(join(root, "src/api/user.controller.ts"), 'import { UserService } from "../service/user.service";\nexport function loadUser() { return fetch("/users"); }\n', "utf8");
  await writeFile(join(root, "src/service/user.service.ts"), "export class UserService { load() { return true; } }\n", "utf8");
  return root;
}

function projectFixture(rootPath: string): CodeflowProject {
  return {
    version: 1,
    projectName: "architecture-fixture",
    rootPath,
    generatedAt: "2026-05-30T00:00:00.000Z",
    git: { isRepo: false },
    summary: { totalFiles: 2, totalFolders: 3, languages: { TypeScript: 2 } },
    files: [
      {
        id: "src",
        name: "src",
        path: "src",
        type: "folder",
        depth: 0,
        children: [
          {
            id: "src/api",
            name: "api",
            path: "src/api",
            type: "folder",
            depth: 1,
            children: [{ id: "src/api/user.controller.ts", name: "user.controller.ts", path: "src/api/user.controller.ts", type: "file", depth: 2, language: "TypeScript" }]
          },
          {
            id: "src/service",
            name: "service",
            path: "src/service",
            type: "folder",
            depth: 1,
            children: [{ id: "src/service/user.service.ts", name: "user.service.ts", path: "src/service/user.service.ts", type: "file", depth: 2, language: "TypeScript" }]
          }
        ]
      }
    ]
  };
}

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateArchitectureRelationships,
  analyzeArchitecture,
  architectureMapToGraph,
  buildArchitectureInputFingerprint,
  buildArchitecturePrompt,
  enhanceLocalArchitecture,
  parseArchitectureJson,
  readArchitectureMap
} from "../../src/main/services/architecture-analysis.service";
import { configureAgentRegistry, saveCustomAgent } from "../../src/main/services/agent-registry.service";
import { adoptArtifactRun } from "../../src/main/services/artifact-run-adoption.service";
import { writeArchitectureReviewStatus } from "../../src/main/services/architecture-review.service";
import { listRunSummaries } from "../../src/main/services/run-log.service";
import { buildProjectStructureFacts } from "../../src/main/services/structure-extractor.service";
import { registerProject } from "../../src/main/services/project-registry.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { buildSemanticIndex } from "../../src/main/services/semantic-index.service";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import type { CodeflowProject } from "../../src/types";
import { createNodeCliFixture } from "./test-cli-fixture";

describe("architecture-analysis.service", () => {
  it("keeps local modules and relationships when applying Agent wording", () => {
    const local = architectureFixtureMap("local");
    const agent = {
      ...architectureFixtureMap("agent"),
      modules: [{
        ...architectureFixtureMap("agent").modules[0],
        title: "Reviewed User API",
        description: "Agent-enhanced wording."
      }],
      relationships: []
    };

    const enhanced = enhanceLocalArchitecture(local, agent);

    expect(enhanced.modules).toHaveLength(2);
    expect(enhanced.modules[0]).toMatchObject({
      title: "Reviewed User API",
      files: ["src/api/user.controller.ts"]
    });
    expect(enhanced.relationships).toEqual(local.relationships);
  });

  it("keeps every semantic relationship as evidence on stable module edges", () => {
    const files = Array.from({ length: 362 }, (_, index) => ({
      path: `src/${index}.ts`,
      imports: [],
      exports: [],
      symbols: [],
      calls: [],
      externalCalls: []
    }));
    const modules = files.map((file, index) => ({
      id: `module-${index}`,
      title: `Module ${index}`,
      category: "domain-service" as const,
      nodeType: "service" as const,
      role: "Owns application behavior.",
      description: "Application behavior.",
      files: [file.path],
      fileRoles: [],
      symbols: [],
      evidence: [],
      risk: "unknown" as const
    }));
    const relations = Array.from({ length: 181 }, (_, index) => ({
      id: `relation-${index}`,
      kind: "call" as const,
      source: files[index * 2].path,
      target: files[index * 2 + 1].path,
      sourceFile: files[index * 2].path,
      targetFile: files[index * 2 + 1].path,
      symbol: "invoke",
      detail: `Call ${index}`,
      confidence: "confirmed" as const
    }));

    const relationships = aggregateArchitectureRelationships(modules, { files, relations });

    expect(relationships).toHaveLength(181);
    expect(relationships.every((relationship) => relationship.evidence.length === 1)).toBe(true);
  });

  it("keeps every static module when the Mock Agent produces architecture output", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-mock-full-static-"));
    const moduleCount = 48;
    await Promise.all(Array.from({ length: moduleCount }, async (_, index) => {
      const modulePath = join(root, "src", `feature-${index}`);
      await mkdir(modulePath, { recursive: true });
      await writeFile(join(modulePath, "index.ts"), `export const feature${index} = () => true;\n`, "utf8");
    }));

    const project = await scanProject(root);
    await mkdir(join(root, FLOWWEAVE_DIR), { recursive: true });
    await writeFile(join(root, FLOWWEAVE_DIR, "project.json"), JSON.stringify({ scanFingerprint: project.scanFingerprint }), "utf8");
    const result = await analyzeArchitecture(project, "mock");

    expect(result.outcome).toBe("generated");
    if (result.outcome !== "generated") throw new Error(result.error.message);
    expect(result.architectureMap.modules).toHaveLength(moduleCount);
    expect(result.architectureMap.modules.flatMap((module) => module.files)).toHaveLength(moduleCount);
  });

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
    expect(prompt).toContain("function and purpose");
    expect(prompt).toContain("important folders and files");
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
            fileRoles: [
              { path: "src/api", role: "Groups request handlers." },
              { path: "src/api/user.controller.ts", role: "Routes user requests." }
            ],
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
    expect(map?.modules[0].fileRoles).toEqual(expect.arrayContaining([
      { path: "src/api", role: "Groups request handlers." },
      { path: "src/api/user.controller.ts", role: "Routes user requests." }
    ]));
    expect(map?.modules[0].risk).toBe("unknown");
    expect(map?.modules[0].confidence).toBeUndefined();
    const graph = architectureMapToGraph(map!);
    expect(graph.nodes[0]).toMatchObject({ id: "user-api", nodeType: "api", category: "api-boundary" });
    expect(graph.edges[0]).toMatchObject({
      relation: "depends_on",
      guidanceNote: expect.stringContaining("imports ../service/user.service")
    });
  });

  it("parses provider-wrapped and fenced architecture JSON", async () => {
    const root = await createFixtureFiles();
    const project = projectFixture(root);
    const facts = await buildProjectStructureFacts(project);
    const content = JSON.stringify({
      modules: [{
        id: "user-api",
        title: "User API",
        category: "api-boundary",
        role: "Receives user requests.",
        description: "HTTP boundary.",
        files: ["src/api/user.controller.ts"],
        fileRoles: [],
        symbols: [],
        evidence: [{ filePath: "src/api/user.controller.ts", detail: "handler" }],
        risk: "normal"
      }],
      relationships: []
    });

    expect(parseArchitectureJson(JSON.stringify({ type: "result", result: `\`\`\`json\n${content}\n\`\`\`` }), project, facts)?.modules)
      .toHaveLength(1);
  });

  it("persists validated mock architecture artifacts", async () => {
    const root = await createFixtureFiles();
    const project = projectFixture(root);
    const facts = await buildProjectStructureFacts(project);

    expect(parseArchitectureJson("not json", project, facts)).toBeUndefined();

    const result = await analyzeArchitecture(project, "mock");
    await waitForArchitectureSource(root, "agent");
    const stored = await readArchitectureMap(root);

    expect(result.outcome).toBe("generated");
    if (result.outcome !== "generated") throw new Error(result.error.message);
    expect(result.localGenerationStatus).toBe("local-ready");
    expect(result.graph.nodes.length).toBeGreaterThan(0);
    expect(stored?.modules.length).toBeGreaterThan(0);
    expect(stored?.modules[0].description).not.toContain("groups");
    expect(stored?.modules[0].description).not.toContain("detected architecture responsibility");
    const storedFileRoles = stored?.modules.flatMap((module) => module.fileRoles) ?? [];
    expect(storedFileRoles.some((item) => item.path === "src/api")).toBe(true);
    expect(storedFileRoles.some((item) => item.path === "src/service")).toBe(true);
    expect(stored?.metadata?.agentId).toBe("mock");
    expect(stored?.modules[0].assessment?.confidence.factors).toHaveLength(5);
    expect(stored?.modules[0].confidence).toBeUndefined();
    await expect(readFile(join(root, FLOWWEAVE_DIR, "file-insights.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports and preserves a corrupted architecture artifact", async () => {
    const root = await createFixtureFiles();
    await mkdir(join(root, FLOWWEAVE_DIR), { recursive: true });
    const artifactPath = join(root, FLOWWEAVE_DIR, "architecture-map.json");
    await writeFile(artifactPath, "{invalid-json", "utf8");

    await expect(readArchitectureMap(root)).rejects.toThrow("unreadable and was preserved");
    await expect(readFile(artifactPath, "utf8")).resolves.toBe("{invalid-json");
  });

  it("uses the local semantic graph when a custom agent lacks a verifiable read-only mode", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "flowweave-architecture-agent-"));
    const root = await createFixtureFiles();
    const scriptPath = join(configRoot, "architecture-agent.mjs");
    configureAgentRegistry(configRoot);
    await writeFile(
      scriptPath,
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
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
    const stored = await readArchitectureMap(root);

    expect(result.outcome).toBe("generated");
    if (result.outcome !== "generated") throw new Error("Expected local analysis.");
    expect(result.localGenerationStatus).toBe("local-ready");
    expect(result.architectureMap.source).toBe("local");
    expect(result.review).toMatchObject({
      state: "reviewing",
      reviewId: expect.stringMatching(/^review-/),
      scanFingerprint: "scan-test",
      inputFingerprint: expect.not.stringMatching(/^scan-test$/),
      agentId: agent.id
    });
    expect(result.architectureMap.metadata).toMatchObject({
      source: "local",
      scanFingerprint: "scan-test",
      inputFingerprint: result.review.inputFingerprint
    });
    expect(await readFile(join(root, FLOWWEAVE_DIR, "architecture-local.json"), "utf8")).toContain(result.review.inputFingerprint);
    expect(stored?.metadata).toMatchObject({
      source: "local",
      inputFingerprint: result.architectureMap.metadata?.inputFingerprint
    });
    expect(result.warning).toBeUndefined();
    expect(summaries).toHaveLength(0);
  });

  it("publishes an Agent-reviewed architecture event after validating a real custom CLI response", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "flowweave-architecture-reviewed-"));
    const root = await createFixtureFiles();
    const scriptPath = join(configRoot, "review-agent.mjs");
    configureAgentRegistry(configRoot);
    await writeFile(
      scriptPath,
      [
        "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
        "import { dirname } from 'node:path';",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', async () => {",
        "  const requestPath = input.match(/Read the request JSON at: (.+)/)?.[1];",
        "  if (!requestPath) throw new Error('Missing Agent Inbox request path.');",
        "  const request = JSON.parse(await readFile(requestPath, 'utf8'));",
        "  const content = {",
        "    architectureStyle: 'layered service',",
        "    modules: [",
        "      {",
        "        id: 'user-api',",
        "        title: 'User API',",
        "        category: 'api-boundary',",
        "        role: 'Receives user requests.',",
        "        description: 'Reviewed HTTP boundary.',",
        "        files: ['src/api/user.controller.ts'],",
        "        fileRoles: [{ path: 'src/api/user.controller.ts', role: 'Routes requests.' }],",
        "        symbols: [{ name: 'loadUser', kind: 'function', filePath: 'src/api/user.controller.ts', role: 'handler' }],",
        "        evidence: [{ filePath: 'src/api/user.controller.ts', symbol: 'loadUser', detail: 'exports handler' }],",
        "        risk: 'normal'",
        "      },",
        "      {",
        "        id: 'user-service',",
        "        title: 'User Service',",
        "        category: 'domain-service',",
        "        role: 'Coordinates user logic.',",
        "        description: 'Reviewed domain service.',",
        "        files: ['src/service/user.service.ts'],",
        "        fileRoles: [{ path: 'src/service/user.service.ts', role: 'Business service.' }],",
        "        symbols: [{ name: 'UserService', kind: 'class', filePath: 'src/service/user.service.ts', role: 'service' }],",
        "        evidence: [{ filePath: 'src/service/user.service.ts', symbol: 'UserService', detail: 'class declaration' }],",
        "        risk: 'normal'",
        "      }",
        "    ],",
        "    relationships: [{",
        "      source: 'user-api',",
        "      target: 'user-service',",
        "      relation: 'calls',",
        "      description: 'API calls service.',",
        "      evidence: [{ filePath: 'src/api/user.controller.ts', detail: 'imports service' }]",
        "    }]",
        "  };",
        "  await mkdir(dirname(request.responsePath), { recursive: true });",
        "  await writeFile(request.responsePath, JSON.stringify({",
        "    protocolVersion: 2,",
        "    runId: request.runId,",
        "    projectId: request.projectId,",
        "    status: 'completed',",
        "    summary: 'Reviewed architecture.',",
        "    content,",
        "    completedAt: new Date().toISOString()",
        "  }, null, 2), 'utf8');",
        "});"
      ].join("\n"),
      "utf8"
    );
    const agent = await saveCustomAgent({
      name: "Reviewed Architecture Agent",
      command: process.execPath,
      args: [scriptPath],
      planArgs: [scriptPath],
      capabilities: ["artifact-analysis"]
    });
    const projectId = await registerProject(root);
    const events: import("../../src/types").ArchitectureReviewEvent[] = [];

    const result = await analyzeArchitecture(projectFixture(root), agent.id, {
      projectId,
      onArchitectureReview: (event) => events.push(event)
    });

    expect(result.outcome).toBe("generated");
    if (result.outcome !== "generated") throw new Error("Expected local architecture.");
    expect(result.review.state).toBe("reviewing");
    await waitForReviewEvent(events, "reviewed");
    expect(events.at(-1)).toMatchObject({
      reviewId: result.review.reviewId,
      status: {
        state: "reviewed",
        agentId: agent.id,
        runId: expect.stringMatching(/^run-/)
      },
      architectureMap: { source: "agent" }
    });
    expect((await readArchitectureMap(root))?.source).toBe("agent");
    expect((await listRunSummaries(root))[0].artifactAdoption).toMatchObject({
      status: "applied",
      message: "Run completed and applied to module graph."
    });
  });

  it("marks completed artifact runs stale when the scan fingerprint changed", async () => {
    const root = await createFixtureFiles();
    await mkdir(join(root, FLOWWEAVE_DIR), { recursive: true });
    await writeFile(
      join(root, FLOWWEAVE_DIR, "project.json"),
      JSON.stringify({ scanFingerprint: "scan-new" }),
      "utf8"
    );

    const adoption = await adoptArtifactRun(
      root,
      {
        id: "run-stale",
        toolId: "codex-desktop",
        status: "completed",
        projectPath: root,
        startedAt: "2026-06-26T00:00:00.000Z",
        completedAt: "2026-06-26T00:01:00.000Z",
        events: [],
        executionMode: "plan",
        purpose: "artifact-analysis",
        artifactTarget: "architecture-map",
        scanFingerprint: "scan-old"
      },
      validArchitectureJson(),
      "auto"
    );

    expect(adoption).toMatchObject({
      status: "stale",
      message: "Run completed but not applied because the project scan changed."
    });
    expect(await readArchitectureMap(root)).toBeUndefined();
  });

  it("rejects a previous review identically for automatic and manual adoption", async () => {
    const root = await createFixtureFiles();
    const project = await scanProject(root);
    const scanFingerprint = project.scanFingerprint ?? "";
    await writeFile(
      join(root, FLOWWEAVE_DIR, "project.json"),
      JSON.stringify({ scanFingerprint }),
      "utf8"
    );
    const { index } = await buildSemanticIndex(project);
    const inputFingerprint = buildArchitectureInputFingerprint(scanFingerprint, index);
    const local = {
      ...architectureFixtureMap("local"),
      version: 2 as const,
      rootPath: root,
      metadata: {
        source: "local" as const,
        generatedAt: "2026-06-25T00:00:00.000Z",
        scanFingerprint,
        inputFingerprint,
        fileCoverage: 1,
        evidenceCoverage: 1
      }
    };
    await writeFile(join(root, FLOWWEAVE_DIR, "architecture-local.json"), JSON.stringify(local), "utf8");
    await writeArchitectureReviewStatus(root, {
      state: "reviewing",
      projectId: "project-1",
      artifactTarget: "architecture-map",
      reviewId: "review-current",
      scanFingerprint,
      inputFingerprint,
      agentId: "mock",
      startedAt: "2026-06-25T00:00:00.000Z"
    });
    const oldRun = {
      id: "run-old",
      projectId: "project-1",
      toolId: "mock" as const,
      status: "completed" as const,
      projectPath: root,
      startedAt: "2026-06-25T00:00:00.000Z",
      completedAt: "2026-06-25T00:01:00.000Z",
      events: [],
      executionMode: "plan" as const,
      purpose: "artifact-analysis" as const,
      artifactTarget: "architecture-map" as const,
      scanFingerprint,
      inputFingerprint,
      reviewId: "review-old"
    };

    const automatic = await adoptArtifactRun(root, oldRun, validArchitectureJson(), "auto");
    const manual = await adoptArtifactRun(root, oldRun, validArchitectureJson(), "manual");

    expect(automatic).toMatchObject({ status: "stale" });
    expect(manual).toEqual(automatic);
    expect(await readArchitectureMap(root)).toBeUndefined();
  });

  it("retries invalid Agent output once and publishes a review failure", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "flowweave-architecture-invalid-"));
    const root = await createFixtureFiles();
    const scriptPath = join(configRoot, "invalid-review-agent.mjs");
    configureAgentRegistry(configRoot);
    await writeFile(
      scriptPath,
      [
        "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
        "import { dirname } from 'node:path';",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', async () => {",
        "  const requestPath = input.match(/Read the request JSON at: (.+)/)?.[1];",
        "  if (!requestPath) throw new Error('Missing Agent Inbox request path.');",
        "  const request = JSON.parse(await readFile(requestPath, 'utf8'));",
        "  await mkdir(dirname(request.responsePath), { recursive: true });",
        "  await writeFile(request.responsePath, JSON.stringify({",
        "    protocolVersion: 2,",
        "    runId: request.runId,",
        "    projectId: request.projectId,",
        "    status: 'completed',",
        "    summary: 'Invalid architecture.',",
        "    content: 'invalid architecture output',",
        "    completedAt: new Date().toISOString()",
        "  }, null, 2), 'utf8');",
        "});"
      ].join("\n"),
      "utf8"
    );
    const agent = await saveCustomAgent({
      name: "Invalid Architecture Agent",
      command: process.execPath,
      args: [scriptPath],
      planArgs: [scriptPath],
      capabilities: ["artifact-analysis"]
    });
    const projectId = await registerProject(root);
    const events: import("../../src/types").ArchitectureReviewEvent[] = [];

    const result = await analyzeArchitecture(projectFixture(root), agent.id, {
      projectId,
      onArchitectureReview: (event) => events.push(event)
    });

    expect(result.outcome).toBe("generated");
    await waitForReviewEvent(events, "review-failed");
    expect(events.at(-1)?.status).toMatchObject({
      state: "review-failed",
      error: {
        code: "invalid-output",
        message: expect.stringContaining("after one repair attempt")
      }
    });
    expect(await listRunSummaries(root)).toHaveLength(2);
    expect((await readArchitectureMap(root))?.source).toBe("local");
  });

  it("keeps the new local baseline active when the background review fails", async () => {
    const originalPath = process.env.PATH;
    const binRoot = await mkdtemp(join(tmpdir(), "flowweave-claude-failure-"));
    const root = await createFixtureFiles();
    const trusted = await analyzeArchitecture(projectFixture(root), "mock");
    if (trusted.outcome !== "generated") throw new Error("Expected trusted architecture.");
    await createNodeCliFixture(binRoot, "claude", [
      "if (process.argv.includes('--version')) { console.log('claude-test 1.0'); process.exit(0); }",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  console.log('API Error: Unable to connect to API (ConnectionRefused)');",
      "  process.exit(1);",
      "});"
    ].join("\n"), process.platform);
    process.env.PATH = `${binRoot}${delimiter}${originalPath ?? ""}`;
    try {
      const result = await analyzeArchitecture(projectFixture(root), "claude-code");
      const stored = await readArchitectureMap(root);

      expect(result.outcome).toBe("generated");
      if (result.outcome !== "generated") throw new Error("Expected local architecture.");
      expect(result.architectureMap.source).toBe("local");
      expect(result.architectureMap.metadata).toMatchObject({
        source: "local",
        scanFingerprint: "scan-test",
        inputFingerprint: expect.any(String)
      });
      expect(result.warning).toBeUndefined();
      expect(stored?.source).toBe("local");
      expect(stored?.metadata?.inputFingerprint).toBe(result.architectureMap.metadata?.inputFingerprint);
      const baseline = JSON.parse(await readFile(join(root, FLOWWEAVE_DIR, "architecture-local.json"), "utf8")) as import("../../src/types").ArchitectureMap;
      expect(baseline.metadata?.inputFingerprint).toBe(result.architectureMap.metadata?.inputFingerprint);
    } finally {
      process.env.PATH = originalPath;
    }
  });

});

async function waitForReviewEvent(
  events: import("../../src/types").ArchitectureReviewEvent[],
  state: import("../../src/types").ArchitectureReviewState
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!events.some((event) => event.status.state === state)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for architecture review state ${state}: ${JSON.stringify(events)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForArchitectureSource(root: string, source: "agent" | "local"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while ((await readArchitectureMap(root))?.source !== source) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for architecture source ${source}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createFixtureFiles() {
  const root = await mkdtemp(join(tmpdir(), "flowweave-architecture-"));
  await mkdir(join(root, "src/api"), { recursive: true });
  await mkdir(join(root, "src/service"), { recursive: true });
  await writeFile(join(root, "src/api/user.controller.ts"), 'import { UserService } from "../service/user.service";\nexport function loadUser() { return fetch("/users"); }\n', "utf8");
  await writeFile(join(root, "src/service/user.service.ts"), "export class UserService { load() { return true; } }\n", "utf8");
  await mkdir(join(root, FLOWWEAVE_DIR), { recursive: true });
  await writeFile(join(root, FLOWWEAVE_DIR, "project.json"), JSON.stringify({ scanFingerprint: "scan-test" }), "utf8");
  return root;
}

function projectFixture(rootPath: string): CodeflowProject {
  return {
    version: 1,
    projectName: "architecture-fixture",
    rootPath,
    generatedAt: "2026-05-30T00:00:00.000Z",
    scanFingerprint: "scan-test",
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

function architectureFixtureMap(source: "agent" | "local"): import("../../src/types").ArchitectureMap {
  const modules = [
    {
      id: "user-api",
      title: "User API",
      category: "api-boundary" as const,
      nodeType: "api" as const,
      role: "Receives user requests.",
      description: "HTTP boundary.",
      files: ["src/api/user.controller.ts"],
      fileRoles: [],
      symbols: [],
      evidence: [{ filePath: "src/api/user.controller.ts", detail: "handler" }],
      risk: "unknown" as const
    },
    {
      id: "user-service",
      title: "User Service",
      category: "domain-service" as const,
      nodeType: "service" as const,
      role: "Coordinates user logic.",
      description: "Domain service.",
      files: ["src/service/user.service.ts"],
      fileRoles: [],
      symbols: [],
      evidence: [{ filePath: "src/service/user.service.ts", detail: "service" }],
      risk: "unknown" as const
    }
  ];
  return {
    version: 1,
    projectName: "architecture-fixture",
    rootPath: "/tmp/architecture-fixture",
    generatedAt: "2026-08-14T00:00:00.000Z",
    source,
    modules,
    relationships: [{
      id: "user-api-user-service-calls",
      source: "user-api",
      target: "user-service",
      relation: "calls",
      description: "API calls service.",
      evidence: [{ filePath: "src/api/user.controller.ts", detail: "call" }]
    }],
    files: [],
    symbols: []
  };
}

function validArchitectureJson() {
  return JSON.stringify({
    architectureStyle: "layered service",
    modules: [
      {
        id: "user-api",
        title: "User API",
        category: "api-boundary",
        role: "Receives user requests.",
        description: "Reviewed HTTP boundary.",
        files: ["src/api/user.controller.ts"],
        fileRoles: [{ path: "src/api/user.controller.ts", role: "Routes requests." }],
        symbols: [{ name: "loadUser", kind: "function", filePath: "src/api/user.controller.ts", role: "handler" }],
        evidence: [{ filePath: "src/api/user.controller.ts", symbol: "loadUser", detail: "exports handler" }]
      },
      {
        id: "user-service",
        title: "User Service",
        category: "domain-service",
        role: "Coordinates user logic.",
        description: "Reviewed domain service.",
        files: ["src/service/user.service.ts"],
        fileRoles: [{ path: "src/service/user.service.ts", role: "Business service." }],
        symbols: [{ name: "UserService", kind: "class", filePath: "src/service/user.service.ts", role: "service" }],
        evidence: [{ filePath: "src/service/user.service.ts", symbol: "UserService", detail: "class declaration" }]
      }
    ],
    relationships: [{
      source: "user-api",
      target: "user-service",
      relation: "calls",
      description: "API calls service.",
      evidence: [{ filePath: "src/api/user.controller.ts", detail: "imports service" }]
    }]
  });
}

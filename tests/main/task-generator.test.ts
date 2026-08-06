import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { graphEdges, graphNodes } from "../../src/data";
import {
  createCanvasArtifact,
  createTaskArtifact,
  createTaskMarkdown,
  inferGraphFromProject
} from "../../src/main/services/task-generator.service";
import type { CodeflowProject } from "../../src/main/storage/schemas";

describe("task-generator.service", () => {
  it("creates a canvas artifact from FlowWeave modules", () => {
    const canvas = createCanvasArtifact("/tmp/project", graphNodes, graphEdges, "scan-1");

    expect(canvas.version).toBe(4);
    expect(canvas.artifactState).toBe("current");
    expect(canvas.generatorVersion).toBe("1.0.0");
    expect(canvas.inputFingerprint).toBe("scan-1");
    expect(canvas.layout?.activeMode).toBe("manual");
    expect(canvas.nodes).toHaveLength(graphNodes.length);
    expect(canvas.edges.some((edge) => edge.source === "user-api" && edge.target === "tests")).toBe(true);
  });

  it("creates task markdown with module guidance, relations, and acceptance criteria", () => {
    const task = createTaskArtifact(graphNodes, graphEdges, "scan-1");
    const markdown = createTaskMarkdown(task);

    expect(task.targetTools).toEqual([
      "claude-code",
      "claude-desktop",
      "codex-local",
      "codex-desktop",
      "gemini-cli",
      "cursor"
    ]);
    expect(task.version).toBe(2);
    expect(task.generatorVersion).toBe("1.0.0");
    expect(task.inputFingerprint).toBe("scan-1");
    expect(task.artifactState).toBe("current");
    expect(task.modules.every((module) => module.kind)).toBe(true);
    expect(task.relations.some((relation) => relation.relation === "reads_writes")).toBe(true);
    expect(markdown).toContain("### User API");
    expect(markdown).toContain("apps/api/src/user/user.controller.ts");
    expect(markdown).toContain("## Module Relations");
    expect(markdown).toContain("## Acceptance Criteria");
  });

  it("infers backend module nodes and fallback edges from a scanned project", async () => {
    const graph = await inferGraphFromProject(createProjectFixture("/tmp/fixture-api"));

    expect(graph.nodes.map((node) => node.id)).toContain("auth");
    expect(graph.nodes.map((node) => node.id)).toContain("database");
    expect(graph.edges.some((edge) => edge.relation === "reads_writes")).toBe(true);
  });

  it("creates depends_on edges from real relative imports", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "flowweave-imports-"));
    await mkdir(join(rootPath, "src/api"), { recursive: true });
    await mkdir(join(rootPath, "src/auth"), { recursive: true });
    await writeFile(join(rootPath, "src/api/index.ts"), 'import { auth } from "../auth";\n', "utf8");
    await writeFile(join(rootPath, "src/auth/index.ts"), "export const auth = true;\n", "utf8");

    const graph = await inferGraphFromProject(createImportProjectFixture(rootPath));

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: "api",
        target: "auth",
        relation: "depends_on"
      })
    );
  });
});

function createProjectFixture(rootPath: string): CodeflowProject {
  return {
    version: 1,
    projectName: "fixture-api",
    rootPath,
    generatedAt: "2026-05-18T00:00:00.000Z",
    git: { isRepo: true },
    summary: { totalFiles: 4, totalFolders: 4, languages: { TypeScript: 3, Prisma: 1 } },
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
                id: "src/auth/auth.service.ts",
                name: "auth.service.ts",
                path: "src/auth/auth.service.ts",
                type: "file",
                depth: 2,
                language: "TypeScript"
              }
            ]
          },
          {
            id: "src/database",
            name: "database",
            path: "src/database",
            type: "folder",
            depth: 1,
            children: [
              {
                id: "src/database/user.repository.ts",
                name: "user.repository.ts",
                path: "src/database/user.repository.ts",
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

function createImportProjectFixture(rootPath: string): CodeflowProject {
  return {
    ...createProjectFixture(rootPath),
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
            children: [
              {
                id: "src/api/index.ts",
                name: "index.ts",
                path: "src/api/index.ts",
                type: "file",
                depth: 2,
                language: "TypeScript"
              }
            ]
          },
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

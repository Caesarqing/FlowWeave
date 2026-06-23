import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../src/types";
import {
  buildAgentPrompt,
  buildLegacyCanvasTaskJson,
  buildModificationContext,
  buildModificationContextJson,
  buildModificationGuidanceMarkdown
} from "../../src/utils/export-artifacts";
import { deleteModuleFromCanvasGraph, updateGraphEdge, updateModuleInCanvasGraph } from "../../src/utils/canvas-graph-crud";
import { buildModuleFileTree } from "../../src/utils/module-file-tree";
import { relationOptions, relationStyle } from "../../src/utils/relation-styles";

describe("canvas graph CRUD helpers", () => {
  it("deletes a module and its related edges", () => {
    const result = deleteModuleFromCanvasGraph(modulesFixture().filter((module) => module.id !== "docs"), edgesFixture(), "service");

    expect(result.modules.map((module) => module.id)).toEqual(["api", "repo"]);
    expect(result.edges).toEqual([]);
  });

  it("invalidates assessments for remaining neighbor modules when deleting a module", () => {
    const result = deleteModuleFromCanvasGraph(modulesFixture(), [
      ...edgesFixture(),
      { id: "api-docs", source: "api", target: "docs", relation: "depends_on" }
    ], "service");

    expect(result.modules.find((module) => module.id === "api")?.assessment?.confidence.level).toBe("unknown");
    expect(result.modules.find((module) => module.id === "repo")?.assessment?.confidence.level).toBe("unknown");
    expect(result.modules.find((module) => module.id === "docs")?.assessment?.confidence.level).toBe("high");
    expect(result.modules.find((module) => module.id === "api")?.status).toBe("needs-review");
    expect(result.edges).toEqual([{ id: "api-docs", source: "api", target: "docs", relation: "depends_on" }]);
  });

  it("updates module metadata and marks it for review", () => {
    const [updated] = updateModuleInCanvasGraph(modulesFixture(), "api", {
      title: "Public API",
      description: "Updated boundary",
      files: ["src/api/public.ts"]
    });

    expect(updated).toMatchObject({
      id: "api",
      title: "Public API",
      description: "Updated boundary",
      files: ["src/api/public.ts"],
      status: "needs-review"
    });
    expect(updated.assessment?.confidence.level).toBe("unknown");
    expect(updated.risk).toBe("unknown");
  });

  it("updates edge endpoints, relation, and guidance while rejecting self loops", () => {
    const [updated] = updateGraphEdge(edgesFixture(), "api-service", {
      source: "repo",
      target: "api",
      relation: "tests",
      guidanceNote: "Repository tests API contract."
    });
    const [unchanged] = updateGraphEdge([updated], "api-service", { source: "api", target: "api" });

    expect(updated).toMatchObject({
      id: "api-service",
      source: "repo",
      target: "api",
      relation: "tests",
      guidanceNote: "Repository tests API contract."
    });
    expect(unchanged).toEqual(updated);
  });
});

describe("canvas relation metadata", () => {
  it("has stable color styling for every relation", () => {
    for (const option of relationOptions) {
      expect(relationStyle[option].color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("module file tree", () => {
  it("builds a stable tree and attaches file descriptions to leaves", () => {
    const tree = buildModuleFileTree(["src/api/user.controller.ts", "src/api/user.service.ts", "tests/user.spec.ts"], [
      { path: "src/api", role: "Groups API files" },
      { path: "src/api/user.controller.ts", role: "HTTP entrypoint" },
      { path: "tests/user.spec.ts", role: "Integration coverage" }
    ]);

    expect(tree.map((node) => node.name)).toEqual(["src", "tests"]);
    expect(tree[0].children[0]).toMatchObject({
      name: "api",
      path: "src/api",
      type: "folder",
      role: "Groups API files"
    });
    expect(tree[0].children[0].children[0]).toMatchObject({
      name: "user.controller.ts",
      path: "src/api/user.controller.ts",
      type: "file",
      role: "HTTP entrypoint"
    });
    expect(tree[1].children[0]).toMatchObject({
      name: "user.spec.ts",
      role: "Integration coverage"
    });
  });

  it("aggregates folder descriptions from child files when a folder role is absent", () => {
    const tree = buildModuleFileTree(["src/api/user.controller.ts", "src/api/user.service.ts"], [
      { path: "src/api/user.controller.ts", role: "HTTP entrypoint." },
      { path: "src/api/user.service.ts", role: "Coordinates user workflow." }
    ]);

    expect(tree[0].children[0]).toMatchObject({
      name: "api",
      type: "folder",
      role: "HTTP entrypoint, plus 1 related responsibilities."
    });
  });
});

describe("modification guidance docs", () => {
  it("serializes canvas guidance, relations, risk overrides, and prompt kind", () => {
    const [api, service, repo] = modulesFixture();
    const context = buildModificationContext({
      projectLabel: "Fixture",
      projectPath: "/tmp/project",
      scanFingerprint: "scan-test",
      nodes: [
        {
          ...api,
          guidanceDraft: "Keep controller edits isolated.",
          assessment: {
            ...api.assessment!,
            risk: {
              ...api.assessment!.risk,
              override: {
                level: "high",
                reason: "Public API contract is changing.",
                createdAt: "2026-06-23T00:00:00.000Z"
              }
            }
          }
        },
        service,
        repo
      ],
      edges: [
        {
          id: "api-service",
          source: "api",
          target: "service",
          relation: "calls",
          guidanceNote: "Service contract may need updates."
        }
      ],
      selectedNodeId: "api",
      generatedAt: "2026-06-23T00:00:00.000Z"
    });

    const markdown = buildModificationGuidanceMarkdown(context);
    const contextJson = JSON.parse(buildModificationContextJson(context));
    const legacyTask = JSON.parse(buildLegacyCanvasTaskJson(context));
    const prompt = buildAgentPrompt(context, "canvas-implementation-plan", "plan");

    expect(markdown).toContain("# FlowWeave Modification Guidance");
    expect(markdown).toContain("Keep controller edits isolated.");
    expect(markdown).toContain("Manual override: high (Public API contract is changing.)");
    expect(markdown).toContain("api -> service: calls");
    expect(markdown).toContain("Guidance: Service contract may need updates.");
    expect(contextJson.canvas.selectedModuleId).toBe("api");
    expect(contextJson.userInstructions.canvas[0].guidance).toBe("Keep controller edits isolated.");
    expect(legacyTask.modules[0].assessment.risk.override.reason).toBe("Public API contract is changing.");
    expect(prompt).toContain("Prompt kind: canvas-implementation-plan");
    expect(prompt).toContain("Context JSON:");
  });
});

function modulesFixture(): GraphNode[] {
  return [
    graphNode("api", "API"),
    graphNode("service", "Service"),
    graphNode("repo", "Repository"),
    graphNode("docs", "Docs")
  ];
}

function graphNode(id: string, title: string): GraphNode {
  return {
    id,
    title,
    subtitle: title,
    kind: "module",
    nodeType: "module",
    risk: "normal",
    assessment: {
      version: 1,
      generatorVersion: "test",
      confidence: { score: 95, level: "high", factors: [] },
      risk: { systemScore: 10, systemLevel: "low", effectiveLevel: "low", factors: [] },
      fingerprint: "scan-test",
      assessedAt: "2026-06-15T00:00:00.000Z"
    },
    description: `${title} module`,
    files: [`src/${id}.ts`],
    guidanceDraft: "Review before editing.",
    status: "mapped",
    x: 0,
    y: 0
  };
}

function edgesFixture(): GraphEdge[] {
  return [
    { id: "api-service", source: "api", target: "service", relation: "calls" },
    { id: "service-repo", source: "service", target: "repo", relation: "reads_writes" }
  ];
}

import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../src/types";
import { deleteModuleFromCanvasGraph, updateGraphEdge, updateModuleInCanvasGraph } from "../../src/utils/canvas-graph-crud";
import { buildModuleFileTree } from "../../src/utils/module-file-tree";
import { relationOptions, relationStyle } from "../../src/utils/relation-styles";

describe("canvas graph CRUD helpers", () => {
  it("deletes a module and its related edges", () => {
    const result = deleteModuleFromCanvasGraph(modulesFixture(), edgesFixture(), "service");

    expect(result.modules.map((module) => module.id)).toEqual(["api", "repo"]);
    expect(result.edges).toEqual([]);
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
  it("has clear Chinese names and descriptions for every relation", () => {
    for (const option of relationOptions) {
      expect(relationStyle[option].accent).not.toContain("淡蓝");
      expect(relationStyle[option].description.length).toBeGreaterThan(8);
    }
    expect(relationStyle.depends_on.accent).toBe("依赖");
  });
});

describe("module file tree", () => {
  it("builds a stable tree and attaches file descriptions to leaves", () => {
    const tree = buildModuleFileTree(["src/api/user.controller.ts", "src/api/user.service.ts", "tests/user.spec.ts"], [
      { path: "src/api/user.controller.ts", role: "HTTP entrypoint" },
      { path: "tests/user.spec.ts", role: "Integration coverage" }
    ]);

    expect(tree.map((node) => node.name)).toEqual(["src", "tests"]);
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
});

function modulesFixture(): GraphNode[] {
  return [
    graphNode("api", "API"),
    graphNode("service", "Service"),
    graphNode("repo", "Repository")
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

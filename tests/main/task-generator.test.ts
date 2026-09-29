import { describe, expect, it } from "vitest";
import { graphEdges, graphNodes } from "./graph.fixture";
import { createCanvasArtifact } from "../../src/main/services/canvas-artifact.service";
import { createTaskArtifact, createTaskMarkdown } from "../../src/main/services/task-artifact.service";

describe("canvas and task artifacts", () => {
  it("creates a v6 canvas and selects the architecture overview when runtime edges exist", () => {
    const canvas = createCanvasArtifact("/tmp/project", graphNodes, [
      { id: "user-api-tests-call", source: "user-api", target: "tests", relation: "calls" }
    ], "scan-1");

    expect(canvas.version).toBe(6);
    expect(canvas.artifactState).toBe("current");
    expect(canvas.generatorVersion).toBe("1.0.0");
    expect(canvas.inputFingerprint).toBe("scan-1");
    expect(canvas.layout?.viewMode).toBe("architecture");
    expect(canvas.layout?.activeMode).toBe("architecture");
    expect(canvas.nodes).toHaveLength(graphNodes.length);
    expect(canvas.nodes.every((node) => node.origin === "generated")).toBe(true);
  });

  it("selects Architecture for dependency-only and empty graphs", () => {
    const dependencyCanvas = createCanvasArtifact("/tmp/project", graphNodes, [
      { id: "dependency", source: graphNodes[0].id, target: graphNodes[1].id, relation: "depends_on" }
    ], "scan-1");
    const emptyCanvas = createCanvasArtifact("/tmp/project", graphNodes, [], "scan-1");

    expect(dependencyCanvas.layout?.viewMode).toBe("architecture");
    expect(emptyCanvas.layout?.viewMode).toBe("architecture");
    expect(emptyCanvas.edges).toEqual([]);
  });

  it("creates task markdown from exactly the supplied graph edges", () => {
    const task = createTaskArtifact(graphNodes, [], "scan-1");
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
    expect(task.relations).toEqual([]);
    expect(markdown).toContain("### User API");
    expect(markdown).toContain("apps/api/src/user/user.controller.ts");
    expect(markdown).toContain("## Module Relations");
    expect(markdown).toContain("## Acceptance Criteria");
  });
});

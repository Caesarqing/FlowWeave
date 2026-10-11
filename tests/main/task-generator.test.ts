import { describe, expect, it } from "vitest";
import { graphEdges, graphNodes } from "./graph.fixture";
import { createCanvasArtifact } from "../../src/main/services/canvas-artifact.service";
import { createTaskArtifact, createTaskMarkdown } from "../../src/main/services/task-artifact.service";

describe("canvas and task artifacts", () => {
  it("creates a v6 canvas and selects the functional view when runtime edges exist", async () => {
    const modules = [graphNodes[0], { ...graphNodes[1], id: "service", nodeType: "service" as const }];
    const canvas = await createCanvasArtifact("/tmp/project", modules, [
      { id: "user-api-service-call", source: "user-api", target: "service", relation: "calls", confidence: "confirmed" }
    ], "scan-1");

    expect(canvas).not.toHaveProperty("version");
    expect(canvas.artifactState).toBe("current");
    expect(canvas.generatorVersion).toBe("1.0.0");
    expect(canvas.inputFingerprint).toBe("scan-1");
    expect(canvas.layout?.viewMode).toBe("execution");
    expect(canvas.layout?.activeMode).toBe("execution");
    expect(canvas.layout?.autoConnectionHandles?.execution?.positions).toEqual(canvas.layout?.autoLayouts.execution);
    expect(canvas.layout?.autoConnectionHandles?.execution?.handles["user-api"].source.map((slot) => slot.edgeId))
      .toContain("user-api-service-call");
    expect(canvas.nodes).toHaveLength(modules.length);
    expect(canvas.nodes.every((node) => node.origin === "generated")).toBe(true);
  });

  it("selects the functional view for dependency-only and empty graphs", async () => {
    const dependencyCanvas = await createCanvasArtifact("/tmp/project", graphNodes, [
      { id: "dependency", source: graphNodes[0].id, target: graphNodes[1].id, relation: "depends_on" }
    ], "scan-1");
    const emptyCanvas = await createCanvasArtifact("/tmp/project", graphNodes, [], "scan-1");

    expect(dependencyCanvas.layout?.viewMode).toBe("execution");
    expect(emptyCanvas.layout?.viewMode).toBe("execution");
    expect(emptyCanvas.edges).toEqual([]);
  });

  it("creates task markdown from exactly the supplied graph edges", () => {
    const generation = { requestId: "generation-1", inputFingerprint: "input-1" };
    const task = createTaskArtifact(graphNodes, [], "scan-1", generation);
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
    expect(task.generation).toEqual(generation);
    expect(task.modules.every((module) => module.kind)).toBe(true);
    expect(task.relations).toEqual([]);
    expect(markdown).toContain("### User API");
    expect(markdown).toContain("apps/api/src/user/user.controller.ts");
    expect(markdown).toContain("## Module Relations");
    expect(markdown).toContain("## Acceptance Criteria");
  });
});

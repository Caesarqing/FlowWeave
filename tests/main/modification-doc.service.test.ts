import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeModificationDocs } from "../../src/main/services/modification-doc.service";
import type { CodeflowCanvas, GraphNode, SequenceDiagramBundle } from "../../src/types";

describe("modification-doc.service", () => {
  it("writes canonical markdown and json docs from canvas and sequence context", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-doc-"));
    const paths = await writeModificationDocs(projectPath, {
      canvas: canvasFixture(projectPath),
      sequence: sequenceFixture(projectPath),
      sequenceInstruction: "Split payment into authorize and capture."
    });

    const markdown = await readFile(paths.guidancePath, "utf8");
    const context = JSON.parse(await readFile(paths.contextPath, "utf8"));

    expect(paths.guidancePath).toBe(join(projectPath, ".flowweave", "docs", "modification-guidance.md"));
    expect(paths.contextPath).toBe(join(projectPath, ".flowweave", "docs", "modification-context.json"));
    expect(markdown).toContain("Keep controller edits isolated.");
    expect(markdown).toContain("Split payment into authorize and capture.");
    expect(context.canvas.modules[0].guidanceDraft).toBe("Keep controller edits isolated.");
    expect(context.sequence.revisionInstruction).toBe("Split payment into authorize and capture.");
    expect(context.sequence.diagrams.architectural.messages[0].evidence[0].filePath).toBe("src/api.ts");
  });

  it("writes canvas docs when the optional sequence artifact is unreadable", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-doc-corrupt-sequence-"));
    await mkdir(join(projectPath, ".flowweave"), { recursive: true });
    await writeFile(join(projectPath, ".flowweave", "sequence-diagrams.json"), "{invalid-json", "utf8");

    const paths = await writeModificationDocs(projectPath, {
      canvas: canvasFixture(projectPath)
    });
    const context = JSON.parse(await readFile(paths.contextPath, "utf8"));

    expect(context.canvas.modules[0].id).toBe("api");
    expect(context.sequence).toBeUndefined();
  });

  it("writes sequence docs when the optional canvas artifact is unreadable", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-doc-corrupt-canvas-"));
    await mkdir(join(projectPath, ".flowweave", "canvas"), { recursive: true });
    await writeFile(join(projectPath, ".flowweave", "canvas", "main.canvas.json"), "{invalid-json", "utf8");

    const paths = await writeModificationDocs(projectPath, {
      sequence: sequenceFixture(projectPath),
      sequenceInstruction: "Keep checkout as one diagram."
    });
    const context = JSON.parse(await readFile(paths.contextPath, "utf8"));

    expect(context.canvas.modules).toEqual([]);
    expect(context.sequence.revisionInstruction).toBe("Keep checkout as one diagram.");
  });

  it("does not mark a selected module when generated from persisted artifacts", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-doc-selection-"));
    const paths = await writeModificationDocs(projectPath, {
      canvas: canvasFixture(projectPath),
      sequence: sequenceFixture(projectPath)
    });
    const context = JSON.parse(await readFile(paths.contextPath, "utf8"));

    expect(context.canvas.selectedModuleId).toBeUndefined();
  });
});

function canvasFixture(projectPath: string): CodeflowCanvas {
  return {
    version: 3,
    id: "main",
    title: "Main Canvas",
    projectPath,
    generatedAt: "2026-06-23T00:00:00.000Z",
    scanFingerprint: "scan-test",
    artifactState: "current",
    nodes: [graphNode()],
    edges: [{ id: "api-api", source: "api", target: "api-tests", relation: "tests", guidanceNote: "Keep test coverage aligned." }]
  };
}

function graphNode(): GraphNode {
  return {
    id: "api",
    title: "API",
    subtitle: "API",
    kind: "module",
    nodeType: "api",
    risk: "medium",
    description: "API boundary",
    files: ["src/api.ts"],
    guidanceDraft: "Keep controller edits isolated.",
    status: "needs-review",
    x: 0,
    y: 0
  };
}

function sequenceFixture(projectPath: string): SequenceDiagramBundle {
  return {
    version: 2,
    projectName: "Fixture",
    rootPath: projectPath,
    generatedAt: "2026-06-23T00:00:00.000Z",
    source: "agent",
    architectural: {
      id: "architectural",
      title: "Architectural Flow",
      kind: "architectural",
      summary: "API flow",
      participants: [
        { id: "client", title: "Client", kind: "actor", description: "Caller" },
        { id: "api", title: "API", kind: "service", description: "API", filePath: "src/api.ts", symbol: "handler" }
      ],
      messages: [
        {
          id: "request",
          sequence: 1,
          from: "client",
          to: "api",
          kind: "sync",
          label: "Call API",
          evidence: [{ filePath: "src/api.ts", symbol: "handler", detail: "Handles request." }]
        }
      ],
      evidence: [{ filePath: "src/api.ts", symbol: "handler", detail: "Entry point." }]
    }
  };
}

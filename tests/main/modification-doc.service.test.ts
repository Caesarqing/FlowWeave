import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeModificationDocs } from "../../src/main/services/modification-doc.service";
import type { CodeflowCanvas, GraphNode, SequenceDiagramBundle } from "../../src/types";

describe("modification-doc.service", () => {
  it("writes canonical delta docs without repeating baseline Canvas or Sequence artifacts", async () => {
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
    expect(markdown).toContain("Split payment into authorize and capture.");
    expect(markdown).not.toContain("Keep controller edits isolated.");
    expect(context.schemaVersion).toBe(2);
    expect(context.delta.modules.added).toEqual([]);
    expect(context.delta.sequenceInstruction).toBe("Split payment into authorize and capture.");
    expect(context.artifactReferences).toContain(".flowweave/sequence-diagrams.json");
  });

  it("writes canvas docs when the optional sequence artifact is unreadable", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-doc-corrupt-sequence-"));
    await mkdir(join(projectPath, ".flowweave"), { recursive: true });
    await writeFile(join(projectPath, ".flowweave", "sequence-diagrams.json"), "{invalid-json", "utf8");

    const paths = await writeModificationDocs(projectPath, {
      canvas: canvasFixture(projectPath)
    });
    const context = JSON.parse(await readFile(paths.contextPath, "utf8"));

    expect(context.delta.modules.added).toEqual([]);
    expect(context.delta.sequenceInstruction).toBeUndefined();
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

    expect(context.delta.modules.added).toEqual([]);
    expect(context.delta.sequenceInstruction).toBe("Keep checkout as one diagram.");
  });

  it("does not mark a selected module when generated from persisted artifacts", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-doc-selection-"));
    const paths = await writeModificationDocs(projectPath, {
      canvas: canvasFixture(projectPath),
      sequence: sequenceFixture(projectPath)
    });
    const context = JSON.parse(await readFile(paths.contextPath, "utf8"));

    expect(context).not.toHaveProperty("canvas");
    expect(context).not.toHaveProperty("selectedModuleId");
  });

  it("persists a sequence instruction without invoking sequence revision", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-doc-instruction-"));
    const paths = await writeModificationDocs(projectPath, {
      canvas: canvasFixture(projectPath),
      sequence: sequenceFixture(projectPath),
      sequenceInstruction: "Keep payment as one step."
    });

    const context = JSON.parse(await readFile(paths.contextPath, "utf8"));

    expect(context.delta.sequenceInstruction).toBe("Keep payment as one step.");
    expect(context).not.toHaveProperty("sequence");
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

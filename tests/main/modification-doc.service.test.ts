import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeModificationDocs } from "../../src/main/services/modification-doc.service";
import { acknowledgeModificationChanges, readModificationDelta } from "../../src/main/services/modification-delta.service";
import type { CodeflowCanvas, GraphNode, SequenceDiagramBundle } from "../../src/types";
import { writeCanvasProtocolFixture } from "./protocol.fixture";

describe("modification-doc.service", () => {
  it("writes canonical delta docs without repeating baseline Canvas or Sequence artifacts", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-doc-"));
    const canvas = await writeCanvasProtocolFixture(projectPath, canvasFixture(projectPath));
    await acknowledgeInitialCanvas(projectPath, canvas);
    const paths = await writeModificationDocs(projectPath, {
      canvas,
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
    const canvas = await writeCanvasProtocolFixture(projectPath, canvasFixture(projectPath));
    await acknowledgeInitialCanvas(projectPath, canvas);
    await mkdir(join(projectPath, ".flowweave"), { recursive: true });
    await writeFile(join(projectPath, ".flowweave", "sequence-diagrams.json"), "{invalid-json", "utf8");

    const paths = await writeModificationDocs(projectPath, {
      canvas
    });
    const context = JSON.parse(await readFile(paths.contextPath, "utf8"));

    expect(context.delta.modules.added).toEqual([]);
    expect(context.delta.sequenceInstruction).toBeUndefined();
  });

  it("preserves an unreadable Canvas and rejects export without acknowledging it", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-doc-corrupt-canvas-"));
    const canvas = await writeCanvasProtocolFixture(projectPath, canvasFixture(projectPath));
    const userStatePath = join(projectPath, ".flowweave", "canvas", "user-state.json");
    const invalidUserState = "{invalid-json";
    await writeFile(userStatePath, invalidUserState, "utf8");
    const manifestPath = join(projectPath, ".flowweave", "generation.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifacts.canvasUserState = createHash("sha256").update(invalidUserState).digest("hex");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(writeModificationDocs(projectPath, {
      sequence: sequenceFixture(projectPath),
      sequenceInstruction: "Keep checkout as one diagram."
    })).rejects.toThrow("FlowWeave committed artifact is malformed and was preserved:");
    await expect(readFile(userStatePath, "utf8")).resolves.toBe(invalidUserState);
    await expect(readFile(join(projectPath, ".flowweave", "modification-baseline.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exports sequence instructions when the Canvas artifact does not exist", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-doc-no-canvas-"));
    const canvas = await writeCanvasProtocolFixture(projectPath, canvasFixture(projectPath));
    await acknowledgeInitialCanvas(projectPath, canvas);
    await rm(join(projectPath, ".flowweave", "canvas", "user-state.json"));
    const paths = await writeModificationDocs(projectPath, { canvas, sequence: sequenceFixture(projectPath), sequenceInstruction: "Keep checkout as one diagram." });
    const context = JSON.parse(await readFile(paths.contextPath, "utf8"));
    expect(context.delta.modules.added).toEqual([]);
    expect(context.delta.sequenceInstruction).toBe("Keep checkout as one diagram.");
  });

  it("does not mark a selected module when generated from persisted artifacts", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-doc-selection-"));
    const canvas = await writeCanvasProtocolFixture(projectPath, canvasFixture(projectPath));
    await acknowledgeInitialCanvas(projectPath, canvas);
    const paths = await writeModificationDocs(projectPath, {
      canvas,
      sequence: sequenceFixture(projectPath)
    });
    const context = JSON.parse(await readFile(paths.contextPath, "utf8"));

    expect(context).not.toHaveProperty("canvas");
    expect(context).not.toHaveProperty("selectedModuleId");
  });

  it("persists a sequence instruction without invoking sequence revision", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-modification-doc-instruction-"));
    const canvas = await writeCanvasProtocolFixture(projectPath, canvasFixture(projectPath));
    await acknowledgeInitialCanvas(projectPath, canvas);
    const paths = await writeModificationDocs(projectPath, {
      canvas,
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

async function acknowledgeInitialCanvas(projectPath: string, canvas: CodeflowCanvas): Promise<void> {
  const current = await readModificationDelta(projectPath, "", canvas);
  await acknowledgeModificationChanges(projectPath, current.snapshot, { kind: "all" });
}

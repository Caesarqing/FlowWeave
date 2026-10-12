import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canvasPersistenceSignature, useCanvasPersistence } from "../../src/hooks/useCanvasPersistence";
import type { CodeflowCanvas } from "../../src/types";

const canvasPersistenceSource = readFileSync(
  new URL("../../src/hooks/useCanvasPersistence.ts", import.meta.url),
  "utf8"
);
const appControllerSource = readFileSync(
  new URL("../../src/hooks/useAppController.ts", import.meta.url),
  "utf8"
);

describe("canvas persistence signature", () => {
  it("does not save a read-only canvas while project analysis is loading", async () => {
    const canvas: CodeflowCanvas = {
      id: "main", title: "Canvas", projectPath: "/workspace/sample", scanFingerprint: "scan",
      generation: { requestId: "old-generation", inputFingerprint: "old-input" }, userRevision: 1,
      layout: { activeMode: "execution", manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
      nodes: [], edges: []
    };
    let flush: (() => Promise<void>) | undefined;
    function Probe() {
      const persistence = useCanvasPersistence("project", canvas.projectPath, "scan", true, "current", 1,
        canvas.userRevision!, [], [], canvas.layout!, [], canvas);
      flush = () => persistence.flushCurrentCanvas(() => { throw new Error("Read-only canvas was built for saving."); });
      return null;
    }

    renderToStaticMarkup(createElement(Probe));
    await expect(flush?.()).resolves.toBeUndefined();
  });

  it("does not treat a save receipt revision as a new user-content change", () => {
    const canvas: CodeflowCanvas = {
      id: "main",
      title: "Canvas",
      projectPath: "/workspace/sample",
      generatedAt: "2026-10-05T00:00:00.000Z",
      generation: { requestId: "generation-1", inputFingerprint: "input-1" },
      userRevision: 4,
      layout: { activeMode: "execution", manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
      nodes: [],
      edges: []
    };
    const signature = canvasPersistenceSignature(canvas);

    expect(canvasPersistenceSignature({ ...canvas, userRevision: 5 })).toBe(signature);
    expect(canvasPersistenceSignature({
      ...canvas,
      layout: { ...canvas.layout!, collapsedGroups: ["area:api"] }
    })).not.toBe(signature);
  });

  it("keeps the analysis timestamp when an edited canvas is auto-saved", () => {
    const autoSaveStart = canvasPersistenceSource.indexOf("current.timeout = window.setTimeout");
    const autoSaveEnd = canvasPersistenceSource.indexOf("}, 500);", autoSaveStart);
    const autoSaveSource = canvasPersistenceSource.slice(autoSaveStart, autoSaveEnd);

    expect(autoSaveStart).toBeGreaterThan(-1);
    expect(autoSaveSource).toContain("persist(canvas, signature)");
    expect(autoSaveSource).not.toContain("new Date().toISOString()");
  });

  it("keeps the analysis timestamp across the save barrier", () => {
    const flushStart = canvasPersistenceSource.indexOf("async function flushCurrentCanvas");
    const flushEnd = canvasPersistenceSource.indexOf("return { flushCurrentCanvas }", flushStart);
    const flushSource = canvasPersistenceSource.slice(flushStart, flushEnd);

    expect(flushStart).toBeGreaterThan(-1);
    expect(flushSource).toContain("const value = { ...buildCanvas(), generatedAt: metadata.generatedAt }");
    expect(flushSource).toContain("await persist(value, valueSignature)");
  });

  it("builds the save-barrier canvas with the current analysis timestamp", () => {
    const buildStart = appControllerSource.indexOf("function buildCurrentCanvas()");
    const buildEnd = appControllerSource.indexOf("async function refreshModificationDelta()", buildStart);
    const buildSource = appControllerSource.slice(buildStart, buildEnd);

    expect(buildStart).toBeGreaterThan(-1);
    expect(buildSource).toContain("generatedAt: state.generatedAt");
    expect(buildSource).not.toContain("new Date().toISOString()");
  });
});

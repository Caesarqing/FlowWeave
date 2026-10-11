import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCanvasSaveCoordinator } from "../../src/hooks/canvas-save-coordinator";
import { readProjectProtocolCanvas, saveProjectProtocolCanvas } from "../../src/main/storage/flowweave-store";
import type { CodeflowCanvas } from "../../src/types";
import { writeCanvasProtocolFixture } from "./protocol.fixture";

describe("canvas save coordinator", () => {
  it("waits for an in-flight save and reports its failure before a project switch", async () => {
    let rejectSave: ((error: Error) => void) | undefined;
    const coordinator = createCanvasSaveCoordinator(async () => new Promise((_, reject) => { rejectSave = reject; }));
    const canvas = { id: "main", title: "Main", projectPath: "/project", generatedAt: "now", nodes: [], edges: [],
      generation: { requestId: "generation", inputFingerprint: "input" }, userRevision: 0 };
    const save = coordinator.save("project", canvas);
    const flush = coordinator.flush("project", "generation");
    await Promise.resolve();
    rejectSave?.(new Error("disk full"));

    await expect(save).rejects.toThrow("disk full");
    await expect(flush).rejects.toThrow("disk full");
  });
  it("saves later edits with the revision returned by an in-flight save", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-save-queue-"));
    const initial: CodeflowCanvas = {
      id: "main", title: "Main", projectPath: root, generatedAt: "2026-10-03T00:00:00.000Z",
      scanFingerprint: "scan", nodes: [{ id: "api", title: "API", subtitle: "", kind: "module", nodeType: "module",
        risk: "unknown", description: "", files: ["src/api.ts"], guidanceDraft: "", status: "mapped", x: 0, y: 0, origin: "generated" }], edges: []
    };
    const canvas = await writeCanvasProtocolFixture(root, initial);
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const coordinator = createCanvasSaveCoordinator(async (_projectId, value) => {
      calls += 1;
      if (calls === 1) await firstGate;
      const saved = await saveProjectProtocolCanvas(root, value);
      if (!saved) throw new Error("Expected a protocol save");
      return saved;
    });
    const first = coordinator.save("project", { ...canvas, nodes: [{ ...canvas.nodes[0], title: "First" }] });
    const second = coordinator.save("project", { ...canvas, nodes: [{ ...canvas.nodes[0], title: "Second" }] });
    releaseFirst?.();
    await Promise.all([first, second]);

    expect((await readProjectProtocolCanvas(root))?.nodes[0].title).toBe("Second");
    expect((await readProjectProtocolCanvas(root))?.userRevision).toBe(2);
  });

  it("keeps the save barrier pending until the newest queued save completes", async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    let markSecondStarted: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    let calls = 0;
    const coordinator = createCanvasSaveCoordinator(async (_projectId, canvas) => {
      calls += 1;
      if (calls === 1) {
        markFirstStarted?.();
        await firstGate;
      } else {
        markSecondStarted?.();
        await secondGate;
      }
      return { path: "/project/.flowweave/canvas/user-state.json", generationId: "generation", userRevision: calls };
    });
    const canvas: CodeflowCanvas = { id: "main", title: "Main", projectPath: "/project", generatedAt: "now", nodes: [], edges: [],
      generation: { requestId: "generation", inputFingerprint: "input" }, userRevision: 0 };
    const first = coordinator.save("project", canvas);
    await firstStarted;
    const second = coordinator.save("project", { ...canvas, title: "Latest" });
    const barrier = coordinator.flush("project", "generation");
    let barrierSettled = false;
    void barrier.then(() => { barrierSettled = true; }, () => { barrierSettled = true; });

    releaseFirst?.();
    await first;
    await secondStarted;
    await Promise.resolve();
    expect(barrierSettled).toBe(false);

    releaseSecond?.();
    await Promise.all([second, barrier]);
    expect(barrierSettled).toBe(true);
    expect(calls).toBe(2);
  });
});

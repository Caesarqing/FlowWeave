import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_CHANNELS } from "../../src/common/ipc-channels";
import type { CodeflowCanvas } from "../../src/types";
import { graphNodes } from "./graph.fixture";

const registeredHandlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      registeredHandlers.set(channel, handler);
    }
  },
  dialog: {},
  shell: {}
}));

import { registerProjectIpc } from "../../src/main/ipc/project.ipc";
import { configureProjectRegistry, registerProject } from "../../src/main/services/project-registry.service";

afterEach(() => registeredHandlers.clear());

describe("project IPC document writes", () => {
  it("preserves relationship diagnostics through Canvas save and a fresh artifact read", async () => {
    const project = await mkdtemp(join(tmpdir(), "flowweave-canvas-diagnostics-project-"));
    const userData = await mkdtemp(join(tmpdir(), "flowweave-canvas-diagnostics-registry-"));
    await mkdir(join(project, ".flowweave"), { recursive: true });
    await writeFile(join(project, ".flowweave", "project.json"), JSON.stringify({ scanFingerprint: "scan-1" }), "utf8");
    await configureProjectRegistry(userData);
    const projectId = await registerProject(project);
    registerProjectIpc();
    const save = registeredHandlers.get(PROJECT_CHANNELS.saveCanvas);
    const read = registeredHandlers.get(PROJECT_CHANNELS.readCanvas);
    if (!save || !read) throw new Error("Canvas IPC handlers were not registered.");
    const canvas: CodeflowCanvas = {
      version: 6, id: "main", title: "Main Canvas", projectPath: project, generatedAt: "2026-09-28T00:00:00.000Z", scanFingerprint: "scan-1", artifactState: "current",
      nodes: [{ ...graphNodes[0], origin: "generated",
        relationSummary: { dependencies: 1, internalRelations: 2, unresolvedRelations: 1, externalRelations: 0 },
        relationDiagnostics: [{ code: "dynamic-call", severity: "warning", message: "Receiver cannot be resolved.", filePath: "src/orders.ts", relationId: "call-1", range: { start: { line: 8, column: 12 }, end: { line: 8, column: 20 } }, candidates: ["src/worker.ts"] }]
      }], edges: []
    };
    await save({}, projectId, canvas);
    const persisted = JSON.parse(await readFile(join(project, ".flowweave", "canvas", "main.canvas.json"), "utf8")) as CodeflowCanvas;
    expect(persisted.nodes).toEqual(canvas.nodes);
    const reloaded = await read({}, projectId) as { mode: "editable"; canvas: CodeflowCanvas };
    expect(reloaded.mode).toBe("editable");
    expect(reloaded.canvas.nodes).toEqual(canvas.nodes);
    expect(reloaded).not.toHaveProperty("quality");
  });

  it("rejects a linked document target without changing its external destination", async () => {
    const project = await mkdtemp(join(tmpdir(), "flowweave-doc-write-project-"));
    const userData = await mkdtemp(join(tmpdir(), "flowweave-doc-write-registry-"));
    const outside = await mkdtemp(join(tmpdir(), "flowweave-doc-write-outside-"));
    const externalFile = join(outside, "keep.md");
    await mkdir(join(project, ".flowweave", "docs"), { recursive: true });
    await writeFile(externalFile, "preserve me", "utf8");
    await symlink(externalFile, join(project, ".flowweave", "docs", "task-spec.md"));
    await configureProjectRegistry(userData);
    const projectId = await registerProject(project);
    registerProjectIpc();
    const handler = registeredHandlers.get(PROJECT_CHANNELS.saveDoc);
    if (!handler) throw new Error("Document save IPC handler was not registered.");

    await expect(handler({}, projectId, "task-spec", "overwrite")).rejects.toThrow("symbolic link");
    await expect(readFile(externalFile, "utf8")).resolves.toBe("preserve me");
  });
});

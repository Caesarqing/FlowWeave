import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_CHANNELS } from "../../src/common/ipc-channels";
import type { ArchitectureMap, CodeflowCanvas, CodeflowProject } from "../../src/types";
import { graphNodes } from "./graph.fixture";
import { readProjectProtocolCanvas, readProjectProtocolOverview } from "../../src/main/storage/flowweave-store";
import { writeArchitectureProtocolFixture } from "./protocol.fixture";

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
    const generatedAt = "2026-09-28T00:00:00.000Z";
    const projectArtifact: CodeflowProject = {
      version: 2, projectName: "Fixture", rootPath: project, generatedAt,
      git: { isRepo: false }, summary: { totalFiles: 1, totalFolders: 1, languages: { TypeScript: 1 } },
      files: [], scanFingerprint: "scan-1"
    };
    const sourceCanvas: CodeflowCanvas = {
      id: "main", title: "Main Canvas", projectPath: project, generatedAt,
      scanFingerprint: "scan-1", artifactState: "current",
      nodes: [{ ...graphNodes[0], origin: "generated" }], edges: []
    };
    const architecture: ArchitectureMap = {
      version: 3, projectName: "Fixture", rootPath: project, generatedAt, source: "local",
      modules: [], relationships: [],
      relationDiagnostics: [{ kind: "call", reason: "ambiguous-target", count: 1, relationIds: ["call-1"] }],
      metadata: { source: "local", scanFingerprint: "scan-1", inputFingerprint: "scan-1" }
    };
    const { canvas } = await writeArchitectureProtocolFixture(project, projectArtifact, sourceCanvas, architecture);
    await configureProjectRegistry(userData);
    const projectId = await registerProject(project);
    registerProjectIpc();
    const save = registeredHandlers.get(PROJECT_CHANNELS.saveCanvas);
    const read = registeredHandlers.get(PROJECT_CHANNELS.readCanvas);
    if (!save || !read) throw new Error("Canvas IPC handlers were not registered.");
    await save({}, projectId, canvas);
    const persisted = await readProjectProtocolCanvas(project);
    expect(persisted?.nodes[0]).toMatchObject({ id: graphNodes[0].id, title: graphNodes[0].title });
    expect(await readProjectProtocolOverview(project)).toMatchObject({
      relationDiagnostics: [{ kind: "call", reason: "ambiguous-target", count: 1, relationIds: ["call-1"] }]
    });
    const reloaded = await read({}, projectId) as { mode: "editable"; canvas: CodeflowCanvas };
    expect(reloaded.mode).toBe("editable");
    expect(reloaded.canvas.nodes[0]).toMatchObject({ id: graphNodes[0].id, title: graphNodes[0].title });
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

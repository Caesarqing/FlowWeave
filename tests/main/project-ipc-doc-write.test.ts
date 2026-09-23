import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_CHANNELS } from "../../src/common/ipc-channels";

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

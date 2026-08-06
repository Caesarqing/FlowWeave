import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  configureProjectRegistry,
  listRegisteredProjects,
  readProjectWorkspaceSession,
  registerProject,
  resetProjectRegistryForTests,
  resolveProjectFile,
  resolveProjectPath,
  restoreRegisteredProject,
  saveProjectWorkspaceSession
} from "../../src/main/services/project-registry.service";

describe("project-registry.service", () => {
  beforeEach(() => resetProjectRegistryForTests());

  it("resolves only projects registered from an absolute directory path", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-project-registry-"));
    const projectId = await registerProject(projectPath);

    expect(resolveProjectPath(projectId)).toBe(await realpath(projectPath));
    expect(() => resolveProjectPath("project-00000000-0000-0000-0000-000000000000")).toThrow("not authorized");
  });

  it("rejects traversal, absolute paths, and symbolic links outside the project", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-project-files-"));
    const outsidePath = await mkdtemp(join(tmpdir(), "flowweave-project-outside-"));
    await writeFile(join(outsidePath, "secret.txt"), "secret", "utf8");
    await symlink(join(outsidePath, "secret.txt"), join(projectPath, "secret-link.txt"));
    const projectId = await registerProject(projectPath);

    await expect(resolveProjectFile(projectId, "../secret.txt")).rejects.toThrow("relative path");
    await expect(resolveProjectFile(projectId, join(outsidePath, "secret.txt"))).rejects.toThrow("relative path");
    await expect(resolveProjectFile(projectId, "secret-link.txt")).rejects.toThrow("escapes");
  });

  it("preserves a registered project across an application restart", async () => {
    const appDataPath = await mkdtemp(join(tmpdir(), "flowweave-project-registry-data-"));
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-project-registry-persisted-"));
    await configureProjectRegistry(appDataPath);

    const projectId = await registerProject(projectPath);

    resetProjectRegistryForTests();
    await configureProjectRegistry(appDataPath);

    await expect(restoreRegisteredProject(projectId)).resolves.toBe(await realpath(projectPath));
    await expect(listRegisteredProjects()).resolves.toEqual([
      expect.objectContaining({ id: projectId, path: await realpath(projectPath) })
    ]);
  });

  it("reuses the registered project id when the same path is opened after a restart", async () => {
    const appDataPath = await mkdtemp(join(tmpdir(), "flowweave-project-registry-reopen-data-"));
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-project-registry-reopen-project-"));
    await configureProjectRegistry(appDataPath);
    const originalProjectId = await registerProject(projectPath);

    resetProjectRegistryForTests();
    await configureProjectRegistry(appDataPath);

    await expect(registerProject(projectPath)).resolves.toBe(originalProjectId);
    await expect(listRegisteredProjects()).resolves.toEqual([
      expect.objectContaining({ id: originalProjectId, path: await realpath(projectPath) })
    ]);
  });

  it("deduplicates persisted projects with the same path and remaps workspace session references", async () => {
    const appDataPath = await mkdtemp(join(tmpdir(), "flowweave-project-registry-duplicate-path-"));
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-project-registry-duplicate-"));
    const keptProjectId = "project-00000000-0000-4000-8000-000000000002";
    const droppedProjectId = "project-00000000-0000-4000-8000-000000000001";
    await writeFile(join(appDataPath, "projects.json"), JSON.stringify({
      version: 2,
      projects: [
        {
          id: droppedProjectId,
          name: "Duplicate",
          path: projectPath,
          lastOpenedAt: "2026-07-29T00:00:00.000Z"
        },
        {
          id: keptProjectId,
          name: "Duplicate",
          path: projectPath,
          lastOpenedAt: "2026-07-29T01:00:00.000Z"
        }
      ],
      session: {
        openProjectIds: [droppedProjectId],
        activeProjectId: droppedProjectId,
        lastPageByProject: { [droppedProjectId]: "tools" },
        contextsByProject: {
          [droppedProjectId]: {
            activePage: "tools",
            expandedPaths: ["src"],
            selectedNodeId: "api",
            selectedAgentId: "claude-code",
            executionMode: "plan",
            selectedRunId: "run-alpha",
            runArtifactTab: "plan",
            checkpointId: "flowweave-100"
          }
        }
      }
    }), "utf8");

    await expect(configureProjectRegistry(appDataPath)).resolves.toBeUndefined();
    await expect(listRegisteredProjects()).resolves.toEqual([
      expect.objectContaining({ id: keptProjectId, path: projectPath })
    ]);
    await expect(readProjectWorkspaceSession()).resolves.toMatchObject({
      openProjectIds: [keptProjectId],
      activeProjectId: keptProjectId,
      lastPageByProject: { [keptProjectId]: "tools" },
      contextsByProject: {
        [keptProjectId]: expect.objectContaining({ selectedAgentId: "claude-code" })
      }
    });
  });

  it("restores the open project tabs and their active page across an application restart", async () => {
    const appDataPath = await mkdtemp(join(tmpdir(), "flowweave-project-workspace-data-"));
    const firstProjectPath = await mkdtemp(join(tmpdir(), "flowweave-project-workspace-first-"));
    const secondProjectPath = await mkdtemp(join(tmpdir(), "flowweave-project-workspace-second-"));
    await configureProjectRegistry(appDataPath);
    const firstProjectId = await registerProject(firstProjectPath);
    const secondProjectId = await registerProject(secondProjectPath);

    await saveProjectWorkspaceSession({
      openProjectIds: [firstProjectId, secondProjectId],
      activeProjectId: secondProjectId,
      lastPageByProject: { [firstProjectId]: "canvas", [secondProjectId]: "tools" },
      contextsByProject: {}
    });

    resetProjectRegistryForTests();
    await configureProjectRegistry(appDataPath);

    await expect(readProjectWorkspaceSession()).resolves.toEqual({
      openProjectIds: [firstProjectId, secondProjectId],
      activeProjectId: secondProjectId,
      lastPageByProject: { [firstProjectId]: "canvas", [secondProjectId]: "tools" },
      contextsByProject: {}
    });
  });

  it("persists independent workspace contexts for every open project", async () => {
    const appDataPath = await mkdtemp(join(tmpdir(), "flowweave-project-context-data-"));
    const firstProjectPath = await mkdtemp(join(tmpdir(), "flowweave-project-context-first-"));
    const secondProjectPath = await mkdtemp(join(tmpdir(), "flowweave-project-context-second-"));
    await configureProjectRegistry(appDataPath);
    const firstProjectId = await registerProject(firstProjectPath);
    const secondProjectId = await registerProject(secondProjectPath);

    await saveProjectWorkspaceSession({
      openProjectIds: [firstProjectId, secondProjectId],
      activeProjectId: secondProjectId,
      lastPageByProject: { [firstProjectId]: "canvas", [secondProjectId]: "tools" },
      contextsByProject: {
        [firstProjectId]: {
          activePage: "canvas",
          expandedPaths: ["src"],
          selectedNodeId: "api",
          selectedAgentId: "claude-code",
          executionMode: "plan",
          selectedRunId: "run-alpha",
          runArtifactTab: "plan",
          checkpointId: "flowweave-100"
        },
        [secondProjectId]: {
          activePage: "tools",
          expandedPaths: ["app"],
          selectedNodeId: "worker",
          selectedAgentId: "codex-local",
          executionMode: "execute",
          selectedRunId: "run-beta",
          runArtifactTab: "result",
          checkpointId: "flowweave-200"
        }
      }
    });

    resetProjectRegistryForTests();
    await configureProjectRegistry(appDataPath);

    await expect(readProjectWorkspaceSession()).resolves.toMatchObject({
      contextsByProject: {
        [firstProjectId]: expect.objectContaining({ selectedAgentId: "claude-code", checkpointId: "flowweave-100" }),
        [secondProjectId]: expect.objectContaining({ selectedAgentId: "codex-local", checkpointId: "flowweave-200" })
      }
    });
  });
});

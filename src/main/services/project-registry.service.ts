import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { ProjectWorkspaceSession, RegisteredProject } from "../../types";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";

const PROJECT_ID_PATTERN = /^project-[a-f0-9-]{36}$/;
const projects = new Map<string, string>();
const registeredProjects = new Map<string, RegisteredProject>();
let configuredRoot: string | undefined;
let isRegistryLoaded = false;
let workspaceSession = emptyWorkspaceSession();

type PersistedProjectRegistry = {
  version: 2;
  projects: RegisteredProject[];
  session: ProjectWorkspaceSession;
};

export async function configureProjectRegistry(rootPath: string): Promise<void> {
  if (!isAbsolute(rootPath)) {
    throw new Error(`Project registry root must be absolute: "${rootPath}".`);
  }
  configuredRoot = rootPath;
  projects.clear();
  registeredProjects.clear();
  workspaceSession = emptyWorkspaceSession();
  isRegistryLoaded = false;
}

export async function registerProject(projectPath: string): Promise<string> {
  if (!isAbsolute(projectPath)) {
    throw new Error(`Project path must be absolute: "${projectPath}".`);
  }
  await ensureRegistryLoaded();
  const canonicalPath = await realpath(projectPath);
  const existing = [...projects.entries()].find(([, path]) => path === canonicalPath);
  if (existing) {
    await markProjectOpened(existing[0], canonicalPath);
    return existing[0];
  }
  const registered = [...registeredProjects.values()].find((project) => project.path === canonicalPath);
  if (registered) {
    projects.set(registered.id, canonicalPath);
    await markProjectOpened(registered.id, canonicalPath);
    return registered.id;
  }
  const projectId = `project-${randomUUID()}`;
  projects.set(projectId, canonicalPath);
  registeredProjects.set(projectId, {
    id: projectId,
    name: basename(canonicalPath),
    path: canonicalPath,
    lastOpenedAt: new Date().toISOString()
  });
  await writeRegistry();
  return projectId;
}

export async function listRegisteredProjects(): Promise<RegisteredProject[]> {
  await ensureRegistryLoaded();
  return [...registeredProjects.values()]
    .map((project) => ({ ...project }))
    .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt) || left.name.localeCompare(right.name));
}

export async function restoreRegisteredProject(projectId: string): Promise<string> {
  assertProjectId(projectId);
  await ensureRegistryLoaded();
  const registered = registeredProjects.get(projectId);
  if (!registered) {
    throw new Error(`Project is not registered in FlowWeave: "${projectId}".`);
  }
  const canonicalPath = await realpath(registered.path);
  projects.set(projectId, canonicalPath);
  await markProjectOpened(projectId, canonicalPath);
  return canonicalPath;
}

export async function readProjectWorkspaceSession(): Promise<ProjectWorkspaceSession> {
  await ensureRegistryLoaded();
  return copyWorkspaceSession(workspaceSession);
}

export async function saveProjectWorkspaceSession(session: ProjectWorkspaceSession): Promise<void> {
  await ensureRegistryLoaded();
  workspaceSession = copyWorkspaceSession(session);
  await writeRegistry();
}

export function resolveProjectPath(projectId: string): string {
  assertProjectId(projectId);
  const projectPath = projects.get(projectId);
  if (!projectPath) {
    throw new Error(`Project is not authorized in this FlowWeave session: "${projectId}".`);
  }
  return projectPath;
}

export async function resolveProjectFile(projectId: string, filePath: string): Promise<string> {
  const projectPath = resolveProjectPath(projectId);
  if (!filePath || isAbsolute(filePath) || filePath.split(/[\\/]/).includes("..")) {
    throw new Error(`Project file path must be a relative path inside the project: "${filePath}".`);
  }
  const absolutePath = resolve(projectPath, filePath);
  assertInsideProject(projectPath, absolutePath);
  const parentPath = resolve(absolutePath, "..");
  const canonicalParent = await realpath(parentPath);
  assertInsideProject(projectPath, canonicalParent);
  try {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      const target = await realpath(absolutePath);
      assertInsideProject(projectPath, target);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  return absolutePath;
}

export function assertProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(`Invalid FlowWeave project id: "${projectId}".`);
  }
}

export function createScanFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createStructureFingerprint(
  projectName: string,
  languages: Record<string, number>,
  files: Array<{ path: string; language?: string; size?: number; modifiedAt?: string }>
): string {
  return createScanFingerprint({
    projectName,
    languages,
    files: files
      .map((file) => ({
        path: file.path,
        language: file.language,
        size: file.size,
        modifiedAt: file.modifiedAt
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
  });
}

export function resetProjectRegistryForTests(): void {
  projects.clear();
  registeredProjects.clear();
  configuredRoot = undefined;
  isRegistryLoaded = false;
  workspaceSession = emptyWorkspaceSession();
}

async function ensureRegistryLoaded(): Promise<void> {
  if (isRegistryLoaded) return;
  if (!configuredRoot) {
    isRegistryLoaded = true;
    return;
  }
  const stored = await readJsonArtifact(projectRegistryPath(configuredRoot));
  if (stored !== undefined) {
    const registry = parsePersistedRegistry(stored);
    for (const project of registry.projects) {
      registeredProjects.set(project.id, project);
    }
    workspaceSession = registry.session;
  }
  isRegistryLoaded = true;
}

async function markProjectOpened(projectId: string, canonicalPath: string): Promise<void> {
  const existing = registeredProjects.get(projectId);
  if (!existing) return;
  registeredProjects.set(projectId, {
    ...existing,
    name: basename(canonicalPath),
    path: canonicalPath,
    lastOpenedAt: new Date().toISOString()
  });
  await writeRegistry();
}

async function writeRegistry(): Promise<void> {
  if (!configuredRoot) return;
  const rootPath = configuredRoot;
  const registry: PersistedProjectRegistry = {
    version: 2,
    projects: [...registeredProjects.values()].sort((left, right) => left.id.localeCompare(right.id)),
    session: copyWorkspaceSession(workspaceSession)
  };
  await writeJsonAtomic(projectRegistryPath(rootPath), registry);
}

function projectRegistryPath(rootPath: string): string {
  return join(rootPath, "projects.json");
}

function parsePersistedRegistry(value: unknown): PersistedProjectRegistry {
  if (!isRecord(value) || value.version !== 2) {
    throw new Error("FlowWeave project registry must use version 2. Remove it and add projects again.");
  }
  return value as PersistedProjectRegistry;
}

function emptyWorkspaceSession(): ProjectWorkspaceSession {
  return { openProjectIds: [], lastPageByProject: {}, contextsByProject: {} };
}

function copyWorkspaceSession(session: ProjectWorkspaceSession): ProjectWorkspaceSession {
  return {
    openProjectIds: [...session.openProjectIds],
    activeProjectId: session.activeProjectId,
    lastPageByProject: { ...session.lastPageByProject },
    contextsByProject: copyWorkspaceContexts(session.contextsByProject)
  };
}

function copyWorkspaceContexts(
  contextsByProject: ProjectWorkspaceSession["contextsByProject"]
): ProjectWorkspaceSession["contextsByProject"] {
  const copied: ProjectWorkspaceSession["contextsByProject"] = {};
  for (const [projectId, context] of Object.entries(contextsByProject)) {
    if (!context) continue;
    copied[projectId] = { ...context, expandedPaths: [...context.expandedPaths] };
  }
  return copied;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertInsideProject(projectPath: string, candidatePath: string): void {
  const normalizedProject = normalize(projectPath);
  const normalizedCandidate = normalize(candidatePath);
  const pathFromProject = relative(normalizedProject, normalizedCandidate);
  if (pathFromProject === ".." || pathFromProject.startsWith(`..${sep}`) || isAbsolute(pathFromProject)) {
    throw new Error(`Path escapes the authorized project: "${candidatePath}".`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

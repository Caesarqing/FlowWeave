import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { ActivePage, AgentId, ExecutionMode, ProjectWorkspaceContext, ProjectWorkspaceSession, RegisteredProject } from "../../types";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { createSerializedExecutor } from "../../utils/serialized-executor";

const PROJECT_ID_PATTERN = /^project-[a-f0-9-]{36}$/;
const projects = new Map<string, string>();
const registeredProjects = new Map<string, RegisteredProject>();
let configuredRoot: string | undefined;
let isRegistryLoaded = false;
let workspaceSession = emptyWorkspaceSession();
let serializeRegistryWrite = createSerializedExecutor();
const ACTIVE_PAGES: ActivePage[] = ["canvas", "structure", "docs", "git-review", "tools"];

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
  serializeRegistryWrite = createSerializedExecutor();
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
  workspaceSession = validateWorkspaceSession(session, registeredProjects);
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
  serializeRegistryWrite = createSerializedExecutor();
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
  await serializeRegistryWrite(() => writeJsonAtomic(projectRegistryPath(rootPath), registry));
}

function projectRegistryPath(rootPath: string): string {
  return join(rootPath, "projects.json");
}

function parsePersistedRegistry(value: unknown): PersistedProjectRegistry {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.projects)) {
    throw new Error("FlowWeave project registry is invalid and was preserved.");
  }
  const projectIds = new Set<string>();
  const projectsByPath = new Map<string, RegisteredProject[]>();
  for (const item of value.projects) {
    if (!isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.path !== "string" ||
      typeof item.lastOpenedAt !== "string") {
      throw new Error("FlowWeave project registry contains an invalid project entry and was preserved.");
    }
    assertProjectId(item.id);
    if (!isAbsolute(item.path) || !item.name.trim() || Number.isNaN(Date.parse(item.lastOpenedAt))) {
      throw new Error("FlowWeave project registry contains an invalid project entry and was preserved.");
    }
    if (projectIds.has(item.id)) {
      throw new Error("FlowWeave project registry contains duplicate projects and was preserved.");
    }
    projectIds.add(item.id);
    const project = {
      id: item.id,
      name: item.name,
      path: item.path,
      lastOpenedAt: item.lastOpenedAt
    };
    projectsByPath.set(item.path, [...(projectsByPath.get(item.path) ?? []), project]);
  }
  const { projects, projectIdAliases } = deduplicateProjectsByPath(projectsByPath);
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const session = value.session === undefined
    ? emptyWorkspaceSession()
    : value.version === 1
      ? migrateVersionOneSession(remapWorkspaceSessionProjectIds(value.session, projectIdAliases), projectMap)
      : validateWorkspaceSession(remapWorkspaceSessionProjectIds(value.session, projectIdAliases), projectMap);
  return { version: 2, projects, session };
}

function deduplicateProjectsByPath(projectsByPath: Map<string, RegisteredProject[]>): {
  projects: RegisteredProject[];
  projectIdAliases: Map<string, string>;
} {
  const projectIdAliases = new Map<string, string>();
  const projects: RegisteredProject[] = [];
  for (const entries of projectsByPath.values()) {
    const sorted = [...entries].sort((left, right) =>
      right.lastOpenedAt.localeCompare(left.lastOpenedAt) || left.id.localeCompare(right.id)
    );
    const kept = sorted[0];
    projects.push(kept);
    for (const duplicate of sorted.slice(1)) {
      projectIdAliases.set(duplicate.id, kept.id);
    }
  }
  return { projects, projectIdAliases };
}

function remapWorkspaceSessionProjectIds(value: unknown, projectIdAliases: Map<string, string>): unknown {
  if (projectIdAliases.size === 0 || !isRecord(value)) return value;
  const openProjectIds = Array.isArray(value.openProjectIds)
    ? deduplicateStrings(value.openProjectIds.map((projectId) => remapProjectId(projectId, projectIdAliases)))
    : value.openProjectIds;
  const lastPageByProject = remapRecordKeys(value.lastPageByProject, projectIdAliases);
  const contextsByProject = remapRecordKeys(value.contextsByProject, projectIdAliases);
  return {
    ...value,
    openProjectIds,
    activeProjectId: remapProjectId(value.activeProjectId, projectIdAliases),
    lastPageByProject,
    contextsByProject
  };
}

function remapProjectId(value: unknown, projectIdAliases: Map<string, string>): unknown {
  return typeof value === "string" ? projectIdAliases.get(value) ?? value : value;
}

function remapRecordKeys(value: unknown, projectIdAliases: Map<string, string>): unknown {
  if (!isRecord(value)) return value;
  const remapped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const remappedKey = projectIdAliases.get(key) ?? key;
    remapped[remappedKey] = remapped[remappedKey] ?? entry;
  }
  return remapped;
}

function deduplicateStrings(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const deduplicated: unknown[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      if (seen.has(value)) continue;
      seen.add(value);
    }
    deduplicated.push(value);
  }
  return deduplicated;
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

function validateWorkspaceSession(
  value: unknown,
  projectsById: Map<string, RegisteredProject>
): ProjectWorkspaceSession {
  if (!isRecord(value) || !Array.isArray(value.openProjectIds) || !isRecord(value.lastPageByProject) || !isRecord(value.contextsByProject)) {
    throw new Error("FlowWeave project workspace session is invalid and was preserved.");
  }
  const openProjectIds = value.openProjectIds.map((projectId) => {
    if (typeof projectId !== "string") {
      throw new Error("FlowWeave project workspace session contains an invalid project id and was preserved.");
    }
    assertProjectId(projectId);
    if (!projectsById.has(projectId)) {
      throw new Error("FlowWeave project workspace session references an unregistered project and was preserved.");
    }
    return projectId;
  });
  if (new Set(openProjectIds).size !== openProjectIds.length) {
    throw new Error("FlowWeave project workspace session contains duplicate project tabs and was preserved.");
  }
  const activeProjectId = value.activeProjectId;
  if (activeProjectId !== undefined && (typeof activeProjectId !== "string" || !openProjectIds.includes(activeProjectId))) {
    throw new Error("FlowWeave project workspace session has an invalid active project and was preserved.");
  }
  const lastPageByProject: Partial<Record<string, ActivePage>> = {};
  for (const [projectId, page] of Object.entries(value.lastPageByProject)) {
    assertProjectId(projectId);
    if (!openProjectIds.includes(projectId) || typeof page !== "string" || !ACTIVE_PAGES.includes(page as ActivePage)) {
      throw new Error("FlowWeave project workspace session contains an invalid page and was preserved.");
    }
    lastPageByProject[projectId] = page as ActivePage;
  }
  const contextsByProject: ProjectWorkspaceSession["contextsByProject"] = {};
  for (const [projectId, context] of Object.entries(value.contextsByProject)) {
    assertProjectId(projectId);
    if (!openProjectIds.includes(projectId)) {
      throw new Error("FlowWeave project workspace context references a closed project and was preserved.");
    }
    contextsByProject[projectId] = validateWorkspaceContext(context, projectId, lastPageByProject[projectId]);
  }
  return { openProjectIds, activeProjectId, lastPageByProject, contextsByProject };
}

function migrateVersionOneSession(value: unknown, projectsById: Map<string, RegisteredProject>): ProjectWorkspaceSession {
  if (!isRecord(value) || !Array.isArray(value.openProjectIds) || !isRecord(value.lastPageByProject)) {
    throw new Error("FlowWeave project workspace session is invalid and was preserved.");
  }
  return validateWorkspaceSession({ ...value, contextsByProject: {} }, projectsById);
}

function validateWorkspaceContext(
  value: unknown,
  projectId: string,
  savedPage: ActivePage | undefined
): ProjectWorkspaceContext {
  if (!isRecord(value) || !Array.isArray(value.expandedPaths)) {
    throw new Error(`FlowWeave project workspace context is invalid for "${projectId}" and was preserved.`);
  }
  const activePage = requireActivePage(value.activePage, "context.activePage");
  if (savedPage && activePage !== savedPage) {
    throw new Error(`FlowWeave project workspace context page conflicts with the session for "${projectId}" and was preserved.`);
  }
  const expandedPaths = value.expandedPaths.map((path) => requireRelativePath(path, "context.expandedPaths"));
  const selectedAgentId = requireAgentId(value.selectedAgentId);
  const executionMode = requireExecutionMode(value.executionMode);
  const selectedRunId = requireStringValue(value.selectedRunId, "context.selectedRunId");
  const checkpointId = requireStringValue(value.checkpointId, "context.checkpointId");
  if (value.runArtifactTab !== "prompt" && value.runArtifactTab !== "plan" && value.runArtifactTab !== "log" && value.runArtifactTab !== "result") {
    throw new Error(`FlowWeave project workspace context has an invalid run artifact tab for "${projectId}" and was preserved.`);
  }
  return {
    activePage,
    expandedPaths,
    selectedNodeId: requireStringValue(value.selectedNodeId, "context.selectedNodeId"),
    selectedAgentId,
    executionMode,
    selectedRunId,
    runArtifactTab: value.runArtifactTab,
    checkpointId
  };
}

function requireActivePage(value: unknown, name: string): ActivePage {
  if (typeof value !== "string" || !ACTIVE_PAGES.includes(value as ActivePage)) {
    throw new Error(`FlowWeave project workspace session has an invalid ${name} and was preserved.`);
  }
  return value as ActivePage;
}

function requireRelativePath(value: unknown, name: string): string {
  const path = requireStringValue(value, name);
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`FlowWeave project workspace session has an invalid ${name} and was preserved.`);
  }
  return path;
}

function requireStringValue(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`FlowWeave project workspace session has an invalid ${name} and was preserved.`);
  }
  return value;
}

function requireAgentId(value: unknown): AgentId {
  if (typeof value !== "string" || (!value.startsWith("custom:") && !["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor"].includes(value))) {
    throw new Error("FlowWeave project workspace session has an invalid context.selectedAgentId and was preserved.");
  }
  return value as AgentId;
}

function requireExecutionMode(value: unknown): ExecutionMode {
  if (value !== "plan" && value !== "execute") {
    throw new Error("FlowWeave project workspace session has an invalid context.executionMode and was preserved.");
  }
  return value;
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

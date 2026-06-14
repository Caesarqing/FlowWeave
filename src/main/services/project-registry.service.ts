import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

const PROJECT_ID_PATTERN = /^project-[a-f0-9-]{36}$/;
const projects = new Map<string, string>();

export async function registerProject(projectPath: string): Promise<string> {
  if (!isAbsolute(projectPath)) {
    throw new Error(`Project path must be absolute: "${projectPath}".`);
  }
  const canonicalPath = await realpath(projectPath);
  const existing = [...projects.entries()].find(([, path]) => path === canonicalPath);
  if (existing) return existing[0];
  const projectId = `project-${randomUUID()}`;
  projects.set(projectId, canonicalPath);
  return projectId;
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

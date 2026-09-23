import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export async function assertSafeProjectWritePath(projectRoot: string, targetPath: string): Promise<void> {
  const absoluteProjectRoot = resolve(projectRoot);
  const canonicalRoot = await realpath(projectRoot);
  const absoluteTarget = resolve(targetPath);
  assertInsideProject(absoluteProjectRoot, absoluteTarget);
  const relativeTarget = relative(absoluteProjectRoot, absoluteTarget);
  const segments = relativeTarget.split(sep).filter(Boolean);
  let currentPath = canonicalRoot;
  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    let info;
    try {
      info = await lstat(currentPath);
    } catch (error) {
      if (isMissingPath(error)) break;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing project write through symbolic link: ${currentPath}`);
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error(`Project write parent is not a directory: ${currentPath}`);
    }
    assertInsideProject(canonicalRoot, await realpath(currentPath));
  }
}

export async function writeProjectTextAtomic(
  projectRoot: string,
  targetPath: string,
  content: string
): Promise<void> {
  await assertSafeProjectWritePath(projectRoot, targetPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await assertSafeProjectWritePath(projectRoot, targetPath);
  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await assertSafeProjectWritePath(projectRoot, targetPath);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function assertInsideProject(projectRoot: string, candidatePath: string): void {
  const pathFromProject = relative(projectRoot, candidatePath);
  if (pathFromProject === ".." || pathFromProject.startsWith(`..${sep}`) || isAbsolute(pathFromProject)) {
    throw new Error(`Path escapes the authorized project: "${candidatePath}".`);
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

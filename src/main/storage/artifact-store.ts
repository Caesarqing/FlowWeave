import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { writeProjectTextAtomic } from "./project-write-guard";

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  const projectRoot = projectRootForFlowWeavePath(path);
  if (projectRoot) {
    await writeProjectTextAtomic(projectRoot, path, content);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function projectRootForFlowWeavePath(path: string): string | undefined {
  const segments = resolve(path).split(sep);
  const index = segments.lastIndexOf(".flowweave");
  if (index < 1) return undefined;
  return segments.slice(0, index).join(sep) || join(sep);
}

export async function readJsonArtifact(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error(`FlowWeave artifact is unreadable and was preserved: ${path}`, { cause: error });
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

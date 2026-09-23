import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CodeflowCanvas, GraphEdge, GraphNode } from "../../types";
import { createCanvasArtifact, createTaskArtifact, createTaskMarkdown } from "../services/task-generator.service";
import { reconcileGeneratedCanvas } from "../services/canvas-migration.service";
import { assertSafeProjectWritePath } from "./project-write-guard";
import { FLOWWEAVE_DIR } from "./flowweave-paths";
import type { CodeflowProject, CodeflowWriteResult, ProjectFileNode } from "./schemas";

export async function writeFlowWeaveProject(
  rootPath: string,
  project: CodeflowProject,
  modules: GraphNode[],
  edges: GraphEdge[] | undefined,
  scanFingerprint: string
): Promise<CodeflowWriteResult> {
  return writeProjectArtifacts(rootPath, project, modules, edges, scanFingerprint);
}

async function writeProjectArtifacts(
  rootPath: string,
  project: CodeflowProject,
  modules: GraphNode[],
  edges: GraphEdge[] | undefined,
  scanFingerprint: string
) {
  const flowweaveRoot = join(rootPath, FLOWWEAVE_DIR);
  const canvasDir = join(flowweaveRoot, "canvas");
  const tasksDir = join(flowweaveRoot, "tasks");
  const contextDir = join(flowweaveRoot, "context");
  await assertSafeProjectWritePath(rootPath, flowweaveRoot);
  await Promise.all([
    mkdir(canvasDir, { recursive: true }),
    mkdir(tasksDir, { recursive: true }),
    mkdir(contextDir, { recursive: true })
  ]);

  const nextCanvas: CodeflowCanvas = reconcileGeneratedCanvas(
    createCanvasArtifact(rootPath, modules, edges, scanFingerprint),
    await readExistingCanvas(join(canvasDir, "main.canvas.json"))
  );
  const task = createTaskArtifact(modules, edges, scanFingerprint);
  const updates: Array<{ path: string; content: string; validate?: (content: string) => void }> = [
    {
      path: join(flowweaveRoot, "project.json"),
      content: jsonText({
        ...project,
        generatorVersion: "1.0.0",
        inputFingerprint: scanFingerprint,
        artifactState: "current",
        scanFingerprint
      })
    },
    { path: join(tasksDir, "current.task.md"), content: createTaskMarkdown(task) },
    { path: join(tasksDir, "current.task.json"), content: jsonText(task) },
    { path: join(contextDir, "file-tree.md"), content: createFileTreeMarkdown(project.files) }
  ];
  updates.splice(1, 0, {
    path: join(canvasDir, "main.canvas.json"),
    content: jsonText(nextCanvas),
    validate: validateCanvasV5Text
  });

  await writeBatchAtomic(rootPath, updates);
  await removeHistoricalTasks(tasksDir);

  return {
    projectJsonPath: join(flowweaveRoot, "project.json"),
    canvasJsonPath: join(canvasDir, "main.canvas.json"),
    taskMarkdownPath: join(tasksDir, "current.task.md"),
    taskJsonPath: join(tasksDir, "current.task.json"),
    contextFileTreePath: join(contextDir, "file-tree.md")
  };
}

async function readExistingCanvas(path: string): Promise<CodeflowCanvas | undefined> {
  try {
    const canvas = JSON.parse(await readFile(path, "utf8")) as Partial<CodeflowCanvas> & { version?: unknown };
    const version = (canvas as { version?: unknown }).version;
    if (version === 1 || version === 2 || version === 3 || version === 4) return undefined;
    if (canvas.version === 5 && Array.isArray(canvas.nodes) && Array.isArray(canvas.edges)) return canvas as CodeflowCanvas;
    throw new Error(`FlowWeave Canvas is not a valid v5 artifact and was preserved: ${path}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    if (error instanceof Error && error.message.startsWith("FlowWeave Canvas is not a valid v5 artifact")) throw error;
    throw new Error(`FlowWeave Canvas is unreadable and was preserved: ${path}`, { cause: error });
  }
}

async function writeBatchAtomic(
  projectRoot: string,
  updates: Array<{ path: string; content: string; validate?: (content: string) => void }>
) {
  await Promise.all(updates.map((update) => assertSafeProjectWritePath(projectRoot, update.path)));
  const temporary = updates.map((update) => ({
    ...update,
    temporaryPath: join(dirname(update.path), `.${basename(update.path)}.${randomUUID()}.tmp`),
    backupPath: join(dirname(update.path), `.${basename(update.path)}.${randomUUID()}.bak`),
    replaced: false,
    backedUp: false
  }));
  try {
    await Promise.all(temporary.map(async (update) => {
      await writeFile(update.temporaryPath, update.content, "utf8");
      const persisted = await readFile(update.temporaryPath, "utf8");
      update.validate?.(persisted);
    }));
    for (const update of temporary) {
      await assertSafeProjectWritePath(projectRoot, update.path);
      if (await pathExists(update.path)) {
        await rename(update.path, update.backupPath);
        update.backedUp = true;
      }
      await rename(update.temporaryPath, update.path);
      update.replaced = true;
    }
    await Promise.all(temporary.map((update) => rm(update.backupPath, { force: true })));
  } catch (error) {
    for (const update of [...temporary].reverse()) {
      if (update.replaced) await rm(update.path, { force: true });
      if (update.backedUp) await rename(update.backupPath, update.path);
      await rm(update.temporaryPath, { force: true });
    }
    throw error;
  }
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function removeHistoricalTasks(tasksDir: string) {
  const names = await readdir(tasksDir);
  await Promise.all(names
    .filter((name) => name !== "current.task.json" && name !== "current.task.md")
    .filter((name) => name.endsWith(".task.json") || name.endsWith(".task.md"))
    .map((name) => rm(join(tasksDir, name), { force: true })));
}

function jsonText(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateCanvasV5Text(content: string) {
  const canvas = JSON.parse(content) as Partial<CodeflowCanvas>;
  if (canvas.version !== 5 || !Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) {
    throw new Error("Generated Canvas must be a valid v5 artifact before replacement.");
  }
}

function createFileTreeMarkdown(nodes: ProjectFileNode[]) {
  const lines = ["# Project File Tree", ""];
  function visit(node: ProjectFileNode) {
    lines.push(`${"  ".repeat(node.depth)}- ${node.name}${node.type === "folder" ? "/" : ""}`);
    node.children?.forEach(visit);
  }
  nodes.forEach(visit);
  lines.push("");
  return lines.join("\n");
}

import { TransactionRecoveryError } from "../services/generation-errors";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, realpath, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ArchitectureMap, CodeflowCanvas, GenerationIdentity, GraphEdge, GraphNode } from "../../types";
import { prepareModificationBaseline } from "../services/modification-delta.service";
import { createCanvasArtifact } from "../services/canvas-artifact.service";
import { createTaskArtifact, createTaskMarkdown } from "../services/task-artifact.service";
import { reconcileGeneratedCanvas, type StoredCanvas } from "../services/canvas-migration.service";
import { assertSafeProjectWritePath } from "./project-write-guard";
import { FLOWWEAVE_DIR } from "./flowweave-paths";
import type { CodeflowProject, CodeflowWriteResult, ProjectFileNode } from "./schemas";

export type ArchitectureArtifacts = {
  generation?: GenerationIdentity;
  local: ArchitectureMap;
  current: ArchitectureMap;
  previousGraph?: Pick<CodeflowCanvas, "nodes" | "edges">;
};

export async function writeFlowWeaveProject(
  rootPath: string,
  project: CodeflowProject,
  modules: GraphNode[],
  edges: GraphEdge[],
  scanFingerprint: string,
  architectureArtifacts?: ArchitectureArtifacts
): Promise<CodeflowWriteResult> {
  const prepared = await prepareFlowWeaveProject(rootPath, project, modules, edges, scanFingerprint, architectureArtifacts);
    await writeBatchAtomic(rootPath, prepared.updates);
    await removeHistoricalTasks(join(rootPath, FLOWWEAVE_DIR, "tasks"));
  return prepared.written;
}

export async function prepareFlowWeaveProject(
  rootPath: string,
  project: CodeflowProject,
  modules: GraphNode[],
  edges: GraphEdge[],
  scanFingerprint: string,
  architectureArtifacts: ArchitectureArtifacts | undefined
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
    { ...createCanvasArtifact(rootPath, modules, edges, scanFingerprint),
      generation: architectureArtifacts?.generation,
      groups: architectureArtifacts?.current.groups, quality: architectureArtifacts?.current.quality,
      inputFingerprint: architectureArtifacts?.current.metadata?.inputFingerprint ?? scanFingerprint },
    await readExistingCanvas(join(canvasDir, "main.canvas.json")),
    architectureArtifacts?.previousGraph
  );
  const task = { ...createTaskArtifact(modules, edges, scanFingerprint), generation: architectureArtifacts?.generation };
  const updates: Array<{ path: string; content: string; validate?: (content: string) => void }> = [
    {
      path: join(flowweaveRoot, "project.json"),
      content: jsonText({
        ...project,
        generation: architectureArtifacts?.generation,
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
  if (architectureArtifacts) {
    updates.push(
      { path: join(flowweaveRoot, "architecture-local.json"), content: jsonText(architectureArtifacts.local) },
      { path: join(flowweaveRoot, "architecture-map.json"), content: jsonText(architectureArtifacts.current) }
    );
  }
  updates.splice(1, 0, {
    path: join(canvasDir, "main.canvas.json"),
    content: jsonText(nextCanvas),
    validate: validateCanvasV6Text
  });

  if (architectureArtifacts?.generation) {
    const baseline = await prepareModificationBaseline(rootPath, nextCanvas,
      { ...nextCanvas, nodes: modules, edges, orphanedEdges: [], orphanedNodeEdits: [] });
    updates.push({ path: join(flowweaveRoot, "modification-baseline.json"), content: jsonText(baseline) });
  }
  return { updates, canvas: nextCanvas, written: {
    projectJsonPath: join(flowweaveRoot, "project.json"),
    canvasJsonPath: join(canvasDir, "main.canvas.json"),
    taskMarkdownPath: join(tasksDir, "current.task.md"),
    taskJsonPath: join(tasksDir, "current.task.json"),
    contextFileTreePath: join(contextDir, "file-tree.md")
  } };
}

async function readExistingCanvas(path: string): Promise<StoredCanvas | undefined> {
  try {
    const canvas = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; nodes?: unknown; edges?: unknown };
    const version = canvas.version;
    if (version === 1 || version === 2 || version === 3 || version === 4) return undefined;
    if ((canvas.version === 5 || canvas.version === 6) && Array.isArray(canvas.nodes) && Array.isArray(canvas.edges)) {
      return canvas as StoredCanvas;
    }
    throw new Error(`FlowWeave Canvas is not a valid v6 artifact and was preserved: ${path}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    if (error instanceof Error && error.message.startsWith("FlowWeave Canvas is not a valid v6 artifact")) throw error;
    throw new Error(`FlowWeave Canvas is unreadable and was preserved: ${path}`, { cause: error });
  }
}

export type ArtifactUpdate = { path: string; content: string; validate?: (content: string) => void };
type JournalEntry = { path: string; temporaryPath: string; backupPath: string; originalExists: boolean; originalHash?: string; hash: string; delete?: true };
type TransactionJournal = { version: 1; transactionId: string; committed: boolean; markerPath?: string; entries: JournalEntry[] };

/** Caller holds the project artifact lock. The journal is durable before any replacement. */
export async function writeBatchAtomic(projectPath: string, inputUpdates: ArtifactUpdate[], removedPaths?: string[]): Promise<void> {
  if (!inputUpdates.length) return;
  const projectRoot = await realpath(projectPath);
  const requestedUpdates = inputUpdates.map((update) => ({ ...update, path: join(projectRoot, relative(resolve(projectPath), resolve(update.path))) }));
  for (const update of requestedUpdates) {
    await assertSafeProjectWritePath(projectRoot, update.path);
    if (await pathExists(update.path) && !(await lstat(update.path)).isFile()) {
      throw new Error(`Artifact target is not a regular file; previous artifacts were preserved: ${update.path}`);
    }
  }
  await recoverArtifactTransaction(projectRoot);
  const transactionId = randomUUID();
  const journalPath = join(projectRoot, FLOWWEAVE_DIR, "transaction.json");
  const generationMarker = basename(requestedUpdates.at(-1)!.path) === "generation.json";
  const writableUpdates: ArtifactUpdate[] = generationMarker ? requestedUpdates : [...requestedUpdates,
    { path: join(projectRoot, FLOWWEAVE_DIR, `.transaction-${transactionId}.commit`), content: transactionId }];
  const updates = [...writableUpdates.slice(0, -1), ...(removedPaths ?? []).map((path) => ({ path: join(projectRoot, relative(resolve(projectPath), resolve(path))), content: "", delete: true as const })), writableUpdates.at(-1)!];
  const targets = new Set<string>();
  for (const update of updates) {
    if (targets.has(update.path)) throw new Error(`Duplicate artifact transaction target: ${update.path}`);
    targets.add(update.path);
    await assertSafeProjectWritePath(projectRoot, update.path);
    if (await pathExists(update.path) && !(await lstat(update.path)).isFile()) throw new Error(`Artifact target is not a regular file: ${update.path}`);
  }
  const entries = await Promise.all(updates.map(async (update): Promise<JournalEntry> => {
    const originalExists = await pathExists(update.path);
    return {
      path: update.path,
      temporaryPath: join(dirname(update.path), `.${basename(update.path)}.${transactionId}.tmp`),
      backupPath: join(dirname(update.path), `.${basename(update.path)}.${transactionId}.bak`),
      originalExists,
      ...(originalExists ? { originalHash: contentHash(await readFile(update.path)) } : {}),
      hash: contentHash(update.content), ...("delete" in update ? { delete: true as const } : {})
    };
  }));
  const journal: TransactionJournal = { version: 1, transactionId, committed: false,
    markerPath: updates.at(-1)!.path, entries };
  await mkdir(dirname(journalPath), { recursive: true });
  await durableWrite(journalPath, JSON.stringify(journal));
  await syncDirectory(dirname(journalPath));
  try {
    const staged = await Promise.allSettled(entries.map(async (entry, index) => {
      await assertSafeProjectWritePath(projectRoot, entry.path);
      if (entry.delete) return;
      await mkdir(dirname(entry.path), { recursive: true });
      await durableWrite(entry.temporaryPath, updates[index].content);
      const update = updates[index];
      if ("validate" in update) update.validate?.(await readFile(entry.temporaryPath, "utf8"));
    }));
    const failures = staged.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, `Artifact staging failed: ${failures.map(String).join("; ")}`);
    for (const entry of entries) {
      await assertSafeProjectWritePath(projectRoot, entry.path);
      if (entry.originalExists) {
        await rename(entry.path, entry.backupPath);
        await syncDirectory(dirname(entry.path));
      }
      if (!entry.delete) await rename(entry.temporaryPath, entry.path);
      await syncDirectory(dirname(entry.path));
    }
  } catch (error) {
    try { await restoreJournal(projectRoot, journal); }
    catch (recoveryError) { throw new TransactionRecoveryError(projectRoot, `transaction ${transactionId}; original: ${String(error)}; recovery: ${String(recoveryError)}`, new AggregateError([error, recoveryError])); }
    throw error;
  }
  // The final generation marker is authoritative even if journal cleanup is interrupted.
  try {
    await cleanupJournal(projectRoot, journal);
  } catch (error) {
    // Committed data must not be rolled back or reported as an uncommitted scan.
    console.warn("Committed artifact transaction cleanup deferred", { projectRoot, transactionId, error });
  }
}

export async function recoverArtifactTransaction(projectRoot: string): Promise<void> {
  const journalPath = join(projectRoot, FLOWWEAVE_DIR, "transaction.json");
  if (!await pathExists(journalPath)) return;
  let journal: TransactionJournal;
  try {
    journal = JSON.parse(await readFile(journalPath, "utf8")) as TransactionJournal;
    if (journal.version !== 1 || typeof journal.transactionId !== "string" || !Array.isArray(journal.entries) || !journal.entries.length) throw new Error("Invalid journal schema");
    for (const entry of journal.entries) {
      if (typeof entry.hash !== "string" || typeof entry.originalExists !== "boolean") throw new Error("Invalid journal entry");
      if (entry.originalHash !== undefined && !/^[a-f\d]{64}$/i.test(entry.originalHash)) throw new Error("Invalid original artifact hash in journal entry");
      for (const path of [entry.path, entry.temporaryPath, entry.backupPath]) await assertSafeProjectWritePath(projectRoot, path);
    }
    const marker = journal.entries.find((entry) => entry.path === journal.markerPath);
    const committed = journal.committed || Boolean(marker && await pathExists(marker.path) && contentHash(await readFile(marker.path, "utf8")) === marker.hash);
    if (committed) {
      for (const entry of journal.entries) {
        if (entry.delete ? await pathExists(entry.path) : !await pathExists(entry.path) || contentHash(await readFile(entry.path, "utf8")) !== entry.hash) throw new Error(`Committed artifact content mismatch: ${entry.path}`);
      }
      await cleanupJournal(projectRoot, journal);
    } else await restoreJournal(projectRoot, journal);
  } catch (error) { throw new TransactionRecoveryError(projectRoot, `journal ${journalPath}`, error); }
}

async function restoreJournal(projectRoot: string, journal: TransactionJournal): Promise<void> {
  const failures: unknown[] = [];
  for (const entry of [...journal.entries].reverse()) {
    try {
      if (await pathExists(entry.backupPath)) {
        if (entry.originalHash && contentHash(await readFile(entry.backupPath)) !== entry.originalHash) {
          throw new Error(`Recovery backup content mismatch: ${entry.backupPath}`);
        }
        await copyFile(entry.backupPath, entry.path);
        const handle = await open(entry.path, "r");
        try { await handle.sync(); } finally { await handle.close(); }
        await syncDirectory(dirname(entry.path));
      }
      else if (entry.originalExists) {
        if (!entry.originalHash || !await pathExists(entry.path) || contentHash(await readFile(entry.path)) !== entry.originalHash) {
          throw new Error(`Recovery backup is missing and the original artifact cannot be verified: ${entry.backupPath}`);
        }
      } else await rm(entry.path, { force: true });
      await rm(entry.temporaryPath, { force: true });
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, `Rollback errors: ${failures.map(String).join("; ")}`);
  await cleanupJournal(projectRoot, journal);
}

async function cleanupJournal(projectRoot: string, journal: TransactionJournal): Promise<void> {
  const results = await Promise.allSettled(journal.entries.flatMap((entry) => [rm(entry.backupPath, { force: true }), rm(entry.temporaryPath, { force: true })]));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Committed transaction cleanup failed");
  await rm(join(projectRoot, FLOWWEAVE_DIR, "transaction.json"));
  if (journal.markerPath && basename(journal.markerPath) === `.transaction-${journal.transactionId}.commit`) await rm(journal.markerPath, { force: true });
}

async function durableWrite(path: string, content: string): Promise<void> {
  const handle = await open(path, "w");
  try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function contentHash(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }

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

function validateCanvasV6Text(content: string) {
  const canvas = JSON.parse(content) as Partial<CodeflowCanvas>;
  if (canvas.version !== 6 || !Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) {
    throw new Error("Generated Canvas must be a valid v6 artifact before replacement.");
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

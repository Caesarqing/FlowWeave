import { statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { generateProject, readCommittedGeneration, readCommittedAnalysis, assertArtifactGeneration } from "../../src/main/services/project-generation.service";
import { withArchitectureArtifactLock } from "../../src/main/services/architecture-review.service";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildSemanticIndex } from "../../src/main/services/semantic-index.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { buildArchitectureInputFingerprint } from "../../src/main/services/static-architecture.service";
import { readProjectGenerationManifest, readProjectProtocolCanvas, readProjectProtocolOverview, readProjectProtocolSnapshot, saveProjectProtocolCanvas, writeBatchAtomic } from "../../src/main/storage/flowweave-store";
import { writeTransactionAuthority } from "../../src/main/storage/transaction-authority";
import { readModificationDelta } from "../../src/main/services/modification-delta.service";

it("prepares semantic artifacts without independently persisting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  const result = await buildSemanticIndex(await scanProject(root));
  expect(result).toHaveProperty("updates");
  await expect(readFile(join(root, ".flowweave/index/semantic-index.json"))).rejects.toHaveProperty("code", "ENOENT");
});

it("accepts an existing deterministic protocol v7 generation manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-legacy-id-"));
  await mkdir(join(root, ".flowweave"));
  const inputFingerprint = "input-fingerprint";
  const rulesVersion = "legacy-rules";
  const generationId = createHash("sha256").update(JSON.stringify({ storageProtocol: 7, rulesVersion, inputFingerprint })).digest("hex");
  const manifest = {
    storageProtocol: 7, generationId, inputFingerprint, rulesVersion, analyzerVersion: "legacy-analyzer",
    artifacts: { staticSnapshot: "0".repeat(64), graphOverview: "0".repeat(64), canvasUserState: "0".repeat(64) },
    committedAt: "2026-10-11T00:00:00.000Z"
  };
  await writeFile(join(root, ".flowweave/generation.json"), JSON.stringify(manifest));
  expect(await readProjectGenerationManifest(root)).toEqual(manifest);
});

it("waits for every staging operation before cleaning rejected batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-stage-"));
  await mkdir(join(root, ".flowweave"));
  const file = join(root, ".flowweave/first.json");
  await writeFile(file, "old");
  await expect(writeBatchAtomic(root, [
    { path: file, content: "new", validate: () => { throw new Error("invalid stage"); } },
    { path: join(root, ".flowweave/deep/second.json"), content: "new" }
  ])).rejects.toThrow("invalid stage");
  expect(await readFile(file, "utf8")).toBe("old");
});

it("commits one identity across the v7 snapshot, overview, user state, and semantic cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-all-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  const result = await generateProject(root, {});
  expect(result.status).toBe("committed");
  if (result.status !== "committed") throw new Error("Expected committed generation");
  const snapshot = JSON.parse(await readFile(join(root, ".flowweave/static-snapshot.json"), "utf8"));
  const overview = JSON.parse(await readFile(join(root, ".flowweave/graph-overview.json"), "utf8"));
  const userState = JSON.parse(await readFile(join(root, ".flowweave/canvas/user-state.json"), "utf8"));
  expect(snapshot.generationId).toBe(result.generation.requestId);
  expect(snapshot.semanticIndex.analysisCapabilities).toEqual(result.index.analysisCapabilities);
  expect(overview.generationId).toBe(result.generation.requestId);
  expect(userState.generationId).toBe(result.generation.requestId);
  const marker = JSON.parse(await readFile(join(root, ".flowweave/generation.json"), "utf8"));
  expect(marker).toMatchObject({ storageProtocol: 7, generationId: result.generation.requestId, inputFingerprint: result.generation.inputFingerprint });
  expect(await readProjectProtocolSnapshot(root)).toMatchObject({ generationId: marker.generationId });
  expect(await readProjectProtocolCanvas(root)).toMatchObject({ generation: result.generation, userRevision: 0 });
  await expect(readFile(join(root, ".flowweave/canvas/main.canvas.json"))).rejects.toHaveProperty("code", "ENOENT");
  for (const path of ["project.json", "architecture-local.json", "architecture-map.json", "tasks/current.task.json", "context/file-tree.md", "modification-baseline.json"]) {
    await expect(readFile(join(root, ".flowweave", path), "utf8"), path).rejects.toHaveProperty("code", "ENOENT");
  }
  for (const path of ["index/manifest.json", "index/semantic-index.json"]) {
    expect(JSON.parse(await readFile(join(root, ".flowweave", path), "utf8")).generation).toEqual(result.generation);
  }
  await expect(readdir(join(root, ".flowweave/index/files"))).rejects.toHaveProperty("code", "ENOENT");
});

it("persists bound relation evidence through the v7 snapshot and graph and fingerprints analyzer contract changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-semantic-evidence-"));
  await mkdir(join(root, "src/api"), { recursive: true });
  await mkdir(join(root, "src/storage"), { recursive: true });
  await writeFile(join(root, "src/api/orders.controller.ts"), [
    'import { readOrders } from "../storage/orders.repository";',
    "export function listOrders() {",
    "  return readOrders();",
    "}"
  ].join("\n"), "utf8");
  await writeFile(join(root, "src/storage/orders.repository.ts"), "export function readOrders(): string[] { return []; }\n", "utf8");

  const result = await generateProject(root, {});
  if (result.status !== "committed") throw new Error("Expected the semantic evidence generation to commit.");
  const snapshot = await readProjectProtocolSnapshot(root);
  const overview = await readProjectProtocolOverview(root);
  const canvas = await readProjectProtocolCanvas(root);
  if (!snapshot || !overview || !canvas) throw new Error("Expected committed v7 graph artifacts.");

  const call = snapshot.semanticIndex.relations.find((relation) => relation.kind === "call" && relation.symbol === "readOrders");
  if (!call) throw new Error("Expected the bound source call in the committed semantic index.");
  expect(call).toMatchObject({
    confidence: "confirmed",
    bindingBasis: "typescript-checker",
    targetRef: {
      kind: "file",
      filePath: "src/storage/orders.repository.ts",
      symbolId: expect.any(String),
      declarationRange: expect.any(Object)
    },
    sourceRange: expect.any(Object)
  });

  const architectureRelation = snapshot.localArchitecture.relationships.find((relation) => relation.sourceRelationIds?.includes(call.id));
  expect(architectureRelation).toMatchObject({
    confidence: "confirmed",
    sourceRelationIds: expect.arrayContaining([call.id]),
    evidence: expect.arrayContaining([expect.objectContaining({
      relationId: call.id,
      range: call.sourceRange,
      bindingBasis: "typescript-checker"
    })])
  });
  expect(overview.edges.find((edge) => edge.sourceRelationIds?.includes(call.id))).toMatchObject({
    confidence: "confirmed",
    sourceRelationIds: expect.arrayContaining([call.id])
  });
  expect(canvas.edges.find((edge) => edge.sourceRelationIds?.includes(call.id))).toMatchObject({
    confidence: "confirmed",
    sourceRelationIds: expect.arrayContaining([call.id])
  });

  const scanFingerprint = snapshot.localArchitecture.metadata?.scanFingerprint;
  if (!scanFingerprint) throw new Error("Expected a source-bound local architecture fingerprint.");
  const currentArchitectureFingerprint = buildArchitectureInputFingerprint(scanFingerprint, result.index);
  expect(currentArchitectureFingerprint).toBe(snapshot.localArchitecture.metadata?.inputFingerprint);

  const changedAnalyzerContractFingerprint = buildArchitectureInputFingerprint(scanFingerprint, {
    ...result.index,
    generatorVersion: `${result.index.generatorVersion}-next`
  });
  expect(changedAnalyzerContractFingerprint).not.toBe(snapshot.localArchitecture.metadata?.inputFingerprint);
});

it("keeps the first static commit to the graph protocol and creates modification baseline on demand", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-lazy-artifacts-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");

  const result = await generateProject(root, {});

  expect(result.status).toBe("committed");
  for (const path of ["project.json", "architecture-local.json", "architecture-map.json", "tasks/current.task.json", "tasks/current.task.md", "context/file-tree.md", "modification-baseline.json"]) {
    await expect(readFile(join(root, ".flowweave", path), "utf8"), path).rejects.toHaveProperty("code", "ENOENT");
  }

  const delta = await readModificationDelta(root, "");
  expect(delta.hasChanges).toBe(false);
  if (result.status !== "committed") throw new Error("Expected committed generation");
  expect(JSON.parse(await readFile(join(root, ".flowweave", "modification-baseline.json"), "utf8")).generation).toEqual(result.generation);
});

it("reuses an unchanged committed generation without rewriting graph artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-reuse-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  const first = await generateProject(root, {});
  if (first.status !== "committed") throw new Error("Expected the first generation to commit.");
  const artifactPaths = [
    ".flowweave/generation.json",
    ".flowweave/static-snapshot.json",
    ".flowweave/graph-overview.json",
    ".flowweave/canvas/user-state.json",
    ".flowweave/index/manifest.json",
    ".flowweave/index/semantic-index.json"
  ];
  const before = await Promise.all(artifactPaths.map((path) => readFile(join(root, path), "utf8")));

  const second = await generateProject(root, {});

  if (second.status !== "committed") throw new Error("Expected the unchanged generation to be reused.");
  expect(second.generation).toEqual(first.generation);
  expect(await Promise.all(artifactPaths.map((path) => readFile(join(root, path), "utf8")))).toEqual(before);
});

it("rebuilds registered semantic facts when source bytes change and mtime is restored", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-restored-mtime-"));
  const sourcePath = join(root, "main.py");
  await writeFile(sourcePath, "def main():\n    return load()\n", "utf8");
  const stableMtime = new Date(Date.now() - 60_000);
  await utimes(sourcePath, stableMtime, stableMtime);
  await writeFile(join(root, "service.py"), "def load():\n    return 1\n", "utf8");
  const first = await generateProject(root, {});
  if (first.status !== "committed") throw new Error("Expected initial committed scan");
  const originalStat = statSync(sourcePath);
  const originalSource = first.index.files.find((file) => file.path === "main.py");
  const originalCalls = first.index.relations.filter((relation) => relation.kind === "call" && relation.sourceFile === "main.py");
  if (!originalSource) throw new Error("Initial semantic index omitted main.py");

  await writeFile(sourcePath, "def main():\n    return save()\n", "utf8");
  await utimes(sourcePath, originalStat.atime, originalStat.mtime);
  expect(statSync(sourcePath).size).toBe(originalStat.size);
  expect(statSync(sourcePath).mtime.toISOString()).toBe(originalStat.mtime.toISOString());

  const second = await generateProject(root, {});
  if (second.status !== "committed") throw new Error("Expected refreshed committed scan");
  const refreshedSource = second.index.files.find((file) => file.path === "main.py");
  const refreshedCalls = second.index.relations.filter((relation) => relation.kind === "call" && relation.sourceFile === "main.py");

  expect(second.generation.inputFingerprint).not.toBe(first.generation.inputFingerprint);
  expect(second.generation.requestId).not.toBe(first.generation.requestId);
  expect(second.delta.modified).toContain("main.py");
  expect(refreshedSource?.contentHash).not.toBe(originalSource.contentHash);
  expect(refreshedCalls).not.toEqual(originalCalls);
});

it("latest registered real process wins even if the newer request fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-race-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  const first = await generateProject(root, {});
  const barrier = join(tmpdir(), `generation-barrier-${randomUUID()}`);
  const older = child("scan", root, barrier, "");
  await waitForFile(`${barrier}.ready`);
  await writeFile(join(root, "pyproject.toml"), "[broken");
  const newer = child("scan", root, "", "");
  expect((await newer.done).code).not.toBe(0);
  await writeFile(`${barrier}.release`, "release");
  const finished = await older.done;
  expect(finished.code, finished.stderr).toBe(0);
  expect(JSON.parse(finished.stdout).status).toBe("superseded");
  expect(await readCommittedGeneration(root)).toEqual(first.status === "committed" ? first.generation : undefined);
}, 20_000);

it.each(["source", "configuration", "file-set", "removed-source"])("rejects changed %s at commit without replacing old generation", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-input-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  await writeFile(join(root, "pyproject.toml"), "[project]\nname = 'fixture'\n");
  const first = await generateProject(root, {});
  if (first.status !== "committed") throw new Error("Expected the initial generation to commit.");
  const barrier = join(tmpdir(), `generation-barrier-${randomUUID()}`);
  const worker = child("scan", root, barrier, "");
  await waitForFile(`${barrier}.ready`);
  if (kind === "removed-source") await unlink(join(root, "main.py"));
  else await writeFile(join(root, kind === "source" ? "main.py" : kind === "configuration" ? "pyproject.toml" : "added.py"), kind === "configuration" ? "[project]\nname = 'changed'\n" : "def changed():\n    return 2\n");
  await writeFile(`${barrier}.release`, "release");
  const result = await worker.done;
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Generation input changed");
  expect(await readCommittedGeneration(root)).toEqual(first.generation);
}, 20_000);

it("revalidates the frozen source snapshot after waiting for the commit lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-commit-lock-race-"));
  const sourcePath = join(root, "main.py");
  await writeFile(sourcePath, "def main():\n    return 1\n");
  const first = await generateProject(root, {});
  if (first.status !== "committed") throw new Error("Expected initial committed scan");
  await writeFile(sourcePath, "def main():\n    return 2\n");
  const barrier = join(tmpdir(), `generation-commit-barrier-${randomUUID()}`);
  const lockBarrier = `${barrier}.lock`;
  const worker = child("commit-race", root, barrier, "");
  await waitForFile(`${barrier}.ready`);
  const owner = child("lock", root, lockBarrier, "");
  await waitForFile(`${lockBarrier}.ready`);
  try {
    await writeFile(`${barrier}.release`, "release");
    await waitForLockCandidate(root);
    await writeFile(sourcePath, "def main():\n    return 3\n");
  } finally {
    await writeFile(`${lockBarrier}.release`, "release");
    await owner.done;
  }
  const result = await worker.done;

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Generation input changed");
  expect(await readCommittedGeneration(root)).toEqual(first.generation);
}, 40_000);

it.each([1, 2, 4, 6])("recovers a process killed at replacement %s using the durable journal", async (crashAt) => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-crash-"));
  await mkdir(join(root, ".flowweave"));
  await writeFile(join(root, ".flowweave/first.json"), "old-first");
  await writeFile(join(root, ".flowweave/second.json"), "old-second");
  await writeFile(join(root, ".flowweave/generation.json"), JSON.stringify({ requestId: "old", inputFingerprint: "old" }));
  const worker = child("crash", root, "", String(crashAt));
  expectKilledWorker(await worker.done);
  await withArchitectureArtifactLock(root, async () => {});
  expect(await readFile(join(root, ".flowweave/first.json"), "utf8")).toBe(crashAt === 6 ? "new-first" : "old-first");
  expect(await readFile(join(root, ".flowweave/second.json"), "utf8")).toBe(crashAt === 6 ? "new-second" : "old-second");
  expect((await readdir(join(root, ".flowweave"))).sort()).toEqual(["first.json", "generation.json", "second.json"]);
}, 20_000);

it("does not publish a partial journal when killed before journal publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-journal-crash-"));
  await mkdir(join(root, ".flowweave"));
  await writeFile(join(root, ".flowweave/first.json"), "old-first");
  const worker = child("journal-crash", root, "", "");
  expectKilledWorker(await worker.done);
  await expect(readFile(join(root, ".flowweave/transaction.json"))).rejects.toHaveProperty("code", "ENOENT");
  expect(await readFile(join(root, ".flowweave/first.json"), "utf8")).toBe("old-first");
  await withArchitectureArtifactLock(root, async () => {});
  await writeBatchAtomic(root, [{ path: join(root, ".flowweave/first.json"), content: "new-first" }]);
  expect(await readFile(join(root, ".flowweave/first.json"), "utf8")).toBe("new-first");
});

it("preserves source and journal when an unsigned legacy transaction targets source code", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-forged-legacy-"));
  await mkdir(join(root, ".flowweave"));
  const sourcePath = join(root, "src/important.ts");
  await mkdir(join(root, "src"));
  await writeFile(sourcePath, "important source");
  const journalPath = join(root, ".flowweave/transaction.json");
  const journalText = JSON.stringify({ version: 1, transactionId: randomUUID(), markerPath: sourcePath,
    entries: [{ path: sourcePath, temporaryPath: sourcePath, backupPath: sourcePath, originalExists: true, hash: "0".repeat(64) }] });
  await writeFile(journalPath, journalText);

  await expect(withArchitectureArtifactLock(root, async () => {})).rejects.toThrow("Unsigned or unsupported transaction journal");
  expect(await readFile(sourcePath, "utf8")).toBe("important source");
  expect(await readFile(journalPath, "utf8")).toBe(journalText);
});

it.each(["missing", "mismatched", "path-escape"])("preserves a forged v2 journal with %s authority", async (condition) => {
  const root = await mkdtemp(join(tmpdir(), `flowweave-forged-v2-${condition}-`));
  await mkdir(join(root, ".flowweave"));
  await mkdir(join(root, "src"));
  const sourcePath = join(root, "src/important.ts");
  await writeFile(sourcePath, "important source");
  const transactionId = randomUUID();
  const hash = createHash("sha256").update("malicious").digest("hex");
  const journalText = JSON.stringify({ version: 2, transactionId, markerPath: "generation.json", entries: [
    { artifactPath: "../src/important.ts", originalExists: true, originalHash: hash, hash },
    { artifactPath: "generation.json", originalExists: false, hash }
  ] });
  const journalPath = join(root, ".flowweave/transaction.json");
  await writeFile(journalPath, journalText);
  if (condition !== "missing") await writeTransactionAuthority(await realpath(root), transactionId, condition === "mismatched" ? "different bytes" : journalText);

  await expect(withArchitectureArtifactLock(root, async () => {})).rejects.toThrow(condition === "path-escape"
    ? "Unsafe transaction artifact path" : "Transaction authority");
  expect(await readFile(sourcePath, "utf8")).toBe("important source");
  expect(await readFile(journalPath, "utf8")).toBe(journalText);
});

it("commits while deleting an artifact whose parent directory never existed", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-absent-delete-"));
  await mkdir(join(root, ".flowweave"));
  await writeBatchAtomic(root, [
    { path: join(root, ".flowweave", "first.json"), content: "new-first" },
    { path: join(root, ".flowweave", "generation.json"), content: "new-marker" }
  ], [join(root, ".flowweave", "old", "missing.json")]);
  expect(await readFile(join(root, ".flowweave", "first.json"), "utf8")).toBe("new-first");
  expect(await readFile(join(root, ".flowweave", "generation.json"), "utf8")).toBe("new-marker");
});

it.each(["missing", "corrupt"])("preserves the recovery journal when an original backup is %s", async (condition) => {
  const root = await mkdtemp(join(tmpdir(), `flowweave-generation-${condition}-backup-`));
  await mkdir(join(root, ".flowweave"));
  await writeFile(join(root, ".flowweave/first.json"), "old-first");
  await writeFile(join(root, ".flowweave/second.json"), "old-second");
  await writeFile(join(root, ".flowweave/generation.json"), JSON.stringify({ requestId: "old", inputFingerprint: "old" }));
  expectKilledWorker(await child("crash", root, "", "2").done);

  const artifactDir = join(root, ".flowweave");
  const backupName = (await readdir(artifactDir)).find((name) => name.startsWith(".first.json.") && name.endsWith(".bak"));
  if (!backupName) throw new Error("Expected the first artifact backup after the interrupted replacement");
  const backupPath = join(artifactDir, backupName);
  if (condition === "missing") await rm(backupPath);
  else await writeFile(backupPath, "corrupted-backup");

  await expect(withArchitectureArtifactLock(root, async () => {})).rejects.toThrow(condition === "missing"
    ? "Recovery backup is missing and the original artifact cannot be verified"
    : "Recovery backup content mismatch");
  expect(await readFile(join(artifactDir, "transaction.json"), "utf8")).toContain("originalHash");
  expect(await readFile(join(artifactDir, "first.json"), "utf8")).toBe("new-first");
  if (condition === "corrupt") expect(await readFile(backupPath, "utf8")).toBe("corrupted-backup");
}, 20_000);

function child(mode: string, root: string, barrier: string, crashAt: string) {
  const process = spawn(globalThis.process.execPath, ["--import", "tsx", "tests/main/generation-process.fixture.ts", mode, root, barrier, crashAt], { cwd: globalThis.process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  process.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  process.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    process.on("error", reject);
    process.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { process, done };
}
function expectKilledWorker(result: { code: number | null; signal: NodeJS.Signals | null }): void {
  expect(result.signal).toBe(globalThis.process.platform === "win32" ? null : "SIGKILL");
  if (globalThis.process.platform === "win32") expect(result.code).not.toBe(0);
}
async function waitForFile(path: string): Promise<void> {
  const started = Date.now();
  while (true) {
    try { await readFile(path); return; }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
    if (Date.now() - started > 10_000) throw new Error(`Barrier did not arrive: ${path}`);
    await delay(20);
  }
}

async function waitForLockCandidate(root: string): Promise<void> {
  const started = Date.now();
  while (true) {
    const entries = await readdir(join(root, ".flowweave"));
    if (entries.some((entry) => entry.startsWith("architecture-artifact.lock."))) return;
    if (Date.now() - started > 10_000) throw new Error("Generation did not wait for the held artifact lock.");
    await delay(20);
  }
}

it("uses frozen bytes for TypeScript and WASM binding after parsing", async () => {
  for (const language of ["ts", "py"]) {
    const root = await mkdtemp(join(tmpdir(), "flowweave-generation-frozen-"));
    const path = join(root, `main.${language}`);
    await writeFile(path, language === "ts" ? "function original() {}\noriginal();" : "def original():\n    pass\noriginal()\n");
    const project = await scanProject(root);
    const result = await buildSemanticIndex(project, { onProgress: (progress) => {
      if (progress.stage === "linking") writeFileSync(path, language === "ts" ? "function changed() {}\nchanged();" : "def changed():\n    pass\nchanged()\n");
    } });
    expect(result.index.symbols.some((symbol) => symbol.name === "original"), language).toBe(true);
    expect(result.index.symbols.some((symbol) => symbol.name === "changed"), language).toBe(false);
    expect(() => result.snapshot.validate()).toThrow("Generation input changed");
  }
});

it("fingerprints excluded external declarations and extended configurations on warm requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-dependencies-"));
  const external = await mkdtemp(join(tmpdir(), "flowweave-generation-external-"));
  const config = join(external, "base.json");
  await writeFile(config, '{"compilerOptions":{"strict":true}}');
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: config }));
  await mkdir(join(root, "node_modules/external"), { recursive: true });
  await writeFile(join(root, "node_modules/external/package.json"), '{"name":"external","types":"index.d.ts"}');
  const declaration = join(root, "node_modules/external/index.d.ts");
  await writeFile(declaration, "export declare function execute(): number;");
  await writeFile(join(root, "main.ts"), "import { execute } from 'external';\nexecute();\n");
  const first = await generateProject(root, {});
  const second = await generateProject(root, {});
  if (first.status !== "committed" || second.status !== "committed") throw new Error("Expected committed scans");
  expect(second.generation.inputFingerprint).toBe(first.generation.inputFingerprint);
  await writeFile(declaration, "export declare function execute(): string;");
  const third = await generateProject(root, {});
  if (third.status !== "committed") throw new Error("Expected committed scan");
  expect(third.generation.inputFingerprint).not.toBe(second.generation.inputFingerprint);
  await writeFile(config, '{"compilerOptions":{"strict":false}}');
  const fourth = await generateProject(root, {});
  if (fourth.status !== "committed") throw new Error("Expected committed scan");
  expect(fourth.generation.inputFingerprint).not.toBe(third.generation.inputFingerprint);
});

it("rejects corrupt lock owners rather than stealing their locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-lock-"));
  await mkdir(join(root, ".flowweave"));
  await writeFile(join(root, ".flowweave/architecture-artifact.lock"), "corrupt owner");
  await expect(withArchitectureArtifactLock(root, async () => {})).rejects.toThrow("Corrupt artifact lock owner");
  expect(await readFile(join(root, ".flowweave/architecture-artifact.lock"), "utf8")).toBe("corrupt owner");
});

it("waits on a canonical-path lock owned by another live process", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-canonical-"));
  const alias = `${root}-alias`;
  await symlink(root, alias);
  const barrier = join(tmpdir(), `generation-barrier-${randomUUID()}`);
  const owner = child("lock", alias, barrier, "");
  await waitForFile(`${barrier}.ready`);
  let entered = false;
  const waiting = withArchitectureArtifactLock(root, async () => { entered = true; });
  await delay(100);
  expect(entered).toBe(false);
  await writeFile(`${barrier}.release`, "release");
  expect((await owner.done).code).toBe(0);
  await waiting;
  expect(entered).toBe(true);
});

it("attempts every rollback and preserves backups until recovery succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-rollback-"));
  await mkdir(join(root, ".flowweave"));
  await writeFile(join(root, ".flowweave/first.json"), "old-first");
  await writeFile(join(root, ".flowweave/second.json"), "old-second");
  await writeFile(join(root, ".flowweave/generation.json"), JSON.stringify({ requestId: "old", inputFingerprint: "old" }));
  const attempts = join(tmpdir(), `generation-rollback-${randomUUID()}`);
  const worker = child("rollback-failure", root, attempts, "");
  const result = await worker.done;
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("injected replacement failure");
  expect(result.stderr).toContain("injected rollback failure");
  const restored = await readFile(attempts, "utf8");
  expect(restored).toContain("first.json");
  expect(restored).toContain("second.json");
  expect((await readdir(join(root, ".flowweave"))).filter((name) => name.endsWith(".bak"))).toHaveLength(2);
  await withArchitectureArtifactLock(root, async () => {});
  expect(await readFile(join(root, ".flowweave/first.json"), "utf8")).toBe("old-first");
  expect(await readFile(join(root, ".flowweave/second.json"), "utf8")).toBe("old-second");
});

it("reports committed on cleanup failure and finishes cleanup at the next lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-cleanup-"));
  await mkdir(join(root, ".flowweave"));
  await writeFile(join(root, ".flowweave/first.json"), "old-first");
  await writeFile(join(root, ".flowweave/second.json"), "old-second");
  const worker = child("cleanup-failure", root, "", "");
  const result = await worker.done;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("committed");
  expect(result.stderr).toContain("Committed artifact transaction cleanup deferred");
  expect(await readFile(join(root, ".flowweave/first.json"), "utf8")).toBe("new-first");
  await withArchitectureArtifactLock(root, async () => {});
  expect((await readdir(join(root, ".flowweave"))).sort()).toEqual(["first.json", "generation.json", "second.json"]);
});

it("finishes cleanup after only some committed backups were removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-partial-cleanup-"));
  await mkdir(join(root, ".flowweave"));
  await writeFile(join(root, ".flowweave/first.json"), "old-first");
  await writeFile(join(root, ".flowweave/second.json"), "old-second");
  const result = await child("partial-cleanup-failure", root, "", "").done;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain("Committed artifact transaction cleanup deferred");
  expect((await readdir(join(root, ".flowweave"))).filter((name) => name.endsWith(".bak"))).toHaveLength(1);
  await withArchitectureArtifactLock(root, async () => {});
  expect((await readdir(join(root, ".flowweave"))).sort()).toEqual(["first.json", "generation.json", "second.json"]);
  expect(await readFile(join(root, ".flowweave/first.json"), "utf8")).toBe("new-first");
});

it("validates committed interrupted contents before removing recovery backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-corrupt-recovery-"));
  await mkdir(join(root, ".flowweave"));
  await writeFile(join(root, ".flowweave/first.json"), "old-first");
  await writeFile(join(root, ".flowweave/second.json"), "old-second");
  await writeFile(join(root, ".flowweave/generation.json"), JSON.stringify({ requestId: "old", inputFingerprint: "old" }));
  expectKilledWorker(await child("crash", root, "", "6").done);
  await writeFile(join(root, ".flowweave/first.json"), "corrupted");
  await expect(withArchitectureArtifactLock(root, async () => {})).rejects.toThrow("Committed artifact content mismatch");
  expect((await readdir(join(root, ".flowweave"))).filter((name) => name.endsWith(".bak"))).toHaveLength(3);
});

it("preserves a committed journal when its backup was corrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-committed-backup-"));
  await mkdir(join(root, ".flowweave"));
  await writeFile(join(root, ".flowweave/first.json"), "old-first");
  await writeFile(join(root, ".flowweave/second.json"), "old-second");
  await writeFile(join(root, ".flowweave/generation.json"), "old-generation");
  expectKilledWorker(await child("crash", root, "", "6").done);
  const artifactDir = join(root, ".flowweave");
  const backupName = (await readdir(artifactDir)).find((name) => name.startsWith(".first.json.") && name.endsWith(".bak"));
  if (!backupName) throw new Error("Expected the committed transaction backup");
  await writeFile(join(artifactDir, backupName), "corrupted backup");

  await expect(withArchitectureArtifactLock(root, async () => {})).rejects.toThrow("Committed transaction backup content mismatch");
  expect(await readFile(join(artifactDir, "transaction.json"), "utf8")).toContain("originalHash");
  expect(await readFile(join(artifactDir, backupName), "utf8")).toBe("corrupted backup");
});

it("saves user edits separately without changing the static generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-edits-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  const result = await generateProject(root, {});
  if (result.status !== "committed") throw new Error("Expected committed scan");
  const canvas = { ...result.canvas, nodes: result.canvas.nodes.map((node, index) => index === 0 ? { ...node, title: "Edited title" } : node) };
  const saved = await saveProjectProtocolCanvas(root, canvas);
  expect(saved).toMatchObject({ userRevision: 1 });
  expect(JSON.parse(await readFile(saved!.path, "utf8")).nodeEdits[canvas.nodes[0].id].title).toBe("Edited title");
  await expect(saveProjectProtocolCanvas(root, canvas)).rejects.toThrow("user state changed");
  await readModificationDelta(root, "");
  const baselinePath = join(root, ".flowweave/modification-baseline.json");
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  await writeFile(baselinePath, JSON.stringify({ ...baseline, acknowledgedAt: "2026-09-29T00:00:00Z" }));
  await expect(readCommittedAnalysis(root)).resolves.toMatchObject({ generation: result.generation });
  await withArchitectureArtifactLock(root, () => assertArtifactGeneration(root, "canvas/user-state.json", result.canvas));
  await expect(readProjectProtocolCanvas(root)).resolves.toMatchObject({ userRevision: 1, nodes: [{ title: "Edited title" }] });
});

it("preserves canvas edits through three source rescans and two save/reopen cycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-rescan-user-state-"));
  const sourcePath = join(root, "main.py");
  await writeFile(sourcePath, "def main():\n    return 1\n");

  const first = await generateProject(root, {});
  if (first.status !== "committed") throw new Error("Expected initial committed scan");
  const target = first.canvas.nodes.find((node) => node.kind === "module");
  if (!target) throw new Error("Initial graph omitted its generated module");

  const firstSave = await saveProjectProtocolCanvas(root, {
    ...first.canvas,
    nodes: first.canvas.nodes.map((node) => node.id === target.id ? { ...node, title: "Reviewed main module" } : node)
  });
  if (!firstSave) throw new Error("Expected first protocol Canvas save");
  const firstReopen = await readProjectProtocolCanvas(root);
  if (!firstReopen) throw new Error("Expected first reopened protocol Canvas");
  expect(firstSave.userRevision).toBe(1);
  expect(firstReopen.nodes.find((node) => node.id === target.id)?.title).toBe("Reviewed main module");

  await writeFile(sourcePath, "def main():\n    return 1\n# source rescan two\n");
  const second = await generateProject(root, {});
  if (second.status !== "committed") throw new Error("Expected second committed scan");
  expect(second.generation.requestId).not.toBe(first.generation.requestId);
  const secondReopen = await readProjectProtocolCanvas(root);
  if (!secondReopen?.layout) throw new Error("Expected second reopened Canvas with layout");
  expect(secondReopen.userRevision).toBe(1);
  expect(secondReopen.nodes.find((node) => node.id === target.id)?.title).toBe("Reviewed main module");

  const secondSave = await saveProjectProtocolCanvas(root, {
    ...secondReopen,
    layout: {
      ...secondReopen.layout,
      activeMode: "manual",
      manualPositions: { ...secondReopen.layout.manualPositions, [target.id]: { x: 137, y: 251 } }
    }
  });
  if (!secondSave) throw new Error("Expected second protocol Canvas save");
  const secondSavedReopen = await readProjectProtocolCanvas(root);
  if (!secondSavedReopen) throw new Error("Expected second save/reopen cycle");
  expect(secondSave.userRevision).toBe(2);
  expect(secondSavedReopen.layout?.manualPositions[target.id]).toEqual({ x: 137, y: 251 });

  await writeFile(sourcePath, "def main():\n    return 1\n# source rescan three\n");
  const third = await generateProject(root, {});
  if (third.status !== "committed") throw new Error("Expected third committed scan");
  expect(third.generation.requestId).not.toBe(second.generation.requestId);
  const thirdReopen = await readProjectProtocolCanvas(root);
  if (!thirdReopen) throw new Error("Expected third reopened protocol Canvas");
  expect(thirdReopen.userRevision).toBe(2);
  expect(thirdReopen.nodes.find((node) => node.id === target.id)?.title).toBe("Reviewed main module");
  expect(thirdReopen.layout?.manualPositions[target.id]).toEqual({ x: 137, y: 251 });
});

it("archives a v6 Canvas and carries its unique module edit into protocol v7", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-v6-migration-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  const first = await generateProject(root, {});
  if (first.status !== "committed") throw new Error("Expected initial committed scan");
  const editedCanvas = {
    ...first.canvas,
    nodes: first.canvas.nodes.map((node, index) => index === 0 ? { ...node, title: "Renamed by user" } : node)
  };
  const legacyBytes = JSON.stringify({ ...editedCanvas, version: 6 });
  const legacyArchitectureBytes = JSON.stringify(first.architectureMap);
  const rootPath = join(root, ".flowweave");
  await writeFile(join(rootPath, "architecture-map.json"), legacyArchitectureBytes);
  await writeFile(join(rootPath, "canvas/main.canvas.json"), legacyBytes);
  await rm(join(rootPath, "generation.json"));
  await rm(join(rootPath, "static-snapshot.json"));
  await rm(join(rootPath, "graph-overview.json"));
  await rm(join(rootPath, "canvas/user-state.json"));

  const migrated = await generateProject(root, {});
  if (migrated.status !== "committed") throw new Error("Expected migrated committed scan");
  const marker = JSON.parse(await readFile(join(rootPath, "generation.json"), "utf8"));
  const backup = JSON.parse(await readFile(join(rootPath, "migration/record.json"), "utf8")) as { backupPath: string; status: string };
  expect(marker.storageProtocol).toBe(7);
  expect(backup.status).toBe("complete");
  await expect(readFile(join(rootPath, "canvas/main.canvas.json"), "utf8")).rejects.toHaveProperty("code", "ENOENT");
  await expect(readFile(join(rootPath, "architecture-map.json"), "utf8")).rejects.toHaveProperty("code", "ENOENT");
  expect(await readFile(join(root, backup.backupPath, "artifacts/canvas/main.canvas.json"), "utf8")).toBe(legacyBytes);
  expect(await readFile(join(root, backup.backupPath, "artifacts/architecture-map.json"), "utf8")).toBe(legacyArchitectureBytes);
  await expect(readProjectProtocolCanvas(root)).resolves.toMatchObject({ nodes: [{ title: "Renamed by user" }] });
});

it("rejects mismatched committed analysis identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-mismatch-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  const result = await generateProject(root, {});
  if (result.status !== "committed") throw new Error("Expected committed scan");
  const snapshotPath = join(root, ".flowweave/static-snapshot.json");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  await writeFile(snapshotPath, JSON.stringify({ ...snapshot, generationId: "different" }));
  await expect(readCommittedAnalysis(root)).rejects.toThrow("artifact hash mismatch");
});

it("never steals a live lock by age and reports its owner after the bounded wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-occupied-"));
  const barrier = join(tmpdir(), `generation-barrier-${randomUUID()}`);
  const owner = child("lock", root, barrier, "");
  await waitForFile(`${barrier}.ready`);
  try {
    await utimes(join(root, ".flowweave/architecture-artifact.lock"), new Date(0), new Date(0));
    await expect(withArchitectureArtifactLock(root, async () => {})).rejects.toThrow(`owner PID ${owner.process.pid}`);
  } finally {
    await writeFile(`${barrier}.release`, "release");
    await owner.done;
  }
}, 40_000);

it("the newer of two successful real processes remains the committed generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-winning-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  const barrier = join(tmpdir(), `generation-barrier-${randomUUID()}`);
  const older = child("scan", root, barrier, "");
  await waitForFile(`${barrier}.ready`);
  const winner = await child("scan", root, "", "").done;
  expect(winner.code, winner.stderr).toBe(0);
  await writeFile(`${barrier}.release`, "release");
  expect(JSON.parse((await older.done).stdout).status).toBe("superseded");
  expect(await readCommittedGeneration(root)).toEqual(JSON.parse(winner.stdout).generation);
});

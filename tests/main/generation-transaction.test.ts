import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { generateProject, readCommittedGeneration, readCommittedAnalysis, assertArtifactGeneration } from "../../src/main/services/project-generation.service";
import { withArchitectureArtifactLock } from "../../src/main/services/architecture-review.service";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildSemanticIndex } from "../../src/main/services/semantic-index.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { writeBatchAtomic } from "../../src/main/storage/flowweave-store";

it("prepares semantic artifacts without independently persisting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  const result = await buildSemanticIndex(await scanProject(root));
  expect(result).toHaveProperty("updates");
  await expect(readFile(join(root, ".flowweave/index/semantic-index.json"))).rejects.toHaveProperty("code", "ENOENT");
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

it("commits one identity across every generated JSON artifact and confirmation baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-all-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  const result = await generateProject(root, {});
  expect(result.status).toBe("committed");
  if (result.status !== "committed") throw new Error("Expected committed generation");
  for (const path of ["project.json", "architecture-local.json", "architecture-map.json", "canvas/main.canvas.json", "tasks/current.task.json", "modification-baseline.json", "index/manifest.json", "index/semantic-index.json"]) {
    expect(JSON.parse(await readFile(join(root, ".flowweave", path), "utf8")).generation, path).toEqual(result.generation);
  }
  expect(JSON.parse(await readFile(join(root, ".flowweave/generation.json"), "utf8"))).toEqual(result.generation);
  const files = await readdir(join(root, ".flowweave/index/files"));
  for (const path of files) expect(JSON.parse(await readFile(join(root, ".flowweave/index/files", path), "utf8")).generation).toEqual(result.generation);
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

it.each(["source", "configuration", "file-set"])("rejects changed %s at commit without replacing old generation", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-input-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  await writeFile(join(root, "pyproject.toml"), "[project]\nname = 'fixture'\n");
  const first = await generateProject(root, {});
  const barrier = join(tmpdir(), `generation-barrier-${randomUUID()}`);
  const worker = child("scan", root, barrier, "");
  await waitForFile(`${barrier}.ready`);
  await writeFile(join(root, kind === "source" ? "main.py" : kind === "configuration" ? "pyproject.toml" : "added.py"), kind === "configuration" ? "[project]\nname = 'changed'\n" : "def changed():\n    return 2\n");
  await writeFile(`${barrier}.release`, "release");
  const result = await worker.done;
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Generation input changed");
  expect(await readCommittedGeneration(root)).toEqual(first.status === "committed" ? first.generation : undefined);
}, 20_000);

it.each([1, 2, 4, 6])("recovers a process killed at replacement %s using the durable journal", async (crashAt) => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-crash-"));
  await mkdir(join(root, ".flowweave"));
  await writeFile(join(root, ".flowweave/first.json"), "old-first");
  await writeFile(join(root, ".flowweave/second.json"), "old-second");
  await writeFile(join(root, ".flowweave/generation.json"), JSON.stringify({ requestId: "old", inputFingerprint: "old" }));
  const worker = child("crash", root, "", String(crashAt));
  expect((await worker.done).signal).toBe("SIGKILL");
  await withArchitectureArtifactLock(root, async () => {});
  expect(await readFile(join(root, ".flowweave/first.json"), "utf8")).toBe(crashAt === 6 ? "new-first" : "old-first");
  expect(await readFile(join(root, ".flowweave/second.json"), "utf8")).toBe(crashAt === 6 ? "new-second" : "old-second");
  expect((await readdir(join(root, ".flowweave"))).sort()).toEqual(["first.json", "generation.json", "second.json"]);
}, 20_000);

it.each(["missing", "corrupt"])("preserves the recovery journal when an original backup is %s", async (condition) => {
  const root = await mkdtemp(join(tmpdir(), `flowweave-generation-${condition}-backup-`));
  await mkdir(join(root, ".flowweave"));
  await writeFile(join(root, ".flowweave/first.json"), "old-first");
  await writeFile(join(root, ".flowweave/second.json"), "old-second");
  await writeFile(join(root, ".flowweave/generation.json"), JSON.stringify({ requestId: "old", inputFingerprint: "old" }));
  expect((await child("crash", root, "", "2").done).signal).toBe("SIGKILL");

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
async function waitForFile(path: string): Promise<void> {
  const started = Date.now();
  while (true) {
    try { await readFile(path); return; }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
    if (Date.now() - started > 10_000) throw new Error(`Barrier did not arrive: ${path}`);
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

it("validates committed interrupted contents before removing recovery backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-corrupt-recovery-"));
  await mkdir(join(root, ".flowweave"));
  await writeFile(join(root, ".flowweave/first.json"), "old-first");
  await writeFile(join(root, ".flowweave/second.json"), "old-second");
  await writeFile(join(root, ".flowweave/generation.json"), JSON.stringify({ requestId: "old", inputFingerprint: "old" }));
  expect((await child("crash", root, "", "6").done).signal).toBe("SIGKILL");
  await writeFile(join(root, ".flowweave/first.json"), "corrupted");
  await expect(withArchitectureArtifactLock(root, async () => {})).rejects.toThrow("Committed artifact content mismatch");
  expect((await readdir(join(root, ".flowweave"))).filter((name) => name.endsWith(".bak"))).toHaveLength(3);
});

it("does not revalidate historical hashes after legitimate Canvas and confirmation edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-edits-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  const result = await generateProject(root, {});
  if (result.status !== "committed") throw new Error("Expected committed scan");
  const canvas = { ...result.canvas, title: "Edited title" };
  await writeFile(join(root, ".flowweave/canvas/main.canvas.json"), JSON.stringify(canvas));
  const baselinePath = join(root, ".flowweave/modification-baseline.json");
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  await writeFile(baselinePath, JSON.stringify({ ...baseline, acknowledgedAt: "2026-09-29T00:00:00Z" }));
  await expect(readCommittedAnalysis(root)).resolves.toMatchObject({ generation: result.generation });
  await withArchitectureArtifactLock(root, () => assertArtifactGeneration(root, "canvas/main.canvas.json", canvas));
});

it("rejects mismatched committed analysis identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-generation-mismatch-"));
  await writeFile(join(root, "main.py"), "def main():\n    return 1\n");
  const result = await generateProject(root, {});
  if (result.status !== "committed") throw new Error("Expected committed scan");
  await writeFile(join(root, ".flowweave/index/semantic-index.json"), JSON.stringify({ ...result.index, generation: { ...result.generation, requestId: "different" } }));
  await expect(readCommittedAnalysis(root)).rejects.toThrow("Artifact generation mismatch");
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

import { cp, mkdir, mkdtemp, rm, writeFile, readFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSemanticIndex } from "../../src/main/services/semantic-index.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { buildStaticArchitecture } from "../../src/main/services/static-architecture.service";
import { generateProject } from "../../src/main/services/project-generation.service";
import { createSourceSnapshot } from "../../src/main/services/source-snapshot.service";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("independent four-language static analysis", () => {
  it("drops stale and unused declaration paths while retaining currently imported types", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-external-types-"));
    roots.push(root);
    const dependencyRoot = join(root, "node_modules", "large-types");
    const unusedTypesRoot = join(root, "node_modules", "@types", "unused");
    await mkdir(dependencyRoot, { recursive: true });
    await mkdir(unusedTypesRoot, { recursive: true });
    await writeFile(join(dependencyRoot, "index.d.ts"), "export declare function execute(): number;\n");
    await writeFile(join(unusedTypesRoot, "index.d.ts"), "declare function unusedAmbientType(): string;\n");
    const legacyManifestPath = join(root, ".flowweave", "index", "manifest.json");
    await mkdir(dirname(legacyManifestPath), { recursive: true });
    await writeFile(legacyManifestPath, JSON.stringify({
      version: 5,
      generatorVersion: "5.0.1",
      projectName: "legacy-cache",
      rootPath: root,
      generatedAt: new Date().toISOString(),
      scanFingerprint: "legacy-scan",
      configurationFingerprint: "legacy-input",
      inputState: { filePaths: [join(unusedTypesRoot, "index.d.ts")], observations: [] },
      files: []
    }));
    await writeFile(join(root, "app.ts"), 'import { execute } from "large-types"; export function read(items: string[]) { execute(); return items.map((item) => item.toLowerCase()).join(","); }\n');

    const prepared = await buildSemanticIndex(await scanProject(root));

    const snapshotState = prepared.snapshot.inputState() as {
      filePaths: string[];
      trackedFileHashes?: Array<[string, string, string]>;
    };
    const capturedPaths = snapshotState.filePaths;
    expect(capturedPaths.some((path) => path.endsWith("/node_modules/large-types/index.d.ts"))).toBe(false);
    expect(capturedPaths.some((path) => path.endsWith("/node_modules/@types/unused/index.d.ts"))).toBe(false);
    expect(snapshotState.trackedFileHashes?.some(([path]) => path.endsWith("/node_modules/large-types/index.d.ts"))).toBe(true);
    expect(prepared.index.relations).toContainEqual(expect.objectContaining({
      sourceFile: "app.ts",
      kind: "call",
      symbol: "items.map",
      targetRef: expect.objectContaining({ kind: "external" })
    }));

    await writeFile(join(root, "app.ts"), "export function read(items: string[]) { return items.join(','); }\n");
    const rebuilt = await buildSemanticIndex(await scanProject(root));
    expect(rebuilt.snapshot.inputState().trackedFileHashes.some(([path]) => path.endsWith("/node_modules/large-types/index.d.ts"))).toBe(false);
  });

  it("preserves automatically included ambient types while filtering external modules from the checker", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ambient-types-"));
    roots.push(root);
    const ambientTypesRoot = join(root, "node_modules", "@types", "runtime");
    await mkdir(ambientTypesRoot, { recursive: true });
    await writeFile(join(ambientTypesRoot, "index.d.ts"), "declare const ambientRuntime: { exit(): void };\n");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "CommonJS", moduleResolution: "Node" }, include: ["src"] }));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export function stop() { return ambientRuntime.exit(); }\n");

    const { index } = await buildSemanticIndex(await scanProject(root));

    expect(index.relations).toContainEqual(expect.objectContaining({
      sourceFile: "src/app.ts",
      kind: "call",
      symbol: "ambientRuntime.exit",
      targetRef: expect.objectContaining({ kind: "external" })
    }));
  });

  it("reuses unchanged external declaration hashes and detects same-timestamp edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-declaration-fingerprint-"));
    roots.push(root);
    const declarationPath = join(root, "node_modules", "dependency", "index.d.ts");
    await mkdir(dirname(declarationPath), { recursive: true });
    await writeFile(declarationPath, "export declare function execute(): number;\n");
    const original = createSourceSnapshot([]);
    original.trackFile(declarationPath);
    const originalFingerprint = original.fingerprint();
    const originalState = original.inputState();

    const unchanged = createSourceSnapshot([], originalState);
    unchanged.trackFile(declarationPath);
    expect(unchanged.fingerprint()).toBe(originalFingerprint);
    unchanged.validate();

    const fileStat = await stat(declarationPath);
    await writeFile(declarationPath, "export declare function execute(): string;\n");
    await utimes(declarationPath, fileStat.atime, fileStat.mtime);
    const modified = createSourceSnapshot([], originalState);
    modified.trackFile(declarationPath);
    expect(modified.fingerprint()).not.toBe(originalFingerprint);
    expect(() => original.validate()).toThrow(/external dependency/);
  });

  it("binds nested package exports and cross-file calls in all four languages", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-v5-workspace-"));
    roots.push(root);
    await cp(join(process.cwd(), "tests/fixtures/four-language-workspace"), root, { recursive: true });
    const project = await scanProject(root);
    const { index } = await buildSemanticIndex(project);
    for (const [sourceFile, targetFile] of [
      ["plugin/packages/dashboard/src/app.ts", "plugin/packages/core/src/service.ts"],
      ["python/src/sample/app.py", "python/src/sample/service.py"],
      ["java/src/main/java/example/App.java", "java/src/main/java/example/Service.java"],
      ["go/main.go", "go/service/service.go"]
    ]) {
      expect(index.relations, `${sourceFile} must bind the real declaration`).toContainEqual(
        expect.objectContaining({ kind: "call", sourceFile, targetFile, confidence: "confirmed" })
      );
    }
    expect(index.version).toBe(5);
    expect(index.relations.filter((relation) => relation.kind === "call" && relation.sourceFile === "plugin/packages/dashboard/src/app.ts")).toHaveLength(2);
    const { architectureMap, quality } = await buildStaticArchitecture(project, index);
    expect(architectureMap.version).toBe(3);
    expect(quality.valid).toBe(true);
    const again = (await buildSemanticIndex(await scanProject(root))).index;
    expect(again.relations).toEqual(index.relations);
  });
  it("invalidates custom extended configuration and same-timestamp source changes, and preserves valid artifacts on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-v5-invalidation-"));
    roots.push(root);
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: "./compiler-settings.json" }));
    await writeFile(join(root, "compiler-settings.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@service": ["./one.ts"] } } }));
    await writeFile(join(root, "app.ts"), 'import { load } from "@service"; export function run() { return load(); }');
    await writeFile(join(root, "one.ts"), 'export function load() { return "one"; }');
    await writeFile(join(root, "two.ts"), 'export function load() { return "two"; }');
    const firstProject = await scanProject(root);
    const first = await buildSemanticIndex(firstProject);
    const firstArchitecture = await buildStaticArchitecture(firstProject, first.index);
    const persisted = await generateProject(firstProject.rootPath, {});
    if (persisted.status === "superseded") throw new Error(`Project generation was superseded: ${persisted.requestId}`);
    expect(first.index.relations).toContainEqual(expect.objectContaining({ kind: "call", sourceFile: "app.ts", targetFile: "one.ts" }));
    await writeFile(join(root, "compiler-settings.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@service": ["./two.ts"] } } }));
    const secondProject = await scanProject(root);
    const second = await buildSemanticIndex(secondProject);
    const secondArchitecture = await buildStaticArchitecture(secondProject, second.index);
    expect(second.index.relations).toContainEqual(expect.objectContaining({ kind: "call", sourceFile: "app.ts", targetFile: "two.ts" }));
    expect(secondArchitecture.inputFingerprint).not.toBe(firstArchitecture.inputFingerprint);
    const prior = second.index.files.find((file) => file.path === "two.ts")!;
    await writeFile(join(root, "two.ts"), 'export function load() { return "new"; }');
    await utimes(join(root, "two.ts"), new Date(prior.modifiedAt), new Date(prior.modifiedAt));
    const third = await buildSemanticIndex(await scanProject(root));
    expect(third.delta.modified).toContain("two.ts");
    const previousSnapshot = await readFile(persisted.written.staticSnapshotPath, "utf8");
    await writeFile(join(root, "tsconfig.json"), '{ "extends":');
    await expect(buildSemanticIndex(await scanProject(root))).rejects.toThrow(/tsconfig.json/);
    expect(await readFile(persisted.written.staticSnapshotPath, "utf8")).toBe(previousSnapshot);
  });

});

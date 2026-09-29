import { cp, mkdtemp, rm, writeFile, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSemanticIndex } from "../../src/main/services/semantic-index.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { buildStaticArchitecture, persistStaticArchitecture } from "../../src/main/services/static-architecture.service";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("independent four-language static analysis", () => {
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
    const persisted = await persistStaticArchitecture(firstProject, firstArchitecture);
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
    const previousCanvas = await readFile(persisted.written.canvasJsonPath, "utf8");
    await expect(persistStaticArchitecture(firstProject, { ...firstArchitecture, quality: { ...firstArchitecture.quality, valid: false, reasons: ["invalid endpoint"] } })).rejects.toThrow(/previous artifacts were preserved/);
    expect(await readFile(persisted.written.canvasJsonPath, "utf8")).toBe(previousCanvas);
    await writeFile(join(root, "tsconfig.json"), '{ "extends":');
    await expect(buildSemanticIndex(await scanProject(root))).rejects.toThrow(/tsconfig.json/);
    expect(await readFile(persisted.written.canvasJsonPath, "utf8")).toBe(previousCanvas);
  });

});

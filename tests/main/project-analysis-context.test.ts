import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverProjectAnalysisContext } from "../../src/main/services/project-analysis-context.service";
import { generateProject } from "../../src/main/services/project-generation.service";
import { flattenProjectFilePaths } from "../../src/main/services/project-import-resolver.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { buildSemanticIndex } from "../../src/main/services/semantic-index.service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("discovers configured nested workspace and language roots from scanned files", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-analysis-context-"));
  roots.push(root);
  await cp(join(process.cwd(), "tests/fixtures/four-language-workspace"), root, { recursive: true });
  const context = await discoverProjectAnalysisContext(root, flattenProjectFilePaths((await scanProject(root)).files));
  expect(context.packages).toContainEqual(expect.objectContaining({
    name: "@fixture/core", rootPath: "plugin/packages/core", sourceRoot: "plugin/packages/core/src", outputRoot: "plugin/packages/core/dist"
  }));
  expect(context.scopes).toEqual(expect.arrayContaining([
    expect.objectContaining({ language: "python", rootPath: "python", sourceRoots: ["python/src"] }),
    expect.objectContaining({ language: "java", rootPath: "java", sourceRoots: ["java/src/main/java", "java/src/test/java"] }),
    expect.objectContaining({ language: "go", rootPath: "go", packageName: "example.com/fixture" })
  ]));
  expect(context.configurationPaths).toContain("plugin/pnpm-workspace.yaml");
});

it("accepts a pnpm settings file without package globs and rejects malformed declared globs", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-pnpm-settings-"));
  roots.push(root);
  await writeFile(join(root, "app.ts"), "export const app = 1;\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  await writeFile(join(root, "pnpm-workspace.yaml"), "minimumReleaseAge: 0\nallowBuilds:\n  esbuild: true\n");
  const files = flattenProjectFilePaths((await scanProject(root)).files);
  const context = await discoverProjectAnalysisContext(root, files);
  expect(context.scopes).toContainEqual(expect.objectContaining({ language: "typescript", paths: ["app.ts"] }));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: wrong-shape\n");
  await expect(discoverProjectAnalysisContext(root, files)).rejects.toThrow(/workspace packages/);
});

it("rejects malformed critical configuration instead of silently using different roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-invalid-config-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/app.py"), "print('test')\n");
  await writeFile(join(root, "pyproject.toml"), "[project\nname = 'broken'\n");
  await expect(discoverProjectAnalysisContext(root, flattenProjectFilePaths((await scanProject(root)).files)))
    .rejects.toThrow(/pyproject.toml/);
});

it("reads standard TOML array tables and multiline values without executing project configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-array-table-config-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/app.py"), "print('test')\n");
  await writeFile(join(root, "pyproject.toml"), [
    "[project]",
    'name = "fixture"',
    'description = """first line',
    'second line"""',
    "[[tool.poetry.source]]",
    'name = "primary"',
    "[[tool.poetry.source]]",
    'name = "secondary"',
    ""
  ].join("\n"));
  const context = await discoverProjectAnalysisContext(root, flattenProjectFilePaths((await scanProject(root)).files));
  expect(context.scopes).toContainEqual(expect.objectContaining({ language: "python", rootPath: "", sourceRoots: ["src"] }));
});

it("accepts a project-level license-files array in pyproject.toml", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-pyproject-license-files-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/app.py"), "def app():\n    return None\n");
  await writeFile(join(root, "pyproject.toml"), [
    "[project]",
    'name = "fixture"',
    'version = "1.0.0"',
    'description = "Static analysis fixture"',
    'requires-python = ">=3.10"',
    'readme = "README.md"',
    'license-files = ["LICENSE.txt"]',
    ""
  ].join("\n"));

  const context = await discoverProjectAnalysisContext(root, flattenProjectFilePaths((await scanProject(root)).files));

  expect(context.scopes).toContainEqual(expect.objectContaining({ language: "python", rootPath: "", sourceRoots: ["src"] }));
});

it("rejects malformed TOML arrays while allowing a trailing comma", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-pyproject-malformed-array-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/app.py"), "def app():\n    return None\n");
  await writeFile(join(root, "pyproject.toml"), [
    "[project]",
    'name = "fixture"',
    'license-files = ["LICENSE.txt",]',
    ""
  ].join("\n"));
  const files = flattenProjectFilePaths((await scanProject(root)).files);
  await expect(discoverProjectAnalysisContext(root, files)).resolves.toEqual(expect.objectContaining({
    scopes: expect.arrayContaining([expect.objectContaining({ language: "python", rootPath: "", sourceRoots: ["src"] })])
  }));

  await writeFile(join(root, "pyproject.toml"), [
    "[project]",
    'name = "fixture"',
    'license-files = ["LICENSE.txt",,]',
    ""
  ].join("\n"));
  await expect(discoverProjectAnalysisContext(root, files)).rejects.toThrow(/pyproject\.toml/);
});

it("commits a generated project without executing JavaScript configuration or package scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-static-config-safety-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  const configSentinel = join(root, "vite-config-executed.txt");
  const lifecycleSentinel = join(root, "lifecycle-executed.txt");
  await writeFile(join(root, "src/app.js"), "export const value = 1;\n");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "static-config-safety-fixture",
    scripts: {
      prepare: "node lifecycle.cjs"
    }
  }));
  await writeFile(join(root, "lifecycle.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(lifecycleSentinel)}, "executed");\n`);
  await writeFile(join(root, "vite.config.js"), [
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(configSentinel)}, "executed");`,
    "module.exports = {};"
  ].join("\n"));

  const project = await scanProject(root);
  const context = await discoverProjectAnalysisContext(root, flattenProjectFilePaths(project.files));

  expect(flattenProjectFilePaths(project.files)).toContain("vite.config.js");
  expect(context.packages).toContainEqual(expect.objectContaining({ name: "static-config-safety-fixture" }));
  const generated = await generateProject(root, {});
  expect(generated.status).toBe("committed");
  await expect(readFile(configSentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(lifecycleSentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  // Positive controls run only after generation: both synthetic probes must detect execution.
  execFileSync(process.execPath, [join(root, "vite.config.js")]);
  execFileSync(process.execPath, [join(root, "lifecycle.cjs")]);
  expect(await readFile(configSentinel, "utf8")).toBe("executed");
  expect(await readFile(lifecycleSentinel, "utf8")).toBe("executed");
});

it("reads Maven plugin configuration containing self-closing elements", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-maven-self-closing-"));
  roots.push(root);
  await mkdir(join(root, "src/main/java/example"), { recursive: true });
  await writeFile(join(root, "src/main/java/example/App.java"), "package example; public class App {}\n");
  await writeFile(join(root, "pom.xml"), `<project><groupId>example</groupId><artifactId>cli</artifactId>
<build><plugins><plugin><executions><execution><configuration>
<exec executable="svn"><arg value="status"/></exec>
</configuration></execution></executions></plugin></plugins></build></project>`);
  const context = await discoverProjectAnalysisContext(root, flattenProjectFilePaths((await scanProject(root)).files));
  expect(context.scopes).toContainEqual(expect.objectContaining({ language: "java", rootPath: "" }));
});

it("analyzes inherited newer TypeScript options as located warnings while retaining configured source bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-newer-tsconfig-"));
  roots.push(root);
  await mkdir(join(root, "config"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "packages/core/src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }));
  await writeFile(join(root, "config/tsconfig.base.json"), JSON.stringify({
    compilerOptions: {
      stableTypeOrdering: true, targt: "ES2022", target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
      rootDir: "../src", outDir: "../dist", baseUrl: "..", paths: { "@app/*": ["src/*"] }
    },
    include: ["../src/**/*.ts"]
  }, null, 2));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: "./config/tsconfig.base.json" }));
  await writeFile(join(root, "packages/core/package.json"), JSON.stringify({ name: "@fixture/core", exports: "./dist/index.js" }));
  await writeFile(join(root, "packages/core/tsconfig.json"), JSON.stringify({
    extends: "../../config/tsconfig.base.json", compilerOptions: { rootDir: "src", outDir: "dist" }, include: ["src/**/*.ts"]
  }));
  await writeFile(join(root, "packages/core/src/index.ts"), "export const core = 1;\n");
  await writeFile(join(root, "src/helper.ts"), "export const helper = 1;\n");
  const sentinel = join(root, "source-executed.txt");
  await writeFile(join(root, "src/app.ts"), [
    'import { writeFileSync } from "node:fs";',
    'import { core } from "@fixture/core";',
    'import { helper } from "@app/helper";',
    `writeFileSync(${JSON.stringify(sentinel)}, "executed");`,
    "export const app = core + helper;"
  ].join("\n"));
  const project = await scanProject(root);
  const context = await discoverProjectAnalysisContext(root, flattenProjectFilePaths(project.files));
  expect(context.packages).toContainEqual(expect.objectContaining({ name: "fixture", sourceRoot: "src", outputRoot: "dist" }));
  expect(context.configurationPaths).toContain("config/tsconfig.base.json");
  const { index } = await buildSemanticIndex(project);
  for (const [code, option, line, endColumn] of [["typescript-5023", "stableTypeOrdering", 3, 25], ["typescript-5025", "targt", 4, 12]] as const) {
    expect(index.diagnostics).toContainEqual(expect.objectContaining({
      code, severity: "warning", stage: "binding", filePath: "config/tsconfig.base.json", message: expect.stringContaining(option),
      range: { start: { line, column: 5 }, end: { line, column: endColumn } }
    }));
  }
  expect(index.relations).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "import", sourceFile: "src/app.ts", targetFile: "src/helper.ts", targetRef: { kind: "file", filePath: "src/helper.ts" } }),
    expect.objectContaining({ kind: "import", sourceFile: "src/app.ts", targetFile: "packages/core/src/index.ts", targetRef: { kind: "file", filePath: "packages/core/src/index.ts" } })
  ]));
  await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it.each<[string, RegExp]>([
  ['{"compilerOptions":{"stableTypeOrdering":true,"rootDir":42}}', /rootDir/],
  ['{"extends":"./missing-config.json","compilerOptions":{"stableTypeOrdering":true}}', /missing-config/],
  ['bad json', /expected/]
])("rejects invalid TypeScript configuration despite unknown options: %s", async (content, error) => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-invalid-tsconfig-"));
  roots.push(root);
  await writeFile(join(root, "app.ts"), "export const app = 1;\n");
  await writeFile(join(root, "tsconfig.json"), content);
  const files = flattenProjectFilePaths((await scanProject(root)).files);
  await expect(discoverProjectAnalysisContext(root, files)).rejects.toThrow(error);
});

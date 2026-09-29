import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverProjectAnalysisContext } from "../../src/main/services/project-analysis-context.service";
import { flattenProjectFilePaths } from "../../src/main/services/project-import-resolver.service";
import { scanProject } from "../../src/main/services/project-scanner.service";

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

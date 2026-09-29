import { generateProject } from "../../src/main/services/project-generation.service";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSemanticIndex, semanticAnalysisScopes } from "../../src/main/services/semantic-index.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { analyzeTypeScriptProject } from "../../src/main/services/typescript-semantic.service";
import type { ProjectAnalysisContext, SemanticFile } from "../../src/types";

function scannedFile(path: string): SemanticFile {
  return { path, size: 0, modifiedAt: "", contentHash: "", cacheKey: "", analyzerId: "typescript", analysisDepth: "semantic", status: "parsed", diagnostics: [], httpEndpoints: [], renderTargets: [] };
}

function analysisContext(paths: string[]): ProjectAnalysisContext {
  return { scopes: [{ id: "ts:test", language: "typescript", rootPath: "", sourceRoots: [""], paths, configurationPaths: [] }], packages: [], configurationPaths: [], diagnostics: [] };
}

describe("typescript semantic analysis", () => {
  it("binds nested exported build paths to proven sources and retains both call sites", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-export-binding-"));
    await cp(join(process.cwd(), "tests/fixtures/four-language-workspace/plugin"), join(root, "plugin"), { recursive: true });
    const path = "plugin/packages/dashboard/src/app.ts";
    const context = analysisContext([path, "plugin/packages/core/src/service.ts", "plugin/packages/core/src/index.ts"]);
    context.packages = [{ name: "@fixture/core", rootPath: "plugin/packages/core", manifestPath: "plugin/packages/core/package.json", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./service": { types: "./dist/service.d.ts", default: "./dist/service.js" } }, sourceRoot: "plugin/packages/core/src", outputRoot: "plugin/packages/core/dist", dependencies: [] }];
    const result = analyzeTypeScriptProject(root, join(root, "plugin/packages/dashboard"), [scannedFile("src/app.ts")], context);
    const calls = result.relations.filter((relation) => relation.kind === "call");
    expect(calls).toHaveLength(2);
    expect(calls.map((relation) => relation.sourceRange?.start)).toEqual([{ line: 3, column: 23 }, { line: 4, column: 10 }]);
    expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({ targetFile: "plugin/packages/core/src/service.ts", targetRef: expect.objectContaining({ kind: "file", symbolId: expect.any(String), declarationRange: expect.any(Object) }), bindingBasis: "typescript-checker" })]));
    expect(result.symbolsByFile.has("plugin/packages/core/src/service.ts")).toBe(false);
  });

  it("recognizes imported filesystem identity and CommonJS bindings without mistaking shadowed names", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-api-binding-"));
    await writeFile(join(root, "app.ts"), "import { readFile as load } from 'node:fs/promises';\nload('real.txt');\nfunction local(load: (name: string) => void) { load('fake.txt'); }\nconst { exec: run } = require('node:child_process');\nrun('echo fixture');\n");
    const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], analysisContext(["app.ts"]));
    expect(result.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "filesystem", moduleName: "node:fs/promises", apiName: "readFile", target: "real.txt", operation: "read" }),
      expect.objectContaining({ kind: "process", apiName: "exec", target: "echo fixture" })
    ]));
    expect(result.operations.filter((operation) => operation.kind === "filesystem")).toHaveLength(1);
  });

  it("reports malformed TypeScript configuration instead of changing resolution silently", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-invalid-config-"));
    await writeFile(join(root, "app.ts"), "export const app = true;\n");
    await writeFile(join(root, "tsconfig.json"), "{ compilerOptions: { bad: }\n");
    expect(() => analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], analysisContext(["app.ts"]))).toThrow(/tsconfig.json/);
  });

  it("binds CommonJS project calls and leaves private package subpaths unresolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-commonjs-binding-"));
    await mkdir(join(root, "pkg/src"), { recursive: true });
    await writeFile(join(root, "pkg/src/index.ts"), "export function load() { return true; }\n");
    await writeFile(join(root, "pkg/src/private.ts"), "export function secret() { return true; }\n");
    await writeFile(join(root, "app.ts"), "const { load: run } = require('@fixture/pkg');\nrun();\nimport { secret } from '@fixture/pkg/private';\nsecret();\n");
    const context = { ...analysisContext(["app.ts", "pkg/src/index.ts", "pkg/src/private.ts"]), packages: [{ name: "@fixture/pkg", rootPath: "pkg", manifestPath: "pkg/package.json", exports: { ".": "./src/index.ts", "./private": null }, dependencies: [] }] };
    const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], context);
    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "call", symbol: "run", targetFile: "pkg/src/index.ts" }),
      expect.objectContaining({ kind: "import", symbol: "@fixture/pkg/private", targetRef: expect.objectContaining({ kind: "unresolved" }) }),
      expect.objectContaining({ kind: "call", symbol: "secret", targetRef: expect.objectContaining({ kind: "unresolved" }) })
    ]));
    expect(result.relations.some((relation) => relation.targetFile === "pkg/src/private.ts")).toBe(false);
  });

  it("keeps emitter instances separate, validates API members, and retains unknown operation targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-operation-identities-"));
    await writeFile(join(root, "app.ts"), "import { EventEmitter } from 'node:events';\nimport axios from 'axios';\nimport * as fs from 'node:fs';\nconst first = new EventEmitter(); const second = new EventEmitter();\nfirst.emit('ready'); second.on('ready', () => {});\nfunction unknown(path: string) { fs.readFile(path); }\nconst client = axios.create({ baseURL: 'https://fixture.test' });\nclient.post('/users');\nconst local = { emit(name: string) {} }; local.emit('ready');\nfs.fake.readFile('fake.txt');\n");
    const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], analysisContext(["app.ts"]));
    const events = result.operations.filter((operation) => operation.kind === "event");
    expect(events).toHaveLength(2);
    expect(events[0].receiverId).not.toBe(events[1].receiverId);
    expect(result.operations.filter((operation) => operation.kind === "filesystem")).toEqual([expect.objectContaining({ target: undefined })]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "unresolved-operation-target" }));
    expect(result.operations.filter((operation) => operation.kind === "http")).toEqual([expect.objectContaining({ method: "POST", target: "https://fixture.test/users", origin: "https://fixture.test" })]);
  });

  it("uses inherited alternate compiler configurations and import versus require export conditions", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-config-conditions-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "pkg"));
    await writeFile(join(root, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", baseUrl: ".", paths: { "@service": ["src/service.ts"] } } }));
    await writeFile(join(root, "tsconfig.build.json"), JSON.stringify({ extends: "./tsconfig.base.json", include: ["src"] }));
    await writeFile(join(root, "src/service.ts"), "export function local() {}\n");
    await writeFile(join(root, "pkg/import.ts"), "export function mode() {}\n");
    await writeFile(join(root, "pkg/require.ts"), "export function mode() {}\n");
    await writeFile(join(root, "src/app.ts"), "import { local } from '@service';\nimport { mode } from '@fixture/conditional';\nconst { mode: common } = require('@fixture/conditional');\nlocal(); mode(); common();\n");
    const context = { ...analysisContext(["src/app.ts", "src/service.ts", "pkg/import.ts", "pkg/require.ts"]), packages: [{ name: "@fixture/conditional", rootPath: "pkg", manifestPath: "pkg/package.json", exports: { ".": { import: "./import.ts", require: "./require.ts" } }, dependencies: [] }], scopes: [{ id: "ts:test", language: "typescript" as const, rootPath: "", sourceRoots: ["src"], paths: ["src/app.ts", "src/service.ts", "pkg/import.ts", "pkg/require.ts"], configurationPaths: ["tsconfig.build.json"] }] };
    const result = analyzeTypeScriptProject(root, root, [scannedFile("src/app.ts")], context);
    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "call", symbol: "local", targetFile: "src/service.ts" }),
      expect.objectContaining({ kind: "call", symbol: "mode", targetFile: "pkg/import.ts" }),
      expect.objectContaining({ kind: "call", symbol: "common", targetFile: "pkg/require.ts" })
    ]));
  });

  it("does not infer implementation calls from declaration-only package exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-declaration-only-"));
    await mkdir(join(root, "pkg"));
    await writeFile(join(root, "pkg/index.d.ts"), "export declare function load(): void;\n");
    await writeFile(join(root, "pkg/index.ts"), "export function load() {}\n");
    await writeFile(join(root, "app.ts"), "import { load } from '@fixture/decl';\nload();\n");
    const context = { ...analysisContext(["app.ts", "pkg/index.d.ts", "pkg/index.ts"]), packages: [{ name: "@fixture/decl", rootPath: "pkg", manifestPath: "pkg/package.json", exports: { ".": { types: "./index.d.ts", import: "./index.ts" } }, dependencies: [] }] };
    const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], context);
    expect(result.relations.filter((relation) => relation.kind === "call")).toEqual([expect.objectContaining({ targetRef: expect.objectContaining({ kind: "unresolved" }) })]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "declaration-only-call" }));
  });

  it("links callable references to the same symbol IDs as arrow and overload implementations", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-symbol-identity-"));
    await writeFile(join(root, "service.ts"), "export const arrow = () => true;\nexport function overloaded(value: string): string;\nexport function overloaded(value: string) { return value; }\n");
    await writeFile(join(root, "app.ts"), "import { arrow, overloaded } from './service';\narrow(); overloaded('value');\n");
    const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts"), scannedFile("service.ts")], analysisContext(["app.ts", "service.ts"]));
    const symbols = result.symbolsByFile.get("service.ts") ?? [];
    const calls = result.relations.filter((relation) => relation.kind === "call");
    expect(calls.find((relation) => relation.symbol === "arrow")?.targetRef).toEqual(expect.objectContaining({ symbolId: symbols.find((symbol) => symbol.name === "arrow")?.id }));
    expect(calls.find((relation) => relation.symbol === "overloaded")?.targetRef).toEqual(expect.objectContaining({ symbolId: symbols.find((symbol) => symbol.name === "overloaded" && symbol.line === 3)?.id, declarationRange: expect.objectContaining({ start: { line: 3, column: 1 } }) }));
  });

  it("retains dispositions for dynamic imports, unresolved inheritance and JSX, and standard library calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-reference-dispositions-"));
    await writeFile(join(root, "app.tsx"), "import { join } from 'node:path';\njoin('a', 'b');\nfunction load(name: string) { return import(name); }\nclass Child extends Missing {}\nconst view = <Missing />; const intrinsic = <div />;\n");
    const result = analyzeTypeScriptProject(root, root, [scannedFile("app.tsx")], analysisContext(["app.tsx"]));
    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "call", symbol: "join", targetRef: expect.objectContaining({ kind: "external", moduleName: "node:path" }) }),
      expect.objectContaining({ kind: "import", symbol: "name", targetRef: expect.objectContaining({ kind: "unresolved" }) }),
      expect.objectContaining({ kind: "inherit", symbol: "Missing", targetRef: expect.objectContaining({ kind: "unresolved" }) }),
      expect.objectContaining({ kind: "render", symbol: "Missing", targetRef: expect.objectContaining({ kind: "unresolved" }) })
    ]));
    expect(result.relations.every((relation) => relation.sourceRange)).toBe(true);
    expect(result.relations.some((relation) => relation.symbol === "div")).toBe(false);
  });

  it("selects a duplicate package only through its containing workspace and rejects equally visible duplicates", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-workspace-visibility-"));
    for (const directory of ["outer", "nested/one", "nested/two"]) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, "index.ts"), "export function load() {}\n");
    }
    await writeFile(join(root, "nested/app.ts"), "import { load } from '@fixture/duplicate';\nload();\n");
    const paths = ["outer/index.ts", "nested/one/index.ts", "nested/two/index.ts", "nested/app.ts"];
    const outer = { name: "@fixture/duplicate", rootPath: "outer", workspaceRoot: "", manifestPath: "outer/package.json", exports: "./index.ts", dependencies: [] };
    const nested = { ...outer, rootPath: "nested/one", workspaceRoot: "nested", manifestPath: "nested/one/package.json" };
    const files = [scannedFile("nested/app.ts")];
    const resolved = analyzeTypeScriptProject(root, root, files, { ...analysisContext(paths), packages: [outer, nested] });
    expect(resolved.relations).toContainEqual(expect.objectContaining({ kind: "call", targetFile: "nested/one/index.ts" }));
    const ambiguous = analyzeTypeScriptProject(root, root, files, { ...analysisContext(paths), packages: [outer, nested, { ...nested, rootPath: "nested/two", manifestPath: "nested/two/package.json" }] });
    expect(ambiguous.relations.find((relation) => relation.kind === "import")?.targetRef).toEqual(expect.objectContaining({ kind: "unresolved", reason: expect.stringContaining("ambiguous") }));
  });

  it("follows exported emitter instances and keeps literal SQL for resource binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-exported-receivers-"));
    await writeFile(join(root, "shared.ts"), "import { EventEmitter } from 'node:events';\nexport const emitter = new EventEmitter();\nemitter.emit('ready');\n");
    await writeFile(join(root, "app.ts"), "import { emitter } from './shared';\nimport { Pool } from 'pg';\nemitter.on('ready', () => {});\nconst db = new Pool(); db.query('SELECT * FROM users');\n");
    const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts"), scannedFile("shared.ts")], analysisContext(["app.ts", "shared.ts"]));
    const events = result.operations.filter((operation) => operation.kind === "event");
    expect(events).toHaveLength(2);
    expect(events[0].receiverId).toBe(events[1].receiverId);
    expect(result.operations).toContainEqual(expect.objectContaining({ kind: "database", target: "SELECT * FROM users", operation: "read", apiName: "query" }));
  });

  it("binds sources using referenced compiler projects rather than an unrelated base configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-project-references-"));
    await mkdir(join(root, "worker"));
    await writeFile(join(root, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@service": ["missing.ts"] } } }));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "./tsconfig.worker.json" }] }));
    await writeFile(join(root, "tsconfig.worker.json"), JSON.stringify({ compilerOptions: { composite: true, baseUrl: ".", paths: { "@service": ["worker/service.ts"] } }, include: ["worker"] }));
    await writeFile(join(root, "worker/service.ts"), "export function service() {}\n");
    await writeFile(join(root, "worker/app.ts"), "import { service } from '@service';\nservice();\n");
    const scope = { ...analysisContext(["worker/app.ts", "worker/service.ts"]).scopes[0], configurationPaths: ["tsconfig.base.json", "tsconfig.json", "tsconfig.worker.json"] };
    const context = { ...analysisContext(scope.paths), scopes: [scope] };
    const result = analyzeTypeScriptProject(root, root, scope.paths.map(scannedFile), context);
    expect(result.relations).toContainEqual(expect.objectContaining({ kind: "call", symbol: "service", targetFile: "worker/service.ts" }));
  });

  it("does not guess HTTP methods or APIs from mutable aliases and local package names", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-api-certainty-"));
    await mkdir(join(root, "pkg"));
    await writeFile(join(root, "pkg/index.ts"), "export default { get(path: string) { return path; } };\n");
    await writeFile(join(root, "app.ts"), "import axios from 'axios';\nimport * as fs from 'node:fs';\nlet mutable = fs; mutable.readFile('uncertain.txt');\naxios.get('/local');\nconst options = { method: 'POST' }; fetch('/known', options);\nfunction request(method: string) { fetch('/unknown', { method }); }\n");
    const context = { ...analysisContext(["app.ts", "pkg/index.ts"]), packages: [{ name: "axios", rootPath: "pkg", manifestPath: "pkg/package.json", exports: "./index.ts", dependencies: [] }] };
    const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], context);
    expect(result.operations).toEqual([
      expect.objectContaining({ kind: "http", method: "POST", target: "/known" }),
      expect.objectContaining({ kind: "http", method: "UNKNOWN", target: "/unknown" })
    ]);
    expect(result.relations).toContainEqual(expect.objectContaining({ kind: "call", symbol: "axios.get", targetFile: "pkg/index.ts" }));
  });

  it("recognizes literal SQL template APIs and Prisma models through imported client identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-sql-identities-"));
    await writeFile(join(root, "app.ts"), "import postgres from 'postgres';\nimport { PrismaClient } from '@prisma/client';\nconst sql = postgres(); sql`SELECT * FROM users`;\nconst prisma = new PrismaClient(); prisma.user.findMany();\nfunction dynamic(id: string) { sql`SELECT * FROM users WHERE id = ${id}`; }\nconst fake = { user: { findMany() {} } }; fake.user.findMany();\n");
    const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], analysisContext(["app.ts"]));
    expect(result.operations.filter((operation) => operation.kind === "database")).toEqual([
      expect.objectContaining({ moduleName: "postgres", target: "SELECT * FROM users", operation: "read" }),
      expect.objectContaining({ moduleName: "@prisma/client", apiName: "findMany", target: "user", operation: "read" }),
      expect.objectContaining({ moduleName: "postgres", target: undefined, operation: "invoke" })
    ]);
  });

  it("does not turn type-only imports into runtime implementation calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ts-type-only-runtime-"));
    await writeFile(join(root, "service.ts"), "export function service() {}\n");
    await writeFile(join(root, "app.ts"), "import type { service } from './service';\nservice();\n");
    const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], analysisContext(["app.ts", "service.ts"]));
    expect(result.relations).toContainEqual(expect.objectContaining({ kind: "import", importUsage: "type", targetFile: "service.ts" }));
    expect(result.relations.filter((relation) => relation.kind === "call")).toEqual([expect.objectContaining({ importUsage: "value", targetRef: expect.objectContaining({ kind: "unresolved", reason: expect.stringContaining("type-only") }) })]);
  });
  it("assigns files to their nearest TypeScript configuration root", () => {
    expect(semanticAnalysisScopes([
      "vite.config.ts",
      "claude-code-main/package.json",
      "claude-code-main/tsconfig.json",
      "claude-code-main/src/app.ts",
      "claude-code-main/src/service.ts"
    ], [
      "vite.config.ts",
      "claude-code-main/src/app.ts",
      "claude-code-main/src/service.ts"
    ])).toEqual([
      { configurationRoot: "", paths: ["vite.config.ts"] },
      { configurationRoot: "claude-code-main", paths: ["claude-code-main/src/app.ts", "claude-code-main/src/service.ts"] }
    ]);
  });

  it("keeps nested project relations stable when the parent also has root-level source", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-parent-child-"));
    const child = join(root, "claude-code-main");
    await mkdir(join(child, "src"), { recursive: true });
    await writeFile(join(root, "vite.config.ts"), "export const config = true;\n", "utf8");
    await writeFile(join(child, "package.json"), "{}\n", "utf8");
    await writeFile(join(child, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } }
    }), "utf8");
    await writeFile(join(child, "src", "service.ts"), "export const service = () => true;\n", "utf8");
    await writeFile(join(child, "src", "app.ts"), "import { service } from '@/service';\nexport const app = () => service();\n", "utf8");

    const parentIndex = (await buildSemanticIndex(await scanProject(root))).index;
    const childIndex = (await buildSemanticIndex(await scanProject(child))).index;
    const parentRelations = parentIndex.relations
      .filter((relation) => relation.sourceFile.startsWith("claude-code-main/"))
      .map((relation) => ({
        ...relation,
        source: relation.source.replace("claude-code-main/", ""),
        target: relation.target.replace("claude-code-main/", ""),
        sourceFile: relation.sourceFile.replace("claude-code-main/", ""),
        targetFile: relation.targetFile?.replace("claude-code-main/", "")
      }));

    expect(parentRelations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "import", sourceFile: "src/app.ts", targetFile: "src/service.ts" }),
      expect.objectContaining({ kind: "call", sourceFile: "src/app.ts", targetFile: "src/service.ts" })
    ]));
    const relationKey = (relation: typeof childIndex.relations[number]) =>
      `${relation.kind}\u0000${relation.source}\u0000${relation.target}\u0000${relation.sourceFile}\u0000${relation.targetFile ?? ""}\u0000${relation.symbol ?? ""}`;
    expect(childIndex.relations.map(relationKey)).toEqual(expect.arrayContaining(parentRelations.map(relationKey)));
  });

  it("merges independent configured projects with their own aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-multi-project-"));
    for (const project of ["api", "worker"]) {
      await mkdir(join(root, project, "src"), { recursive: true });
      await writeFile(join(root, project, "tsconfig.json"), JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } }
      }), "utf8");
      await writeFile(join(root, project, "src", "service.ts"), `export const ${project}Service = () => true;\n`, "utf8");
      await writeFile(join(root, project, "src", "app.ts"), `import { ${project}Service } from '@/service';\nexport const app = () => ${project}Service();\n`, "utf8");
    }

    const { index } = await buildSemanticIndex(await scanProject(root));

    expect(index.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "call", sourceFile: "api/src/app.ts", targetFile: "api/src/service.ts" }),
      expect.objectContaining({ kind: "call", sourceFile: "worker/src/app.ts", targetFile: "worker/src/service.ts" })
    ]));
  });

  it("resolves tsconfig aliases, cross-file calls, inheritance, JSX renders, and signatures", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-typescript-semantic-"));
    await mkdir(join(root, "src", "components"), { recursive: true });
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
        jsx: "react-jsx"
      },
      include: ["src"]
    }), "utf8");
    await writeFile(join(root, "src", "service.ts"), `
export class BaseService {}
export class UserService extends BaseService {
  load(id: string): Promise<string> { return Promise.resolve(id); }
}
export const userService = new UserService();
`, "utf8");
    await writeFile(join(root, "src", "components", "User.tsx"), `
import { userService } from "@/service";
export function User(props: { id: string }) {
  userService.load(props.id);
  return <div>{props.id}</div>;
}
`, "utf8");
    await writeFile(join(root, "src", "App.tsx"), `
import { User } from "@/components/User";
export const App = () => <User id="1" />;
`, "utf8");

    const { index } = await buildSemanticIndex(await scanProject(root));

    expect(index.files.find((file) => file.path === "src/service.ts")?.analysisDepth).toBe("semantic");
    expect(index.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "load", signature: expect.stringContaining("Promise<string>") })
    ]));
    expect(index.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "import", sourceFile: "src/App.tsx", targetFile: "src/components/User.tsx" }),
      expect.objectContaining({ kind: "call", sourceFile: "src/components/User.tsx", targetFile: "src/service.ts" }),
      expect.objectContaining({ kind: "inherit", sourceFile: "src/service.ts", targetFile: "src/service.ts" }),
      expect.objectContaining({ kind: "render", sourceFile: "src/App.tsx", targetFile: "src/components/User.tsx" })
    ]));
    expect(index.relations.filter((relation) => relation.kind === "import" && relation.sourceFile === "src/App.tsx")).toEqual([
      expect.objectContaining({ targetFile: "src/components/User.tsx", confidence: "confirmed" })
    ]);
  });

  it("invalidates linked relations when tsconfig aliases change", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-typescript-config-"));
    await mkdir(join(root, "src", "one"), { recursive: true });
    await mkdir(join(root, "src", "two"), { recursive: true });
    await writeFile(join(root, "src", "one", "service.ts"), "export const service = () => 'one';\n", "utf8");
    await writeFile(join(root, "src", "two", "service.ts"), "export const service = () => 'two';\n", "utf8");
    await writeFile(join(root, "src", "app.ts"), "import { service } from '@/service';\nexport const app = service();\n", "utf8");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/one/*"] } }
    }), "utf8");

    const first = await generateProject(root, {});
    if (first.status !== "committed") throw new Error("Expected committed generation");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/two/*"] } }
    }), "utf8");
    const second = await buildSemanticIndex(await scanProject(root));

    expect(first.index.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "import", sourceFile: "src/app.ts", targetFile: "src/one/service.ts" })
    ]));
    expect(second.delta.unchanged).toContain("src/app.ts");
    expect(second.index.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "import", sourceFile: "src/app.ts", targetFile: "src/two/service.ts" })
    ]));
  });

  it("invalidates the semantic index when a nested configuration changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-nested-config-"));
    const child = join(root, "app");
    await mkdir(join(child, "src", "one"), { recursive: true });
    await mkdir(join(child, "src", "two"), { recursive: true });
    await writeFile(join(child, "src", "one", "service.ts"), "export const service = () => 'one';\n", "utf8");
    await writeFile(join(child, "src", "two", "service.ts"), "export const service = () => 'two';\n", "utf8");
    await writeFile(join(child, "src", "app.ts"), "import { service } from '@/service';\nexport const app = service();\n", "utf8");
    await writeFile(join(child, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/one/*"] } }
    }), "utf8");

    const first = await buildSemanticIndex(await scanProject(root));
    await writeFile(join(child, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/two/*"] } }
    }), "utf8");
    const second = await buildSemanticIndex(await scanProject(root));

    expect(first.index.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "import", sourceFile: "app/src/app.ts", targetFile: "app/src/one/service.ts" })
    ]));
    expect(second.index.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "import", sourceFile: "app/src/app.ts", targetFile: "app/src/two/service.ts" })
    ]));
  });

  it("rebuilds an outdated semantic index instead of reusing syntax-only cache entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-typescript-upgrade-"));
    await writeFile(join(root, "service.ts"), "export const service = () => true;\n", "utf8");
    await writeFile(join(root, "app.ts"), "import { service } from './service';\nexport const app = () => service();\n", "utf8");
    const first = await generateProject(root, {});
    if (first.status !== "committed") throw new Error("Expected committed generation");
    const manifestPath = join(root, ".flowweave", "index", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: number };
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: 1 })}\n`, "utf8");

    const rebuilt = await buildSemanticIndex(await scanProject(root));

    expect(first.index.files.every((file) => file.analysisDepth === "semantic")).toBe(true);
    expect(rebuilt.delta.added).toEqual(["app.ts", "service.ts"]);
    expect(rebuilt.index.files.every((file) => file.analysisDepth === "semantic")).toBe(true);
  });

  it("resolves workspace package exports, re-exports, and dynamic imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-typescript-workspace-"));
    await mkdir(join(root, "apps", "web", "src"), { recursive: true });
    await mkdir(join(root, "packages", "shared", "src"), { recursive: true });
    await writeFile(join(root, "packages", "shared", "package.json"), JSON.stringify({
      name: "@flow/shared",
      exports: { ".": { types: "./src/index.ts", import: "./src/index.ts" } }
    }), "utf8");
    await writeFile(join(root, "packages", "shared", "src", "value.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "packages", "shared", "src", "index.ts"), "export { value } from './value';\n", "utf8");
    await writeFile(
      join(root, "apps", "web", "src", "app.ts"),
      "export async function load() { return import('@flow/shared'); }\n",
      "utf8"
    );

    const { index } = await buildSemanticIndex(await scanProject(root));

    expect(index.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "import",
        sourceFile: "apps/web/src/app.ts",
        targetFile: "packages/shared/src/index.ts"
      }),
      expect.objectContaining({
        kind: "import",
        sourceFile: "packages/shared/src/index.ts",
        targetFile: "packages/shared/src/value.ts"
      })
    ]));
  });
});

it("retains both filesystem roles and resolves explicit open modes without inventing defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-ts-fs-roles-"));
  await writeFile(join(root, "app.ts"), "import * as fs from 'node:fs';\nfs.copyFile('/a', '/b', () => {});\nfs.rename('/a', '/b', () => {});\nfs.open('/c', 'r+', () => {});\nfs.openSync('/d', 0);\nfs.openSync('/e', fs.constants.O_RDWR | fs.constants.O_CREAT);\nfs.openSync('/f', fs.constants.O_TRUNC);\nfs.openSync('/g', fs.constants.O_CREAT);\nfunction uncertain(flags: string, path: string) { fs.open(path, flags, () => {}); }\n");
  const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], analysisContext(["app.ts"]));
  expect(result.operations.filter((item) => item.apiName === "copyFile")).toEqual([expect.objectContaining({ target: "/a", operation: "read", role: "source" }), expect.objectContaining({ target: "/b", operation: "write", role: "target" })]);
  expect(result.operations.filter((item) => item.apiName === "rename")).toEqual([expect.objectContaining({ target: "/a", operation: "write", role: "source" }), expect.objectContaining({ target: "/b", operation: "write", role: "target" })]);
  expect(result.operations.filter((item) => item.target === "/c").map((item) => item.operation)).toEqual(["read", "write"]);
  expect(result.operations.filter((item) => item.target === "/d").map((item) => item.operation)).toEqual(["read"]);
  expect(result.operations.filter((item) => item.target === "/e").map((item) => item.operation)).toEqual(["read", "write"]);
  expect(result.operations.filter((item) => item.target === "/f").map((item) => item.operation)).toEqual(["write"]);
  expect(result.operations.filter((item) => item.target === "/g").map((item) => item.operation)).toEqual(["read", "write"]);
  expect(result.operations.find((item) => item.range.start.line === 9)).toMatchObject({ operation: "invoke", unresolvedReason: expect.any(String) });
});

it("executes prepared SQLite SQL at execution sites, preserving database identity across aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-ts-sqlite-"));
  await writeFile(join(root, "app.ts"), "import sqlite3 from 'sqlite3';\nimport Database from 'better-sqlite3';\nconst db = new sqlite3.Database(':memory:');\nconst alias = db; const stmt = alias.prepare('SELECT * FROM users WHERE id = ?');\nstmt.get('not SQL');\ndb.prepare('UPDATE users SET name = ?').run('name');\nconst other = new Database(':memory:'); const prepared = other.prepare('SELECT * FROM users');\nprepared.all();\ndb.all('SELECT * FROM users');\nfunction later() { stmt.all(); }\ndb.all('SELECT * FROM users, teams');\n");
  const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], analysisContext(["app.ts"]));
  const operations = result.operations.filter((item) => item.kind === "database");
  expect(operations.some((item) => item.apiName === "prepare")).toBe(false);
  expect(operations.find((item) => item.range.start.line === 5)).toMatchObject({ target: "SELECT * FROM users WHERE id = ?", operation: "read" });
  expect(operations.find((item) => item.range.start.line === 6)).toMatchObject({ target: "UPDATE users SET name = ?", operation: "write" });
  expect(operations.find((item) => item.range.start.line === 5)?.receiverId).toBe(operations.find((item) => item.range.start.line === 9)?.receiverId);
  expect(operations.find((item) => item.range.start.line === 8)).toMatchObject({ target: "SELECT * FROM users", operation: "read" });
  expect(operations.find((item) => item.range.start.line === 8)?.receiverId).not.toBe(operations.find((item) => item.range.start.line === 9)?.receiverId);
  expect(operations.find((item) => item.range.start.line === 10)?.unresolvedReason).toMatch(/function/i);
});

it("keeps emitter identities across aliases, reexports, relocation, and inserted lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-ts-emitter-stability-"));
  const source = "import { EventEmitter } from 'node:events';\nexport const emitter = new EventEmitter();\nconst alias = emitter; alias.emit('ready');\nexport const second = new EventEmitter(); second.emit('ready');\n";
  await writeFile(join(root, "shared.ts"), source);
  await writeFile(join(root, "index.ts"), "export { emitter as shared } from './shared';\n");
  await writeFile(join(root, "app.ts"), "import { shared } from './index'; const alias = shared; alias.on('ready', () => {});\n");
  const paths = ["shared.ts", "index.ts", "app.ts"];
  const first = analyzeTypeScriptProject(root, root, paths.map(scannedFile), analysisContext(paths));
  const events = first.operations.filter((item) => item.kind === "event");
  expect(events).toHaveLength(3);
  expect(events[0].receiverId).toBe(events[2].receiverId);
  expect(events[1].receiverId).not.toBe(events[0].receiverId);
  const moved = await mkdtemp(join(tmpdir(), "flowweave-ts-emitter-moved-"));
  await cp(root, moved, { recursive: true });
  await writeFile(join(moved, "shared.ts"), `\n// inserted\n${source}`);
  expect(analyzeTypeScriptProject(moved, moved, paths.map(scannedFile), analysisContext(paths)).operations.filter((item) => item.kind === "event").map((item) => item.receiverId)).toEqual(events.map((item) => item.receiverId));
});

it("applies Axios URL combination and rejects runtime URL overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-ts-http-options-"));
  await writeFile(join(root, "app.ts"), "import axios from 'axios';\nconst client = axios.create({ baseURL: 'https://api.test/v1/' });\nclient.get('../users?secret=yes');\nclient.get('//elsewhere.test/users');\nclient.get('https://elsewhere.test/users', { allowAbsoluteUrls: false });\nfunction request(options: object, baseURL: string) { client.get('/users', options); client.get('/users', { baseURL }); }\nconst fixed = axios.create({ baseURL: 'https://api.test/v1', allowAbsoluteUrls: false }); fixed.get('https://elsewhere.test/users');\n");
  const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], analysisContext(["app.ts"]));
  const operations = result.operations.filter((item) => item.kind === "http");
  expect(operations[0].target).toBe("https://api.test/users?secret=yes");
  expect(operations[1].unresolvedReason).toMatch(/protocol|origin/i);
  expect(operations[2].target).toBe("https://api.test/v1/https://elsewhere.test/users");
  expect(operations[3].unresolvedReason).toMatch(/dynamic|option/i);
  expect(operations[4].unresolvedReason).toMatch(/dynamic|option/i);
  expect(operations[5].target).toBe("https://api.test/v1/https://elsewhere.test/users");
});

it("maps missing package outputs only to unique files included by the package compiler config", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-ts-output-membership-"));
  await mkdir(join(root, "pkg/src"), { recursive: true });
  await writeFile(join(root, "pkg/src/service.ts"), "export function service() {}\n");
  await writeFile(join(root, "pkg/src/service.tsx"), "export function service() {}\n");
  await writeFile(join(root, "pkg/tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist", jsx: "react" }, include: ["src"], exclude: ["src/service.ts"] }));
  await writeFile(join(root, "app.ts"), "import { service } from '@fixture/pkg'; service();\n");
  const paths = ["app.ts", "pkg/src/service.ts", "pkg/src/service.tsx"];
  const context = { ...analysisContext(paths), packages: [{ name: "@fixture/pkg", rootPath: "pkg", manifestPath: "pkg/package.json", exports: "./dist/service.js", sourceRoot: "pkg/src", outputRoot: "pkg/dist", configurationPath: "pkg/tsconfig.json", dependencies: [] }] };
  const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], context);
  expect(result.relations.find((item) => item.kind === "call")?.targetFile).toBe("pkg/src/service.tsx");
  await writeFile(join(root, "pkg/tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist", jsx: "react" }, files: ["src/service.ts", "src/service.tsx"] }));
  const ambiguous = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], context);
  expect(ambiguous.relations.find((item) => item.kind === "import")?.targetRef).toMatchObject({ kind: "unresolved", candidates: expect.arrayContaining(["pkg/src/service.ts", "pkg/src/service.tsx"]) });
});

it.each([
  ["service.tsx", { jsx: "preserve" }, "service.jsx", "service.js"],
  ["service.mts", {}, "service.mjs", "service.js"],
  ["service.cts", {}, "service.cjs", "service.js"],
  ["service.js", { allowJs: true }, "service.js", "service.mjs"]
])("requires the configured emit extension for %s", async (file, options, validOutput, invalidOutput) => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-ts-output-extension-"));
  await mkdir(join(root, "pkg/src"), { recursive: true });
  await writeFile(join(root, `pkg/src/${file}`), "export function service() {}\n");
  await writeFile(join(root, "pkg/tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist", ...options }, include: ["src"] }));
  await writeFile(join(root, "app.ts"), "import { service } from '@fixture/pkg'; service();\n");
  const paths = ["app.ts", `pkg/src/${file}`];
  const pkg = { name: "@fixture/pkg", rootPath: "pkg", manifestPath: "pkg/package.json", configurationPath: "pkg/tsconfig.json", dependencies: [] };
  const valid = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], { ...analysisContext(paths), packages: [{ ...pkg, exports: `./dist/${validOutput}` }] });
  expect(valid.relations.find((item) => item.kind === "call")?.targetFile).toBe(`pkg/src/${file}`);
  const invalid = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], { ...analysisContext(paths), packages: [{ ...pkg, exports: `./dist/${invalidOutput}` }] });
  expect(invalid.relations.find((item) => item.kind === "import")?.targetRef).toMatchObject({ kind: "unresolved" });
});

it("diagnoses ambiguous emitter anchors instead of merging independent block instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowweave-ts-ambiguous-emitter-"));
  await writeFile(join(root, "app.ts"), "import { EventEmitter } from 'node:events';\n{ const emitter = new EventEmitter(); emitter.emit('ready'); }\n{ const emitter = new EventEmitter(); emitter.on('ready', () => {}); }\n");
  const result = analyzeTypeScriptProject(root, root, [scannedFile("app.ts")], analysisContext(["app.ts"]));
  expect(result.operations).toHaveLength(2);
  expect(result.operations.every((item) => item.receiverId === undefined && item.unresolvedReason?.includes("ambiguous"))).toBe(true);
  expect(result.diagnostics.filter((item) => item.code === "unresolved-operation-target")).toHaveLength(2);
});

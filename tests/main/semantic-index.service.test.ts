import { generateProject } from "../../src/main/services/project-generation.service";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSemanticIndex, moduleClusteringRelations, readSemanticIndex, SEMANTIC_INDEX_GENERATOR_VERSION } from "../../src/main/services/semantic-index.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import type { SemanticIndex, SemanticRelation } from "../../src/types";

describe("semantic-index.service", () => {
  it("rebuilds degraded file caches when the analyzer generator changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-degraded-cache-"));
    await writeFile(join(root, "app.js"), 'const service = require("./service");\nmodule.exports = () => service.load();\n', "utf8");
    await writeFile(join(root, "service.js"), "exports.load = () => 1;\n", "utf8");
    const first = await scanSemantic(root);
    const manifestPath = join(root, ".flowweave", "index", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, generatorVersion: "degraded-generator" }), "utf8");
    const app = first.index.files.find((file) => file.path === "app.js")!;
    await mkdir(join(root, ".flowweave", "index", "files"), { recursive: true });
    await writeFile(join(root, ".flowweave", "index", "files", `${app.cacheKey}.json`), JSON.stringify({
      ...app, insight: { ...app.insight, imports: [], calls: [], symbols: [] }
    }), "utf8");
    const second = await scanSemantic(root);
    expect(second.index.files.find((file) => file.path === "app.js")?.insight?.imports).toContain("./service");
    expect(second.index.relations).toContainEqual(expect.objectContaining({
      kind: "import", sourceFile: "app.js", targetFile: "service.js"
    }));
  });

  it("rebuilds cached TypeScript diagnostics after binding stages are added", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-binding-stage-cache-"));
    await writeFile(join(root, "app.ts"), "import { absent } from './absent';\nabsent();\n", "utf8");
    await scanSemantic(root);

    const indexPath = join(root, ".flowweave", "index", "semantic-index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      generatorVersion: string;
      diagnostics: Array<Record<string, unknown>>;
    };
    index.generatorVersion = "5.0.7";
    const unresolvedImport = index.diagnostics.find((diagnostic) => diagnostic.code === "unresolved-import");
    if (!unresolvedImport) throw new Error("Expected persisted unresolved import diagnostic");
    delete unresolvedImport.stage;
    await writeFile(indexPath, JSON.stringify(index), "utf8");

    const manifestPath = join(root, ".flowweave", "index", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { generatorVersion: string };
    manifest.generatorVersion = "5.0.7";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const refreshed = await scanSemantic(root);

    expect(refreshed.index.generatorVersion).not.toBe("5.0.7");
    expect(refreshed.index.diagnostics).toContainEqual(expect.objectContaining({ code: "unresolved-import", stage: "binding" }));
  });

  it("locates Python package dependencies without inventing calls or resolving ambiguous roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-python-dependencies-"));
    for (const path of ["backend/services/news", "backend/services/shared", "other/services/shared"]) {
      await mkdir(join(root, path), { recursive: true });
    }
    await writeFile(join(root, "backend/services/news/app.py"), "from .service import load\nfrom services.shared.queue import publish\nfrom services.shared.db import connect\n", "utf8");
    await writeFile(join(root, "backend/services/news/service.py"), "def load():\n    return 1\n", "utf8");
    await writeFile(join(root, "backend/services/shared/queue.py"), "def publish():\n    pass\n", "utf8");
    for (const path of ["backend/services/shared/db.py", "other/services/shared/db.py"]) {
      await writeFile(join(root, path), "def connect():\n    pass\n", "utf8");
    }
    const { index } = await scanSemantic(root);
    expect(index.relations).toContainEqual(expect.objectContaining({
      kind: "import", sourceFile: "backend/services/news/app.py", targetFile: "backend/services/news/service.py", confidence: "confirmed"
    }));
    expect(index.relations.some((relation) => relation.targetFile === "backend/services/shared/queue.py")).toBe(false);
    expect(index.diagnostics).toContainEqual(expect.objectContaining({ code: "unresolved-import", filePath: "backend/services/news/app.py" }));
    expect(index.relations.find((relation) => relation.target === "services.shared.db")?.targetFile).toBeUndefined();
    expect(index.relations.some((relation) => relation.kind === "call")).toBe(false);
  });
  it("exposes only confirmed, file-resolved runtime relations for module clustering", () => {
    const relations: SemanticRelation[] = [
      semanticRelation("import", "import", "src/z.ts", "src/a.ts", "confirmed"),
      semanticRelation("call-z", "call", "src/z.ts", "src/a.ts", "confirmed"),
      semanticRelation("call-inferred", "call", "src/b.ts", "src/a.ts", "inferred"),
      semanticRelation("test", "test", "tests/a.test.ts", "src/a.ts", "confirmed"),
      semanticRelation("call-a", "call", "src/a.ts", "src/b.ts", "confirmed"),
      semanticRelation("external", "http", "src/c.ts", undefined, "confirmed")
    ];

    const selected = moduleClusteringRelations({ relations } as SemanticIndex);

    expect(selected.map((relation) => relation.id)).toEqual(["call-a", "call-z"]);
  });

  it("records parse-error stage and rejects persisted errors without it", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-diagnostic-stage-"));
    await writeFile(join(root, "app.ts"), "export function run( {\n", "utf8");
    await writeFile(join(root, "app.py"), "def run(:\n    pass\n", "utf8");

    const built = await scanSemantic(root);
    const errors = built.index.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((diagnostic) => diagnostic.stage === "parsing" && diagnostic.message.length > 0)).toBe(true);

    const semanticIndexPath = join(root, ".flowweave", "index", "semantic-index.json");
    const persisted = JSON.parse(await readFile(semanticIndexPath, "utf8")) as {
      files: Array<{ diagnostics: Array<{ severity: string; stage?: string }> }>;
    };
    const persistedError = persisted.files.flatMap((file) => file.diagnostics).find((diagnostic) => diagnostic.severity === "error");
    if (!persistedError) throw new Error("Expected a persisted parse diagnostic.");
    delete persistedError.stage;
    await writeFile(semanticIndexPath, JSON.stringify(persisted), "utf8");

    await expect(readSemanticIndex(root)).resolves.toBeUndefined();
  });

  it("persists a versioned semantic index and reuses unchanged files", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-semantic-index-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "api.ts"), 'import { service } from "./service";\nexport function invoke() {\n  service();\n  ghost();\n}\n', "utf8");
    await writeFile(join(root, "src", "service.ts"), "export function service() {}\n", "utf8");

    const first = await scanSemantic(root);
    const cachePath = join(root, ".flowweave", "index", "files", `${first.index.files[0].cacheKey}.json`);
    const semanticIndexPath = join(root, ".flowweave", "index", "semantic-index.json");
    const second = await scanSemantic(root);
    const stored = await readSemanticIndex(root);

    expect(first.delta.added).toEqual(["src/api.ts", "src/service.ts"]);
    expect(second.delta.unchanged).toEqual(["src/api.ts", "src/service.ts"]);
    expect(stored?.version).toBe(5);
    expect(stored?.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "import",
        sourceFile: "src/api.ts",
        targetFile: "src/service.ts",
        confidence: "confirmed"
      })
    ]));
    expect(stored?.relations.find((relation) => relation.kind === "call" && relation.symbol === "service")).toMatchObject({
      confidence: "confirmed",
      bindingBasis: "typescript-checker",
      targetRef: {
        kind: "file",
        filePath: "src/service.ts",
        symbolId: expect.any(String),
        declarationRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 29 } }
      },
      sourceRange: { start: { line: 3, column: 3 }, end: { line: 3, column: 12 } }
    });
    expect(stored?.relations.find((relation) => relation.kind === "call" && relation.symbol === "ghost")).toMatchObject({
      confidence: "inferred",
      bindingBasis: "typescript-checker",
      targetRef: { kind: "unresolved", reason: expect.any(String), candidates: [] },
      sourceRange: { start: { line: 4, column: 3 }, end: { line: 4, column: 10 } }
    });
    await expect(readFile(cachePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(stored?.files.every((file) => file.generation?.requestId === second.generation.requestId)).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".flowweave", "index", "manifest.json"), "utf8")).generatorVersion).toBe(SEMANTIC_INDEX_GENERATOR_VERSION);

    const corrupted = JSON.parse(await readFile(semanticIndexPath, "utf8")) as { relations: Array<Record<string, unknown>> };
    const corruptedCall = corrupted.relations.find((relation) => relation.kind === "call" && relation.symbol === "service");
    if (!corruptedCall) throw new Error("Expected persisted source call relation");
    delete corruptedCall.confidence;
    await writeFile(semanticIndexPath, JSON.stringify(corrupted), "utf8");
    await expect(readSemanticIndex(root)).resolves.toBeUndefined();

    corruptedCall.confidence = "confirmed";
    corruptedCall.targetRef = {
      kind: "unresolved",
      reason: "Multiple source declarations match the call.",
      candidates: ["symbol-one", "symbol-two"]
    };
    corruptedCall.targetFile = "src/service.ts";
    await writeFile(semanticIndexPath, JSON.stringify(corrupted), "utf8");
    await expect(readSemanticIndex(root)).resolves.toBeUndefined();

    const rebuilt = await scanSemantic(root);
    const restored = await readSemanticIndex(root);
    expect(rebuilt.index.relations.find((relation) => relation.kind === "call" && relation.symbol === "service")).toMatchObject({
      confidence: "confirmed",
      bindingBasis: "typescript-checker",
      targetRef: { kind: "file", filePath: "src/service.ts" },
      sourceRange: { start: { line: 3, column: 3 }, end: { line: 3, column: 12 } }
    });
    expect(restored?.relations.find((relation) => relation.kind === "call" && relation.symbol === "service")).toMatchObject({
      confidence: "confirmed",
      targetRef: { kind: "file", filePath: "src/service.ts" },
      sourceRange: { start: { line: 3, column: 3 }, end: { line: 3, column: 12 } }
    });
  });

  it("reports parser coverage, offline execution, and known source-binding limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-analysis-capabilities-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export const load = () => 1;\n", "utf8");
    await writeFile(join(root, "src", "app.py"), "def load():\n    return 1\n", "utf8");
    await writeFile(join(root, "src", "App.java"), "package fixture; class App { int load() { return 1; } }\n", "utf8");
    await writeFile(join(root, "src", "app.go"), "package fixture\nfunc load() int { return 1 }\n", "utf8");
    await writeFile(join(root, "src", "app.rs"), "fn load() -> i32 { 1 }\n", "utf8");

    const project = await scanProject(root);
    const { index } = await buildSemanticIndex(project);

    expect(index.analysisCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        language: "TypeScript",
        parserId: "typescript-program",
        status: "available",
        sourceFiles: 1,
        failedFiles: 0,
        unsupportedFiles: 0,
        offline: true
      }),
      expect.objectContaining({
        language: "Python",
        parserId: "tree-sitter-python-wasm",
        status: "available",
        sourceFiles: 1,
        offline: true
      }),
      expect.objectContaining({
        language: "Java",
        parserId: "tree-sitter-java-wasm",
        limitations: expect.arrayContaining([
          expect.objectContaining({ code: "classpath-not-loaded", count: 1 })
        ])
      }),
      expect.objectContaining({
        language: "Rust",
        parserId: "lightweight-language",
        status: "unsupported",
        unsupportedFiles: 1,
        limitations: expect.arrayContaining([
          expect.objectContaining({ code: "unsupported-semantic-language", count: 1 })
        ])
      })
    ]));
  });

  it("keeps cold caches isolated by project and preserves graph counts across warm reuse", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "flowweave-semantic-independent-a-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "flowweave-semantic-independent-b-"));
    for (const root of [firstRoot, secondRoot]) await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(firstRoot, "src", "api.py"), "from .service import load\ndef api():\n    return load()\n", "utf8");
    await writeFile(join(firstRoot, "src", "service.py"), "def load():\n    return 'first project'\n", "utf8");
    await writeFile(join(secondRoot, "src", "api.py"), "from .service import load\ndef api():\n    return load()\n", "utf8");
    await writeFile(join(secondRoot, "src", "service.py"), "def load():\n    return 'second project'\n", "utf8");
    const firstProject = await scanProject(firstRoot);
    const secondProject = await scanProject(secondRoot);

    const firstCold = await scanSemantic(firstProject.rootPath);
    const secondCold = await scanSemantic(secondProject.rootPath);
    const firstHash = firstCold.index.files.find((file) => file.path === "src/service.py")?.contentHash;
    const secondHash = secondCold.index.files.find((file) => file.path === "src/service.py")?.contentHash;
    let lastWarm = firstCold;
    for (let iteration = 0; iteration < 20; iteration += 1) {
      lastWarm = await scanSemantic(firstProject.rootPath);
      expect(lastWarm.delta.unchanged).toEqual(["src/api.py", "src/service.py"]);
    }

    expect(firstCold.delta.added).toEqual(["src/api.py", "src/service.py"]);
    expect(secondCold.delta.added).toEqual(["src/api.py", "src/service.py"]);
    expect(firstHash).not.toBe(secondHash);
    expect(lastWarm.index.files).toHaveLength(firstCold.index.files.length);
    expect(lastWarm.index.relations).toHaveLength(firstCold.index.relations.length);
  });

  it("reports modified and deleted files and removes deleted cache entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-semantic-delta-"));
    await writeFile(join(root, "main.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "old.ts"), "export const old = true;\n", "utf8");
    const first = await scanSemantic(root);
    const deletedCacheKey = first.index.files.find((file) => file.path === "old.ts")?.cacheKey;

    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(join(root, "main.ts"), "export const value = 2;\n", "utf8");
    await rm(join(root, "old.ts"));
    const second = await scanSemantic(root);

    expect(second.delta.modified).toEqual(["main.ts"]);
    expect(second.delta.deleted).toEqual(["old.ts"]);
    expect(second.index.files.map((file) => file.path)).toEqual(["main.ts"]);
    await expect(readFile(join(root, ".flowweave", "index", "files", `${deletedCacheKey}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("excludes common credential files from scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-semantic-sensitive-"));
    await writeFile(join(root, ".env"), "TOKEN=secret\n", "utf8");
    await writeFile(join(root, "credentials.json"), "{\"token\":\"secret\"}\n", "utf8");
    await writeFile(join(root, "app.ts"), "export const app = true;\n", "utf8");

    const project = await scanProject(root);

    expect(JSON.stringify(project.files)).not.toContain(".env");
    expect(JSON.stringify(project.files)).not.toContain("credentials.json");
    expect(JSON.stringify(project.files)).toContain("app.ts");
  });

  it("preserves dynamic HTTP operations without inventing service or router bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-semantic-http-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "server"), { recursive: true });
    await writeFile(join(root, "src", "api.ts"), "export const load = (id: string) => fetch(`/api/users/${id}`);\n", "utf8");
    await writeFile(join(root, "server", "users.ts"), "router.get('/api/users/:id', getUser);\n", "utf8");

    const { index } = await scanSemantic(root);

    expect(index.relations).toContainEqual(expect.objectContaining({ kind: "http", sourceFile: "src/api.ts", targetRef: expect.objectContaining({ kind: "unresolved" }) }));
    expect(index.relations.some((relation) => relation.kind === "http" && relation.targetFile === "server/users.ts")).toBe(false);
    expect(index.diagnostics).toContainEqual(expect.objectContaining({ code: "resource-target-unresolved", filePath: "src/api.ts" }));
  });

});

function semanticRelation(
  id: string,
  kind: SemanticRelation["kind"],
  sourceFile: string,
  targetFile: string | undefined,
  confidence: SemanticRelation["confidence"]
): SemanticRelation {
  return {
    id,
    kind,
    source: sourceFile,
    target: targetFile ?? "external",
    sourceFile,
    targetFile,
    detail: id,
    confidence
  };
}

async function scanSemantic(root: string) {
  const result = await generateProject(root, {});
  if (result.status !== "committed") throw new Error(`Unexpected superseded test scan: ${root}`);
  return result;
}

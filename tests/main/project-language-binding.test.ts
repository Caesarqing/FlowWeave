import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AnalysisScope, ProjectAnalysisContext, SemanticFile } from "../../src/types";
import { buildSemanticIndex } from "../../src/main/services/semantic-index.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { discoverProjectAnalysisContext } from "../../src/main/services/project-analysis-context.service";
import { flattenProjectFilePaths } from "../../src/main/services/project-import-resolver.service";
import { analyzeTreeSitterProject } from "../../src/main/services/project-language-binding.service";

function file(path: string): SemanticFile {
  return { path, size: 0, modifiedAt: "", contentHash: "", cacheKey: "", analyzerId: "", analysisDepth: "syntax", status: "parsed", diagnostics: [], httpEndpoints: [], renderTargets: [] };
}
function context(scopes: AnalysisScope[]): ProjectAnalysisContext {
  return { scopes, packages: [], configurationPaths: [], diagnostics: [] };
}
function scope(language: AnalysisScope["language"], rootPath: string, sourceRoots: string[], paths: string[], packageName: string): AnalysisScope {
  return { id: language + ":" + rootPath, language, rootPath, sourceRoots, paths, configurationPaths: [], packageName };
}

describe("source-only project language binding", () => {
  it.each([
    ["four-language-workspace", "3b194e4b32a656b54080de4810ba1d725c7e3cbd581b2d7abc11ca6ae97e8dba"],
    ["ambiguous-workspace", "5b7ff8360a4453b8da1702985fdb4c361625d72fab03bb8801ba9a66bb572553"]
  ])("preserves complete declaration-binding evidence for %s", async (fixture, expectedSha256) => {
    const root = resolve("tests/fixtures", fixture);
    const paths = flattenProjectFilePaths((await scanProject(root)).files);
    const analysisContext = await discoverProjectAnalysisContext(root, paths);
    const result = await analyzeTreeSitterProject(root, paths.map(file), analysisContext);
    const evidence = { relations: result.relations, symbolsByFile: [...result.symbolsByFile], diagnostics: result.diagnostics, operations: result.operations };
    expect(createHash("sha256").update(JSON.stringify(evidence)).digest("hex")).toBe(expectedSha256);
  });

  it("binds Python reexports, Java static imports, and Go module aliases in the real workspace", async () => {
    const root = resolve("tests/fixtures/four-language-workspace");
    const py = ["python/src/sample/__init__.py", "python/src/sample/app.py", "python/src/sample/service.py"];
    const java = ["java/src/main/java/example/App.java", "java/src/main/java/example/Service.java"];
    const go = ["go/main.go", "go/service/service.go"];
    const result = await analyzeTreeSitterProject(root, [...py, ...java, ...go].map(file), context([
      scope("python", "python", ["python/src"], py, "sample"),
      scope("java", "java", ["java/src/main/java"], java, "example"),
      scope("go", "go", ["go"], go, "example.com/fixture")
    ]));
    for (const [source, target] of [[py[1], py[2]], [java[0], java[1]], [go[0], go[1]]]) {
      expect(result.relations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "call", sourceFile: source, targetFile: target, targetRef: expect.objectContaining({ kind: "file", symbolId: expect.any(String), declarationRange: expect.any(Object) }), sourceRange: expect.any(Object) })]));
    }
    expect(result.relations.find((relation) => relation.kind === "call" && relation.sourceFile === py[1])).toMatchObject({
      confidence: "confirmed",
      targetRef: {
        kind: "file",
        filePath: py[2],
        symbolId: expect.any(String),
        declarationRange: { start: { line: 1, column: 1 }, end: { line: 2, column: 20 } }
      },
      sourceRange: { start: { line: 4, column: 12 }, end: { line: 4, column: 18 } }
    });
    expect(result.relations.find((relation) => relation.kind === "call" && relation.sourceFile === go[0])).toMatchObject({
      confidence: "confirmed",
      targetRef: {
        kind: "file",
        filePath: go[1],
        symbolId: expect.any(String),
        declarationRange: { start: { line: 3, column: 1 }, end: { line: 3, column: 39 } }
      },
      sourceRange: { start: { line: 5, column: 15 }, end: { line: 5, column: 25 } }
    });
    expect(result.symbolsByFile.get(py[2])?.[0]).toMatchObject({ qualifiedName: "sample.service.load", scopeId: "python:python" });
  });

  it("does not confirm calling an imported module as a direct declaration call", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-module-call-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/app.py"), "import service as module\nmodule()\n");
      await writeFile(join(root, "src/service.py"), "def load():\n    return 1\n");
      const result = await analyzeTreeSitterProject(root, [file("src/app.py"), file("src/service.py")], context([
        scope("python", "src", ["src"], ["src/app.py", "src/service.py"], "sample")
      ]));
      const call = result.relations.find((relation) => relation.kind === "call" && relation.symbol === "module");

      expect(call).toMatchObject({
        confidence: "inferred",
        targetRef: { kind: "unresolved" },
        sourceRange: { start: { line: 2, column: 1 } }
      });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "unresolved-call", stage: "binding", range: call?.sourceRange }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves repeated calls, lexical shadows, ambiguous overloads, concrete receivers, and imported operation identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-bindings-"));
    const sources: Record<string, string> = {
      "py/service.py": "def load():\n    return 1\nclass Client:\n    def work(self):\n        return 1\n",
      "py/app.py": 'from service import load, Client\nimport requests as req\nfrom pathlib import Path as P\nimport subprocess as sp\ndef run():\n    load(); load()\n    c = Client()\n    c.work()\n    req.get("https://example.test/users")\n    P("data.txt").read_text()\n    sp.run(["echo", "hello"])\ndef shadow(load, req):\n    load()\n    req.get("https://wrong.test")\n',
      "java/p/A.java": 'package p; import java.nio.file.Files; import java.nio.file.Path; class A { static void work(String a) {} static void work(Integer a) {} void run() { work(null); Files.readString(Path.of("data.txt")); } }',
      "go/main.go": 'package main\nimport h "net/http"\nimport "os"\nfunc main() { h.Get("https://example.test"); os.ReadFile("data.txt") }\nfunc shadow(h string) { h.Get("https://wrong.test") }'
    };
    try {
      for (const [path, source] of Object.entries(sources)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), source);
      }
      const paths = Object.keys(sources);
      const result = await analyzeTreeSitterProject(root, paths.map(file), context([
        scope("python", "py", ["py"], paths.filter((p) => p.startsWith("py/")), "py"),
        scope("java", "java", ["java"], paths.filter((p) => p.startsWith("java/")), "p"),
        scope("go", "go", ["go"], paths.filter((p) => p.startsWith("go/")), "example.test/main")
      ]));
      expect(result.relations.filter((r) => r.kind === "call" && r.symbol === "load" && r.targetFile === "py/service.py")).toHaveLength(2);
      expect(result.relations).toContainEqual(expect.objectContaining({ kind: "call", symbol: "c.work", targetFile: "py/service.py" }));
      expect(result.relations).toContainEqual(expect.objectContaining({ kind: "call", symbol: "work", targetRef: expect.objectContaining({ kind: "unresolved", candidates: expect.any(Array) }) }));
      expect(result.operations.map((o) => [o.moduleName, o.target])).toEqual(expect.arrayContaining([["requests", "https://example.test/users"], ["pathlib", "data.txt"], ["subprocess", "echo"], ["java.nio.file.Files", "data.txt"], ["net/http", "https://example.test"], ["os", "data.txt"]]));
      expect(result.operations.some((o) => o.target === "https://wrong.test")).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "ambiguous-call")).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("binds package-qualified source calls and receiver factories without claiming interface implementations", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-receivers-"));
    const sources: Record<string, string> = {
      "py/pkg/__init__.py": "",
      "py/pkg/service.py": "def load():\n    return 1\n",
      "py/app.py": 'import pkg.service\nimport requests as req\ndef run():\n    label = "中文😀"; pkg.service.load()\n    (lambda req: req.get("https://shadow.test"))(None)\n    req.unknown_factory().get("https://wrong.test")\n',
      "java/p/Base.java": 'package p; class Base { void inherited() {} }',
      "java/p/Child.java": 'package p; class Child extends Base {}',
      "java/p/Api.java": 'package p; interface Api { void work(); }',
      "java/p/App.java": 'package p; import java.net.http.HttpClient; import java.net.http.HttpRequest; import java.net.URI; import java.sql.DriverManager; import q.Remote; class App { void run(Api api) { Remote.load(); var c = new Child(); c.inherited(); api.work(); p.Child x = new p.Child(); x.inherited(); var h = HttpClient.newHttpClient(); var r = HttpRequest.newBuilder(URI.create("https://java.test/users")).GET().build(); h.send(r, null); var db = DriverManager.getConnection("jdbc:sqlite:data.db"); db.createStatement().executeQuery("select 1"); var prepared = db.prepareStatement("select name from users"); prepared.executeQuery(); new ProcessBuilder("echo").start(); } }',
      "library/q/Remote.java": 'package q; public class Remote { public static void load() {} }',
      "go/main.go": 'package main\nimport "example.test/shared/service"\nimport h "net/http"\nimport "os/exec"\ntype Api interface { Work() }\nfunc main() { api.Load(); c := h.Client{}; r, err := h.NewRequest("POST", "https://go.test/users", nil); c.Do(r); cmd := exec.Command("echo"); cmd.Run(); _ = err }\nfunc unresolved(api Api) { api.Work(); f := main; f() }',
      "shared/service/service.go": 'package api\nfunc Load() {}'
    };
    try {
      for (const [path, source] of Object.entries(sources)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), source);
      }
      const paths = Object.keys(sources);
      const goScope = scope("go", "go", ["go"], paths.filter((p) => p.startsWith("go/")), "example.test/app");
      const result = await analyzeTreeSitterProject(root, paths.map(file), context([
        scope("python", "py", ["py"], paths.filter((p) => p.startsWith("py/")), "py"),
        { ...scope("java", "java", ["java"], paths.filter((p) => p.startsWith("java/")), "example:app"), dependencies: ["example:library"] },
        scope("java", "library", ["library"], paths.filter((p) => p.startsWith("library/")), "example:library"),
        { ...goScope, dependencies: ["example.test/shared=>shared"] },
        scope("go", "shared", ["shared"], paths.filter((p) => p.startsWith("shared/")), "replacement.test/shared")
      ]));
      expect(result.relations).toContainEqual(expect.objectContaining({ kind: "call", symbol: "pkg.service.load", targetFile: "py/pkg/service.py" }));
      expect(result.relations).toContainEqual(expect.objectContaining({ kind: "call", symbol: "api.Load", targetFile: "shared/service/service.go" }));
      expect(result.relations.filter((r) => r.kind === "call" && r.targetFile === "java/p/Base.java")).toHaveLength(2);
      const packageCall = result.relations.find((relation) => relation.kind === "call" && relation.symbol === "pkg.service.load");
      expect(packageCall).toMatchObject({
        confidence: "confirmed",
        targetRef: {
          kind: "file",
          filePath: "py/pkg/service.py",
          symbolId: expect.any(String),
          declarationRange: { start: { line: 1, column: 1 }, end: { line: 2, column: 13 } }
        },
        sourceRange: { start: { line: 4, column: 21 }, end: { line: 4, column: 39 } }
      });
      const shadowedCall = result.relations.find((relation) => relation.kind === "call" && relation.symbol === "req.get");
      expect(shadowedCall).toMatchObject({
        confidence: "inferred",
        targetRef: { kind: "unresolved", candidates: ["py/app.py:104:req"] },
        sourceRange: { start: { line: 5, column: 18 }, end: { line: 5, column: 48 } }
      });
      const unknownFactoryCall = result.relations.find((relation) => relation.kind === "call" && relation.symbol === "req.unknown_factory().get");
      expect(unknownFactoryCall).toMatchObject({
        confidence: "inferred",
        targetRef: { kind: "unresolved", candidates: [] },
        sourceRange: { start: { line: 6, column: 5 }, end: { line: 6, column: 52 } }
      });
      const apiLoad = result.relations.find((relation) => relation.kind === "call" && relation.symbol === "api.Load");
      expect(apiLoad).toMatchObject({
        confidence: "confirmed",
        targetRef: {
          kind: "file",
          filePath: "shared/service/service.go",
          symbolId: expect.any(String),
          declarationRange: { start: { line: 2, column: 1 }, end: { line: 2, column: 15 } }
        },
        sourceRange: { start: { line: 6, column: 15 }, end: { line: 6, column: 25 } }
      });
      const interfaceMethod = result.relations.find((relation) => relation.kind === "call" && relation.sourceFile === "go/main.go" && relation.symbol === "api.Work");
      const interfaceType = result.symbolsByFile.get("go/main.go")?.find((symbol) => symbol.name === "Api");
      expect(interfaceType).toBeDefined();
      expect(interfaceMethod).toMatchObject({
        confidence: "inferred",
        targetRef: { kind: "unresolved", reason: "Interface member Work has runtime dispatch", candidates: [interfaceType?.id] },
        sourceRange: { start: { line: 7, column: 28 }, end: { line: 7, column: 38 } }
      });
      const functionVariableCall = result.relations.find((relation) => relation.kind === "call" && relation.sourceFile === "go/main.go" && relation.symbol === "f");
      expect(functionVariableCall).toMatchObject({
        confidence: "inferred",
        targetRef: { kind: "unresolved", candidates: [] },
        sourceRange: { start: { line: 7, column: 51 }, end: { line: 7, column: 54 } }
      });
      expect(result.relations.filter((relation) => relation.kind === "call" && relation.sourceFile === "go/main.go" && ["api.work", "api.Work", "f"].includes(relation.symbol ?? "")).every((relation) => relation.targetRef?.kind === "unresolved")).toBe(true);
      expect(result.operations.map((o) => [o.kind, o.target])).toEqual(expect.arrayContaining([["http", "https://java.test/users"], ["database", "select 1"], ["process", "echo"], ["http", "https://go.test/users"]]));
      expect(result.operations.find((o) => o.target === "https://go.test/users" && o.apiName === "Do")?.method).toBe("POST");
      expect(result.operations.filter((o) => o.kind === "database")).toHaveLength(2);
      expect(result.operations).toContainEqual(expect.objectContaining({ kind: "database", target: "select name from users", origin: "jdbc:sqlite:data.db" }));
      expect(result.operations.find((o) => o.kind === "database")?.origin).toBe("jdbc:sqlite:data.db");
      expect(result.relations).toContainEqual(expect.objectContaining({ kind: "call", symbol: "Remote.load", targetFile: "library/q/Remote.java" }));
      expect(result.operations.filter((o) => o.kind === "process")).toHaveLength(2);
      expect(result.operations.some((o) => o.target?.includes("shadow.test") || o.target?.includes("wrong.test"))).toBe(false);
      const call = result.relations.find((r) => r.symbol === "pkg.service.load");
      expect(call?.sourceRange).toEqual({ start: { line: 4, column: 21 }, end: { line: 4, column: 39 } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps package import evidence while diagnosing duplicate Go symbols and unknown targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ambiguous-"));
    const sources: Record<string, string> = {
      "go/main.go": 'package main\nimport "example.test/app/service"\nfunc main() { service.Load(); service.Conditional() }',
      "go/service/one.go": 'package service\nfunc Load() {}',
      "go/service/two.go": 'package service\nfunc Load() {}',
      "go/service/conditional.go": '//go:build linux\npackage service\nfunc Conditional() {}',
      "py/service.py": 'def load():\n    return 1\nclass Client:\n    def work(self):\n        return 1\n',
      "py/app.py": 'from service import load, Client\nimport requests as req\nclass C:\n    def __init__(self):\n        self.client = Client()\n    def load(self):\n        return 0\n    def run(self, url):\n        load()\n        self.client.work()\n        req.get(url)\ndef outer():\n    def inner():\n        return load()\n    return inner()\n',
      "java/p/Service.java": 'package p; class Service { static void load() {} Service(String x) {} Service(Integer x) {} }',
      "java/p/App.java": 'package p; import static p.Service.*; class App { void run() { load(); new Service(null); } }'
    };
    try {
      for (const [path, source] of Object.entries(sources)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), source); }
      const paths = Object.keys(sources);
      const result = await analyzeTreeSitterProject(root, paths.map(file), context([
        scope("go", "go", ["go"], paths.filter((p) => p.startsWith("go/")), "example.test/app"),
        scope("python", "py", ["py"], paths.filter((p) => p.startsWith("py/")), "py"),
        scope("java", "java", ["java"], paths.filter((p) => p.startsWith("java/")), "p")
      ]));
      const imports = result.relations.filter((r) => r.kind === "import" && r.sourceFile === "go/main.go");
      expect(imports).toHaveLength(3);
      expect(imports.every((r) => r.targetRef?.kind === "file")).toBe(true);
      expect(result.relations.find((r) => r.symbol === "service.Load")?.targetRef).toMatchObject({ kind: "unresolved", candidates: expect.any(Array) });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "go-build-constraints" }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "unknown-operation-target", filePath: "py/app.py" }));
      expect(result.operations).toContainEqual(expect.objectContaining({ moduleName: "requests", target: undefined }));
      expect(result.relations.filter((r) => r.kind === "call" && r.symbol === "load" && r.sourceFile === "py/app.py").every((r) => r.targetFile === "py/service.py")).toBe(true);
      expect(result.relations).toContainEqual(expect.objectContaining({ kind: "call", symbol: "self.client.work", targetFile: "py/service.py" }));
      expect(result.relations).toContainEqual(expect.objectContaining({ kind: "call", symbol: "load", sourceFile: "java/p/App.java", targetFile: "java/p/Service.java" }));
      expect(result.relations.find((r) => r.symbol === "Service" && r.sourceFile === "java/p/App.java")?.targetRef).toMatchObject({ kind: "unresolved", candidates: expect.any(Array) });
      expect(result.symbolsByFile.get("py/app.py")).toContainEqual(expect.objectContaining({ qualifiedName: "app.outer.inner" }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps Python receiver candidates across branches and resets them after an unconditional assignment", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-python-branches-"));
    const source = [
      "class Alpha:",
      "    def work(self): pass",
      "class Beta:",
      "    def work(self): pass",
      "class Gamma:",
      "    def work(self): pass",
      "def run(flag):",
      "    receiver = Alpha()",
      "    if flag:",
      "        receiver = Beta()",
      "        receiver.work()",
      "    receiver.work()",
      "    receiver = Alpha()",
      "    if flag:",
      "        receiver = Beta()",
      "    else:",
      "        receiver = Gamma()",
      "    receiver.work()",
      "    receiver = Alpha()",
      "    for item in [1]:",
      "        receiver = Beta()",
      "    receiver.work()",
      "    receiver = Alpha()",
      "    try:",
      "        receiver = Beta()",
      "    except Exception:",
      "        receiver = Gamma()",
      "    receiver.work()",
      "    receiver = Alpha()",
      "    match flag:",
      "        case True:",
      "            receiver = Beta()",
      "        case _:",
      "            receiver = Gamma()",
      "    receiver.work()",
      "    receiver = Gamma()",
      "    alias = receiver",
      "    alias.work()",
      "    receiver = Alpha()",
      "    for receiver in [Beta()]:",
      "        pass",
      "    receiver.work()"
    ].join("\n");
    try {
      await mkdir(join(root, "py"), { recursive: true });
      await writeFile(join(root, "py/app.py"), source);
      const result = await analyzeTreeSitterProject(root, [file("py/app.py")], context([scope("python", "py", ["py"], ["py/app.py"], "py")]));
      const calls = result.relations.filter((relation) => relation.kind === "call" && relation.symbol === "receiver.work");
      const methodAt = (line: number) => calls.find((relation) => relation.sourceRange?.start.line === line);
      const methodById = new Map(result.symbolsByFile.get("py/app.py")?.map((symbol) => [symbol.id, symbol.qualifiedName]));
      expect(methodAt(11)?.targetRef).toMatchObject({ kind: "file" });
      expect(methodById.get(methodAt(11)?.targetRef?.kind === "file" ? methodAt(11)?.targetRef.symbolId : undefined)).toBe("app.Beta.work");
      for (const line of [12, 18, 22, 28, 35]) {
        expect(methodAt(line)?.targetRef, `line ${line}`).toMatchObject({ kind: "unresolved", candidates: expect.any(Array) });
      }
      const aliasCall = result.relations.find((relation) => relation.kind === "call" && relation.symbol === "alias.work");
      expect(aliasCall?.targetRef).toMatchObject({ kind: "file" });
      expect(methodById.get(aliasCall?.targetRef?.kind === "file" ? aliasCall.targetRef.symbolId : undefined)).toBe("app.Gamma.work");
      expect(methodAt(42)?.targetRef).toMatchObject({ kind: "unresolved", candidates: expect.any(Array) });
      for (const line of [12, 18, 22, 28, 35]) {
        const relation = methodAt(line);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "ambiguous-call", relationId: relation?.id, range: relation?.sourceRange, candidates: expect.any(Array) }));
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps a Java call unresolved when its dependency classpath is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-java-missing-classpath-"));
    const sourcePath = "src/main/java/fixture/App.java";
    try {
      await mkdir(join(root, "src/main/java/fixture"), { recursive: true });
      await writeFile(join(root, sourcePath), [
        "package fixture;",
        "import com.vendor.Client;",
        "import java.util.UUID;",
        "class App {",
        "void run(Client client) {",
        "  client.execute();",
        "  UUID.randomUUID();",
        "  LocalService.execute();",
        "}",
        "}"
      ].join("\n"));
      await writeFile(join(root, "src/main/java/fixture/LocalService.java"), [
        "package fixture;",
        "class LocalService {",
        "  static void execute() {}",
        "}"
      ].join("\n"));

      const { index } = await buildSemanticIndex(await scanProject(root));
      const calls = index.relations.filter((relation) => relation.kind === "call" && relation.sourceFile === sourcePath);
      const call = calls.find((relation) => relation.symbol === "client.execute");
      const jdkCall = calls.find((relation) => relation.symbol === "UUID.randomUUID");
      const sourceCall = calls.find((relation) => relation.symbol === "LocalService.execute");
      const javaCapability = index.analysisCapabilities?.find((capability) => capability.language === "Java");

      expect(call).toMatchObject({
        kind: "call",
        symbol: "client.execute",
        confidence: "inferred",
        bindingBasis: "classpath-unavailable",
        targetRef: { kind: "unresolved" },
        sourceRange: { start: { line: 6, column: 3 }, end: { line: 6, column: 19 } }
      });
      expect(index.diagnostics).toContainEqual(expect.objectContaining({
        code: "unresolved-call",
        filePath: sourcePath,
        range: call?.sourceRange,
        candidates: ["external:com.vendor.Client.execute"]
      }));
      expect(jdkCall).toMatchObject({
        confidence: "confirmed",
        targetRef: { kind: "external", standardLibrary: true },
        sourceRange: { start: { line: 7, column: 3 }, end: { line: 7, column: 20 } }
      });
      expect(sourceCall).toMatchObject({
        confidence: "confirmed",
        targetRef: { kind: "file", filePath: "src/main/java/fixture/LocalService.java", symbolId: expect.any(String) },
        sourceRange: { start: { line: 8, column: 3 }, end: { line: 8, column: 25 } }
      });
      expect(calls).toHaveLength(3);
      expect(index.relations.find((relation) => relation.kind === "import" && relation.sourceFile === sourcePath && relation.symbol === "com.vendor.Client"))
        .toMatchObject({ kind: "import", confidence: "confirmed" });
      expect(javaCapability?.limitations).toContainEqual(expect.objectContaining({ code: "classpath-not-loaded" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists the four-language ambiguity fixture without fabricated bindings or standard API operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ambiguity-fixture-"));
    try {
      await cp(resolve("tests/fixtures/ambiguous-workspace"), root, { recursive: true });
      const first = await buildSemanticIndex(await scanProject(root));
      const second = await buildSemanticIndex(await scanProject(root));
      expect(second.index.relations).toEqual(first.index.relations);
      expect(second.index.resources).toEqual(first.index.resources);
      expect(second.delta.modified).toEqual([]);
      const calls = first.index.relations.filter((r) => r.kind === "call");
      for (const [source, name] of [["typescript/src/app.ts", "ghost"], ["python/src/app.py", "client.run"], ["java/src/main/java/fixture/App.java", "Service.work"], ["java/src/main/java/fixture/App.java", "api.work"], ["go/main.go", "Load"], ["go/main.go", "api.Work"], ["go/main.go", "real.Get"]]) {
        const call = calls.find((r) => r.sourceFile === source && r.symbol === name);
        expect(call?.targetRef, `${source}: ${name}`).toMatchObject({ kind: "unresolved", candidates: expect.any(Array) });
        expect(call?.sourceRange).toBeDefined();
        expect(first.index.diagnostics).toContainEqual(expect.objectContaining({ relationId: call?.id, range: call?.sourceRange, candidates: expect.any(Array) }));
      }
      expect(calls.filter((r) => r.sourceFile === "typescript/src/app.ts" && r.symbol === "load").map((r) => r.targetFile)).toEqual(expect.arrayContaining(["typescript/src/first.ts", undefined]));
      expect(calls).toContainEqual(expect.objectContaining({ sourceFile: "typescript/src/app.ts", symbol: "second", targetFile: "typescript/src/second.ts" }));
      expect(calls.find((r) => r.sourceFile === "java/src/main/java/fixture/App.java" && r.symbol === "Service.work")?.targetRef).toMatchObject({ kind: "unresolved", candidates: expect.arrayContaining([expect.any(String), expect.any(String)]) });
      expect(first.index.diagnostics).toContainEqual(expect.objectContaining({ code: "go-build-constraints", filePath: "go/conditional.go" }));
      expect(first.index.relations.some((r) => ["http", "filesystem"].includes(r.kind) && ["python/src/app.py", "go/main.go", "java/src/main/java/fixture/App.java"].includes(r.sourceFile))).toBe(false);
      expect(first.index.httpEndpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "/users", origin: "https://urllib.test", method: "POST", filePath: "python/src/network.py" }),
        expect.objectContaining({ path: "/users", origin: "https://stdlib.test", method: "GET", filePath: "python/src/network.py" }),
        expect.objectContaining({ path: "/api", origin: "https://service.test", method: "GET", filePath: "python/src/network.py" })
      ]));
      expect(first.index.httpEndpoints.some((endpoint) => endpoint.path.includes("shadow.test") || endpoint.path.includes("local-source.test"))).toBe(false);
      expect(first.index.diagnostics).toContainEqual(expect.objectContaining({ code: "unknown-operation-target", filePath: "python/src/network.py", range: expect.any(Object) }));
      expect(first.index.diagnostics).toContainEqual(expect.objectContaining({ code: "unsupported-http-route", filePath: "go/main.go", range: expect.any(Object) }));
      for (const [source, name] of [["python/src/app.py", "load"], ["java/src/main/java/fixture/App.java", "Service.work"], ["go/main.go", "Load"], ["typescript/src/app.ts", "load"]]) {
        const call = calls.find((r) => r.sourceFile === source && r.symbol === name);
        const content = await readFile(join(root, source), "utf8");
        const line = content.split("\n")[(call?.sourceRange?.start.line ?? 0) - 1];
        expect(line).toContain("中文😀");
        expect(call?.sourceRange?.start.column).toBe((line?.indexOf(name + "(") ?? -1) + 1);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSemanticIndex, moduleClusteringRelations, readSemanticIndex } from "../../src/main/services/semantic-index.service";
import { scanProject } from "../../src/main/services/project-scanner.service";
import type { SemanticIndex, SemanticRelation } from "../../src/types";

describe("semantic-index.service", () => {
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

  it("persists a versioned semantic index and reuses unchanged files", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-semantic-index-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "api.ts"), 'import { service } from "./service";\nexport const api = () => service();\n', "utf8");
    await writeFile(join(root, "src", "service.ts"), "export const service = () => fetch('/users');\n", "utf8");

    const first = await buildSemanticIndex(await scanProject(root));
    const cachePath = join(root, ".flowweave", "index", "files", `${first.index.files[0].cacheKey}.json`);
    const cacheModifiedAt = (await stat(cachePath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await buildSemanticIndex(await scanProject(root));
    const stored = await readSemanticIndex(root);

    expect(first.delta.added).toEqual(["src/api.ts", "src/service.ts"]);
    expect(second.delta.unchanged).toEqual(["src/api.ts", "src/service.ts"]);
    expect(stored?.version).toBe(4);
    expect(stored?.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "import",
        sourceFile: "src/api.ts",
        targetFile: "src/service.ts",
        confidence: "confirmed"
      })
    ]));
    expect((await stat(cachePath)).mtimeMs).toBe(cacheModifiedAt);
    expect(JSON.parse(await readFile(join(root, ".flowweave", "index", "manifest.json"), "utf8")).generatorVersion).toBe("4.0.0");
  });

  it("reports modified and deleted files and removes deleted cache entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-semantic-delta-"));
    await writeFile(join(root, "main.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "old.ts"), "export const old = true;\n", "utf8");
    const first = await buildSemanticIndex(await scanProject(root));
    const deletedCacheKey = first.index.files.find((file) => file.path === "old.ts")?.cacheKey;

    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(join(root, "main.ts"), "export const value = 2;\n", "utf8");
    await rm(join(root, "old.ts"));
    const second = await buildSemanticIndex(await scanProject(root));

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

  it("persists frontend-to-backend HTTP relations in the shared semantic index", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-semantic-http-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "server"), { recursive: true });
    await writeFile(join(root, "src", "api.ts"), "export const load = (id: string) => fetch(`/api/users/${id}`);\n", "utf8");
    await writeFile(join(root, "server", "users.ts"), "router.get('/api/users/:id', getUser);\n", "utf8");

    const { index } = await buildSemanticIndex(await scanProject(root));

    expect(index.httpEndpoints).toHaveLength(2);
    expect(index.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "http",
        sourceFile: "src/api.ts",
        targetFile: "server/users.ts"
      })
    ]));
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

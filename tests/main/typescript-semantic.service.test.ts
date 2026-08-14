import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSemanticIndex, semanticAnalysisScopes } from "../../src/main/services/semantic-index.service";
import { scanProject } from "../../src/main/services/project-scanner.service";

describe("typescript semantic analysis", () => {
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

    const first = await buildSemanticIndex(await scanProject(root));
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
    const first = await buildSemanticIndex(await scanProject(root));
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

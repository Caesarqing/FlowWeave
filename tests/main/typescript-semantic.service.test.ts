import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSemanticIndex } from "../../src/main/services/semantic-index.service";
import { scanProject } from "../../src/main/services/project-scanner.service";

describe("typescript semantic analysis", () => {
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

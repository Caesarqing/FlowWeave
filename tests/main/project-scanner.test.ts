import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import { scanProject } from "../../src/main/services/project-scanner.service";
import { buildSemanticIndex } from "../../src/main/services/semantic-index.service";

describe("project-scanner.service", () => {
  it("builds a nested file tree and language summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-scan-"));
    await mkdir(join(root, "src/auth"), { recursive: true });
    await writeFile(join(root, "src/auth/index.ts"), "export const auth = true;\n");
    await writeFile(join(root, "package.json"), "{}\n");

    const project = await scanProject(root);

    expect(project.summary.totalFiles).toBe(2);
    expect(project.summary.languages.TypeScript).toBe(1);
    expect(project.files.map((node) => node.path)).toContain("src");
    expect(project.files.find((node) => node.path === "src")?.children?.[0].path).toBe("src/auth");

    const selected = await scanProject(root, { selection: {
      sourcePaths: ["src/auth/index.ts"], configurationPaths: ["package.json"],
      scopeSha256: "a".repeat(64), sourceInventorySha256: "b".repeat(64)
    } });
    expect(filePaths(selected.files)).toEqual(filePaths(project.files));
    expect(selected.summary).toEqual(project.summary);
  });

  it("scans and indexes source files beyond eight nested directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-scan-deep-"));
    const nestedPath = join(root, "a", "b", "c", "d", "e", "f", "g", "h", "i", "j");
    await mkdir(nestedPath, { recursive: true });
    await writeFile(join(nestedPath, "deep.ts"), "export const deep = true;\n");

    const project = await scanProject(root);

    expect(JSON.stringify(project.files)).toContain("a/b/c/d/e/f/g/h/i/j/deep.ts");
    expect(project.summary.totalFiles).toBe(1);
    expect(project.summary.truncated).toBe(false);
    expect((await buildSemanticIndex(project)).index.files.map((file) => file.path)).toContain("a/b/c/d/e/f/g/h/i/j/deep.ts");
  });

  it("uses an exact frozen source selection, preserving selected first-party vendor files", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-scan-selection-"));
    await mkdir(join(root, "spring-orm/src/main/java/org/springframework/orm/jpa/vendor"), { recursive: true });
    await mkdir(join(root, "spring-orm/src/main/java/org/springframework/orm/jpa"), { recursive: true });
    await mkdir(join(root, "src/main/java"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, "spring-orm/src/main/java/org/springframework/orm/jpa/vendor/Adapter.java"), "package adapter;\n");
    await writeFile(join(root, "spring-orm/src/main/java/org/springframework/orm/jpa/Excluded.java"), "package adapter;\n");
    await writeFile(join(root, "src/main/java/Included.java"), "package included;\n");
    await writeFile(join(root, "tests/Fixture.java"), "package tests;\n");
    await writeFile(join(root, "generated/Generated.java"), "package generated;\n");
    await writeFile(join(root, "pom.xml"), "<project/>\n");

    const selection = {
      sourcePaths: [
        "spring-orm/src/main/java/org/springframework/orm/jpa/vendor/Adapter.java",
        "src/main/java/Included.java"
      ],
      configurationPaths: ["pom.xml"],
      scopeSha256: "a".repeat(64),
      sourceInventorySha256: "b".repeat(64)
    };
    const project = await scanProject(root, { concurrency: 2, selection } as Parameters<typeof scanProject>[1]);

    expect(filePaths(project.files).sort()).toEqual([...selection.sourcePaths, "pom.xml"].sort());
    expect(project.summary.languages).toEqual({ Java: 2 });
  });

  it("rejects a missing path from a frozen source selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-scan-selection-missing-"));
    await writeFile(join(root, "present.ts"), "export {};\n");

    const selection = {
      sourcePaths: ["missing.ts"],
      configurationPaths: [],
      scopeSha256: "a".repeat(64),
      sourceInventorySha256: "b".repeat(64)
    };

    await expect(scanProject(root, { concurrency: 1, selection } as Parameters<typeof scanProject>[1]))
      .rejects.toThrow(/missing\.ts/);
  });

  it("uses each independent fixture directory's exact file count", async () => {
    const fixtures = [
      { root: await mkdtemp(join(tmpdir(), "flowweave-scan-scale-a-")), count: 257 },
      { root: await mkdtemp(join(tmpdir(), "flowweave-scan-scale-b-")), count: 64 }
    ];
    await Promise.all(fixtures.flatMap(({ root, count }) => Array.from({ length: count }, (_, index) =>
      writeFile(join(root, `fixture-${String(index).padStart(4, "0")}.txt`), `entry ${index}\n`, "utf8")
    )));

    const projects = await Promise.all(fixtures.map(({ root }) => scanProject(root)));

    expect(projects.map((project) => project.summary.totalFiles)).toEqual([257, 64]);
  });

  it("orders dot entries first, then large folders, then ordinary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-scan-order-"));
    await mkdir(join(root, ".config"), { recursive: true });
    await mkdir(join(root, "10-services"), { recursive: true });
    await mkdir(join(root, "2-components", "nested"), { recursive: true });
    await writeFile(join(root, ".editorconfig"), "root = true\n");
    await writeFile(join(root, ".config", "settings.json"), "{}\n");
    await writeFile(join(root, "2-components", "button.tsx"), "export const button = true;\n");
    await writeFile(join(root, "2-components", "nested", "panel.tsx"), "export const panel = true;\n");
    await writeFile(join(root, "10-services", "api.ts"), "export const api = true;\n");
    await writeFile(join(root, "10-config.ts"), "export {};\n");
    await writeFile(join(root, "2-config.ts"), "export {};\n");
    await writeFile(join(root, "README.md"), "# Project\n");

    const project = await scanProject(root);

    expect(project.files.map((node) => node.path)).toEqual([
      ".config",
      ".editorconfig",
      "2-components",
      "10-services",
      "2-config.ts",
      "10-config.ts",
      "README.md"
    ]);
  });

  it("ignores generated .flowweave output", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ignore-"));
    await mkdir(join(root, FLOWWEAVE_DIR, "runs"), { recursive: true });
    await writeFile(join(root, FLOWWEAVE_DIR, "runs", "plan.md"), "# generated\n");
    await writeFile(join(root, "index.ts"), "export const app = true;\n");

    const project = await scanProject(root);

    expect(JSON.stringify(project.files)).not.toContain(FLOWWEAVE_DIR);
    expect(project.summary.totalFiles).toBe(1);
  });

  it("ignores analysis noise while keeping binary assets and architecture configuration visible", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-scan-ignore-"));
    await mkdir(join(root, ".codex"), { recursive: true });
    await mkdir(join(root, ".cursor"), { recursive: true });
    await mkdir(join(root, "src", "generated"), { recursive: true });
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, ".codex", "instructions.md"), "ignored\n");
    await writeFile(join(root, ".cursor", "rules"), "ignored\n");
    await writeFile(join(root, "src", "generated", "client.ts"), "export const generated = true;\n");
    await writeFile(join(root, "assets", "logo.png"), "binary\n");
    await writeFile(join(root, ".env.local"), "TOKEN=secret\n");
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "tsconfig.json"), "{}\n");
    await writeFile(join(root, "Dockerfile"), "FROM node:22\n");
    await writeFile(join(root, "src", "app.ts"), "export const app = true;\n");

    const project = await scanProject(root);
    const serialized = JSON.stringify(project.files);

    expect(serialized).not.toContain(".codex");
    expect(serialized).not.toContain(".cursor");
    expect(serialized).not.toContain("generated/client.ts");
    expect(serialized).toContain("logo.png");
    expect(serialized).not.toContain(".env.local");
    expect(serialized).toContain("package.json");
    expect(serialized).toContain("tsconfig.json");
    expect(serialized).toContain("Dockerfile");
    expect(serialized).toContain("src/app.ts");
    expect((await buildSemanticIndex(project)).index.files.map((file) => file.path)).not.toContain("assets/logo.png");
  });

  it("ignores nested dependencies and symbolic links outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-scan-safe-"));
    const outside = await mkdtemp(join(tmpdir(), "flowweave-scan-outside-"));
    await mkdir(join(root, "backend", "node_modules", "package"), { recursive: true });
    await writeFile(join(root, "backend", "node_modules", "package", "index.ts"), "export const dependency = true;\n");
    await writeFile(join(outside, "secret.ts"), "export const secret = true;\n");
    await symlink(outside, join(root, "linked"));
    await writeFile(join(root, "main.ts"), "export const main = true;\n");

    const project = await scanProject(root);
    const serialized = JSON.stringify(project.files);

    expect(serialized).not.toContain("node_modules");
    expect(serialized).not.toContain("linked");
    expect(serialized).not.toContain("secret.ts");
    expect(serialized).toContain("main.ts");
  });

  it("recognizes a git repository without an origin remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-scan-git-"));
    await promisify(execFile)("git", ["init", root]);
    await writeFile(join(root, "main.ts"), "export const main = true;\n");

    const project = await scanProject(root);

    expect(project.git.isRepo).toBe(true);
    expect(project.git.remote).toBeUndefined();
  });

  it("rejects invalid scan concurrency settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-scan-options-"));
    await writeFile(join(root, "main.ts"), "export const main = true;\n");

    await expect(scanProject(root, { concurrency: 0 })).rejects.toThrow(
      "Project scan concurrency must be an integer between 1 and 128"
    );
  });
});

function filePaths(nodes: import("../../src/types").ProjectFileNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.type === "file" ? [node.path] : []),
    ...filePaths(node.children ?? [])
  ]);
}

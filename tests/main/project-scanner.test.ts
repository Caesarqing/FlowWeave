import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FLOWWEAVE_DIR } from "../../src/main/storage/flowweave-paths";
import { scanProject } from "../../src/main/services/project-scanner.service";

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

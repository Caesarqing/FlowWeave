import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("ignores generated .flowweave output", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowweave-ignore-"));
    await mkdir(join(root, FLOWWEAVE_DIR, "runs"), { recursive: true });
    await writeFile(join(root, FLOWWEAVE_DIR, "runs", "plan.md"), "# generated\n");
    await writeFile(join(root, "index.ts"), "export const app = true;\n");

    const project = await scanProject(root);

    expect(JSON.stringify(project.files)).not.toContain(FLOWWEAVE_DIR);
    expect(project.summary.totalFiles).toBe(1);
  });
});

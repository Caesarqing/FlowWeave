import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Electron desktop entry", () => {
  it("uses a CommonJS preload when renderer sandboxing is enabled", async () => {
    const root = process.cwd();
    const mainSource = await readFile(join(root, "src/main/index.ts"), "utf8");
    const configSource = await readFile(join(root, "electron.vite.config.ts"), "utf8");

    expect(mainSource).toContain('preload: join(__dirname, "../preload/index.cjs")');
    expect(mainSource).toContain("sandbox: true");
    expect(configSource).toContain('format: "cjs"');
    expect(configSource).toContain('entryFileNames: "index.cjs"');
  });
});

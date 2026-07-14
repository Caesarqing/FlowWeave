import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Electron desktop entry", () => {
  it("uses a CommonJS preload when renderer sandboxing is enabled", async () => {
    const root = process.cwd();
    const mainSource = await readFile(join(root, "src/main/index.ts"), "utf8");
    const configSource = await readFile(join(root, "electron.vite.config.ts"), "utf8");
    const packageSource = await readFile(join(root, "package.json"), "utf8");
    const brandSource = await readFile(join(root, "src/components/BrandLogo.tsx"), "utf8");

    expect(mainSource).toContain('preload: join(__dirname, "../preload/index.cjs")');
    expect(mainSource).toContain("sandbox: true");
    expect(mainSource).toContain('"--flowweave-smoke-test"');
    expect(mainSource).toContain('"did-finish-load"');
    expect(mainSource).toContain('"did-fail-load"');
    expect(mainSource).toContain("function exitSmokeTest(window: BrowserWindow, exitCode: number): never");
    expect(mainSource).toContain("window.destroy();");
    expect(mainSource).toContain("process.exit(exitCode);");
    expect(configSource).toContain('format: "cjs"');
    expect(configSource).toContain('entryFileNames: "index.cjs"');
    expect(mainSource).toContain('"flowweave-app-icon.png"');
    expect(packageSource).toContain('"icon": "logo/flowweave-app-icon.png"');
    expect(packageSource).not.toContain('"icon": "logo/flowweave_white_on_black.png"');
    expect(brandSource).toContain('"./flowweave_black_line_on_white.png"');
    expect(brandSource).toContain('"./flowweave_white_on_black.png"');
    expect(`${mainSource}${packageSource}${brandSource}`).not.toContain("_little.png");
  });
});

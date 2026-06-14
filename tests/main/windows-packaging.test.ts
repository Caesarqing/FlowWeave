import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows packaging", () => {
  it("defines assisted per-user NSIS installers for both architectures", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      build: {
        win: { icon: string; target: string[]; artifactName: string };
        nsis: Record<string, boolean>;
      };
    };

    expect(packageJson.scripts["dist:win:x64"]).toContain("--x64");
    expect(packageJson.scripts["dist:win:arm64"]).toContain("--arm64");
    expect(packageJson.scripts["smoke:packaged"]).toContain("run-packaged-smoke");
    expect(packageJson.build.win).toMatchObject({
      icon: "logo/flowweave-app-icon.ico",
      target: ["nsis"],
      artifactName: "${productName}-${version}-win-${arch}-setup.${ext}"
    });
    expect(packageJson.build.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true
    });
  });

  it("includes a Windows icon", async () => {
    await expect(access(join(process.cwd(), "logo", "flowweave-app-icon.ico"))).resolves.toBeUndefined();
  });

  it("builds Windows installers and a macOS package in GitHub Actions", async () => {
    const workflow = await readFile(join(process.cwd(), ".github", "workflows", "windows-build.yml"), "utf8");

    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("runs-on: windows-11-arm");
    expect(workflow).toContain("runs-on: macos-14");
    expect(workflow).toContain("electron-builder --win --dir --x64");
    expect(workflow).toContain("electron-builder --win --dir --arm64");
    expect(workflow).toContain("electron-builder --mac --dir --arm64");
    expect(workflow).toContain("npm run smoke:packaged");
    expect(workflow).toContain("scripts/run-windows-installer-smoke.ps1");
    expect(workflow).toContain("FlowWeave-0.1.0-win-x64-setup.exe");
    expect(workflow).toContain("FlowWeave-0.1.0-win-arm64-setup.exe");
    expect(workflow).toContain("FlowWeave-0.1.0-mac-arm64.zip");
  });
});

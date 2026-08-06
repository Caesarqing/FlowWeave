import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertProjectPluginPath,
  getBuiltInAgentPluginManifest,
  getBuiltInAgentPluginStatuses,
  installBuiltInAgentPlugin,
  resolveAgentPluginInstructionPath,
  resolveBundledPluginRoot,
  resolveExternalPluginRoot,
  resolveProjectPluginRoot
} from "../../src/main/services/agent-plugin.service";

describe("agent-plugin.service", () => {
  it("loads the built-in FlowWeave plugin manifest for four host targets", async () => {
    const manifest = await getBuiltInAgentPluginManifest();

    expect(manifest).toMatchObject({
      id: "flowweave",
      protocolVersion: 1,
      hosts: expect.arrayContaining([
        expect.objectContaining({ id: "codex" }),
        expect.objectContaining({ id: "claude" }),
        expect.objectContaining({ id: "gemini" }),
        expect.objectContaining({ id: "cursor" })
      ])
    });
  });

  it("detects missing and installed project-local built-in plugin copies", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const pluginRoot = resolveProjectPluginRoot(projectPath);

    const before = await getBuiltInAgentPluginStatuses(projectPath);
    expect(before.every((status) => status.status === "missing")).toBe(true);
    expect(before.every((status) => status.installTarget === pluginRoot)).toBe(true);

    await installBuiltInAgentPlugin(projectPath);
    const after = await getBuiltInAgentPluginStatuses(projectPath);

    expect(after.every((status) => status.status === "installed")).toBe(true);
    expect(after.every((status) => status.hostInstructionPath?.startsWith(join(pluginRoot, "hosts")))).toBe(true);
    await expect(readFile(join(pluginRoot, "manifest.json"), "utf8")).resolves.toContain('"protocolVersion": 1');
  });

  it("installs native plugin manifests and marketplace discovery files for external agents", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const externalPluginRoot = resolveExternalPluginRoot(projectPath);

    await installBuiltInAgentPlugin(projectPath);

    await expect(readFile(join(externalPluginRoot, ".codex-plugin", "plugin.json"), "utf8")).resolves.toContain('"skills": "./skills/"');
    await expect(readFile(join(externalPluginRoot, ".claude-plugin", "plugin.json"), "utf8")).resolves.toContain('"version": "0.2.0"');
    const codexMarketplace = JSON.parse(await readFile(join(projectPath, ".agents", "plugins", "marketplace.json"), "utf8")) as {
      plugins: Array<{ source: { path: string } }>;
    };
    const claudeMarketplace = JSON.parse(await readFile(join(projectPath, ".claude-plugin", "marketplace.json"), "utf8")) as {
      plugins: Array<{ source: string }>;
    };

    expect(codexMarketplace.plugins[0]?.source.path).toBe("./plugins/flowweave");
    expect(claudeMarketplace.plugins[0]?.source).toBe("./plugins/flowweave");
  });

  it("preserves existing Codex and Claude marketplace plugin entries while upserting FlowWeave", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    await mkdir(join(projectPath, ".agents", "plugins"), { recursive: true });
    await mkdir(join(projectPath, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(projectPath, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        name: "existing-codex-marketplace",
        interface: { displayName: "Existing Codex" },
        plugins: [{
          name: "existing-tool",
          source: { source: "local", path: "./plugins/existing-tool" },
          category: "Developer Tools"
        }, {
          name: "flowweave",
          source: { source: "local", path: "./old-flowweave" }
        }]
      }),
      "utf8"
    );
    await writeFile(
      join(projectPath, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "existing-claude-marketplace",
        owner: { name: "Existing Owner" },
        plugins: [{
          name: "existing-tool",
          source: "./plugins/existing-tool"
        }, {
          name: "flowweave",
          source: "./old-flowweave"
        }]
      }),
      "utf8"
    );

    await installBuiltInAgentPlugin(projectPath);

    const codexMarketplace = JSON.parse(await readFile(join(projectPath, ".agents", "plugins", "marketplace.json"), "utf8")) as {
      name: string;
      plugins: Array<{ name: string; source: string | { path: string } }>;
    };
    const claudeMarketplace = JSON.parse(await readFile(join(projectPath, ".claude-plugin", "marketplace.json"), "utf8")) as {
      name: string;
      owner: { name: string };
      plugins: Array<{ name: string; source: string | { path: string } }>;
    };

    expect(codexMarketplace.name).toBe("existing-codex-marketplace");
    expect(codexMarketplace.plugins.map((plugin) => plugin.name)).toEqual(["existing-tool", "flowweave"]);
    expect((codexMarketplace.plugins[1]?.source as { path: string }).path).toBe("./plugins/flowweave");
    expect(claudeMarketplace.owner.name).toBe("Existing Owner");
    expect(claudeMarketplace.plugins.map((plugin) => plugin.name)).toEqual(["existing-tool", "flowweave"]);
    expect(claudeMarketplace.plugins[1]?.source).toBe("./plugins/flowweave");
  });

  it("refreshes an existing external plugin directory only when it is FlowWeave-owned", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const externalPluginRoot = resolveExternalPluginRoot(projectPath);
    await mkdir(externalPluginRoot, { recursive: true });
    await writeFile(
      join(externalPluginRoot, "manifest.json"),
      JSON.stringify({
        id: "flowweave",
        name: "FlowWeave Agent Bridge",
        version: "0.1.0",
        protocolVersion: 1,
        description: "old",
        hosts: []
      }),
      "utf8"
    );

    await installBuiltInAgentPlugin(projectPath);

    await expect(readFile(join(externalPluginRoot, ".codex-plugin", "plugin.json"), "utf8")).resolves.toContain('"version": "0.2.0"');
  });

  it("rejects an existing non-FlowWeave external plugin directory without overwriting it", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const externalPluginRoot = resolveExternalPluginRoot(projectPath);
    const unrelatedPath = join(externalPluginRoot, "unrelated.txt");
    await mkdir(externalPluginRoot, { recursive: true });
    await writeFile(unrelatedPath, "do not overwrite", "utf8");

    await expect(installBuiltInAgentPlugin(projectPath)).rejects.toThrow("Refusing to overwrite existing non-FlowWeave plugin directory");
    await expect(readFile(unrelatedPath, "utf8")).resolves.toBe("do not overwrite");
  });

  it("rejects malformed marketplace JSON instead of overwriting it", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const marketplacePath = join(projectPath, ".agents", "plugins", "marketplace.json");
    await mkdir(join(projectPath, ".agents", "plugins"), { recursive: true });
    await writeFile(marketplacePath, "{ invalid json", "utf8");

    await expect(installBuiltInAgentPlugin(projectPath)).rejects.toThrow("Codex marketplace is malformed JSON");
    await expect(readFile(marketplacePath, "utf8")).resolves.toBe("{ invalid json");
  });

  it("marks installed project plugin discovery as outdated when a native manifest version differs", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const externalPluginRoot = resolveExternalPluginRoot(projectPath);
    await installBuiltInAgentPlugin(projectPath);
    await writeFile(
      join(externalPluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "flowweave",
        version: "0.1.0",
        skills: "./skills/"
      }),
      "utf8"
    );

    const statuses = await getBuiltInAgentPluginStatuses(projectPath);

    expect(statuses.every((status) => status.status === "outdated")).toBe(true);
    expect(statuses[0]?.message).toContain("version mismatch");
  });

  it("resolves host instructions from bundled resources before install and project copy after install", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const pluginRoot = resolveProjectPluginRoot(projectPath);

    await expect(resolveAgentPluginInstructionPath(projectPath, "codex")).resolves.toBe(join(resolveBundledPluginRoot(), "hosts", "codex.md"));

    await installBuiltInAgentPlugin(projectPath);

    await expect(resolveAgentPluginInstructionPath(projectPath, "codex")).resolves.toBe(join(pluginRoot, "hosts", "codex.md"));
  });

  it("rejects plugin paths outside the authorized project plugin directory", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));

    expect(() => assertProjectPluginPath(projectPath, join(projectPath, ".flowweave", "agent-plugins", "flowweave"))).not.toThrow();
    expect(() => assertProjectPluginPath(projectPath, join(projectPath, "..", "flowweave"))).toThrow("escapes the authorized project plugin directory");
  });

  it("allows tests to resolve a packaged-style bundled plugin root override", async () => {
    const original = process.env.FLOWWEAVE_BUNDLED_PLUGIN_ROOT;
    process.env.FLOWWEAVE_BUNDLED_PLUGIN_ROOT = join(process.cwd(), "flowweave-plugin");
    try {
      expect(resolveBundledPluginRoot()).toBe(join(process.cwd(), "flowweave-plugin"));
    } finally {
      if (original === undefined) delete process.env.FLOWWEAVE_BUNDLED_PLUGIN_ROOT;
      else process.env.FLOWWEAVE_BUNDLED_PLUGIN_ROOT = original;
    }
  });

  it("packages the built-in plugin as an Electron extra resource", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      build?: { extraResources?: Array<{ from?: string; to?: string }> };
    };

    expect(packageJson.build?.extraResources).toContainEqual({
      from: "flowweave-plugin",
      to: "flowweave-plugin"
    });
  });
});

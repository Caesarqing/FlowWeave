import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertProjectPluginPath,
  getBuiltInAgentPluginManifest,
  getBuiltInAgentPluginStatuses,
  installBuiltInAgentPlugin,
  resolveAgentPluginInstructionPath,
  resolveBundledPluginRoot,
  resolveExternalPluginRoot
} from "../../src/main/services/agent-plugin.service";

const renameFailure = vi.hoisted(() => ({
  sourceMarker: undefined as string | undefined,
  destinationPath: undefined as string | undefined,
  message: undefined as string | undefined
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const [sourcePath, destinationPath] = args;
      if (renameFailure.sourceMarker && renameFailure.destinationPath === String(destinationPath) &&
        String(sourcePath).includes(renameFailure.sourceMarker)) {
        const message = renameFailure.message ?? "Injected filesystem rename failure.";
        renameFailure.sourceMarker = undefined;
        renameFailure.destinationPath = undefined;
        renameFailure.message = undefined;
        const error = new Error(message) as Error & { code: string };
        error.code = "EIO";
        throw error;
      }
      return actual.rename(...args);
    }
  };
});

afterEach(() => {
  renameFailure.sourceMarker = undefined;
  renameFailure.destinationPath = undefined;
  renameFailure.message = undefined;
});

describe("agent-plugin.service", () => {
  it("loads the built-in FlowWeave plugin manifest for four host targets", async () => {
    const manifest = await getBuiltInAgentPluginManifest();

    expect(manifest).toMatchObject({
      id: "flowweave",
      protocolVersion: 2,
      hosts: expect.arrayContaining([
        expect.objectContaining({ id: "codex" }),
        expect.objectContaining({ id: "claude" }),
        expect.objectContaining({ id: "gemini" }),
        expect.objectContaining({ id: "cursor" })
      ])
    });
  });

  it("uses Agent Inbox v2 instructions and the request responsePath throughout the plugin", async () => {
    const pluginRoot = resolveBundledPluginRoot();
    const manifest = JSON.parse(await readFile(join(pluginRoot, "manifest.json"), "utf8")) as {
      protocolVersion: number;
      description: string;
    };
    const nativeManifestPaths = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "package.json"];
    const hostInstructionPaths = ["codex.md", "claude.md", "gemini.md", "cursor.md"];
    const nativeManifests = await Promise.all(nativeManifestPaths.map(async (path) =>
      readFile(join(pluginRoot, path), "utf8")
    ));
    const hostInstructions = await Promise.all(hostInstructionPaths.map(async (path) =>
      readFile(join(pluginRoot, "hosts", path), "utf8")
    ));
    const skill = await readFile(join(pluginRoot, "skills", "flowweave", "SKILL.md"), "utf8");

    expect(manifest.protocolVersion).toBe(2);
    expect(manifest.description).toContain("Agent Inbox v2");
    for (const content of [...nativeManifests, ...hostInstructions, skill]) {
      expect(content).toContain("Agent Inbox v2");
      expect(content).not.toContain("Agent Protocol v1");
      expect(content).not.toMatch(/(?<!agent-)response\.json/);
      expect(content).not.toMatch(/(?<!agent-)request\.json/);
    }
    for (const content of [...hostInstructions, skill]) expect(content).toContain("responsePath");
    expect(skill).toContain("agent-request.json");
    expect(skill).toContain("agent-response.json");
  });

  it("detects missing and installed project-local built-in plugin copies", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const pluginRoot = resolveExternalPluginRoot(projectPath);

    const before = await getBuiltInAgentPluginStatuses(projectPath);
    expect(before.every((status) => status.status === "missing")).toBe(true);
    expect(before.every((status) => status.installTarget === pluginRoot)).toBe(true);

    await installBuiltInAgentPlugin(projectPath);
    const after = await getBuiltInAgentPluginStatuses(projectPath);

    expect(after.every((status) => status.status === "installed")).toBe(true);
    expect(after.every((status) => status.hostInstructionPath?.startsWith(join(pluginRoot, "hosts")))).toBe(true);
    await expect(readFile(join(pluginRoot, "manifest.json"), "utf8")).resolves.toContain('"protocolVersion": 2');
    await expect(readFile(join(projectPath, ".flowweave", "agent-plugins", "flowweave", "manifest.json")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const state = JSON.parse(await readFile(join(projectPath, ".flowweave", "agent-plugin-state.json"), "utf8")) as {
      schemaVersion: number;
      pluginId: string;
      installedVersion: string;
      protocolVersion: number;
      contentHash: string;
      sourceHash: string;
      hostChecks: Array<{ hostId: string; status: string }>;
      recentMigrationResult: { status: string };
    };
    expect(state).toMatchObject({
      schemaVersion: 1,
      pluginId: "flowweave",
      installedVersion: "0.2.0",
      protocolVersion: 2,
      recentMigrationResult: { status: "not-run" }
    });
    expect(state.contentHash).toBe(state.sourceHash);
    expect(state.hostChecks.map(({ hostId, status }) => [hostId, status])).toEqual([
      ["codex", "installed"],
      ["claude", "installed"],
      ["gemini", "installed"],
      ["cursor", "installed"]
    ]);
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
        name: "FlowWeave Agent Inbox",
        version: "0.1.0",
        protocolVersion: 2,
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

  it("keeps the installed plugin and marketplace bytes when another marketplace is malformed", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    await installBuiltInAgentPlugin(projectPath);
    const pluginManifestPath = join(resolveExternalPluginRoot(projectPath), "manifest.json");
    const codexMarketplacePath = join(projectPath, ".agents", "plugins", "marketplace.json");
    const claudeMarketplacePath = join(projectPath, ".claude-plugin", "marketplace.json");
    const originalPluginManifest = await readFile(pluginManifestPath, "utf8");
    const originalCodexMarketplace = await readFile(codexMarketplacePath, "utf8");
    await writeFile(claudeMarketplacePath, "{ malformed Claude marketplace", "utf8");

    await expect(installBuiltInAgentPlugin(projectPath)).rejects.toThrow("Claude marketplace is malformed JSON");

    await expect(readFile(pluginManifestPath, "utf8")).resolves.toBe(originalPluginManifest);
    await expect(readFile(codexMarketplacePath, "utf8")).resolves.toBe(originalCodexMarketplace);
    await expect(readFile(claudeMarketplacePath, "utf8")).resolves.toBe("{ malformed Claude marketplace");
  });

  it("rolls the plugin and Codex marketplace back when the Claude marketplace write fails", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    await installBuiltInAgentPlugin(projectPath);
    const pluginManifestPath = join(resolveExternalPluginRoot(projectPath), "manifest.json");
    const codexMarketplacePath = join(projectPath, ".agents", "plugins", "marketplace.json");
    const claudeDirectory = join(projectPath, ".claude-plugin");
    const claudeMarketplacePath = join(claudeDirectory, "marketplace.json");
    const statePath = join(projectPath, ".flowweave", "agent-plugin-state.json");
    const originalPluginManifest = await readFile(pluginManifestPath, "utf8");
    const originalCodexMarketplace = await readFile(codexMarketplacePath, "utf8");
    const originalClaudeMarketplace = await readFile(claudeMarketplacePath, "utf8");
    const originalState = await readFile(statePath, "utf8");
    const originalMode = (await stat(claudeDirectory)).mode & 0o777;

    await chmod(claudeDirectory, 0o555);
    try {
      await expect(installBuiltInAgentPlugin(projectPath)).rejects.toThrow(
        "FlowWeave plugin installation failed during update-claude-marketplace"
      );
    } finally {
      await chmod(claudeDirectory, originalMode);
    }

    await expect(readFile(pluginManifestPath, "utf8")).resolves.toBe(originalPluginManifest);
    await expect(readFile(codexMarketplacePath, "utf8")).resolves.toBe(originalCodexMarketplace);
    await expect(readFile(claudeMarketplacePath, "utf8")).resolves.toBe(originalClaudeMarketplace);
    await expect(readFile(statePath, "utf8")).resolves.toBe(originalState);
    await expect(readdir(join(projectPath, "plugins"))).resolves.toEqual(["flowweave"]);
  });

  it("restores the previous plugin and project state when staged plugin activation fails", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    await installBuiltInAgentPlugin(projectPath);
    const pluginRoot = resolveExternalPluginRoot(projectPath);
    const pluginMarkerPath = join(pluginRoot, "hosts", "codex.md");
    await writeFile(pluginMarkerPath, "previous installed plugin contents\n", "utf8");
    const before = await captureInstalledPluginState(projectPath);
    renameFailure.sourceMarker = ".flowweave-staging-";
    renameFailure.destinationPath = pluginRoot;
    renameFailure.message = "Injected failure activating staged plugin.";

    await expect(installBuiltInAgentPlugin(projectPath)).rejects.toThrow(
      "FlowWeave plugin installation failed during replace-plugin-directory"
    );

    await expect(captureInstalledPluginState(projectPath)).resolves.toEqual(before);
    await expect(readFile(pluginMarkerPath, "utf8")).resolves.toBe("previous installed plugin contents\n");
  });

  it("restores the previous plugin and marketplaces when the Codex marketplace write fails", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    await installBuiltInAgentPlugin(projectPath);
    const pluginRoot = resolveExternalPluginRoot(projectPath);
    const pluginMarkerPath = join(pluginRoot, "hosts", "codex.md");
    const codexMarketplacePath = join(projectPath, ".agents", "plugins", "marketplace.json");
    await writeFile(pluginMarkerPath, "previous installed plugin contents\n", "utf8");
    const before = await captureInstalledPluginState(projectPath);
    renameFailure.sourceMarker = ".marketplace.json.";
    renameFailure.destinationPath = codexMarketplacePath;
    renameFailure.message = "Injected failure writing Codex marketplace.";

    await expect(installBuiltInAgentPlugin(projectPath)).rejects.toThrow(
      "FlowWeave plugin installation failed during update-codex-marketplace"
    );

    await expect(captureInstalledPluginState(projectPath)).resolves.toEqual(before);
    await expect(readFile(pluginMarkerPath, "utf8")).resolves.toBe("previous installed plugin contents\n");
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

  it.each([
    ["missing", undefined],
    ["v1", 1]
  ])("rejects installed plugin manifests with %s protocolVersion", async (_label, protocolVersion) => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const manifestPath = join(resolveExternalPluginRoot(projectPath), "manifest.json");
    await installBuiltInAgentPlugin(projectPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.protocolVersion = protocolVersion;
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(getBuiltInAgentPluginStatuses(projectPath)).rejects.toThrow("requires protocolVersion 2");
  });

  it("resolves host instructions from bundled resources before install and project copy after install", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const pluginRoot = resolveExternalPluginRoot(projectPath);

    await expect(resolveAgentPluginInstructionPath(projectPath, "codex")).resolves.toBe(join(resolveBundledPluginRoot(), "hosts", "codex.md"));

    await installBuiltInAgentPlugin(projectPath);

    await expect(resolveAgentPluginInstructionPath(projectPath, "codex")).resolves.toBe(join(pluginRoot, "hosts", "codex.md"));
  });

  it("rejects plugin paths outside the authorized project plugin directory", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));

    expect(() => assertProjectPluginPath(projectPath, join(projectPath, "plugins", "flowweave"))).not.toThrow();
    expect(() => assertProjectPluginPath(projectPath, join(projectPath, "plugins", "flowweave", "hosts", "codex.md"))).not.toThrow();
    expect(() => assertProjectPluginPath(projectPath, join(projectPath, ".flowweave", "agent-plugins", "flowweave"))).toThrow(
      "escapes the authorized project plugin directory"
    );
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

async function captureInstalledPluginState(projectPath: string): Promise<{
  pluginFiles: Array<{ path: string; contents: string }>;
  codexMarketplace: string;
  claudeMarketplace: string;
  pluginState: string;
}> {
  const pluginRoot = resolveExternalPluginRoot(projectPath);
  const pluginFiles: Array<{ path: string; contents: string }> = [];
  await collectPluginFiles(pluginRoot, pluginRoot, pluginFiles);
  pluginFiles.sort((left, right) => left.path.localeCompare(right.path));
  return {
    pluginFiles,
    codexMarketplace: await readFile(join(projectPath, ".agents", "plugins", "marketplace.json"), "utf8"),
    claudeMarketplace: await readFile(join(projectPath, ".claude-plugin", "marketplace.json"), "utf8"),
    pluginState: await readFile(join(projectPath, ".flowweave", "agent-plugin-state.json"), "utf8")
  };
}

async function collectPluginFiles(
  pluginRoot: string,
  directoryPath: string,
  collected: Array<{ path: string; contents: string }>
): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      await collectPluginFiles(pluginRoot, entryPath, collected);
    } else if (entry.isFile()) {
      collected.push({
        path: entryPath.slice(pluginRoot.length + 1),
        contents: (await readFile(entryPath)).toString("base64")
      });
    }
  }
}

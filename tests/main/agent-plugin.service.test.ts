import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
      if (renameFailure.sourceMarker && (!renameFailure.destinationPath || renameFailure.destinationPath === String(destinationPath)) &&
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

    await writeManagedHostInstructions(projectPath);
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
      recentMigrationResult: { status: "completed" }
    });
    expect(state.contentHash).toBe(state.sourceHash);
    expect(state.hostChecks.map(({ hostId, status }) => [hostId, status])).toEqual([
      ["codex", "installed"],
      ["claude", "installed"],
      ["gemini", "installed"],
      ["cursor", "installed"]
    ]);
  });

  it("migrates valid legacy project manifests before installing the plugin state", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const legacyRoot = join(projectPath, ".flowweave", "agent-connectors");
    const targetRoot = join(projectPath, ".flowweave", "agents", "connectors");
    const legacyManifest = JSON.stringify({
      id: "custom:reviewer",
      name: "Project reviewer",
      kind: "cli",
      protocol: "agent-inbox",
      protocolVersion: 2,
      command: "reviewer",
      args: [],
      capabilities: ["implementation-plan"],
      description: "Reviews the project"
    }, null, 2) + "\n";
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(join(legacyRoot, "reviewer.json"), legacyManifest, "utf8");
    await writeManagedHostInstructions(projectPath);

    await installBuiltInAgentPlugin(projectPath);

    await expect(readFile(join(targetRoot, "reviewer.json"), "utf8")).resolves.toBe(legacyManifest);
    await expect(readFile(join(legacyRoot, "reviewer.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const state = JSON.parse(await readFile(join(projectPath, ".flowweave", "agent-plugin-state.json"), "utf8")) as {
      recentMigrationResult: { status: string; migratedFiles?: Array<{ sourcePath: string; targetPath: string }> };
    };
    expect(state.recentMigrationResult.status).toBe("completed");
    expect(state.recentMigrationResult.migratedFiles).toContainEqual(expect.objectContaining({
      sourcePath: join(legacyRoot, "reviewer.json"),
      targetPath: join(targetRoot, "reviewer.json")
    }));

    await installBuiltInAgentPlugin(projectPath);
    const reinstalledState = JSON.parse(await readFile(join(projectPath, ".flowweave", "agent-plugin-state.json"), "utf8")) as {
      recentMigrationResult: unknown;
    };
    expect(reinstalledState.recentMigrationResult).toEqual(state.recentMigrationResult);
  });

  it("migrates only explicitly completed legacy bridge runs into a summary", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const bridgeRun = join(projectPath, ".flowweave", "agent-bridge", "run-1");
    const summaryPath = join(projectPath, ".flowweave", "runs", "run-1", "legacy-summary.json");
    await mkdir(bridgeRun, { recursive: true });
    await writeFile(join(bridgeRun, "request.json"), "{\"kind\":\"review\"}\n", "utf8");
    await writeFile(join(bridgeRun, "completion.json"), "{\"status\":\"completed\",\"completedAt\":\"2026-09-20T00:00:00.000Z\"}\n", "utf8");

    await installBuiltInAgentPlugin(projectPath);

    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as { migratedFrom: string; completedAt: string; files: unknown[] };
    expect(summary.migratedFrom).toBe(bridgeRun);
    expect(summary.completedAt).toBe("2026-09-20T00:00:00.000Z");
    expect(summary.files).toHaveLength(2);
    await expect(readFile(bridgeRun, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const flowweaveEntries = await readdir(join(projectPath, ".flowweave"));
    expect(flowweaveEntries.some((entry) => entry.includes("agent-bridge.flowweave-migration-"))).toBe(false);
  });

  it("records and deletes abandoned legacy bridge runs with no response or completion", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const bridgeRun = join(projectPath, ".flowweave", "agent-bridge", "abandoned-run");
    const summaryPath = join(projectPath, ".flowweave", "runs", "abandoned-run", "legacy-summary.json");
    await mkdir(bridgeRun, { recursive: true });
    await writeFile(join(bridgeRun, "request.json"), "{\"kind\":\"review\"}\n", "utf8");
    await writeFile(join(bridgeRun, "prompt.md"), "Review the module graph.\n", "utf8");
    await writeFile(join(bridgeRun, "instructions.md"), "Return a structured response.\n", "utf8");

    await installBuiltInAgentPlugin(projectPath);

    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as { status: string; files: unknown[] };
    expect(summary.status).toBe("abandoned");
    expect(summary.files).toHaveLength(3);
    await expect(readFile(bridgeRun, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks legacy cleanup without moving manifests when a target conflicts or a response is pending", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const legacyRoot = join(projectPath, ".flowweave", "agent-connectors");
    const targetRoot = join(projectPath, ".flowweave", "agents", "connectors");
    const bridgeRun = join(projectPath, ".flowweave", "agent-bridge", "run-1");
    const source = JSON.stringify({
      id: "custom:reviewer", name: "Legacy reviewer", protocol: "agent-inbox", protocolVersion: 2,
      command: "legacy-reviewer", args: [], capabilities: ["implementation-plan"], description: "Legacy"
    });
    await mkdir(legacyRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    await mkdir(bridgeRun, { recursive: true });
    await writeFile(join(legacyRoot, "reviewer.json"), source, "utf8");
    await writeFile(join(targetRoot, "reviewer.json"), "{\"different\":true}\n", "utf8");
    await writeFile(join(bridgeRun, "agent-response.json"), "{}\n", "utf8");

    await installBuiltInAgentPlugin(projectPath);

    await expect(readFile(join(legacyRoot, "reviewer.json"), "utf8")).resolves.toBe(source);
    await expect(readFile(join(targetRoot, "reviewer.json"), "utf8")).resolves.toBe("{\"different\":true}\n");
    const state = JSON.parse(await readFile(join(projectPath, ".flowweave", "agent-plugin-state.json"), "utf8")) as {
      recentMigrationResult: { status: string; message?: string };
    };
    expect(state.recentMigrationResult.status).toBe("blocked");
    expect(state.recentMigrationResult.message).toContain(join(legacyRoot, "reviewer.json"));
  });

  it("preserves unknown bridge files and refuses legacy bridge symlinks", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const bridgeRun = join(projectPath, ".flowweave", "agent-bridge", "run-1");
    await mkdir(bridgeRun, { recursive: true });
    await writeFile(join(bridgeRun, "notes.txt"), "user note\n", "utf8");

    await installBuiltInAgentPlugin(projectPath);

    await expect(readFile(join(bridgeRun, "notes.txt"), "utf8")).resolves.toBe("user note\n");
    const externalPath = await mkdtemp(join(tmpdir(), "flowweave-external-bridge-"));
    await writeFile(join(externalPath, "keep.txt"), "outside project\n", "utf8");
    await rm(join(projectPath, ".flowweave", "agent-bridge"), { recursive: true });
    await symlink(externalPath, join(projectPath, ".flowweave", "agent-bridge"));

    await expect(installBuiltInAgentPlugin(projectPath)).rejects.toThrow("symbolic link");
    await expect(readFile(join(externalPath, "keep.txt"), "utf8")).resolves.toBe("outside project\n");
  });

  it("rolls back staged project manifests when legacy cleanup fails", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-project-"));
    const legacyRoot = join(projectPath, ".flowweave", "agent-connectors");
    const targetPath = join(projectPath, ".flowweave", "agents", "connectors", "reviewer.json");
    const sourcePath = join(legacyRoot, "reviewer.json");
    const manifest = JSON.stringify({
      id: "custom:reviewer", name: "Legacy reviewer", protocol: "agent-inbox", protocolVersion: 2,
      command: "reviewer", args: [], capabilities: ["implementation-plan"], description: "Legacy"
    });
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(sourcePath, manifest, "utf8");
    renameFailure.sourceMarker = legacyRoot;
    renameFailure.message = "Injected legacy cleanup failure.";

    await expect(installBuiltInAgentPlugin(projectPath)).rejects.toThrow("Injected legacy cleanup failure");
    await expect(readFile(sourcePath, "utf8")).resolves.toBe(manifest);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["codex", "plugins/flowweave/hosts/codex.md"],
    ["claude", "plugins/flowweave/hosts/claude.md"],
    ["gemini", "plugins/flowweave/hosts/gemini.md"],
    ["cursor", "plugins/flowweave/hosts/cursor.md"]
  ] as const)("reports a missing %s file without changing other host statuses", async (hostId, relativePath) => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-host-missing-"));
    await writeManagedHostInstructions(projectPath);
    await installBuiltInAgentPlugin(projectPath);
    const missingPath = join(projectPath, relativePath);
    await rm(missingPath);

    const statuses = await getBuiltInAgentPluginStatuses(projectPath);
    const targetStatus = statuses.find((status) => status.hostId === hostId);
    const otherStatuses = statuses.filter((status) => status.hostId !== hostId);

    expect(targetStatus?.status).toBe("missing");
    expect(targetStatus?.missingFiles).toContain(relativePath);
    expect(targetStatus?.checks).toContainEqual(expect.objectContaining({ code: "host-instruction-missing", status: "failed" }));
    expect(otherStatuses.every((status) => status.status === "installed")).toBe(true);
  });

  it("contains a host-specific filesystem error to that host status", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-host-path-error-"));
    await writeManagedHostInstructions(projectPath);
    await installBuiltInAgentPlugin(projectPath);
    const claudeManifestDirectory = join(projectPath, "plugins", "flowweave", ".claude-plugin");
    await rm(claudeManifestDirectory, { recursive: true });
    await writeFile(claudeManifestDirectory, "unexpected file", "utf8");

    const statuses = await getBuiltInAgentPluginStatuses(projectPath);
    const claudeStatus = statuses.find((status) => status.hostId === "claude");
    const codexStatus = statuses.find((status) => status.hostId === "codex");

    expect(claudeStatus?.status).toBe("error");
    expect(claudeStatus?.checks).toContainEqual(expect.objectContaining({
      code: "check-error",
      status: "failed",
      filePath: expect.stringContaining(".claude-plugin/plugin.json")
    }));
    expect(codexStatus?.status).toBe("installed");
  });

  it("preserves a healthy install when the bundled shared skill is incomplete", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-broken-bundle-"));
    await writeManagedHostInstructions(projectPath);
    await installBuiltInAgentPlugin(projectPath);
    const pluginRoot = resolveExternalPluginRoot(projectPath);
    const installedManifest = await readFile(join(pluginRoot, "manifest.json"), "utf8");
    const codexMarketplacePath = join(projectPath, ".agents", "plugins", "marketplace.json");
    const claudeMarketplacePath = join(projectPath, ".claude-plugin", "marketplace.json");
    const codexMarketplace = await readFile(codexMarketplacePath, "utf8");
    const claudeMarketplace = await readFile(claudeMarketplacePath, "utf8");
    const bundledRoot = await mkdtemp(join(tmpdir(), "flowweave-plugin-bundled-copy-"));
    await cp(resolveBundledPluginRoot(), bundledRoot, { recursive: true });
    await rm(join(bundledRoot, "skills", "flowweave", "SKILL.md"));
    const originalBundledRoot = process.env.FLOWWEAVE_BUNDLED_PLUGIN_ROOT;

    process.env.FLOWWEAVE_BUNDLED_PLUGIN_ROOT = bundledRoot;
    try {
      await expect(installBuiltInAgentPlugin(projectPath)).rejects.toThrow("shared Skill is missing");
    } finally {
      if (originalBundledRoot === undefined) delete process.env.FLOWWEAVE_BUNDLED_PLUGIN_ROOT;
      else process.env.FLOWWEAVE_BUNDLED_PLUGIN_ROOT = originalBundledRoot;
    }

    await expect(readFile(join(pluginRoot, "manifest.json"), "utf8")).resolves.toBe(installedManifest);
    await expect(readFile(join(pluginRoot, "skills", "flowweave", "SKILL.md"), "utf8")).resolves.toContain("Agent Inbox v2");
    await expect(readFile(codexMarketplacePath, "utf8")).resolves.toBe(codexMarketplace);
    await expect(readFile(claudeMarketplacePath, "utf8")).resolves.toBe(claudeMarketplace);
    await expect(readFile(join(projectPath, ".flowweave", "agent-plugin-state.json"), "utf8")).resolves.toContain('"status": "installed"');
  });

  it.each([
    ["codex", ".agents/plugins/marketplace.json", "marketplace-entry-missing"],
    ["claude", ".claude-plugin/marketplace.json", "marketplace-entry-missing"],
    ["gemini", "GEMINI.md", "managed-block-missing"],
    ["cursor", ".cursor/rules/flowweave.mdc", "managed-block-missing"]
  ] as const)("isolates %s host integration failure to its own status", async (hostId, relativePath, code) => {
    const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-host-integration-"));
    await writeManagedHostInstructions(projectPath);
    await installBuiltInAgentPlugin(projectPath);
    await rm(join(projectPath, relativePath), { force: true });

    const statuses = await getBuiltInAgentPluginStatuses(projectPath);
    const targetStatus = statuses.find((status) => status.hostId === hostId);
    const otherStatuses = statuses.filter((status) => status.hostId !== hostId);

    expect(targetStatus?.status).toBe("missing");
    expect(targetStatus?.missingFiles).toContain(relativePath);
    expect(targetStatus?.checks).toContainEqual(expect.objectContaining({ code, status: "failed" }));
    expect(otherStatuses.every((status) => status.status === "installed")).toBe(true);
  });

  it.each(["codex", "claude", "gemini", "cursor"] as const)(
    "reports a %s version mismatch only for that host",
    async (hostId) => {
      const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-host-version-"));
      await writeManagedHostInstructions(projectPath);
      await installBuiltInAgentPlugin(projectPath);
      const statePath = join(projectPath, ".flowweave", "agent-plugin-state.json");
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        hostChecks: Array<{ hostId: string; version: string }>;
      };
      const targetCheck = state.hostChecks.find((check) => check.hostId === hostId);
      if (!targetCheck) throw new Error(`Missing persisted host check for ${hostId}.`);
      targetCheck.version = "0.1.0";
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

      const statuses = await getBuiltInAgentPluginStatuses(projectPath);
      const targetStatus = statuses.find((status) => status.hostId === hostId);
      const otherStatuses = statuses.filter((status) => status.hostId !== hostId);

      expect(targetStatus?.status).toBe("outdated");
      expect(targetStatus?.checks).toContainEqual(expect.objectContaining({ code: "version-mismatch", status: "failed" }));
      expect(otherStatuses.every((status) => status.status === "installed")).toBe(true);
    }
  );

  it.each(["codex", "claude", "gemini", "cursor"] as const)(
    "reports a %s content hash mismatch only for that host",
    async (hostId) => {
      const projectPath = await mkdtemp(join(tmpdir(), "flowweave-plugin-host-hash-"));
      await writeManagedHostInstructions(projectPath);
      await installBuiltInAgentPlugin(projectPath);
      const instructionPath = join(projectPath, "plugins", "flowweave", "hosts", `${hostId}.md`);
      await writeFile(instructionPath, `${await readFile(instructionPath, "utf8")}\nHost-specific change.\n`, "utf8");

      const statuses = await getBuiltInAgentPluginStatuses(projectPath);
      const targetStatus = statuses.find((status) => status.hostId === hostId);
      const otherStatuses = statuses.filter((status) => status.hostId !== hostId);

      expect(targetStatus?.status).toBe("outdated");
      expect(targetStatus?.checks).toContainEqual(expect.objectContaining({ code: "content-hash-mismatch", status: "failed" }));
      expect(otherStatuses.every((status) => status.status === "installed")).toBe(true);
    }
  );

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
    await writeManagedHostInstructions(projectPath);
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

    expect(statuses.find((status) => status.hostId === "codex")?.status).toBe("outdated");
    expect(statuses.filter((status) => status.hostId !== "codex").every((status) => status.status === "installed")).toBe(true);
    expect(statuses.find((status) => status.hostId === "codex")?.message).toContain("version");
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

async function writeManagedHostInstructions(projectPath: string): Promise<void> {
  const managedBlock = [
    "<!-- flowweave:start -->",
    "Read .flowweave/runs/<run-id>/agent-request.json and follow responsePath.",
    "<!-- flowweave:end -->",
    ""
  ].join("\n");
  await writeFile(join(projectPath, "GEMINI.md"), managedBlock, "utf8");
  await mkdir(join(projectPath, ".cursor", "rules"), { recursive: true });
  await writeFile(
    join(projectPath, ".cursor", "rules", "flowweave.mdc"),
    `---\ndescription: FlowWeave project instructions\nalwaysApply: true\n---\n${managedBlock}`,
    "utf8"
  );
}

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

import { mkdtemp, readFile } from "node:fs/promises";
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

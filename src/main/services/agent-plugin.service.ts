import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { AgentPluginHostId, AgentPluginManifest, AgentPluginStatus } from "../../types";

const BUILT_IN_PLUGIN_DIR = "flowweave-plugin";
const MANIFEST_FILE = "manifest.json";
const PROJECT_PLUGIN_ROOT = ".flowweave/agent-plugins";
const EXTERNAL_PLUGIN_ROOT = "plugins";
const CODEX_MARKETPLACE_FILE = ".agents/plugins/marketplace.json";
const CLAUDE_MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
const FLOWWEAVE_PLUGIN_PATH = "./plugins/flowweave";

export async function getBuiltInAgentPluginManifest(): Promise<AgentPluginManifest> {
  const manifestPath = join(resolveBundledPluginRoot(), MANIFEST_FILE);
  const value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  return parseAgentPluginManifest(value, manifestPath);
}

export async function getBuiltInAgentPluginStatuses(projectPath: string): Promise<AgentPluginStatus[]> {
  const pluginRoot = resolveProjectPluginRoot(projectPath);
  assertProjectPluginPath(projectPath, pluginRoot);
  let manifest: AgentPluginManifest;
  try {
    manifest = await getBuiltInAgentPluginManifest();
  } catch (error) {
    return unavailableStatuses(pluginRoot, formatError(error));
  }

  const installation = await readProjectPluginInstallation(projectPath, manifest);
  return manifest.hosts.map((host) => {
    return {
      pluginId: manifest.id,
      hostId: host.id,
      displayName: host.displayName,
      status: installation.status,
      installedVersion: installation.installedVersion,
      bundledVersion: manifest.version,
      installTarget: pluginRoot,
      hostInstructionPath: join(pluginRoot, "hosts", `${host.id}.md`),
      message: installation.status === "installed"
        ? `Project FlowWeave plugin copy is installed for ${host.displayName}.`
        : installation.message
    };
  });
}

export async function installBuiltInAgentPlugin(projectPath: string): Promise<AgentPluginStatus[]> {
  const manifest = await getBuiltInAgentPluginManifest();
  const pluginRoot = resolveProjectPluginRoot(projectPath);
  assertProjectPluginPath(projectPath, pluginRoot);
  await mkdir(resolve(projectPath, PROJECT_PLUGIN_ROOT), { recursive: true });
  await cp(resolveBundledPluginRoot(), pluginRoot, {
    recursive: true,
    force: true,
    filter: shouldCopyPluginFile
  });
  const externalPluginRoot = resolveExternalPluginRoot(projectPath);
  assertProjectPath(projectPath, externalPluginRoot);
  await assertExternalPluginRootIsWritable(externalPluginRoot);
  await mkdir(resolve(projectPath, EXTERNAL_PLUGIN_ROOT), { recursive: true });
  await cp(resolveBundledPluginRoot(), externalPluginRoot, {
    recursive: true,
    force: true,
    filter: shouldCopyPluginFile
  });
  await upsertCodexMarketplace(resolve(projectPath, CODEX_MARKETPLACE_FILE));
  await upsertClaudeMarketplace(resolve(projectPath, CLAUDE_MARKETPLACE_FILE));
  const installed = await readInstalledManifest(join(pluginRoot, MANIFEST_FILE));
  if (!installed || installed.id !== manifest.id) {
    throw new Error(`Installed FlowWeave plugin manifest could not be verified at ${pluginRoot}.`);
  }
  return getBuiltInAgentPluginStatuses(projectPath);
}

export async function resolveAgentPluginInstructionPath(projectPath: string, hostId: AgentPluginHostId): Promise<string> {
  const pluginRoot = resolveProjectPluginRoot(projectPath);
  const projectInstructionPath = join(pluginRoot, "hosts", `${hostId}.md`);
  assertProjectPluginPath(projectPath, projectInstructionPath);
  if (await pathExists(projectInstructionPath)) {
    return projectInstructionPath;
  }
  const bundledInstructionPath = join(resolveBundledPluginRoot(), "hosts", `${hostId}.md`);
  if (await pathExists(bundledInstructionPath)) {
    return bundledInstructionPath;
  }
  throw new Error(`FlowWeave plugin instructions were not found for host "${hostId}".`);
}

export function resolveBundledPluginRoot(): string {
  if (process.env.FLOWWEAVE_BUNDLED_PLUGIN_ROOT) {
    return resolve(process.env.FLOWWEAVE_BUNDLED_PLUGIN_ROOT);
  }
  if (process.defaultApp || process.env.NODE_ENV === "test") {
    return resolve(process.cwd(), BUILT_IN_PLUGIN_DIR);
  }
  return resolve(process.resourcesPath, BUILT_IN_PLUGIN_DIR);
}

export function resolveProjectPluginRoot(projectPath: string): string {
  if (!isAbsolute(projectPath)) {
    throw new Error(`Project path must be absolute for FlowWeave plugin installation: "${projectPath}".`);
  }
  return resolve(projectPath, PROJECT_PLUGIN_ROOT, "flowweave");
}

export function resolveExternalPluginRoot(projectPath: string): string {
  if (!isAbsolute(projectPath)) {
    throw new Error(`Project path must be absolute for FlowWeave plugin installation: "${projectPath}".`);
  }
  return resolve(projectPath, EXTERNAL_PLUGIN_ROOT, "flowweave");
}

export function assertProjectPluginPath(projectPath: string, candidatePath: string): void {
  const allowedRoot = normalize(resolve(projectPath, PROJECT_PLUGIN_ROOT));
  const normalizedCandidate = normalize(resolve(candidatePath));
  const pathFromRoot = relative(allowedRoot, normalizedCandidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`FlowWeave plugin path escapes the authorized project plugin directory: "${candidatePath}".`);
  }
}

async function readInstalledManifest(manifestPath: string): Promise<AgentPluginManifest | undefined> {
  const content = await readFile(manifestPath, "utf8").catch(() => undefined);
  if (!content) return undefined;
  const value = JSON.parse(content) as unknown;
  return parseAgentPluginManifest(value, manifestPath);
}

type ProjectPluginInstallation = {
  status: AgentPluginStatus["status"];
  installedVersion?: string;
  message: string;
};

type NativePluginManifest = {
  name: string;
  version?: string;
};

async function readProjectPluginInstallation(projectPath: string, manifest: AgentPluginManifest): Promise<ProjectPluginInstallation> {
  const pluginRoot = resolveProjectPluginRoot(projectPath);
  const externalPluginRoot = resolveExternalPluginRoot(projectPath);
  const flowweaveManifest = await readInstalledManifest(join(pluginRoot, MANIFEST_FILE));
  const codexManifest = await readNativePluginManifest(join(externalPluginRoot, ".codex-plugin", "plugin.json"));
  const claudeManifest = await readNativePluginManifest(join(externalPluginRoot, ".claude-plugin", "plugin.json"));
  const codexMarketplace = await readJsonRecord(resolve(projectPath, CODEX_MARKETPLACE_FILE));
  const claudeMarketplace = await readJsonRecord(resolve(projectPath, CLAUDE_MARKETPLACE_FILE));

  const missing = [
    flowweaveManifest ? undefined : "FlowWeave plugin copy",
    codexManifest ? undefined : "Codex plugin manifest",
    marketplaceIncludesPlugin(codexMarketplace) ? undefined : "Codex marketplace",
    claudeManifest ? undefined : "Claude plugin manifest",
    marketplaceIncludesPlugin(claudeMarketplace) ? undefined : "Claude marketplace"
  ].filter(isString);
  const installedVersion = [flowweaveManifest?.version, codexManifest?.version, claudeManifest?.version].find(isString);
  const outdated = [
    flowweaveManifest && (flowweaveManifest.version !== manifest.version || flowweaveManifest.protocolVersion !== manifest.protocolVersion),
    codexManifest && codexManifest.version !== manifest.version,
    claudeManifest && claudeManifest.version !== manifest.version
  ].some(Boolean);

  if (outdated) {
    return {
      status: "outdated",
      installedVersion,
      message: `Project FlowWeave plugin discovery can be refreshed: ${missing.length > 0 ? `${missing.join(", ")} missing; ` : ""}version mismatch with bundled ${manifest.version}.`
    };
  }
  if (missing.length > 0) {
    return {
      status: "missing",
      installedVersion,
      message: `Project FlowWeave plugin discovery is incomplete: ${missing.join(", ")} missing.`
    };
  }
  return {
    status: "installed",
    installedVersion,
    message: "Project FlowWeave plugin copy and Codex/Claude marketplace discovery files are installed."
  };
}

async function readNativePluginManifest(manifestPath: string): Promise<NativePluginManifest | undefined> {
  const value = await readJsonRecord(manifestPath);
  if (!value || value.name !== "flowweave") return undefined;
  return {
    name: value.name,
    version: typeof value.version === "string" ? value.version : undefined
  };
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  const content = await readFile(filePath, "utf8").catch(() => undefined);
  if (!content) return undefined;
  const value = JSON.parse(content) as unknown;
  return isRecord(value) ? value : undefined;
}

async function readJsonRecordStrict(filePath: string, label: string): Promise<Record<string, unknown> | undefined> {
  const content = await readFile(filePath, "utf8").catch(() => undefined);
  if (!content) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`${label} is malformed JSON at ${filePath}: ${formatError(error)}`);
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must contain a JSON object at ${filePath}.`);
  }
  return value;
}

function marketplaceIncludesPlugin(value: Record<string, unknown> | undefined): boolean {
  const plugins = value?.plugins;
  if (!Array.isArray(plugins)) return false;
  return plugins.some((plugin) => {
    if (!isRecord(plugin) || plugin.name !== "flowweave") return false;
    if (plugin.source === FLOWWEAVE_PLUGIN_PATH) return true;
    if (!isRecord(plugin.source)) return false;
    return plugin.source.source === "local" && plugin.source.path === FLOWWEAVE_PLUGIN_PATH;
  });
}

function isAgentPluginManifest(value: unknown): value is AgentPluginManifest {
  if (!isRecord(value)) return false;
  if (value.id !== "flowweave" || typeof value.name !== "string" || typeof value.version !== "string") return false;
  if (value.protocolVersion !== 2 || typeof value.description !== "string") return false;
  if (!Array.isArray(value.hosts)) return false;
  return value.hosts.every((host) => (
    isRecord(host) &&
    (host.id === "codex" || host.id === "claude" || host.id === "gemini" || host.id === "cursor") &&
    typeof host.displayName === "string" &&
    typeof host.installTarget === "string" &&
    Array.isArray(host.capabilities) &&
    Array.isArray(host.protocols) &&
    host.protocols.every((protocol) => protocol === "agent-inbox")
  ));
}

function parseAgentPluginManifest(value: unknown, manifestPath: string): AgentPluginManifest {
  if (!isRecord(value) || value.protocolVersion !== 2) {
    throw new Error(`FlowWeave plugin manifest ${manifestPath} requires protocolVersion 2; update or reinstall the plugin.`);
  }
  if (!isAgentPluginManifest(value)) {
    throw new Error(`Invalid FlowWeave plugin manifest: ${manifestPath}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function buildCodexMarketplace() {
  return {
    name: "flowweave-local",
    interface: {
      displayName: "FlowWeave Local"
    },
    plugins: [{
      name: "flowweave",
      source: {
        source: "local",
        path: FLOWWEAVE_PLUGIN_PATH
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL"
      },
      category: "Developer Tools"
    }]
  };
}

async function upsertCodexMarketplace(filePath: string): Promise<void> {
  const existing = await readJsonRecordStrict(filePath, "Codex marketplace");
  const base = existing ?? buildCodexMarketplace();
  const plugins = Array.isArray(base.plugins) ? base.plugins.filter((plugin) => !isFlowWeavePluginEntry(plugin)) : [];
  await writeJsonFile(filePath, {
    ...base,
    plugins: [...plugins, buildCodexMarketplace().plugins[0]]
  });
}

function buildClaudeMarketplace() {
  return {
    name: "flowweave-local",
    metadata: {
      description: "Local FlowWeave Agent Inbox plugin marketplace."
    },
    owner: {
      name: "FlowWeave"
    },
    plugins: [{
      name: "flowweave",
      description: "FlowWeave Agent Inbox",
      source: FLOWWEAVE_PLUGIN_PATH,
      category: "development"
    }]
  };
}

async function upsertClaudeMarketplace(filePath: string): Promise<void> {
  const existing = await readJsonRecordStrict(filePath, "Claude marketplace");
  const base = existing ?? buildClaudeMarketplace();
  const plugins = Array.isArray(base.plugins) ? base.plugins.filter((plugin) => !isFlowWeavePluginEntry(plugin)) : [];
  await writeJsonFile(filePath, {
    ...base,
    plugins: [...plugins, buildClaudeMarketplace().plugins[0]]
  });
}

function isFlowWeavePluginEntry(value: unknown): boolean {
  return isRecord(value) && value.name === "flowweave";
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function unavailableStatuses(installTarget: string, message: string): AgentPluginStatus[] {
  return (["codex", "claude", "gemini", "cursor"] as const).map((hostId) => ({
    pluginId: "flowweave",
    hostId,
    displayName: displayNameForHost(hostId),
    status: "unavailable",
    bundledVersion: "unknown",
    installTarget,
    hostInstructionPath: join(installTarget, "hosts", `${hostId}.md`),
    message: `FlowWeave bundled plugin is unavailable: ${message}`
  }));
}

function displayNameForHost(hostId: "codex" | "claude" | "gemini" | "cursor"): string {
  if (hostId === "codex") return "Codex";
  if (hostId === "claude") return "Claude";
  if (hostId === "gemini") return "Gemini";
  return "Cursor";
}

function shouldCopyPluginFile(source: string): boolean {
  const name = basename(source);
  return name !== "node_modules" &&
    name !== ".git" &&
    name !== ".DS_Store" &&
    !name.endsWith(".tmp");
}

function assertProjectPath(projectPath: string, candidatePath: string): void {
  const allowedRoot = normalize(resolve(projectPath));
  const normalizedCandidate = normalize(resolve(candidatePath));
  const pathFromRoot = relative(allowedRoot, normalizedCandidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`FlowWeave plugin path escapes the authorized project directory: "${candidatePath}".`);
  }
}

async function assertExternalPluginRootIsWritable(pluginRoot: string): Promise<void> {
  if (!await pathExists(pluginRoot)) return;
  const flowweaveManifest = await readInstalledManifest(join(pluginRoot, MANIFEST_FILE));
  if (flowweaveManifest?.id === "flowweave") return;
  const codexManifest = await readNativePluginManifest(join(pluginRoot, ".codex-plugin", "plugin.json"));
  if (codexManifest?.name === "flowweave") return;
  const claudeManifest = await readNativePluginManifest(join(pluginRoot, ".claude-plugin", "plugin.json"));
  if (claudeManifest?.name === "flowweave") return;
  throw new Error(`Refusing to overwrite existing non-FlowWeave plugin directory: ${pluginRoot}. Move it or choose a different plugin path before refreshing FlowWeave.`);
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

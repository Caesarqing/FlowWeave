import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type {
  AgentPluginHostCheck,
  AgentPluginHostId,
  AgentPluginManifest,
  AgentPluginMigrationResult,
  AgentPluginState,
  AgentPluginStatus
} from "../../types";

const BUILT_IN_PLUGIN_DIR = "flowweave-plugin";
const MANIFEST_FILE = "manifest.json";
const EXTERNAL_PLUGIN_ROOT = "plugins";
const LEGACY_PROJECT_PLUGIN_PATH = ".flowweave/agent-plugins/flowweave";
const PLUGIN_STATE_PATH = ".flowweave/agent-plugin-state.json";
const CODEX_MARKETPLACE_FILE = ".agents/plugins/marketplace.json";
const CLAUDE_MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
const FLOWWEAVE_PLUGIN_PATH = "./plugins/flowweave";
const HOST_IDS = ["codex", "claude", "gemini", "cursor"] as const;

export async function getBuiltInAgentPluginManifest(): Promise<AgentPluginManifest> {
  const manifestPath = join(resolveBundledPluginRoot(), MANIFEST_FILE);
  const value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  return parseAgentPluginManifest(value, manifestPath);
}

export async function getBuiltInAgentPluginStatuses(projectPath: string): Promise<AgentPluginStatus[]> {
  const pluginRoot = resolveExternalPluginRoot(projectPath);
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
  const sourceRoot = resolveBundledPluginRoot();
  const pluginRoot = resolveExternalPluginRoot(projectPath);
  const statePath = resolve(projectPath, PLUGIN_STATE_PATH);
  const operationId = randomUUID();
  const stagingPath = join(dirname(pluginRoot), `.flowweave-staging-${operationId}`);
  const backupPath = join(dirname(pluginRoot), `.flowweave-backup-${operationId}`);
  const legacyPluginPath = resolve(projectPath, LEGACY_PROJECT_PLUGIN_PATH);
  const legacyBackupPath = join(dirname(legacyPluginPath), `.flowweave-backup-${operationId}`);
  let phase = "preflight-bundled-plugin";
  let manifest: AgentPluginManifest;
  let codexMarketplace: MarketplacePlan;
  let claudeMarketplace: MarketplacePlan;
  let previousStateContent: string | undefined;
  let recentMigrationResult: AgentPluginMigrationResult = { status: "not-run" };
  let existingPlugin = false;
  let existingLegacyPlugin = false;
  try {
    manifest = await getBuiltInAgentPluginManifest();
    assertProjectPluginPath(projectPath, pluginRoot);
    assertProjectPath(projectPath, statePath);
    assertProjectPath(projectPath, stagingPath);
    assertProjectPath(projectPath, backupPath);
    assertProjectPath(projectPath, legacyPluginPath);
    assertProjectPath(projectPath, legacyBackupPath);

    phase = "preflight-marketplaces";
    codexMarketplace = await planMarketplaceUpdate(
      resolve(projectPath, CODEX_MARKETPLACE_FILE),
      "Codex marketplace",
      buildCodexMarketplace(),
      buildCodexMarketplace().plugins[0]
    );
    claudeMarketplace = await planMarketplaceUpdate(
      resolve(projectPath, CLAUDE_MARKETPLACE_FILE),
      "Claude marketplace",
      buildClaudeMarketplace(),
      buildClaudeMarketplace().plugins[0]
    );

    phase = "preflight-existing-state";
    previousStateContent = await readOptionalText(statePath);
    recentMigrationResult = readRecentMigrationResult(previousStateContent, statePath);
    await assertExternalPluginRootIsWritable(pluginRoot);
    existingPlugin = await pathExists(pluginRoot);
    existingLegacyPlugin = await pathExists(legacyPluginPath);
    if (existingLegacyPlugin) await assertLegacyPluginIsFlowWeave(legacyPluginPath);
  } catch (error) {
    throw pluginInstallationError(phase, sourceRoot, pluginRoot, "all", error, []);
  }

  phase = "stage-plugin";
  let activeHostId: AgentPluginHostId | undefined;
  let canonicalPluginBackedUp = false;
  let stagedPluginActivated = false;
  let legacyPluginBackedUp = false;
  let stateWriteAttempted = false;
  let installedStatuses: AgentPluginStatus[] | undefined;
  const marketplaceWrites: MarketplacePlan[] = [];
  try {
    const sourceHash = await calculatePluginContentHash(sourceRoot);
    await mkdir(dirname(pluginRoot), { recursive: true });
    await cp(sourceRoot, stagingPath, {
      recursive: true,
      force: false,
      filter: shouldCopyPluginFile
    });

    phase = "validate-staging";
    const stagedHash = await calculatePluginContentHash(stagingPath);
    if (stagedHash !== sourceHash) {
      throw new Error(`Staged plugin content hash ${stagedHash} does not match bundled source hash ${sourceHash}.`);
    }
    await validateStagedPlugin(stagingPath, manifest, projectPath);

    phase = "replace-plugin-directory";
    if (existingPlugin) {
      await rename(pluginRoot, backupPath);
      canonicalPluginBackedUp = true;
    }
    await rename(stagingPath, pluginRoot);
    stagedPluginActivated = true;

    phase = "update-codex-marketplace";
    await writeTextAtomic(codexMarketplace.filePath, codexMarketplace.nextContent);
    marketplaceWrites.push(codexMarketplace);
    phase = "update-claude-marketplace";
    await writeTextAtomic(claudeMarketplace.filePath, claudeMarketplace.nextContent);
    marketplaceWrites.push(claudeMarketplace);

    phase = "verify-installed-plugin";
    const installedHash = await calculatePluginContentHash(pluginRoot);
    if (installedHash !== stagedHash) {
      throw new Error(`Installed plugin content hash ${installedHash} does not match staged hash ${stagedHash}.`);
    }
    const statuses = await getBuiltInAgentPluginStatuses(projectPath);
    const failedStatus = statuses.find((status) => status.status !== "installed");
    if (failedStatus) {
      activeHostId = failedStatus.hostId;
      throw new Error(`Host verification failed: ${failedStatus.message}`);
    }

    phase = "remove-legacy-plugin-copy";
    if (existingLegacyPlugin) {
      await rename(legacyPluginPath, legacyBackupPath);
      legacyPluginBackedUp = true;
    }

    phase = "write-plugin-state";
    const hostChecks = await buildHostChecks(projectPath, manifest, installedHash);
    const failedHostCheck = hostChecks.find((hostCheck) => hostCheck.status !== "installed");
    if (failedHostCheck) {
      activeHostId = failedHostCheck.hostId;
      throw new Error(failedHostCheck.message);
    }
    const state: AgentPluginState = {
      schemaVersion: 1,
      pluginId: manifest.id,
      installedVersion: manifest.version,
      protocolVersion: manifest.protocolVersion,
      contentHash: installedHash,
      installedAt: new Date().toISOString(),
      sourceHash,
      hostChecks,
      recentMigrationResult
    };
    await writeTextAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
    stateWriteAttempted = true;
    installedStatuses = statuses;
  } catch (error) {
    const rollbackErrors = await rollbackPluginInstall({
      pluginRoot,
      backupPath,
      stagingPath,
      statePath,
      previousStateContent,
      stateWriteAttempted,
      canonicalPluginBackedUp,
      stagedPluginActivated,
      legacyPluginPath,
      legacyBackupPath,
      legacyPluginBackedUp,
      marketplaceWrites
    });
    throw pluginInstallationError(phase, sourceRoot, pluginRoot, activeHostId ?? "all", error, rollbackErrors);
  }

  if (!installedStatuses) throw new Error(`FlowWeave plugin installation completed without host status results at ${pluginRoot}.`);
  if (canonicalPluginBackedUp) {
    try {
      await rm(backupPath, { recursive: true });
    } catch (error) {
      throw new Error(`FlowWeave plugin installed at ${pluginRoot}, but removing its backup failed at ${backupPath}: ${formatError(error)}`);
    }
  }
  if (legacyPluginBackedUp) {
    try {
      await rm(legacyBackupPath, { recursive: true });
    } catch (error) {
      throw new Error(`FlowWeave plugin installed at ${pluginRoot}, but removing its verified legacy copy backup failed at ${legacyBackupPath}: ${formatError(error)}`);
    }
  }
  return installedStatuses;
}

export async function resolveAgentPluginInstructionPath(projectPath: string, hostId: AgentPluginHostId): Promise<string> {
  const pluginRoot = resolveExternalPluginRoot(projectPath);
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

export function resolveExternalPluginRoot(projectPath: string): string {
  if (!isAbsolute(projectPath)) {
    throw new Error(`Project path must be absolute for FlowWeave plugin installation: "${projectPath}".`);
  }
  return resolve(projectPath, EXTERNAL_PLUGIN_ROOT, "flowweave");
}

export function assertProjectPluginPath(projectPath: string, candidatePath: string): void {
  const allowedRoot = normalize(resolveExternalPluginRoot(projectPath));
  const normalizedCandidate = normalize(resolve(candidatePath));
  const pathFromRoot = relative(allowedRoot, normalizedCandidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`FlowWeave plugin path escapes the authorized project plugin directory: "${candidatePath}".`);
  }
}

async function readInstalledManifest(manifestPath: string): Promise<AgentPluginManifest | undefined> {
  const content = await readOptionalText(manifestPath);
  if (content === undefined) return undefined;
  const value = parseJson(content, "FlowWeave plugin manifest", manifestPath);
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
  description?: string;
};

async function readProjectPluginInstallation(projectPath: string, manifest: AgentPluginManifest): Promise<ProjectPluginInstallation> {
  const pluginRoot = resolveExternalPluginRoot(projectPath);
  const flowweaveManifest = await readInstalledManifest(join(pluginRoot, MANIFEST_FILE));
  const codexManifest = await readNativePluginManifest(join(pluginRoot, ".codex-plugin", "plugin.json"), "Codex plugin manifest");
  const claudeManifest = await readNativePluginManifest(join(pluginRoot, ".claude-plugin", "plugin.json"), "Claude plugin manifest");
  const codexMarketplace = await readJsonRecord(resolve(projectPath, CODEX_MARKETPLACE_FILE), "Codex marketplace");
  const claudeMarketplace = await readJsonRecord(resolve(projectPath, CLAUDE_MARKETPLACE_FILE), "Claude marketplace");

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
    codexManifest && (codexManifest.version !== manifest.version || !codexManifest.description?.includes("Agent Inbox v2")),
    claudeManifest && (claudeManifest.version !== manifest.version || !claudeManifest.description?.includes("Agent Inbox v2"))
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

async function readNativePluginManifest(manifestPath: string, label: string): Promise<NativePluginManifest | undefined> {
  const value = await readJsonRecord(manifestPath, label);
  if (!value || value.name !== "flowweave") return undefined;
  return {
    name: value.name,
    version: typeof value.version === "string" ? value.version : undefined,
    description: typeof value.description === "string" ? value.description : undefined
  };
}

async function readJsonRecord(filePath: string, label: string): Promise<Record<string, unknown> | undefined> {
  const content = await readOptionalText(filePath);
  if (content === undefined) return undefined;
  const value = parseJson(content, label, filePath);
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
  const hosts = value.hosts;
  const validHosts = hosts.every((host: unknown) => (
    isRecord(host) &&
    (host.id === "codex" || host.id === "claude" || host.id === "gemini" || host.id === "cursor") &&
    typeof host.displayName === "string" &&
    typeof host.installTarget === "string" &&
    Array.isArray(host.capabilities) &&
    Array.isArray(host.protocols) &&
    host.protocols.includes("agent-inbox") &&
    host.protocols.every((protocol) => protocol === "agent-inbox")
  ));
  return validHosts &&
    hosts.length === HOST_IDS.length &&
    HOST_IDS.every((hostId) => hosts.some((host: unknown) => isRecord(host) && host.id === hostId));
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

type MarketplacePlan = {
  filePath: string;
  label: string;
  previousContent?: string;
  nextContent: string;
};

async function planMarketplaceUpdate(
  filePath: string,
  label: string,
  defaultMarketplace: Record<string, unknown>,
  flowWeavePlugin: unknown
): Promise<MarketplacePlan> {
  const previousContent = await readOptionalText(filePath);
  const existing = previousContent === undefined
    ? defaultMarketplace
    : parseJsonRecord(previousContent, label, filePath);
  const currentPlugins = existing.plugins;
  if (currentPlugins !== undefined && !Array.isArray(currentPlugins)) {
    throw new Error(`${label} plugins must be an array at ${filePath}.`);
  }
  const plugins = (currentPlugins ?? []).filter((plugin) => !isFlowWeavePluginEntry(plugin));
  const marketplace = {
    ...existing,
    plugins: [...plugins, flowWeavePlugin]
  };
  return {
    filePath,
    label,
    previousContent,
    nextContent: `${JSON.stringify(marketplace, null, 2)}\n`
  };
}

function isFlowWeavePluginEntry(value: unknown): boolean {
  return isRecord(value) && value.name === "flowweave";
}

type PluginRollbackInput = {
  pluginRoot: string;
  backupPath: string;
  stagingPath: string;
  statePath: string;
  previousStateContent?: string;
  stateWriteAttempted: boolean;
  canonicalPluginBackedUp: boolean;
  stagedPluginActivated: boolean;
  legacyPluginPath: string;
  legacyBackupPath: string;
  legacyPluginBackedUp: boolean;
  marketplaceWrites: MarketplacePlan[];
};

async function calculatePluginContentHash(pluginRoot: string): Promise<string> {
  const hash = createHash("sha256");
  await updatePluginContentHash(pluginRoot, "", hash);
  return hash.digest("hex");
}

async function updatePluginContentHash(
  directoryPath: string,
  relativeDirectory: string,
  hash: ReturnType<typeof createHash>
): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!shouldCopyPluginFile(entry.name)) continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      hash.update(`${relativePath}\0directory\0`);
      await updatePluginContentHash(entryPath, relativePath, hash);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported plugin entry type at ${entryPath}.`);
    }
    hash.update(`${relativePath}\0file\0`);
    hash.update(await readFile(entryPath));
    hash.update("\0");
  }
}

async function validateStagedPlugin(
  stagingPath: string,
  expectedManifest: AgentPluginManifest,
  projectPath: string
): Promise<void> {
  const stagedManifestPath = join(stagingPath, MANIFEST_FILE);
  const stagedManifest = await readInstalledManifest(stagedManifestPath);
  if (!stagedManifest || stagedManifest.id !== expectedManifest.id ||
    stagedManifest.version !== expectedManifest.version ||
    stagedManifest.protocolVersion !== expectedManifest.protocolVersion) {
    throw new Error(`Staged plugin identity, version, or protocol does not match the bundled manifest at ${stagedManifestPath}.`);
  }

  for (const hostId of HOST_IDS) {
    const instructionPath = join(stagingPath, "hosts", `${hostId}.md`);
    if (!await pathExists(instructionPath)) {
      throw new Error(`hostId=${hostId}: required host instruction is missing at ${instructionPath}.`);
    }
  }

  await validateNativePluginManifest(
    join(stagingPath, ".codex-plugin", "plugin.json"),
    "Codex plugin manifest",
    expectedManifest
  );
  await validateNativePluginManifest(
    join(stagingPath, ".claude-plugin", "plugin.json"),
    "Claude plugin manifest",
    expectedManifest
  );

  assertProjectPath(projectPath, stagingPath);
}

async function validateNativePluginManifest(
  manifestPath: string,
  label: string,
  expectedManifest: AgentPluginManifest
): Promise<void> {
  const manifest = await readNativePluginManifest(manifestPath, label);
  if (!manifest || manifest.version !== expectedManifest.version || !manifest.description?.includes("Agent Inbox v2")) {
    throw new Error(`${label} does not declare FlowWeave Agent Inbox v2 version ${expectedManifest.version} at ${manifestPath}.`);
  }
}

async function buildHostChecks(
  projectPath: string,
  manifest: AgentPluginManifest,
  contentHash: string
): Promise<AgentPluginHostCheck[]> {
  const checks: AgentPluginHostCheck[] = [];
  for (const hostId of HOST_IDS) {
    const requiredFiles = requiredFilesForHost(hostId);
    const missingFiles: string[] = [];
    for (const path of requiredFiles) {
      if (!await pathExists(resolve(projectPath, path))) missingFiles.push(path);
    }
    checks.push({
      hostId,
      status: missingFiles.length === 0 ? "installed" : "error",
      requiredFiles,
      missingFiles,
      version: manifest.version,
      protocolVersion: manifest.protocolVersion,
      contentHash,
      message: missingFiles.length === 0
        ? `FlowWeave Agent Inbox v2 plugin files verified for ${displayNameForHost(hostId)}.`
        : `Missing required plugin files for ${displayNameForHost(hostId)}: ${missingFiles.join(", ")}.`
    });
  }
  return checks;
}

function requiredFilesForHost(hostId: AgentPluginHostId): string[] {
  const pluginFiles = ["plugins/flowweave/manifest.json", `plugins/flowweave/hosts/${hostId}.md`];
  if (hostId === "codex") {
    return [...pluginFiles, "plugins/flowweave/.codex-plugin/plugin.json", CODEX_MARKETPLACE_FILE];
  }
  if (hostId === "claude") {
    return [...pluginFiles, "plugins/flowweave/.claude-plugin/plugin.json", CLAUDE_MARKETPLACE_FILE];
  }
  return pluginFiles;
}

function readRecentMigrationResult(content: string | undefined, statePath: string): AgentPluginMigrationResult {
  if (content === undefined) return { status: "not-run" };
  const state = parseJsonRecord(content, "FlowWeave plugin state", statePath);
  const result = state.recentMigrationResult;
  if (!isRecord(result) || !["not-run", "completed", "blocked", "failed"].includes(String(result.status))) {
    throw new Error(`Invalid recent migration result in FlowWeave plugin state at ${statePath}.`);
  }
  return result as AgentPluginMigrationResult;
}

async function assertLegacyPluginIsFlowWeave(pluginPath: string): Promise<void> {
  if (!await isFlowWeavePluginDirectory(pluginPath)) {
    throw new Error(`Refusing to remove unverified legacy plugin directory: ${pluginPath}.`);
  }
}

async function isFlowWeavePluginDirectory(pluginPath: string): Promise<boolean> {
  const info = await lstat(pluginPath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`FlowWeave plugin path must be a real directory: ${pluginPath}.`);
  }
  const manifest = await readJsonRecord(join(pluginPath, MANIFEST_FILE), "FlowWeave plugin identity manifest");
  if (manifest?.id === "flowweave") return true;
  const codexManifest = await readNativePluginManifest(join(pluginPath, ".codex-plugin", "plugin.json"), "Codex plugin identity manifest");
  if (codexManifest?.name === "flowweave") return true;
  const claudeManifest = await readNativePluginManifest(join(pluginPath, ".claude-plugin", "plugin.json"), "Claude plugin identity manifest");
  return claudeManifest?.name === "flowweave";
}

async function rollbackPluginInstall(input: PluginRollbackInput): Promise<string[]> {
  const errors: string[] = [];
  for (const marketplace of [...input.marketplaceWrites].reverse()) {
    try {
      await restoreFile(marketplace.filePath, marketplace.previousContent);
    } catch (error) {
      errors.push(`${marketplace.label} at ${marketplace.filePath}: ${formatError(error)}`);
    }
  }
  if (input.stateWriteAttempted) {
    try {
      await restoreFile(input.statePath, input.previousStateContent);
    } catch (error) {
      errors.push(`plugin state at ${input.statePath}: ${formatError(error)}`);
    }
  }
  if (input.stagedPluginActivated) {
    try {
      await rm(input.pluginRoot, { recursive: true, force: true });
    } catch (error) {
      errors.push(`new plugin at ${input.pluginRoot}: ${formatError(error)}`);
    }
  }
  if (input.canonicalPluginBackedUp) {
    try {
      if (await pathExists(input.backupPath)) await rename(input.backupPath, input.pluginRoot);
    } catch (error) {
      errors.push(`plugin backup at ${input.backupPath}: ${formatError(error)}`);
    }
  }
  if (input.legacyPluginBackedUp) {
    try {
      if (await pathExists(input.legacyBackupPath)) await rename(input.legacyBackupPath, input.legacyPluginPath);
    } catch (error) {
      errors.push(`legacy plugin backup at ${input.legacyBackupPath}: ${formatError(error)}`);
    }
  }
  try {
    await rm(input.stagingPath, { recursive: true, force: true });
  } catch (error) {
    errors.push(`staging directory at ${input.stagingPath}: ${formatError(error)}`);
  }
  return errors;
}

async function restoreFile(filePath: string, content: string | undefined): Promise<void> {
  if (content === undefined) {
    await rm(filePath, { force: true });
    return;
  }
  await writeTextAtomic(filePath, content);
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw new Error(`Reading FlowWeave plugin file at ${filePath} failed: ${formatError(error)}`);
  }
}

function parseJson(content: string, label: string, filePath: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`${label} is malformed JSON at ${filePath}: ${formatError(error)}`);
  }
}

function parseJsonRecord(content: string, label: string, filePath: string): Record<string, unknown> {
  const value = parseJson(content, label, filePath);
  if (!isRecord(value)) throw new Error(`${label} must contain a JSON object at ${filePath}.`);
  return value;
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, filePath);
  } catch (error) {
    let cleanupError: string | undefined;
    try {
      await rm(temporaryPath, { force: true });
    } catch (removeError) {
      cleanupError = formatError(removeError);
    }
    throw new Error(
      `Atomic write failed at ${filePath}: ${formatError(error)}${cleanupError ? `; temporary file cleanup failed: ${cleanupError}` : ""}`
    );
  }
}

function pluginInstallationError(
  phase: string,
  sourcePath: string,
  targetPath: string,
  hostId: AgentPluginHostId | "all",
  error: unknown,
  rollbackErrors: string[]
): Error {
  const rollbackMessage = rollbackErrors.length > 0 ? ` Rollback errors: ${rollbackErrors.join("; ")}` : "";
  return new Error(
    `FlowWeave plugin installation failed during ${phase} (source="${sourcePath}", target="${targetPath}", hostId="${hostId}"): ${formatError(error)}.${rollbackMessage}`
  );
}

function unavailableStatuses(installTarget: string, message: string): AgentPluginStatus[] {
  return HOST_IDS.map((hostId) => ({
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
  if (await isFlowWeavePluginDirectory(pluginRoot)) return;
  throw new Error(`Refusing to overwrite existing non-FlowWeave plugin directory: ${pluginRoot}. Move it or choose a different plugin path before refreshing FlowWeave.`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw new Error(`Checking FlowWeave plugin path at ${path} failed: ${formatError(error)}`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

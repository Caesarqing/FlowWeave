import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type {
  AgentPluginHostCheck,
  AgentPluginHostId,
  AgentPluginManifest,
  AgentPluginMigrationResult,
  AgentPluginState,
  AgentPluginStatus,
  AgentPluginStatusCheck,
  AgentPluginCheckCode
} from "../../types";
import { parseAgentManifest } from "./agent-discovery.service";

const BUILT_IN_PLUGIN_DIR = "flowweave-plugin";
const MANIFEST_FILE = "manifest.json";
const EXTERNAL_PLUGIN_ROOT = "plugins";
const LEGACY_PROJECT_PLUGIN_PATH = ".flowweave/agent-plugins/flowweave";
const LEGACY_CONNECTOR_DIRECTORY = ".flowweave/agent-connectors";
const PROJECT_CONNECTOR_DIRECTORY = ".flowweave/agents/connectors";
const LEGACY_BRIDGE_DIRECTORY = ".flowweave/agent-bridge";
const AGENT_RUNS_DIRECTORY = ".flowweave/runs";
const PLUGIN_STATE_PATH = ".flowweave/agent-plugin-state.json";
const CODEX_MARKETPLACE_FILE = ".agents/plugins/marketplace.json";
const CLAUDE_MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
const FLOWWEAVE_PLUGIN_PATH = "./plugins/flowweave";
const HOST_IDS = ["codex", "claude", "gemini", "cursor"] as const;
const MANAGED_BLOCK_START = "<!-- flowweave:start -->";
const MANAGED_BLOCK_END = "<!-- flowweave:end -->";

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

  const installedManifest = await readInstalledManifest(join(pluginRoot, MANIFEST_FILE));
  const persistedHostChecks = await readPersistedHostChecks(projectPath);
  const sourceRoot = resolveBundledPluginRoot();
  return Promise.all(manifest.hosts.map((host) => readHostPluginStatus({
    projectPath,
    pluginRoot,
    sourceRoot,
    bundledManifest: manifest,
    installedManifest,
    persistedHostCheck: persistedHostChecks.find((check) => check.hostId === host.id),
    hostId: host.id,
    displayName: host.displayName
  })));
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
  let legacyMigration: LegacyMigrationTransaction | undefined;
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
    phase = "remove-legacy-plugin-copy";
    if (existingLegacyPlugin) {
      await rename(legacyPluginPath, legacyBackupPath);
      legacyPluginBackedUp = true;
    }

    phase = "migrate-legacy-project-data";
    legacyMigration = await prepareLegacyProjectData(projectPath, recentMigrationResult);
    recentMigrationResult = legacyMigration.result;
    await legacyMigration.stage();

    phase = "verify-host-installation";
    const hostChecks = await buildHostChecks(projectPath, manifest, installedHash);
    const failedHostCheck = hostChecks.find((hostCheck) => hostCheck.status !== "installed");
    if (failedHostCheck) {
      activeHostId = failedHostCheck.hostId;
      throw new Error(failedHostCheck.message);
    }
    await legacyMigration.commit();
    recentMigrationResult = legacyMigration.result;

    phase = "write-plugin-state";
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
    installedStatuses = await getBuiltInAgentPluginStatuses(projectPath);
    const failedInstallCheck = findFailedPluginInstallationCheck(installedStatuses);
    if (failedInstallCheck) {
      phase = "verify-installed-plugin";
      activeHostId = failedInstallCheck.hostId;
      throw new Error(failedInstallCheck.message);
    }
  } catch (error) {
    const migrationRollbackErrors = legacyMigration ? await legacyMigration.rollback() : [];
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
    throw pluginInstallationError(phase, sourceRoot, pluginRoot, activeHostId ?? "all", error, [
      ...migrationRollbackErrors,
      ...rollbackErrors
    ]);
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

type PersistedHostCheck = Pick<AgentPluginHostCheck, "hostId" | "version">;

type ReadHostStatusInput = {
  projectPath: string;
  pluginRoot: string;
  sourceRoot: string;
  bundledManifest: AgentPluginManifest;
  installedManifest: AgentPluginManifest | undefined;
  persistedHostCheck: PersistedHostCheck | undefined;
  hostId: AgentPluginHostId;
  displayName: string;
};

async function readPersistedHostChecks(projectPath: string): Promise<PersistedHostCheck[]> {
  const statePath = resolve(projectPath, PLUGIN_STATE_PATH);
  const content = await readOptionalText(statePath);
  if (content === undefined) return [];
  const state = parseJsonRecord(content, "FlowWeave plugin state", statePath);
  if (!Array.isArray(state.hostChecks)) {
    throw new Error(`FlowWeave plugin state is missing hostChecks at ${statePath}.`);
  }
  return state.hostChecks.filter((value): value is PersistedHostCheck => (
    isRecord(value) &&
    HOST_IDS.includes(value.hostId as AgentPluginHostId) &&
    typeof value.version === "string"
  ));
}

async function readHostPluginStatus(input: ReadHostStatusInput): Promise<AgentPluginStatus> {
  const {
    projectPath,
    pluginRoot,
    sourceRoot,
    bundledManifest,
    installedManifest,
    persistedHostCheck,
    hostId,
    displayName
  } = input;
  const requiredFiles = requiredFilesForHost(hostId);
  const missingFiles: string[] = [];
  const checks: AgentPluginStatusCheck[] = [];
  let installedVersion: string | undefined = installedManifest?.version;
  let contentHash: string | undefined;
  let checkingFilePath: string | undefined;

  try {
    for (const filePath of requiredFiles) {
      checkingFilePath = resolve(projectPath, filePath);
      const exists = await pathExists(checkingFilePath);
      checkingFilePath = undefined;
      if (exists) continue;
      missingFiles.push(filePath);
      checks.push({
        code: missingCodeForPath(filePath),
        status: "failed",
        filePath,
        message: `${displayName} required file is missing: ${filePath}.`
      });
    }

    if (installedManifest) {
      if (installedManifest.version !== bundledManifest.version || persistedHostCheck?.version !== undefined &&
        persistedHostCheck.version !== bundledManifest.version) {
        checks.push({
          code: "version-mismatch",
          status: "failed",
          filePath: join("plugins", "flowweave", MANIFEST_FILE),
          message: `${displayName} plugin version does not match bundled version ${bundledManifest.version}.`
        });
      }
      if (installedManifest.protocolVersion !== bundledManifest.protocolVersion) {
        checks.push({
          code: "protocol-mismatch",
          status: "failed",
          filePath: join("plugins", "flowweave", MANIFEST_FILE),
          message: `${displayName} plugin protocol does not match Agent Inbox v${bundledManifest.protocolVersion}.`
        });
      }
    }

    checkingFilePath = hostId === "codex"
      ? resolve(projectPath, "plugins/flowweave/.codex-plugin/plugin.json")
      : hostId === "claude"
        ? resolve(projectPath, "plugins/flowweave/.claude-plugin/plugin.json")
        : undefined;
    installedVersion = await addNativeManifestChecks(projectPath, hostId, bundledManifest, checks, missingFiles) ?? installedVersion;
    checkingFilePath = undefined;
    checkingFilePath = hostId === "codex"
      ? resolve(projectPath, CODEX_MARKETPLACE_FILE)
      : hostId === "claude"
        ? resolve(projectPath, CLAUDE_MARKETPLACE_FILE)
        : undefined;
    await addMarketplaceChecks(projectPath, hostId, checks, missingFiles);
    checkingFilePath = undefined;
    checkingFilePath = hostId === "gemini"
      ? resolve(projectPath, "GEMINI.md")
      : hostId === "cursor"
        ? resolve(projectPath, ".cursor/rules/flowweave.mdc")
        : undefined;
    await addManagedBlockChecks(projectPath, hostId, checks, missingFiles);
    checkingFilePath = undefined;
    const pluginFilesReady = pluginRequiredFilesForHost(hostId).every((filePath) => !missingFiles.includes(filePath));
    if (installedManifest && pluginFilesReady) {
      const [expectedHash, actualHash] = await Promise.all([
        calculateHostPluginContentHash(sourceRoot, hostId),
        calculateHostPluginContentHash(pluginRoot, hostId)
      ]);
      contentHash = actualHash;
      if (actualHash !== expectedHash) {
        checks.push({
          code: "content-hash-mismatch",
          status: "failed",
          filePath: join("plugins", "flowweave", "hosts", `${hostId}.md`),
          message: `${displayName} plugin content hash does not match the bundled host resources.`
        });
      }
    }
  } catch (error) {
    const filePath = checkingFilePath ? relative(projectPath, checkingFilePath) : undefined;
    if (filePath && !missingFiles.includes(filePath)) missingFiles.push(filePath);
    checks.push({
      code: "check-error",
      status: "failed",
      ...(filePath ? { filePath } : {}),
      message: `${displayName} plugin check failed${filePath ? ` at ${filePath}` : ""}: ${formatError(error)}`
    });
  }

  if (checks.length === 0 || checks.every((check) => check.status === "passed")) {
    checks.push({ code: "host-ready", status: "passed", message: `${displayName} Agent Inbox v2 checks passed.` });
  }
  const status = statusForChecks(checks, missingFiles);
  const suggestedActions = suggestedActionsForChecks(checks);
  const failedMessages = checks.filter((check) => check.status === "failed").map((check) => check.message);
  return {
    pluginId: bundledManifest.id,
    hostId,
    displayName,
    status,
    installedVersion,
    bundledVersion: bundledManifest.version,
    installTarget: pluginRoot,
    hostInstructionPath: join(pluginRoot, "hosts", `${hostId}.md`),
    requiredFiles,
    missingFiles,
    protocolVersion: installedManifest?.protocolVersion ?? bundledManifest.protocolVersion,
    contentHash: contentHash ?? "",
    checks,
    suggestedActions,
    message: failedMessages.join(" ") || `${displayName} Agent Inbox v2 is ready.`
  };
}

async function addNativeManifestChecks(
  projectPath: string,
  hostId: AgentPluginHostId,
  bundledManifest: AgentPluginManifest,
  checks: AgentPluginStatusCheck[],
  missingFiles: string[]
): Promise<string | undefined> {
  if (hostId !== "codex" && hostId !== "claude") return undefined;
  const filePath = hostId === "codex"
    ? "plugins/flowweave/.codex-plugin/plugin.json"
    : "plugins/flowweave/.claude-plugin/plugin.json";
  if (missingFiles.includes(filePath)) return undefined;
  const nativeManifest = await readNativePluginManifest(resolve(projectPath, filePath), `${displayNameForHost(hostId)} plugin manifest`);
  if (!nativeManifest) {
    missingFiles.push(filePath);
    checks.push({
      code: "native-manifest-missing",
      status: "failed",
      filePath,
      message: `${displayNameForHost(hostId)} native plugin manifest is missing or has a different plugin ID.`
    });
    return undefined;
  }
  if (nativeManifest.version !== bundledManifest.version) {
    checks.push({
      code: "version-mismatch",
      status: "failed",
      filePath,
      message: `${displayNameForHost(hostId)} native plugin version does not match bundled version ${bundledManifest.version}.`
    });
  }
  if (!nativeManifest.description?.includes("Agent Inbox v2")) {
    checks.push({
      code: "protocol-mismatch",
      status: "failed",
      filePath,
      message: `${displayNameForHost(hostId)} native plugin manifest must declare Agent Inbox v2.`
    });
  }
  return nativeManifest.version;
}

async function addMarketplaceChecks(
  projectPath: string,
  hostId: AgentPluginHostId,
  checks: AgentPluginStatusCheck[],
  missingFiles: string[]
): Promise<void> {
  const marketplacePath = hostId === "codex"
    ? CODEX_MARKETPLACE_FILE
    : hostId === "claude"
      ? CLAUDE_MARKETPLACE_FILE
      : undefined;
  if (!marketplacePath) return;
  if (missingFiles.includes(marketplacePath)) return;
  const filePath = resolve(projectPath, marketplacePath);
  const marketplace = await readJsonRecord(filePath, `${displayNameForHost(hostId)} marketplace`);
  if (!marketplaceIncludesPlugin(marketplace)) {
    missingFiles.push(marketplacePath);
    checks.push({
      code: "marketplace-entry-missing",
      status: "failed",
      filePath: marketplacePath,
      message: `${displayNameForHost(hostId)} marketplace is missing the FlowWeave entry.`
    });
  }
}

async function addManagedBlockChecks(
  projectPath: string,
  hostId: AgentPluginHostId,
  checks: AgentPluginStatusCheck[],
  missingFiles: string[]
): Promise<void> {
  const filePath = hostId === "gemini"
    ? "GEMINI.md"
    : hostId === "cursor"
      ? ".cursor/rules/flowweave.mdc"
      : undefined;
  if (!filePath) return;
  if (missingFiles.includes(filePath)) {
    return;
  }
  const content = await readFile(resolve(projectPath, filePath), "utf8");
  const starts = content.split(MANAGED_BLOCK_START).length - 1;
  const ends = content.split(MANAGED_BLOCK_END).length - 1;
  const start = content.indexOf(MANAGED_BLOCK_START);
  const end = content.indexOf(MANAGED_BLOCK_END);
  const hasValidBlock = starts === 1 && ends === 1 && start < end &&
    content.slice(start, end).includes("runs/<run-id>/agent-request.json");
  const cursorRuleEnabled = hostId !== "cursor" || /alwaysApply:\s*true/.test(content);
  if (!hasValidBlock || !cursorRuleEnabled) {
    checks.push({
      code: "managed-block-invalid",
      status: "failed",
      filePath,
      message: `${displayNameForHost(hostId)} FlowWeave managed block is invalid in ${filePath}.`
    });
  }
}

function missingCodeForPath(filePath: string): AgentPluginCheckCode {
  if (filePath === join("plugins", "flowweave", MANIFEST_FILE) ||
    filePath === join("plugins", "flowweave", "skills", "flowweave", "SKILL.md")) return "plugin-copy-missing";
  if (filePath === CODEX_MARKETPLACE_FILE || filePath === CLAUDE_MARKETPLACE_FILE) return "marketplace-entry-missing";
  if (filePath.includes(".codex-plugin") || filePath.includes(".claude-plugin")) return "native-manifest-missing";
  if (filePath === "GEMINI.md" || filePath === ".cursor/rules/flowweave.mdc") return "managed-block-missing";
  return "host-instruction-missing";
}

function statusForChecks(
  checks: AgentPluginStatusCheck[],
  missingFiles: string[]
): AgentPluginStatus["status"] {
  if (checks.some((check) => check.code === "check-error")) return "error";
  if (missingFiles.length > 0 || checks.some((check) => check.code === "managed-block-invalid")) return "missing";
  if (checks.some((check) => check.code === "version-mismatch" || check.code === "protocol-mismatch" || check.code === "content-hash-mismatch")) {
    return "outdated";
  }
  return "installed";
}

function suggestedActionsForChecks(checks: AgentPluginStatusCheck[]): AgentPluginStatus["suggestedActions"] {
  const failedCodes = new Set(checks.filter((check) => check.status === "failed").map((check) => check.code));
  const actions: AgentPluginStatus["suggestedActions"] = [];
  if (failedCodes.has("check-error")) actions.push("repair");
  if (failedCodes.has("version-mismatch") || failedCodes.has("protocol-mismatch") || failedCodes.has("content-hash-mismatch")) actions.push("refresh");
  if (failedCodes.has("plugin-copy-missing") || failedCodes.has("native-manifest-missing") || failedCodes.has("marketplace-entry-missing") || failedCodes.has("host-instruction-missing")) actions.push("install");
  if (failedCodes.has("managed-block-missing") || failedCodes.has("managed-block-invalid")) actions.push("connect");
  return actions;
}

function findFailedPluginInstallationCheck(statuses: AgentPluginStatus[]): {
  hostId: AgentPluginHostId;
  message: string;
} | undefined {
  for (const status of statuses) {
    const failedCheck = status.checks.find((check) => check.status === "failed" && !isProjectConnectionCheck(check));
    if (failedCheck) return { hostId: status.hostId, message: failedCheck.message };
  }
  return undefined;
}

function isProjectConnectionCheck(check: AgentPluginStatusCheck): boolean {
  return check.code === "managed-block-missing" || check.code === "managed-block-invalid" ||
    check.filePath === "GEMINI.md" || check.filePath === join(".cursor", "rules", "flowweave.mdc");
}

async function calculateHostPluginContentHash(pluginRoot: string, hostId: AgentPluginHostId): Promise<string> {
  const relativePaths = ["manifest.json", "skills/flowweave/SKILL.md", `hosts/${hostId}.md`];
  if (hostId === "codex") relativePaths.push(".codex-plugin/plugin.json");
  if (hostId === "claude") relativePaths.push(".claude-plugin/plugin.json");
  const hash = createHash("sha256");
  for (const relativePath of relativePaths) {
    const filePath = join(pluginRoot, relativePath);
    hash.update(`${relativePath}\0file\0`);
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
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

type LegacyMigrationTransaction = {
  result: AgentPluginMigrationResult;
  stage: () => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<string[]>;
};

type MigrationWrite = {
  targetPath: string;
  content: string;
  sourcePath: string;
  targetExists: boolean;
};

type MigrationMove = {
  sourcePath: string;
  backupPath: string;
};

async function prepareLegacyProjectData(
  projectPath: string,
  previousResult: AgentPluginMigrationResult
): Promise<LegacyMigrationTransaction> {
  const legacyConnectorPath = resolve(projectPath, LEGACY_CONNECTOR_DIRECTORY);
  const targetConnectorPath = resolve(projectPath, PROJECT_CONNECTOR_DIRECTORY);
  const legacyBridgePath = resolve(projectPath, LEGACY_BRIDGE_DIRECTORY);
  const runsPath = resolve(projectPath, AGENT_RUNS_DIRECTORY);
  assertProjectPath(projectPath, legacyConnectorPath);
  assertProjectPath(projectPath, targetConnectorPath);
  assertProjectPath(projectPath, legacyBridgePath);
  assertProjectPath(projectPath, runsPath);
  await assertMigrationPathIsSafe(projectPath, legacyConnectorPath);
  await assertMigrationPathIsSafe(projectPath, targetConnectorPath);
  await assertMigrationPathIsSafe(projectPath, legacyBridgePath);
  await assertMigrationPathIsSafe(projectPath, runsPath);

  if (previousResult.status === "cleanup-failed") {
    return retryLegacyCleanup(projectPath, previousResult);
  }

  const connectorPlan = await planLegacyConnectorMigration(legacyConnectorPath, targetConnectorPath);
  const bridgePlan = await planLegacyBridgeMigration(legacyBridgePath, runsPath);
  const blockedPaths = [...connectorPlan.blockedPaths, ...bridgePlan.blockedPaths];
  if (blockedPaths.length > 0) {
    return noOpLegacyMigration({
      status: "blocked",
      message: `Legacy Agent data was preserved because migration is blocked at: ${blockedPaths.join(", ")}.`
    });
  }
  const connectorExists = await pathExists(legacyConnectorPath);
  const bridgeExists = await pathExists(legacyBridgePath);
  if (!connectorExists && !bridgeExists) {
    return noOpLegacyMigration(previousResult.status === "completed" ? previousResult : {
      status: "completed",
      completedAt: new Date().toISOString(),
      migratedFiles: [],
      migratedRuns: []
    });
  }
  const writes: MigrationWrite[] = [
    ...connectorPlan.entries.map((entry) => ({
      sourcePath: entry.sourcePath,
      targetPath: entry.targetPath,
      content: entry.content,
      targetExists: entry.targetExists
    })),
    ...bridgePlan.runs.map((run) => ({
      sourcePath: run.sourcePath,
      targetPath: run.summaryPath,
      content: run.summaryContent,
      targetExists: false
    }))
  ];
  const operationId = randomUUID();
  const moves: MigrationMove[] = [];
  if (connectorExists) {
    moves.push({
      sourcePath: legacyConnectorPath,
      backupPath: join(dirname(legacyConnectorPath), `.${basename(legacyConnectorPath)}.flowweave-migration-${operationId}`)
    });
  }
  if (bridgeExists) {
    moves.push({
      sourcePath: legacyBridgePath,
      backupPath: join(dirname(legacyBridgePath), `.${basename(legacyBridgePath)}.flowweave-migration-${operationId}`)
    });
  }
  const result: AgentPluginMigrationResult = {
    status: "not-run",
    migratedFiles: connectorPlan.entries.map((entry) => ({
      sourcePath: entry.sourcePath,
      targetPath: entry.targetPath,
      contentHash: createHash("sha256").update(entry.content).digest("hex")
    })),
    migratedRuns: bridgePlan.runs.map((run) => ({
      sourcePath: run.sourcePath,
      targetPath: run.summaryPath,
      contentHash: createHash("sha256").update(run.summaryContent).digest("hex"),
      disposition: run.disposition
    }))
  };
  const createdTargets = new Set<string>();
  const moved = new Set<string>();
  let committed = false;
  return {
    result,
    async stage(): Promise<void> {
      for (const write of writes) {
        if (write.targetExists) continue;
        await writeTextAtomic(write.targetPath, write.content);
        createdTargets.add(write.targetPath);
      }
    },
    async commit(): Promise<void> {
      try {
        for (const move of moves) {
          await rename(move.sourcePath, move.backupPath);
          moved.add(move.sourcePath);
        }
        committed = true;
        await verifyMigrationTargets(result);
        result.cleanupPaths = await Promise.all(moves.map(async (move) => ({
          path: move.backupPath,
          contentHash: await calculateMigrationDirectoryHash(move.backupPath)
        })));
        for (const cleanup of result.cleanupPaths) {
          try {
            await rm(cleanup.path, { recursive: true });
          } catch (error) {
            result.status = "cleanup-failed";
            result.message = `Legacy cleanup failed at ${cleanup.path}: ${formatError(error)}`;
            return;
          }
        }
        result.status = "completed";
        result.completedAt = new Date().toISOString();
      } catch (error) {
        if (committed) throw error;
        await rollbackLegacyMigration(moves, moved, createdTargets);
        throw error;
      }
    },
    async rollback(): Promise<string[]> {
      if (committed) return [];
      return rollbackLegacyMigration(moves, moved, createdTargets);
    }
  };
}

async function retryLegacyCleanup(
  projectPath: string,
  previousResult: AgentPluginMigrationResult
): Promise<LegacyMigrationTransaction> {
  const cleanupPaths = previousResult.cleanupPaths ?? [];
  if (cleanupPaths.length === 0) {
    return noOpLegacyMigration({
      ...previousResult,
      status: "blocked",
      message: "Legacy cleanup cannot retry because its recorded isolation paths are missing."
    });
  }
  for (const cleanup of cleanupPaths) {
    assertProjectPath(projectPath, cleanup.path);
    await assertMigrationPathIsSafe(projectPath, cleanup.path);
  }
  const result: AgentPluginMigrationResult = { ...previousResult, cleanupPaths: [...cleanupPaths] };
  return {
    result,
    stage: async () => { await verifyMigrationTargets(result); },
    commit: async () => {
      for (const cleanup of cleanupPaths) {
        if (!await pathExists(cleanup.path)) continue;
        const hash = await calculateMigrationDirectoryHash(cleanup.path);
        if (hash !== cleanup.contentHash) {
          result.status = "blocked";
          result.message = `Refusing cleanup retry because isolation hash changed at ${cleanup.path}.`;
          return;
        }
        try {
          await rm(cleanup.path, { recursive: true });
        } catch (error) {
          result.status = "cleanup-failed";
          result.message = `Legacy cleanup retry failed at ${cleanup.path}: ${formatError(error)}`;
          return;
        }
      }
      result.status = "completed";
      result.completedAt = new Date().toISOString();
      result.message = undefined;
    },
    rollback: async () => []
  };
}

async function verifyMigrationTargets(result: AgentPluginMigrationResult): Promise<void> {
  for (const migration of [...result.migratedFiles ?? [], ...result.migratedRuns ?? []]) {
    const content = await readFile(migration.targetPath, "utf8");
    const contentHash = createHash("sha256").update(content).digest("hex");
    if (contentHash !== migration.contentHash) {
      throw new Error(`Migrated target verification failed at ${migration.targetPath}.`);
    }
  }
}

async function calculateMigrationDirectoryHash(directoryPath: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string, relativePath: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = join(path, entry.name);
      const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        hash.update(`${nextRelativePath}\u0000directory\u0000`);
        await visit(entryPath, nextRelativePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported legacy migration entry at ${entryPath}.`);
      hash.update(`${nextRelativePath}\u0000file\u0000`);
      hash.update(await readFile(entryPath));
      hash.update("\u0000");
    }
  }
  await visit(directoryPath, "");
  return hash.digest("hex");
}

function noOpLegacyMigration(result: AgentPluginMigrationResult): LegacyMigrationTransaction {
  return { result, stage: async () => {}, commit: async () => {}, rollback: async () => [] };
}

async function rollbackLegacyMigration(
  moves: MigrationMove[],
  moved: Set<string>,
  createdTargets: Set<string>
): Promise<string[]> {
  const errors: string[] = [];
  for (const move of [...moves].reverse()) {
    if (!moved.has(move.sourcePath)) continue;
    try {
      await mkdir(dirname(move.sourcePath), { recursive: true });
      if (await pathExists(move.backupPath)) await rename(move.backupPath, move.sourcePath);
    } catch (error) {
      errors.push(`legacy source at ${move.sourcePath}: ${formatError(error)}`);
    }
  }
  for (const targetPath of createdTargets) {
    try {
      await rm(targetPath, { force: true });
    } catch (error) {
      errors.push(`staged migration target at ${targetPath}: ${formatError(error)}`);
    }
  }
  return errors;
}

type ConnectorMigrationEntry = {
  sourcePath: string;
  targetPath: string;
  content: string;
  targetExists: boolean;
};

async function planLegacyConnectorMigration(legacyPath: string, targetPath: string): Promise<{
  entries: ConnectorMigrationEntry[];
  blockedPaths: string[];
}> {
  let entries;
  try {
    entries = await readdir(legacyPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return { entries: [], blockedPaths: [] };
    throw new Error(`Unable to inspect legacy Agent connector directory ${legacyPath}: ${formatError(error)}`);
  }
  const migrationEntries: ConnectorMigrationEntry[] = [];
  const blockedPaths: string[] = [];
  for (const entry of entries) {
    const sourcePath = join(legacyPath, entry.name);
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      blockedPaths.push(sourcePath);
      continue;
    }
    const content = await readFile(sourcePath, "utf8");
    try {
      parseAgentManifest(content, sourcePath);
    } catch {
      blockedPaths.push(sourcePath);
      continue;
    }
    const targetPathname = join(targetPath, entry.name);
    const existing = await readOptionalText(targetPathname);
    if (existing !== undefined && existing !== content) {
      blockedPaths.push(sourcePath);
      continue;
    }
    migrationEntries.push({ sourcePath, targetPath: targetPathname, content, targetExists: existing !== undefined });
  }
  return { entries: migrationEntries, blockedPaths };
}

type BridgeMigrationRun = {
  sourcePath: string;
  summaryPath: string;
  summaryContent: string;
  disposition: "completed" | "abandoned";
};

async function planLegacyBridgeMigration(legacyPath: string, runsPath: string): Promise<{
  runs: BridgeMigrationRun[];
  blockedPaths: string[];
}> {
  let entries;
  try {
    entries = await readdir(legacyPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return { runs: [], blockedPaths: [] };
    throw new Error(`Unable to inspect legacy Agent bridge directory ${legacyPath}: ${formatError(error)}`);
  }
  const runs: BridgeMigrationRun[] = [];
  const blockedPaths: string[] = [];
  for (const entry of entries) {
    const sourcePath = join(legacyPath, entry.name);
    if (!entry.isDirectory()) {
      blockedPaths.push(sourcePath);
      continue;
    }
    const files = await readdir(sourcePath, { withFileTypes: true });
    const fileNames = files.map((file) => file.name).sort();
    if (!files.every((file) => file.isFile())) {
      blockedPaths.push(sourcePath);
      continue;
    }
    const summaryPath = join(runsPath, entry.name, "legacy-summary.json");
    if (await pathExists(summaryPath)) {
      blockedPaths.push(summaryPath);
      continue;
    }
    const isCompleted = fileNames.includes("completion.json") &&
      fileNames.every((name) => name === "request.json" || name === "completion.json");
    const isAbandoned = ["instructions.md", "prompt.md", "request.json"].every((name) => fileNames.includes(name)) &&
      fileNames.every((name) => name === "instructions.md" || name === "prompt.md" || name === "request.json");
    if (!isCompleted && !isAbandoned) {
      blockedPaths.push(sourcePath);
      continue;
    }
    let completion: Record<string, unknown> | undefined;
    if (isCompleted) {
      const completionPath = join(sourcePath, "completion.json");
      try {
        completion = parseJsonRecord(await readFile(completionPath, "utf8"), "Legacy Agent completion", completionPath);
      } catch {
        blockedPaths.push(sourcePath);
        continue;
      }
      if (completion.status !== "completed") {
        blockedPaths.push(sourcePath);
        continue;
      }
    }
    const disposition = isCompleted ? "completed" : "abandoned";
    const summaryContent = `${JSON.stringify({
      migratedFrom: sourcePath,
      status: disposition,
      ...(completion ? { completedAt: completion.completedAt } : { abandonedAt: new Date().toISOString() }),
      files: await Promise.all(fileNames.map(async (name) => ({
        name,
        contentHash: createHash("sha256").update(await readFile(join(sourcePath, name), "utf8")).digest("hex")
      })))
    }, null, 2)}\n`;
    runs.push({ sourcePath, summaryPath, summaryContent, disposition });
  }
  return { runs, blockedPaths };
}

async function assertMigrationPathIsSafe(projectPath: string, candidatePath: string): Promise<void> {
  const normalizedProjectPath = resolve(projectPath);
  const normalizedCandidatePath = resolve(candidatePath);
  const pathFromProject = relative(normalizedProjectPath, normalizedCandidatePath);
  if (pathFromProject === ".." || pathFromProject.startsWith(`..${sep}`) || isAbsolute(pathFromProject)) {
    throw new Error(`Migration path escapes the project root: ${candidatePath}.`);
  }
  const segments = pathFromProject.split(sep).filter(Boolean);
  let currentPath = normalizedProjectPath;
  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    try {
      if ((await lstat(currentPath)).isSymbolicLink()) {
        throw new Error(`Migration path contains a symbolic link: ${currentPath}.`);
      }
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
  }
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

  const skillPath = join(stagingPath, "skills", "flowweave", "SKILL.md");
  if (!await pathExists(skillPath)) {
    throw new Error(`required shared Skill is missing at ${skillPath}.`);
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
    const requiredFiles = pluginRequiredFilesForHost(hostId);
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
  const pluginFiles = pluginRequiredFilesForHost(hostId);
  if (hostId === "gemini") return [...pluginFiles, "GEMINI.md"];
  if (hostId === "cursor") return [...pluginFiles, ".cursor/rules/flowweave.mdc"];
  return pluginFiles;
}

function pluginRequiredFilesForHost(hostId: AgentPluginHostId): string[] {
  const pluginFiles = [
    "plugins/flowweave/manifest.json",
    "plugins/flowweave/skills/flowweave/SKILL.md",
    `plugins/flowweave/hosts/${hostId}.md`
  ];
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
  if (!isRecord(result) || !["not-run", "completed", "blocked", "cleanup-failed"].includes(String(result.status))) {
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
    requiredFiles: requiredFilesForHost(hostId),
    missingFiles: [],
    protocolVersion: 2,
    contentHash: "",
    checks: [{ code: "check-error", status: "failed", message: `FlowWeave bundled plugin is unavailable: ${message}` }],
    suggestedActions: ["repair"],
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

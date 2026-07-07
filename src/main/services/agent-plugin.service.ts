import { access, cp, mkdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { AgentPluginHostId, AgentPluginManifest, AgentPluginStatus } from "../../types";

const BUILT_IN_PLUGIN_DIR = "flowweave-plugin";
const MANIFEST_FILE = "manifest.json";
const PROJECT_PLUGIN_ROOT = ".flowweave/agent-plugins";

export async function getBuiltInAgentPluginManifest(): Promise<AgentPluginManifest> {
  const manifestPath = join(resolveBundledPluginRoot(), MANIFEST_FILE);
  const value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (!isAgentPluginManifest(value)) {
    throw new Error(`Invalid FlowWeave built-in plugin manifest: ${manifestPath}`);
  }
  return value;
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

  const installed = await readInstalledManifest(join(pluginRoot, MANIFEST_FILE));
  const status = installed
    ? installed.version === manifest.version && installed.protocolVersion === manifest.protocolVersion ? "installed" : "outdated"
    : "missing";
  return manifest.hosts.map((host) => {
    return {
      pluginId: manifest.id,
      hostId: host.id,
      displayName: host.displayName,
      status,
      installedVersion: installed?.version,
      bundledVersion: manifest.version,
      installTarget: pluginRoot,
      hostInstructionPath: join(pluginRoot, "hosts", `${host.id}.md`),
      message: status === "installed"
        ? `Project FlowWeave plugin copy is installed for ${host.displayName}.`
        : status === "outdated"
          ? `Project FlowWeave plugin copy can be refreshed for ${host.displayName}.`
          : `Project FlowWeave plugin copy is not installed for ${host.displayName}.`
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
  return isAgentPluginManifest(value) ? value : undefined;
}

function isAgentPluginManifest(value: unknown): value is AgentPluginManifest {
  if (!isRecord(value)) return false;
  if (value.id !== "flowweave" || typeof value.name !== "string" || typeof value.version !== "string") return false;
  if (value.protocolVersion !== 1 || typeof value.description !== "string") return false;
  if (!Array.isArray(value.hosts)) return false;
  return value.hosts.every((host) => (
    isRecord(host) &&
    (host.id === "codex" || host.id === "claude" || host.id === "gemini" || host.id === "cursor") &&
    typeof host.displayName === "string" &&
    typeof host.installTarget === "string" &&
    Array.isArray(host.capabilities) &&
    Array.isArray(host.protocols)
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

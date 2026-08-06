import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCapability, AgentDefinition, AgentDiscoveryResult, AgentDiscoverySource, AgentProtocol, ToolDetectionResult } from "../../types";
import { resolveProjectPath } from "./project-registry.service";
import { createAdapterFromDefinition, getAgentAdapter, getAgentRegistryRoot, listAgentDefinitions, registerDiscoveredAgentDefinitions } from "./agent-registry.service";

const MANIFEST_DIRECTORY = ["agents", "connectors"];
const PROJECT_MANIFEST_DIRECTORY = [".flowweave", "agent-connectors"];
const DETECTION_CONCURRENCY = 4;

export type DiscoverAgentDefinitionsOptions = {
  builtinDefinitions: AgentDefinition[];
  userDataPath: string;
  projectPath?: string;
  detectDefinition: (definition: AgentDefinition) => Promise<ToolDetectionResult>;
};

export async function discoverAgentDefinitions(options: DiscoverAgentDefinitionsOptions): Promise<AgentDiscoveryResult[]> {
  const userDefinitions = await readManifestDefinitions(join(options.userDataPath, ...MANIFEST_DIRECTORY), "user-manifest");
  const projectDefinitions = options.projectPath
    ? await readManifestDefinitions(join(options.projectPath, ...PROJECT_MANIFEST_DIRECTORY), "project-manifest")
    : [];
  const definitions = mergeDefinitions(options.builtinDefinitions, userDefinitions, projectDefinitions);
  const results = await mapWithConcurrency(definitions, DETECTION_CONCURRENCY, async (entry) => ({
    definition: entry.definition,
    availability: await options.detectDefinition(entry.definition),
    source: entry.source
  }));
  return results.sort(compareDiscoveryResults);
}

export async function discoverAgents(projectId?: string): Promise<AgentDiscoveryResult[]> {
  const results = await discoverAgentDefinitions({
    builtinDefinitions: await listAgentDefinitions(),
    userDataPath: getAgentRegistryRoot(),
    projectPath: projectId ? resolveProjectPath(projectId) : undefined,
    detectDefinition: detectAgentDefinition
  });
  registerDiscoveredAgentDefinitions(projectId, results.map((result) => result.definition));
  return results;
}

type DiscoveryDefinition = {
  definition: AgentDefinition;
  source: AgentDiscoverySource;
};

async function readManifestDefinitions(directory: string, source: AgentDiscoverySource): Promise<DiscoveryDefinition[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissingDirectory(error)) return [];
    throw new Error(`Unable to read Agent connector manifests from ${directory}: ${errorMessage(error)}`);
  });
  const definitions: DiscoveryDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    const content = await readFile(path, "utf8").catch((error: unknown) => {
      throw new Error(`Unable to read Agent connector manifest ${path}: ${errorMessage(error)}`);
    });
    definitions.push({ definition: parseManifest(content, path), source });
  }
  return definitions;
}

function mergeDefinitions(
  builtins: AgentDefinition[],
  userDefinitions: DiscoveryDefinition[],
  projectDefinitions: DiscoveryDefinition[]
): DiscoveryDefinition[] {
  const definitions = new Map<string, DiscoveryDefinition>();
  for (const definition of builtins) {
    definitions.set(definition.id, { definition, source: definition.builtIn ? "builtin" : "user-manifest" });
  }
  for (const entry of userDefinitions) definitions.set(entry.definition.id, entry);
  for (const entry of projectDefinitions) definitions.set(entry.definition.id, entry);
  return [...definitions.values()];
}

function parseManifest(content: string, path: string): AgentDefinition {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Agent connector manifest ${path} is invalid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) throw new Error(`Agent connector manifest ${path} must be a JSON object.`);
  const id = requiredString(value, "id", path);
  if (!id.startsWith("custom:") || id.length <= "custom:".length) {
    throw new Error(`Agent connector manifest ${path} has an invalid id; expected a custom:* id.`);
  }
  const protocol = requiredProtocol(value, path);
  const kind = protocol === "desktop-bridge" ? "desktop" : "cli";
  const command = requiredString(value, "command", path);
  const appPath = optionalString(value, "appPath", path);
  if (protocol === "desktop-bridge" && !appPath && !command) {
    throw new Error(`Agent connector manifest ${path} requires appPath or command for desktop-bridge.`);
  }
  return {
    id: id as AgentDefinition["id"],
    name: requiredString(value, "name", path),
    kind,
    protocol,
    protocolVersion: 1,
    command,
    args: stringArray(value, "args", path),
    planArgs: optionalStringArray(value, "planArgs", path),
    executeArgs: optionalStringArray(value, "executeArgs", path),
    appPath,
    bridgeInstructions: optionalString(value, "bridgeInstructions", path),
    capabilities: capabilities(value, path),
    description: requiredString(value, "description", path),
    builtIn: false,
    createdAt: optionalString(value, "createdAt", path) ?? "manifest",
    updatedAt: optionalString(value, "updatedAt", path) ?? "manifest"
  };
}

function requiredProtocol(value: Record<string, unknown>, path: string): AgentProtocol {
  const protocol = requiredString(value, "protocol", path);
  if (protocol !== "cli-stdin" && protocol !== "desktop-bridge") {
    throw new Error(`Unsupported Agent protocol in ${path}: ${protocol}. Supported protocols are cli-stdin and desktop-bridge.`);
  }
  return protocol;
}

function requiredString(value: Record<string, unknown>, property: string, path: string): string {
  const result = optionalString(value, property, path);
  if (!result) throw new Error(`Agent connector manifest ${path} requires a non-empty ${property}.`);
  return result;
}

function optionalString(value: Record<string, unknown>, property: string, path: string): string | undefined {
  const candidate = value[property];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || !candidate.trim() || candidate.length > 2048 || /[\0\r\n]/.test(candidate)) {
    throw new Error(`Agent connector manifest ${path} has an invalid ${property}.`);
  }
  return candidate.trim();
}

function stringArray(value: Record<string, unknown>, property: string, path: string): string[] {
  return optionalStringArray(value, property, path) ?? [];
}

function optionalStringArray(value: Record<string, unknown>, property: string, path: string): string[] | undefined {
  const candidate = value[property];
  if (candidate === undefined) return undefined;
  if (!Array.isArray(candidate) || candidate.length > 64 || candidate.some((item) => typeof item !== "string" || item.length > 4096 || /[\0\r\n]/.test(item))) {
    throw new Error(`Agent connector manifest ${path} has an invalid ${property} array.`);
  }
  return [...candidate];
}

function capabilities(value: Record<string, unknown>, path: string): AgentCapability[] {
  const candidate = optionalStringArray(value, "capabilities", path) ?? ["implementation-plan"];
  const allowed = new Set<AgentCapability>(["artifact-analysis", "implementation-plan", "execute"]);
  if (candidate.some((item) => !allowed.has(item as AgentCapability))) {
    throw new Error(`Agent connector manifest ${path} includes an unsupported capability.`);
  }
  return candidate as AgentCapability[];
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function compareDiscoveryResults(left: AgentDiscoveryResult, right: AgentDiscoveryResult): number {
  if (left.availability.available !== right.availability.available) return left.availability.available ? -1 : 1;
  return left.definition.name.localeCompare(right.definition.name);
}

async function detectAgentDefinition(definition: AgentDefinition): Promise<ToolDetectionResult> {
  const adapter = definition.builtIn
    ? await getAgentAdapter(definition.id)
    : createAdapterFromDefinition(definition);
  return adapter.detect();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingDirectory(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

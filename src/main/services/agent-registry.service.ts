import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentCapability, AgentDefinition, AgentId, AgentProtocol, BuiltInAgentId, CustomAgentId, CustomAgentInput, RuntimeAgentId, ToolAdapter } from "../../types";
import { ClaudeCodeAdapter } from "../agents/claude-code.adapter";
import { CodexLocalAdapter } from "../agents/codex-local.adapter";
import { CursorAdapter } from "../agents/cursor.adapter";
import { CustomCliAdapter } from "../agents/custom-cli.adapter";
import { ClaudeDesktopAdapter, CodexDesktopAdapter, DesktopBridgeAdapter } from "../agents/desktop-bridge.adapter";
import { GeminiCliAdapter } from "../agents/gemini-cli.adapter";
import { MockAgentAdapter } from "../agents/mock.adapter";
import { resolveCandidate } from "../agents/agent-command";
import { writeJsonAtomic } from "../storage/artifact-store";

const BUILT_IN_AGENTS: AgentDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code CLI",
    kind: "cli",
    protocol: "agent-inbox",
    protocolVersion: 2,
    pluginId: "flowweave",
    installTarget: "Claude skills/plugins directory",
    command: "claude",
    args: ["--print", "--permission-mode", "plan"],
    capabilities: ["artifact-analysis", "implementation-plan", "execute"],
    description: "调用 Claude Code 的 plan 模式输出计划，不直接修改项目文件。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    kind: "desktop",
    protocol: "agent-inbox",
    protocolVersion: 2,
    pluginId: "flowweave",
    installTarget: "Claude skills/plugins directory",
    command: "/Applications/Claude.app",
    args: [".flowweave/runs/<run-id>"],
    appPath: "/Applications/Claude.app",
    capabilities: ["artifact-analysis", "implementation-plan"],
    description: "检测并打开 Claude 桌面端，通过项目内文件系统桥接请求等待桌面端回写计划。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "codex-local",
    name: "Codex CLI",
    kind: "cli",
    protocol: "agent-inbox",
    protocolVersion: 2,
    pluginId: "flowweave",
    installTarget: "Codex skills/plugins directory",
    command: "codex",
    args: ["exec", "--sandbox", "read-only"],
    capabilities: ["artifact-analysis", "implementation-plan", "execute"],
    description: "调用本地 Codex CLI 读取 FlowWeave 上下文，并生成可审查的实现计划。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "codex-desktop",
    name: "Codex Desktop",
    kind: "desktop",
    protocol: "agent-inbox",
    protocolVersion: 2,
    pluginId: "flowweave",
    installTarget: "Codex skills/plugins directory",
    command: "/Applications/ChatGPT.app",
    args: [".flowweave/runs/<run-id>"],
    appPath: "/Applications/ChatGPT.app",
    capabilities: ["artifact-analysis", "implementation-plan"],
    description: "检测并打开 Codex 桌面端，通过项目内文件系统桥接请求等待桌面端回写计划。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    kind: "cli",
    protocol: "agent-inbox",
    protocolVersion: 2,
    pluginId: "flowweave",
    installTarget: "Gemini agent instructions or skills directory",
    command: "gemini",
    args: [],
    capabilities: ["artifact-analysis", "implementation-plan", "execute"],
    description: "调用本地 Gemini CLI，通过 stdin 传入 FlowWeave prompt 并记录 stdout/stderr。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "desktop",
    protocol: "agent-inbox",
    protocolVersion: 2,
    pluginId: "flowweave",
    installTarget: "Cursor rules or project instructions directory",
    command: "cursor/code <project> / Cursor.app",
    args: [],
    capabilities: ["implementation-plan"],
    description: "检测 Cursor CLI 或桌面应用，生成计划文件并打开项目供用户在 Cursor 中审查执行。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  }
];

let configuredRoot: string | undefined;
const GLOBAL_DISCOVERY_SCOPE = "global";
let discoveredDefinitionsByProject = new Map<string, Map<AgentId, AgentDefinition>>();

export function configureAgentRegistry(rootPath: string) {
  configuredRoot = rootPath;
  discoveredDefinitionsByProject = new Map();
}

export function getAgentRegistryRoot(): string {
  return agentConfigRoot();
}

export async function listAgentDefinitions(): Promise<AgentDefinition[]> {
  return [...BUILT_IN_AGENTS, ...(await readCustomAgents())];
}

export async function saveCustomAgent(input: CustomAgentInput): Promise<AgentDefinition> {
  const name = input.name.trim();
  const protocol = input.protocol ?? "agent-inbox";
  const command = input.command?.trim() ?? "";
  const appPath = input.appPath?.trim() ?? "";
  if (!name) throw new Error("Agent name is required.");
  if (!isAgentProtocol(protocol)) throw new Error(`Unsupported Agent protocol: ${protocol}`);
  const isDesktop = Boolean(appPath);
  const capabilities = normalizeCapabilities(input.capabilities, protocol, input.planArgs, isDesktop);
  const commandPath = isDesktop
    ? validateCustomDesktopAppPath(appPath)
    : await validateCustomAgentCommand(command, input.args ?? [], input.planArgs ?? [], input.executeArgs ?? []);

  const agents = await readCustomAgents();
  const now = new Date().toISOString();
  const id = createCustomAgentId(name, agents);
  const agent: AgentDefinition = {
    id,
    name,
    kind: isDesktop ? "desktop" : "cli",
    protocol,
    command: commandPath,
    args: input.args ?? [],
    planArgs: input.planArgs ?? [],
    executeArgs: input.executeArgs ?? [],
    appPath: isDesktop ? commandPath : undefined,
    capabilities,
    description: input.description?.trim() || (isDesktop ? "Custom Desktop Agent" : "Custom CLI Agent"),
    builtIn: false,
    createdAt: now,
    updatedAt: now
  };
  await writeCustomAgents([...agents, agent]);
  return agent;
}

async function validateCustomAgentCommand(command: string, args: string[], planArgs: string[], executeArgs: string[]): Promise<string> {
  if (command.length > 2048 || /[\0\r\n]/.test(command)) {
    throw new Error("Agent command contains invalid control characters or exceeds 2048 characters.");
  }
  if (!command) throw new Error("Agent command is required.");
  if (args.length > 64) {
    throw new Error("Agent arguments cannot contain more than 64 entries.");
  }
  if (planArgs.length > 64 || executeArgs.length > 64) {
    throw new Error("Agent plan or execute arguments cannot contain more than 64 entries.");
  }
  for (const argument of [...args, ...planArgs, ...executeArgs]) {
    if (argument.length > 4096 || /[\0\r\n]/.test(argument)) {
      throw new Error("Agent argument contains invalid control characters or exceeds 4096 characters.");
    }
  }
  const commandPath = await resolveCandidate(command);
  if (!commandPath) {
    throw new Error(`Agent executable was not found or is not executable: ${command}`);
  }
  return commandPath;
}

function validateCustomDesktopAppPath(appPath: string): string {
  if (!appPath) throw new Error("Agent app path is required.");
  if (appPath.length > 2048 || /[\0\r\n]/.test(appPath)) {
    throw new Error("Agent app path contains invalid control characters or exceeds 2048 characters.");
  }
  return appPath;
}

export async function deleteCustomAgent(agentId: AgentId): Promise<void> {
  if (!isCustomAgentId(agentId)) return;
  const agents = await readCustomAgents();
  await writeCustomAgents(agents.filter((agent) => agent.id !== agentId));
}

export async function getAgentDefinition(agentId: RuntimeAgentId, projectId?: string): Promise<AgentDefinition | undefined> {
  if (agentId === "mock") {
    return {
      id: "custom:mock",
      name: "Mock Agent",
      kind: "cli",
      protocol: "agent-inbox",
      protocolVersion: 2,
      command: "built-in",
      args: [],
      capabilities: ["artifact-analysis", "implementation-plan"],
      description: "Built-in mock tool for development tests.",
      builtIn: true,
      createdAt: "builtin",
      updatedAt: "builtin"
    };
  }
  const projectDefinition = projectId
    ? discoveredDefinitionsByProject.get(projectId)?.get(agentId as AgentId)
    : undefined;
  const globalDefinition = discoveredDefinitionsByProject.get(GLOBAL_DISCOVERY_SCOPE)?.get(agentId as AgentId);
  return projectDefinition ?? globalDefinition ?? (await listAgentDefinitions()).find((agent) => agent.id === agentId);
}

export function registerDiscoveredAgentDefinitions(projectId: string | undefined, definitions: AgentDefinition[]): void {
  const scope = projectId ?? GLOBAL_DISCOVERY_SCOPE;
  discoveredDefinitionsByProject.set(
    scope,
    new Map(definitions.filter((definition) => !definition.builtIn).map((definition) => [definition.id, definition]))
  );
}

export async function getAgentAdapter(agentId: RuntimeAgentId, projectId?: string): Promise<ToolAdapter> {
  if (agentId === "mock") return new MockAgentAdapter();
  if (agentId === "claude-code") return new ClaudeCodeAdapter();
  if (agentId === "claude-desktop") return new ClaudeDesktopAdapter();
  if (agentId === "codex-local") return new CodexLocalAdapter();
  if (agentId === "codex-desktop") return new CodexDesktopAdapter();
  if (agentId === "gemini-cli") return new GeminiCliAdapter();
  if (agentId === "cursor") return new CursorAdapter();

  const definition = await getAgentDefinition(agentId, projectId);
  if (!definition || definition.builtIn) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return createAdapterFromDefinition(definition);
}

export function createAdapterFromDefinition(definition: AgentDefinition): ToolAdapter {
  if (definition.kind === "desktop") {
    return new DesktopBridgeAdapter({
      id: definition.id,
      name: definition.name,
      appPath: definition.appPath ?? definition.command
    });
  }
  return new CustomCliAdapter(definition);
}

export function isBuiltInAgentId(agentId: RuntimeAgentId): agentId is BuiltInAgentId {
  return (
    agentId === "claude-code" ||
    agentId === "claude-desktop" ||
    agentId === "codex-local" ||
    agentId === "codex-desktop" ||
    agentId === "gemini-cli" ||
    agentId === "cursor"
  );
}

export function isCustomAgentId(agentId: string): agentId is CustomAgentId {
  return agentId.startsWith("custom:");
}

async function readCustomAgents(): Promise<AgentDefinition[]> {
  const content = await readFile(agentConfigPath(), "utf8").catch(() => "[]");
  try {
    const parsed = JSON.parse(content) as AgentDefinition[];
    return parsed
      .filter((agent) => isCustomAgentId(agent.id) && !agent.builtIn)
      .map(migrateCustomAgent);
  } catch {
    return [];
  }
}

async function writeCustomAgents(agents: AgentDefinition[]) {
  await writeJsonAtomic(agentConfigPath(), agents);
}

function agentConfigPath() {
  return join(agentConfigRoot(), "agents.json");
}

function agentConfigRoot() {
  return configuredRoot ?? process.env.FLOWWEAVE_AGENT_CONFIG_DIR ?? join(homedir(), ".flowweave");
}

function createCustomAgentId(name: string, existing: AgentDefinition[]): CustomAgentId {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  const existingIds = new Set(existing.map((agent) => agent.id));
  let index = 1;
  let id = `custom:${base}` as CustomAgentId;
  while (existingIds.has(id)) {
    index += 1;
    id = `custom:${base}-${index}` as CustomAgentId;
  }
  return id;
}

function migrateCustomAgent(agent: AgentDefinition): AgentDefinition {
  const protocol = "agent-inbox" as const;
  return {
    ...agent,
    protocol,
    protocolVersion: 2,
    appPath: agent.kind === "desktop" ? agent.appPath ?? agent.command : agent.appPath,
    capabilities: agent.capabilities ?? (agent.kind === "desktop" ? ["implementation-plan"] : ["execute"])
  };
}

function isAgentProtocol(value: string): value is AgentProtocol {
  return value === "agent-inbox";
}

function normalizeCapabilities(
  capabilities: AgentCapability[] | undefined,
  protocol: AgentProtocol,
  planArgs: string[] | undefined,
  isDesktop: boolean
): AgentCapability[] {
  const allowed = new Set<AgentCapability>(["artifact-analysis", "implementation-plan", "execute"]);
  if (capabilities) {
    return [...new Set(capabilities.filter((capability) => allowed.has(capability)))];
  }
  if (protocol === "agent-inbox" && isDesktop) return ["artifact-analysis", "implementation-plan"];
  return planArgs && planArgs.length > 0 ? ["artifact-analysis", "implementation-plan"] : ["execute"];
}

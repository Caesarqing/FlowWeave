import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, AgentId, BuiltInAgentId, CustomAgentId, CustomAgentInput, RuntimeAgentId, ToolAdapter } from "../../types";
import { ClaudeCodeAdapter } from "../agents/claude-code.adapter";
import { CodexLocalAdapter } from "../agents/codex-local.adapter";
import { CursorAdapter } from "../agents/cursor.adapter";
import { CustomCliAdapter } from "../agents/custom-cli.adapter";
import { MockAgentAdapter } from "../agents/mock.adapter";

const BUILT_IN_AGENTS: AgentDefinition[] = [
  {
    id: "codex-local",
    name: "Codex Local",
    kind: "cli",
    command: "codex",
    args: ["exec", "--sandbox", "read-only"],
    description: "调用本地 Codex CLI 读取 FlowWeave 上下文，并生成可审查的实现计划。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "claude-code",
    name: "Claude Code",
    kind: "cli",
    command: "claude",
    args: ["--print", "--permission-mode", "plan"],
    description: "调用 Claude Code 的 plan 模式输出计划，不直接修改项目文件。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "desktop",
    command: "cursor <project> / Cursor.app",
    args: [],
    description: "检测 Cursor CLI 或桌面应用，生成计划文件并打开项目供用户在 Cursor 中审查执行。",
    builtIn: true,
    createdAt: "builtin",
    updatedAt: "builtin"
  }
];

let configuredRoot: string | undefined;

export function configureAgentRegistry(rootPath: string) {
  configuredRoot = rootPath;
}

export async function listAgentDefinitions(): Promise<AgentDefinition[]> {
  return [...BUILT_IN_AGENTS, ...(await readCustomAgents())];
}

export async function saveCustomAgent(input: CustomAgentInput): Promise<AgentDefinition> {
  const name = input.name.trim();
  const command = input.command.trim();
  if (!name) throw new Error("Agent name is required.");
  if (!command) throw new Error("Agent command is required.");

  const agents = await readCustomAgents();
  const now = new Date().toISOString();
  const id = createCustomAgentId(name, agents);
  const agent: AgentDefinition = {
    id,
    name,
    kind: "cli",
    command,
    args: input.args ?? [],
    description: input.description?.trim() || "Custom CLI Agent",
    builtIn: false,
    createdAt: now,
    updatedAt: now
  };
  await writeCustomAgents([...agents, agent]);
  return agent;
}

export async function deleteCustomAgent(agentId: AgentId): Promise<void> {
  if (!isCustomAgentId(agentId)) return;
  const agents = await readCustomAgents();
  await writeCustomAgents(agents.filter((agent) => agent.id !== agentId));
}

export async function getAgentDefinition(agentId: RuntimeAgentId): Promise<AgentDefinition | undefined> {
  if (agentId === "mock") {
    return {
      id: "custom:mock",
      name: "Mock Agent",
      kind: "cli",
      command: "built-in",
      args: [],
      description: "Built-in mock tool for development tests.",
      builtIn: true,
      createdAt: "builtin",
      updatedAt: "builtin"
    };
  }
  return (await listAgentDefinitions()).find((agent) => agent.id === agentId);
}

export async function getAgentAdapter(agentId: RuntimeAgentId): Promise<ToolAdapter> {
  if (agentId === "mock") return new MockAgentAdapter();
  if (agentId === "codex-local") return new CodexLocalAdapter();
  if (agentId === "claude-code") return new ClaudeCodeAdapter();
  if (agentId === "cursor") return new CursorAdapter();

  const definition = await getAgentDefinition(agentId);
  if (!definition || definition.builtIn) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return new CustomCliAdapter(definition);
}

export function isBuiltInAgentId(agentId: RuntimeAgentId): agentId is BuiltInAgentId {
  return agentId === "codex-local" || agentId === "claude-code" || agentId === "cursor";
}

export function isCustomAgentId(agentId: string): agentId is CustomAgentId {
  return agentId.startsWith("custom:");
}

async function readCustomAgents(): Promise<AgentDefinition[]> {
  const content = await readFile(agentConfigPath(), "utf8").catch(() => "[]");
  try {
    const parsed = JSON.parse(content) as AgentDefinition[];
    return parsed.filter((agent) => isCustomAgentId(agent.id) && !agent.builtIn);
  } catch {
    return [];
  }
}

async function writeCustomAgents(agents: AgentDefinition[]) {
  const path = agentConfigPath();
  await mkdir(agentConfigRoot(), { recursive: true });
  await writeFile(path, `${JSON.stringify(agents, null, 2)}\n`, "utf8");
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

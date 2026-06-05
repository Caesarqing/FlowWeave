import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ArchitectureMap, CodeflowCanvas, CodeflowProject, GraphEdge, GraphNode, SequenceDiagramBundle } from "../../types";
import { agentConnectorKind, buildAgentConnectorPrompt, type AgentConnectorKind } from "../../utils/agent-connector-prompts";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

export type WriteAgentConnectorsInput = {
  project: CodeflowProject;
  modules: GraphNode[];
  edges: GraphEdge[];
  canvasPath?: string;
  taskMarkdownPath?: string;
  taskJsonPath?: string;
  contextFileTreePath?: string;
};

type ConnectorContext = {
  version: 1;
  projectName: string;
  projectPath: string;
  generatedAt: string;
  artifactPaths: {
    projectJson: string;
    canvasJson: string;
    architectureMap: string;
    sequenceDiagrams: string;
    contextFileTree: string;
    taskMarkdown?: string;
    taskJson?: string;
  };
  modules: Array<{
    id: string;
    title: string;
    nodeType: string;
    risk: string;
    files: string[];
    description: string;
  }>;
  relationships: Array<{
    source: string;
    target: string;
    relation: string;
    guidanceNote?: string;
  }>;
};

export async function writeAgentConnectors(input: WriteAgentConnectorsInput) {
  const connectorDir = getAgentConnectorsDir(input.project.rootPath);
  await mkdir(connectorDir, { recursive: true });

  const context = buildConnectorContext(input);
  const contextJsonPath = join(connectorDir, "context.json");
  const contextMarkdownPath = join(connectorDir, "context.md");
  const agentFiles = connectorKinds().map((kind) => ({
    kind,
    path: join(connectorDir, `${kind}.md`),
    content: buildAgentConnectorMarkdown(kind, context)
  }));
  const skillFiles = connectorKinds().map((kind) => ({
    kind,
    path: join(connectorDir, "skills", kind, "SKILL.md"),
    content: buildAgentConnectorSkillMarkdown(kind, context)
  }));

  await Promise.all([
    writeFile(contextJsonPath, `${JSON.stringify(context, null, 2)}\n`, "utf8"),
    writeFile(contextMarkdownPath, buildContextMarkdown(context), "utf8"),
    ...agentFiles.map((file) => writeFile(file.path, file.content, "utf8")),
    ...skillFiles.map(async (file) => {
      await mkdir(join(connectorDir, "skills", file.kind), { recursive: true });
      await writeFile(file.path, file.content, "utf8");
    })
  ]);

  return {
    connectorDir,
    contextJsonPath,
    contextMarkdownPath,
    codexPath: join(connectorDir, "codex.md"),
    claudePath: join(connectorDir, "claude.md"),
    geminiPath: join(connectorDir, "gemini.md"),
    cursorPath: join(connectorDir, "cursor.md")
  };
}

export async function refreshAgentConnectorsFromProject(projectPath: string) {
  const project = await readJson<CodeflowProject>(join(projectPath, FLOWWEAVE_DIR, "project.json"));
  const canvas = await readJson<CodeflowCanvas>(join(projectPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json")).catch(() => undefined);
  if (!project) {
    throw new Error(`FlowWeave project artifact not found: ${join(projectPath, FLOWWEAVE_DIR, "project.json")}`);
  }
  return writeAgentConnectors({
    project,
    modules: canvas?.nodes ?? [],
    edges: canvas?.edges ?? [],
    canvasPath: join(projectPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json"),
    contextFileTreePath: join(projectPath, FLOWWEAVE_DIR, "context", "file-tree.md")
  });
}

export function getAgentConnectorsDir(projectPath: string) {
  return join(projectPath, FLOWWEAVE_DIR, "agent-connectors");
}

export function buildAgentConnectorMarkdown(kind: AgentConnectorKind, context: ConnectorContext) {
  const prompt = buildAgentConnectorPrompt({ agentId: agentIdForConnectorKind(kind), projectPath: context.projectPath });
  return `# ${prompt.title}

Use this file inside ${connectorAgentName(kind)} to connect with FlowWeave's project context.

## Connection Prompt

${prompt.command}

## Project

- Project: ${context.projectName}
- Project path: ${context.projectPath}
- FlowWeave connector context: ${context.artifactPaths.projectJson.replace("project.json", "agent-connectors/context.json")}
- Canvas: ${context.artifactPaths.canvasJson}
- Architecture map: ${context.artifactPaths.architectureMap}
- Sequence diagrams: ${context.artifactPaths.sequenceDiagrams}
- File tree: ${context.artifactPaths.contextFileTree}

## Rules

- Read context.json and context.md before analyzing or editing.
- Before editing, remind the user to create or confirm a FlowWeave checkpoint when rollback may be needed.
- You may modify project files directly when the user asks for changes.
- Keep changes focused on the user's current request and FlowWeave's module boundaries.
- After modifying files, tell the user which files changed and ask them to return to FlowWeave to inspect Git diff, refresh the project, or roll back from a checkpoint.
- Do not edit .flowweave artifacts unless the user specifically asks to update FlowWeave metadata.

## Current Modules

${context.modules.map((module) => `- ${module.title} (${module.id}): ${module.files.join(", ") || "no mapped files"}`).join("\n") || "- No modules mapped yet."}
`;
}

export function buildContextMarkdown(context: ConnectorContext) {
  return `# FlowWeave Agent Context

Project: ${context.projectName}
Path: ${context.projectPath}
Generated: ${context.generatedAt}

## Artifacts

- Project JSON: ${context.artifactPaths.projectJson}
- Canvas JSON: ${context.artifactPaths.canvasJson}
- Architecture Map: ${context.artifactPaths.architectureMap}
- Sequence Diagrams: ${context.artifactPaths.sequenceDiagrams}
- File Tree: ${context.artifactPaths.contextFileTree}

## Modules

${context.modules.map((module) => `### ${module.title}

- id: ${module.id}
- type: ${module.nodeType}
- risk: ${module.risk}
- files: ${module.files.join(", ") || "none"}

${module.description}
`).join("\n") || "No modules mapped yet."}

## Relationships

${context.relationships.map((edge) => `- ${edge.source} -> ${edge.target}: ${edge.relation}${edge.guidanceNote ? ` (${edge.guidanceNote})` : ""}`).join("\n") || "- No relationships mapped yet."}
`;
}

export function buildConnectorContext(input: WriteAgentConnectorsInput): ConnectorContext {
  const root = input.project.rootPath;
  return {
    version: 1,
    projectName: input.project.projectName,
    projectPath: root,
    generatedAt: new Date().toISOString(),
    artifactPaths: {
      projectJson: join(root, FLOWWEAVE_DIR, "project.json"),
      canvasJson: input.canvasPath ?? join(root, FLOWWEAVE_DIR, "canvas", "main.canvas.json"),
      architectureMap: join(root, FLOWWEAVE_DIR, "architecture-map.json"),
      sequenceDiagrams: join(root, FLOWWEAVE_DIR, "sequence-diagrams.json"),
      contextFileTree: input.contextFileTreePath ?? join(root, FLOWWEAVE_DIR, "context", "file-tree.md"),
      taskMarkdown: input.taskMarkdownPath,
      taskJson: input.taskJsonPath
    },
    modules: input.modules.map((module) => ({
      id: module.id,
      title: module.title,
      nodeType: module.nodeType,
      risk: module.risk,
      files: module.files,
      description: module.description
    })),
    relationships: input.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      guidanceNote: edge.guidanceNote
    }))
  };
}

function buildAgentConnectorSkillMarkdown(kind: AgentConnectorKind, context: ConnectorContext) {
  return `---
name: flowweave-${kind}-connector
description: Connect ${connectorAgentName(kind)} to the FlowWeave project context for ${context.projectName}
---

# FlowWeave ${connectorAgentName(kind)} Connector

Read ${join(context.projectPath, FLOWWEAVE_DIR, "agent-connectors", `${kind}.md`)} and follow it before analyzing or editing this project.

You may modify project files directly. After edits, report changed files and tell the user to inspect Git diff in FlowWeave.
`;
}

function connectorKinds(): AgentConnectorKind[] {
  return ["codex", "claude", "gemini", "cursor"];
}

function connectorAgentName(kind: AgentConnectorKind) {
  if (kind === "codex") return "Codex";
  if (kind === "claude") return "Claude";
  if (kind === "gemini") return "Gemini";
  return "Cursor";
}

function agentIdForConnectorKind(kind: AgentConnectorKind) {
  if (kind === "codex") return "codex-local" as const;
  if (kind === "claude") return "claude-code" as const;
  if (kind === "gemini") return "gemini-cli" as const;
  return "cursor" as const;
}

async function readJson<T>(filePath: string) {
  const content = await readFile(filePath, "utf8");
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${basename(filePath)}: ${message}`);
  }
}

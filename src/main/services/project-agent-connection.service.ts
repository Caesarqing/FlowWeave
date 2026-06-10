import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type {
  ArchitectureMap,
  CodeflowCanvas,
  CodeflowProject,
  ProjectAgentConnectionConfig,
  ProjectAgentConnectionStatus,
  ProjectAgentPlatform,
  SequenceDiagramBundle
} from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

const FLOWWEAVE_BLOCK_START = "<!-- flowweave:start -->";
const FLOWWEAVE_BLOCK_END = "<!-- flowweave:end -->";
const CONNECTION_CONFIG_FILE = "agent-connection.json";
const AGENT_CONTEXT_FILE = "agent-context.md";
const DEFAULT_PLATFORMS: ProjectAgentPlatform[] = ["codex", "claude", "gemini", "cursor"];
const CURSOR_FRONTMATTER = [
  "---",
  "description: Use FlowWeave project context when analyzing or changing this project",
  "alwaysApply: true",
  "---"
].join("\n");

type ProjectArtifacts = {
  project: CodeflowProject;
  canvas?: CodeflowCanvas;
  architecture?: ArchitectureMap;
  sequences?: SequenceDiagramBundle;
  fileTree?: string;
  taskPaths: string[];
};

type PlatformEntry = {
  platform: ProjectAgentPlatform;
  filePath: string;
};

export async function getProjectAgentConnection(projectPath: string): Promise<ProjectAgentConnectionStatus> {
  const paths = connectionPaths(projectPath);
  const config = await readConnectionConfig(paths.configPath);
  if (!config) {
    return createStatus(projectPath, undefined, "disabled", "External Agent connection has not been configured.");
  }
  if (!config.enabled) {
    return createStatus(projectPath, config, "disabled", "External Agent connection is disabled for this project.");
  }

  const connectionIssue = await findConnectionFileIssue(projectPath, config.platforms);
  if (connectionIssue) {
    return createStatus(projectPath, config, "needs-refresh", connectionIssue);
  }

  const latestSourceTime = await latestArtifactModificationTime(projectPath);
  if (latestSourceTime > Date.parse(config.updatedAt)) {
    return createStatus(projectPath, config, "needs-refresh", "FlowWeave project artifacts changed after the Agent context was generated.");
  }

  return createStatus(projectPath, config, "ready", "Project instructions and FlowWeave Agent context are ready.");
}

export async function enableProjectAgentConnection(projectPath: string): Promise<ProjectAgentConnectionStatus> {
  await requireProjectArtifact(projectPath);
  return writeProjectAgentConnection(projectPath, DEFAULT_PLATFORMS);
}

export async function refreshProjectAgentConnection(projectPath: string): Promise<ProjectAgentConnectionStatus> {
  const config = await readConnectionConfig(connectionPaths(projectPath).configPath);
  if (!config) {
    throw new Error(`Cannot refresh Agent connection for "${projectPath}": the project has not been configured.`);
  }
  if (!config.enabled) {
    throw new Error(`Cannot refresh Agent connection for "${projectPath}": the connection is disabled.`);
  }
  await requireProjectArtifact(projectPath);
  return writeProjectAgentConnection(projectPath, config.platforms);
}

export async function refreshProjectAgentConnectionIfEnabled(projectPath: string): Promise<ProjectAgentConnectionStatus | undefined> {
  const config = await readConnectionConfig(connectionPaths(projectPath).configPath);
  if (!config?.enabled) return undefined;
  return refreshProjectAgentConnection(projectPath);
}

export async function disableProjectAgentConnection(projectPath: string): Promise<ProjectAgentConnectionStatus> {
  const paths = connectionPaths(projectPath);
  const existingConfig = await readConnectionConfig(paths.configPath);
  const platforms = existingConfig?.platforms ?? DEFAULT_PLATFORMS;

  const plannedUpdates = await planManagedBlockRemoval(platformEntries(projectPath, platforms));
  for (const update of plannedUpdates) {
    if (update.content.trim()) {
      await writeTextAtomic(update.filePath, update.content);
    } else {
      await rm(update.filePath, { force: true });
    }
  }
  await rm(paths.contextPath, { force: true });

  const config: ProjectAgentConnectionConfig = {
    version: 1,
    enabled: false,
    platforms,
    updatedAt: new Date().toISOString()
  };
  await writeJsonAtomic(paths.configPath, config);
  return createStatus(projectPath, config, "disabled", "External Agent connection is disabled for this project.");
}

export function getProjectAgentContextPath(projectPath: string) {
  return connectionPaths(projectPath).contextPath;
}

async function writeProjectAgentConnection(
  projectPath: string,
  platforms: ProjectAgentPlatform[]
): Promise<ProjectAgentConnectionStatus> {
  const paths = connectionPaths(projectPath);
  const artifacts = await readProjectArtifacts(projectPath);
  const context = buildAgentContext(projectPath, artifacts);
  const block = buildManagedInstructionBlock();
  const plannedUpdates = await planManagedBlockUpsert(platformEntries(projectPath, platforms), block);

  await writeTextAtomic(paths.contextPath, context);
  for (const update of plannedUpdates) {
    await writeTextAtomic(update.filePath, update.content);
  }

  const config: ProjectAgentConnectionConfig = {
    version: 1,
    enabled: true,
    platforms: [...platforms],
    updatedAt: new Date().toISOString()
  };
  await writeJsonAtomic(paths.configPath, config);
  return createStatus(projectPath, config, "ready", "Project instructions and FlowWeave Agent context are ready.");
}

function connectionPaths(projectPath: string) {
  const flowweavePath = join(projectPath, FLOWWEAVE_DIR);
  return {
    configPath: join(flowweavePath, CONNECTION_CONFIG_FILE),
    contextPath: join(flowweavePath, AGENT_CONTEXT_FILE)
  };
}

function platformEntries(projectPath: string, platforms: ProjectAgentPlatform[]): PlatformEntry[] {
  const entries: Record<ProjectAgentPlatform, string> = {
    codex: join(projectPath, "AGENTS.md"),
    claude: join(projectPath, "CLAUDE.md"),
    gemini: join(projectPath, "GEMINI.md"),
    cursor: join(projectPath, ".cursor", "rules", "flowweave.mdc")
  };
  return platforms.map((platform) => ({ platform, filePath: entries[platform] }));
}

function generatedFilePaths(projectPath: string, platforms: ProjectAgentPlatform[]) {
  return [
    connectionPaths(projectPath).contextPath,
    ...platformEntries(projectPath, platforms).map((entry) => entry.filePath)
  ];
}

function createStatus(
  projectPath: string,
  config: ProjectAgentConnectionConfig | undefined,
  state: ProjectAgentConnectionStatus["state"],
  message: string
): ProjectAgentConnectionStatus {
  const platforms = config?.platforms ?? DEFAULT_PLATFORMS;
  const paths = connectionPaths(projectPath);
  return {
    state,
    enabled: config?.enabled ?? false,
    needsConfirmation: !config,
    projectPath,
    contextPath: paths.contextPath,
    configPath: paths.configPath,
    generatedFiles: generatedFilePaths(projectPath, platforms),
    platforms: [...platforms],
    updatedAt: config?.updatedAt,
    message
  };
}

async function readConnectionConfig(configPath: string): Promise<ProjectAgentConnectionConfig | undefined> {
  const content = await readOptionalText(configPath);
  if (content === undefined) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid FlowWeave Agent connection config at "${configPath}": ${formatError(error)}`);
  }
  if (!isConnectionConfig(value)) {
    throw new Error(`Invalid FlowWeave Agent connection config shape at "${configPath}".`);
  }
  return value;
}

function isConnectionConfig(value: unknown): value is ProjectAgentConnectionConfig {
  if (!isRecord(value)) return false;
  if (value.version !== 1 || typeof value.enabled !== "boolean" || typeof value.updatedAt !== "string") return false;
  if (!Array.isArray(value.platforms)) return false;
  return value.platforms.every((platform) => DEFAULT_PLATFORMS.includes(platform as ProjectAgentPlatform));
}

async function requireProjectArtifact(projectPath: string) {
  const projectPathname = join(projectPath, FLOWWEAVE_DIR, "project.json");
  try {
    await stat(projectPathname);
  } catch (error) {
    throw new Error(`Cannot connect external Agents: required FlowWeave project artifact is missing at "${projectPathname}". ${formatError(error)}`);
  }
}

async function readProjectArtifacts(projectPath: string): Promise<ProjectArtifacts> {
  const root = join(projectPath, FLOWWEAVE_DIR);
  const project = await readRequiredJson<CodeflowProject>(join(root, "project.json"));
  const [canvas, architecture, sequences, fileTree, taskPaths] = await Promise.all([
    readOptionalJson<CodeflowCanvas>(join(root, "canvas", "main.canvas.json")),
    readOptionalJson<ArchitectureMap>(join(root, "architecture-map.json")),
    readOptionalJson<SequenceDiagramBundle>(join(root, "sequence-diagrams.json")),
    readOptionalText(join(root, "context", "file-tree.md")),
    listTaskPaths(join(root, "tasks"), projectPath)
  ]);
  const scanFingerprint = project.scanFingerprint;
  return {
    project,
    canvas: artifactMatchesScan(scanFingerprint, canvas?.scanFingerprint) && canvas?.artifactState !== "stale" ? canvas : undefined,
    architecture: artifactMatchesScan(scanFingerprint, architecture?.metadata?.inputFingerprint) ? architecture : undefined,
    sequences: artifactMatchesScan(scanFingerprint, sequences?.metadata?.inputFingerprint) ? sequences : undefined,
    fileTree,
    taskPaths
  };
}

function artifactMatchesScan(scanFingerprint: string | undefined, artifactFingerprint: string | undefined) {
  return !scanFingerprint || scanFingerprint === artifactFingerprint;
}

function buildAgentContext(projectPath: string, artifacts: ProjectArtifacts) {
  const lines = [
    "# FlowWeave Agent Context",
    "",
    `Project: ${artifacts.project.projectName}`,
    `Project root: ${projectPath}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Agent Instructions",
    "",
    "- Treat FlowWeave artifacts as navigation context, then verify important claims against the source code.",
    "- Read source files needed for the user's request. Do not invent files, symbols, calls, or behavior.",
    "- You may modify project files when the user asks you to implement a change.",
    "- After modifying files, report the changed file paths and the verification you ran.",
    "- Ask the user to return to FlowWeave to review Git diff, refresh the project scan, or rollback when needed.",
    "- When asked to process the current FlowWeave pending request, inspect `.flowweave/agent-bridge/*/request.json`, choose the newest request without a response, and follow its `instructionsPath`.",
    "",
    "## FlowWeave Artifacts",
    "",
    "- Project scan: `.flowweave/project.json`",
    "- Canvas: `.flowweave/canvas/main.canvas.json`",
    "- File tree: `.flowweave/context/file-tree.md`",
    `- Architecture map: ${artifacts.architecture ? "`.flowweave/architecture-map.json`" : "not generated"}`,
    `- Sequence diagrams: ${artifacts.sequences ? "`.flowweave/sequence-diagrams.json`" : "not generated"}`,
    `- Tasks: ${artifacts.taskPaths.length > 0 ? artifacts.taskPaths.map((path) => `\`${path}\``).join(", ") : "none"}`,
    "",
    "## Project Snapshot",
    "",
    `- Files: ${artifacts.project.summary.totalFiles}`,
    `- Folders: ${artifacts.project.summary.totalFolders}`,
    `- Languages: ${formatLanguages(artifacts.project.summary.languages)}`,
    `- Git branch: ${artifacts.project.git.branch ?? "unknown"}`,
    ""
  ];

  appendCanvasSummary(lines, artifacts.canvas);
  appendArchitectureSummary(lines, artifacts.architecture);
  appendSequenceSummary(lines, artifacts.sequences);
  if (artifacts.fileTree) {
    lines.push("## File Tree", "", artifacts.fileTree.trim(), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

function appendCanvasSummary(lines: string[], canvas: CodeflowCanvas | undefined) {
  if (!canvas) return;
  lines.push("## Canvas Modules", "");
  for (const node of canvas.nodes) {
    const files = node.files.length > 0 ? ` Files: ${node.files.join(", ")}.` : "";
    lines.push(`- ${node.title} (${node.nodeType}): ${node.description || node.role || "No description."}${files}`);
  }
  lines.push("", "## Canvas Relationships", "");
  for (const edge of canvas.edges) {
    lines.push(`- ${edge.source} --${edge.relation}--> ${edge.target}${edge.guidanceNote ? `: ${edge.guidanceNote}` : ""}`);
  }
  lines.push("");
}

function appendArchitectureSummary(lines: string[], architecture: ArchitectureMap | undefined) {
  if (!architecture) return;
  lines.push("## Architecture Modules", "");
  for (const module of architecture.modules) {
    lines.push(`- ${module.title} (${module.category}): ${module.role}. Files: ${module.files.join(", ") || "none"}.`);
  }
  lines.push("", "## Architecture Relationships", "");
  for (const relationship of architecture.relationships) {
    lines.push(`- ${relationship.source} --${relationship.relation}--> ${relationship.target}: ${relationship.description}`);
  }
  lines.push("");
}

function appendSequenceSummary(lines: string[], sequences: SequenceDiagramBundle | undefined) {
  if (!sequences) return;
  lines.push(
    "## Sequence Diagrams",
    "",
    `- Architectural: ${sequences.architectural.title}. ${sequences.architectural.summary}`,
    `- Detailed design: ${sequences.detailedDesign.title}. ${sequences.detailedDesign.summary}`,
    ""
  );
}

function buildManagedInstructionBlock() {
  return [
    FLOWWEAVE_BLOCK_START,
    "## FlowWeave Project Context",
    "",
    "Before analyzing or changing this project, read `.flowweave/agent-context.md`.",
    "Use it as navigation context, verify behavior against source code, and report changed files after edits.",
    "When the user says `使用 FlowWeave 上下文处理当前待办`, process the newest pending request under `.flowweave/agent-bridge` and write the required response atomically.",
    FLOWWEAVE_BLOCK_END
  ].join("\n");
}

async function planManagedBlockUpsert(entries: PlatformEntry[], block: string) {
  return Promise.all(entries.map(async (entry) => {
    const existing = await readOptionalText(entry.filePath) ?? "";
    const content = entry.platform === "cursor" && !existing.trim()
      ? `${CURSOR_FRONTMATTER}\n\n${block}\n`
      : upsertManagedBlock(existing, block, entry.filePath);
    return { filePath: entry.filePath, content };
  }));
}

async function planManagedBlockRemoval(entries: PlatformEntry[]) {
  const updates: Array<{ filePath: string; content: string }> = [];
  for (const entry of entries) {
    const existing = await readOptionalText(entry.filePath);
    if (existing === undefined) continue;
    let content = removeManagedBlock(existing, entry.filePath);
    if (entry.platform === "cursor" && content.trim() === CURSOR_FRONTMATTER) {
      content = "";
    }
    updates.push({ filePath: entry.filePath, content });
  }
  return updates;
}

export function upsertManagedBlock(existing: string, block: string, filePath: string) {
  const range = findManagedBlock(existing, filePath);
  if (!range) {
    return existing.trim()
      ? `${existing.trimEnd()}\n\n${block}\n`
      : `${block}\n`;
  }
  return `${existing.slice(0, range.start)}${block}${existing.slice(range.end)}`.trimEnd() + "\n";
}

export function removeManagedBlock(existing: string, filePath: string) {
  const range = findManagedBlock(existing, filePath);
  if (!range) return existing;
  const before = existing.slice(0, range.start).trimEnd();
  const after = existing.slice(range.end).trimStart();
  if (before && after) return `${before}\n\n${after}`.trimEnd() + "\n";
  return `${before}${after}`.trimEnd() + (before || after ? "\n" : "");
}

function findManagedBlock(content: string, filePath: string): { start: number; end: number } | undefined {
  const starts = markerIndexes(content, FLOWWEAVE_BLOCK_START);
  const ends = markerIndexes(content, FLOWWEAVE_BLOCK_END);
  if (starts.length === 0 && ends.length === 0) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || starts[0] > ends[0]) {
    throw new Error(
      `FlowWeave managed block markers are malformed or duplicated in "${filePath}". ` +
      `Expected exactly one "${FLOWWEAVE_BLOCK_START}" followed by one "${FLOWWEAVE_BLOCK_END}".`
    );
  }
  return {
    start: starts[0],
    end: ends[0] + FLOWWEAVE_BLOCK_END.length
  };
}

function markerIndexes(content: string, marker: string) {
  const indexes: number[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const index = content.indexOf(marker, cursor);
    if (index === -1) break;
    indexes.push(index);
    cursor = index + marker.length;
  }
  return indexes;
}

async function latestArtifactModificationTime(projectPath: string) {
  const root = join(projectPath, FLOWWEAVE_DIR);
  const paths = [
    join(root, "project.json"),
    join(root, "canvas", "main.canvas.json"),
    join(root, "architecture-map.json"),
    join(root, "sequence-diagrams.json"),
    join(root, "context", "file-tree.md")
  ];
  const times = await Promise.all(paths.map(async (filePath) => {
    try {
      return (await stat(filePath)).mtimeMs;
    } catch (error) {
      if (isMissingFileError(error)) return 0;
      throw error;
    }
  }));
  return Math.max(...times);
}

async function findConnectionFileIssue(projectPath: string, platforms: ProjectAgentPlatform[]) {
  const contextPath = connectionPaths(projectPath).contextPath;
  if (await readOptionalText(contextPath) === undefined) {
    return `Connection file is missing: ${contextPath}`;
  }
  for (const entry of platformEntries(projectPath, platforms)) {
    const content = await readOptionalText(entry.filePath);
    if (content === undefined) return `Connection file is missing: ${entry.filePath}`;
    if (!findManagedBlock(content, entry.filePath)) {
      return `FlowWeave managed instructions are missing from: ${entry.filePath}`;
    }
    if (entry.platform === "cursor" && !content.includes("alwaysApply: true")) {
      return `Cursor FlowWeave rule is not configured as an automatic project rule: ${entry.filePath}`;
    }
  }
  return undefined;
}

async function listTaskPaths(tasksPath: string, projectPath: string) {
  try {
    const entries = await readdir(tasksPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && (entry.name === "current.task.md" || entry.name === "current.task.json"))
      .map((entry) => relative(projectPath, join(tasksPath, entry.name)))
      .sort();
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw new Error(`Reading FlowWeave task artifacts failed at "${tasksPath}": ${formatError(error)}`);
  }
}

async function readRequiredJson<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, "utf8");
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in FlowWeave artifact "${filePath}": ${formatError(error)}`);
  }
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  const content = await readOptionalText(filePath);
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in FlowWeave artifact "${filePath}": ${formatError(error)}`);
  }
}

async function readOptionalText(filePath: string) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw new Error(`Reading "${filePath}" failed: ${formatError(error)}`);
  }
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(filePath: string, content: string) {
  const parentPath = dirname(filePath);
  await mkdir(parentPath, { recursive: true });
  const temporaryPath = join(parentPath, `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new Error(`Writing FlowWeave Agent connection file "${filePath}" failed: ${formatError(error)}`);
  }
}

function formatLanguages(languages: Record<string, number>) {
  const entries = Object.entries(languages).sort((left, right) => right[1] - left[1]);
  return entries.length > 0 ? entries.map(([language, count]) => `${language} (${count})`).join(", ") : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error: unknown) {
  return isRecord(error) && error.code === "ENOENT";
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

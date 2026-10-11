import { createHash } from "node:crypto";
import { readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type {
  CodeflowProject,
  CodeflowTask,
  GenerationIdentity,
  ProjectAgentConnectionConfig,
  ProjectAgentConnectionStatus,
  ProjectAgentPlatform
} from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { assertSafeProjectWritePath, writeProjectTextAtomic } from "../storage/project-write-guard";
import { readProjectProtocolCanvas, readProjectProtocolOverview, readProjectProtocolSnapshot } from "../storage/flowweave-store";
import { withArchitectureArtifactLock } from "./architecture-review.service";
import { buildAgentProtocolContextInstructions } from "./agent-protocol.service";
import { readSequenceDiagrams } from "./sequence-diagram.service";
import { ArtifactGenerationMismatchError } from "./generation-errors";
import { readCommittedGeneration } from "./project-generation.service";

const FLOWWEAVE_BLOCK_START = "<!-- flowweave:start -->";
const FLOWWEAVE_BLOCK_END = "<!-- flowweave:end -->";
const CONNECTION_CONFIG_FILE = "agent-connection.json";
const AGENT_CONTEXT_FILE = "agent-context.md";
const DEFAULT_PLATFORMS: ProjectAgentPlatform[] = ["codex", "claude", "gemini", "cursor"];
const AGENT_PROTOCOL_VERSION = 2;
const CURSOR_FRONTMATTER = [
  "---",
  "description: Use FlowWeave project context when analyzing or changing this project",
  "alwaysApply: true",
  "---"
].join("\n");

type ProjectArtifacts = {
  project: CodeflowProject;
  artifactSchemas: ArtifactSchema[];
  taskPaths: string[];
};

type ArtifactSchema = {
  path: string;
  schemaVersion: number;
};

type AgentContextInput = {
  projectPath: string;
  artifacts: ProjectArtifacts;
  managedBlock: string;
  contextFingerprint: string;
};

type PlatformEntry = {
  platform: ProjectAgentPlatform;
  filePath: string;
};

export async function getProjectAgentConnection(projectPath: string): Promise<ProjectAgentConnectionStatus> {
  return getProjectAgentConnectionStatus(projectPath, undefined);
}

export async function getProjectAgentConnectionForPlatform(
  projectPath: string,
  platform: ProjectAgentPlatform
): Promise<ProjectAgentConnectionStatus> {
  return getProjectAgentConnectionStatus(projectPath, platform);
}

async function getProjectAgentConnectionStatus(
  projectPath: string,
  platform: ProjectAgentPlatform | undefined
): Promise<ProjectAgentConnectionStatus> {
  const paths = connectionPaths(projectPath);
  const config = await readConnectionConfig(paths.configPath);
  if (!config) {
    return createStatus(projectPath, undefined, "disabled", "External Agent connection has not been configured.", []);
  }
  if (!config.enabled) {
    return createStatus(projectPath, config, "disabled", "External Agent connection is disabled for this project.", []);
  }

  if (platform && !config.platforms.includes(platform)) {
    const filePath = platformEntries(projectPath, [platform])[0]?.filePath;
    return createStatus(
      projectPath,
      config,
      "disabled",
      `External Agent connection is not configured for ${platform}.`,
      filePath ? [filePath] : []
    );
  }

  const platformsToCheck = platform ? [platform] : config.platforms;
  const contextInput = await createAgentContextInput(projectPath);
  const connectionIssue = await findConnectionFileIssue(contextInput, platformsToCheck);
  if (connectionIssue) {
    return createStatus(projectPath, config, "needs-refresh", connectionIssue.message, [connectionIssue.filePath]);
  }
  if (config.contextFingerprint !== contextInput.contextFingerprint) {
    return createStatus(
      projectPath,
      config,
      "needs-refresh",
      "FlowWeave Agent context inputs changed after the connection was generated.",
      [paths.contextPath]
    );
  }

  return createStatus(projectPath, config, "ready", "Project instructions and FlowWeave Agent context are ready.", []);
}

export async function enableProjectAgentConnection(projectPath: string): Promise<ProjectAgentConnectionStatus> {
  await requireProjectArtifact(projectPath);
  return writeProjectAgentConnection(projectPath, DEFAULT_PLATFORMS, DEFAULT_PLATFORMS);
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
  return writeProjectAgentConnection(projectPath, config.platforms, config.platforms);
}

export async function refreshProjectAgentConnectionForPlatform(
  projectPath: string,
  platform: ProjectAgentPlatform
): Promise<ProjectAgentConnectionStatus> {
  const config = await readConnectionConfig(connectionPaths(projectPath).configPath);
  if (!config) {
    throw new Error(`Cannot refresh Agent connection for "${projectPath}": the project has not been configured.`);
  }
  if (!config.enabled) {
    throw new Error(`Cannot refresh Agent connection for "${projectPath}": the connection is disabled.`);
  }
  if (!config.platforms.includes(platform)) {
    throw new Error(`Cannot refresh Agent connection for "${projectPath}": ${platform} is not an enabled project platform.`);
  }
  await requireProjectArtifact(projectPath);
  return writeProjectAgentConnection(projectPath, config.platforms, [platform]);
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
  await Promise.all([
    ...plannedUpdates.map((update) => assertSafeProjectWritePath(projectPath, update.filePath)),
    assertSafeProjectWritePath(projectPath, paths.contextPath),
    assertSafeProjectWritePath(projectPath, paths.configPath)
  ]);
  for (const update of plannedUpdates) {
    if (update.content.trim()) {
      await writeProjectTextAtomic(projectPath, update.filePath, update.content);
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
  await writeProjectTextAtomic(projectPath, paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
  return createStatus(projectPath, config, "disabled", "External Agent connection is disabled for this project.", []);
}

export function getProjectAgentContextPath(projectPath: string) {
  return connectionPaths(projectPath).contextPath;
}

async function writeProjectAgentConnection(
  projectPath: string,
  configuredPlatforms: ProjectAgentPlatform[],
  platformsToWrite: ProjectAgentPlatform[]
): Promise<ProjectAgentConnectionStatus> {
  const paths = connectionPaths(projectPath);
  const contextInput = await createAgentContextInput(projectPath);
  const context = buildAgentContext(contextInput);
  const plannedUpdates = await planManagedBlockUpsert(platformEntries(projectPath, platformsToWrite), contextInput.managedBlock);

  await Promise.all([
    ...plannedUpdates.map((update) => assertSafeProjectWritePath(projectPath, update.filePath)),
    assertSafeProjectWritePath(projectPath, paths.contextPath),
    assertSafeProjectWritePath(projectPath, paths.configPath)
  ]);
  await writeProjectTextAtomic(projectPath, paths.contextPath, context);
  for (const update of plannedUpdates) {
    await writeProjectTextAtomic(projectPath, update.filePath, update.content);
  }

  const config: ProjectAgentConnectionConfig = {
    version: 1,
    enabled: true,
    platforms: [...configuredPlatforms],
    updatedAt: new Date().toISOString(),
    contextFingerprint: contextInput.contextFingerprint
  };
  await writeProjectTextAtomic(projectPath, paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
  const connectionIssue = await findConnectionFileIssue(contextInput, platformsToWrite);
  if (connectionIssue) {
    throw new Error(`FlowWeave Agent connection verification failed: ${connectionIssue.message}`);
  }
  return createStatus(projectPath, config, "ready", "Project instructions and FlowWeave Agent context are ready.", []);
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
  message: string,
  missingFiles: string[]
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
    missingFiles,
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
  if (await readProjectProtocolSnapshot(projectPath)) return;
  const snapshotPath = join(projectPath, FLOWWEAVE_DIR, "static-snapshot.json");
  throw new Error(`Cannot connect external Agents before FlowWeave protocol v7 is committed. Missing or unverified snapshot at "${snapshotPath}".`);
}

async function readProjectArtifacts(projectPath: string): Promise<ProjectArtifacts> {
  const root = join(projectPath, FLOWWEAVE_DIR);
  const core = await withArchitectureArtifactLock(projectPath, async () => {
    const [snapshot, overview, canvas] = await Promise.all([
      readProjectProtocolSnapshot(projectPath),
      readProjectProtocolOverview(projectPath),
      readProjectProtocolCanvas(projectPath)
    ]);
    if (!snapshot || !overview || !canvas) throw new Error(`Cannot build Agent context before FlowWeave protocol v7 is committed: ${projectPath}`);
    return {
      project: snapshot.project,
      artifactSchemas: [
        { path: ".flowweave/static-snapshot.json", schemaVersion: snapshot.schemaVersion },
        { path: ".flowweave/graph-overview.json", schemaVersion: overview.schemaVersion },
        { path: ".flowweave/canvas/user-state.json", schemaVersion: 1 }
      ]
    };
  });

  const [sequence, taskPaths] = await Promise.all([
    readCurrentSequence(projectPath, core.project.generation),
    listTaskPaths(join(root, "tasks"), projectPath, core.project)
  ]);
  await withArchitectureArtifactLock(projectPath, async () => {
    const currentGeneration = await readCommittedGeneration(projectPath);
    if (!sameGeneration(core.project.generation, currentGeneration)) {
      throw new ArtifactGenerationMismatchError(projectPath, "Agent context", core.project.generation, currentGeneration);
    }
  });
  const artifactSchemas = sequence
    ? [...core.artifactSchemas, { path: ".flowweave/sequence-diagrams.json", schemaVersion: sequence.version }]
    : core.artifactSchemas;
  return { project: core.project, artifactSchemas, taskPaths };
}

async function readCurrentSequence(projectPath: string, generation: GenerationIdentity | undefined) {
  let bundle: Awaited<ReturnType<typeof readSequenceDiagrams>>;
  try {
    bundle = await readSequenceDiagrams(projectPath);
  } catch (error) {
    if (error instanceof ArtifactGenerationMismatchError) return undefined;
    throw error;
  }
  if (!bundle || !sameGeneration(generation, bundle.generation)) return undefined;
  return bundle;
}

function sameGeneration(left: GenerationIdentity | undefined, right: GenerationIdentity | undefined) {
  return Boolean(left && right && left.requestId === right.requestId && left.inputFingerprint === right.inputFingerprint);
}

function isGenerationIdentity(value: unknown): value is GenerationIdentity {
  return isRecord(value) && typeof value.requestId === "string" && typeof value.inputFingerprint === "string";
}

async function createAgentContextInput(projectPath: string): Promise<AgentContextInput> {
  const resolvedProjectPath = await realpath(projectPath);
  const artifacts = await readProjectArtifacts(projectPath);
  const managedBlock = buildManagedInstructionBlock();
  const contextFingerprint = contentHash(JSON.stringify({
    projectPath: resolvedProjectPath,
    scanFingerprint: artifacts.project.scanFingerprint ?? "unavailable",
    protocolVersion: AGENT_PROTOCOL_VERSION,
    artifactSchemas: artifacts.artifactSchemas,
    managedBlockHash: contentHash(managedBlock)
  }));
  return { projectPath, artifacts, managedBlock, contextFingerprint };
}

function buildAgentContext(input: AgentContextInput) {
  const { artifacts, contextFingerprint, projectPath } = input;
  const lines = [
    "# FlowWeave Agent Context",
    "",
    `Project: ${artifacts.project.projectName}`,
    `Project root: ${projectPath}`,
    `Scan fingerprint: ${artifacts.project.scanFingerprint ?? "unavailable"}`,
    `Protocol version: ${AGENT_PROTOCOL_VERSION}`,
    `Context fingerprint: ${contextFingerprint}`,
    "",
    "## Agent Instructions",
    "",
    "- Treat FlowWeave artifacts as navigation context, then verify important claims against the source code.",
    "- Read only the request and artifact paths needed for the current task.",
    "",
    ...buildAgentProtocolContextInstructions(),
    "## FlowWeave Artifacts",
    "",
    ...artifacts.artifactSchemas.map((artifact) => `- ${artifact.path} (schema v${artifact.schemaVersion})`),
    `- Active tasks: ${artifacts.taskPaths.length > 0 ? artifacts.taskPaths.map((path) => `\`${path}\``).join(", ") : "none"}`,
    ""
  ];
  return `${lines.join("\n").trim()}\n`;
}

function buildManagedInstructionBlock() {
  return [
    FLOWWEAVE_BLOCK_START,
    "## FlowWeave Project Context",
    "",
    "Before analyzing or changing this project, read `.flowweave/agent-context.md`.",
    "Use it as navigation context, verify behavior against source code, and report changed files after edits.",
    "When the user says `Use FlowWeave context to process the Agent Inbox.` or `使用 FlowWeave 上下文处理当前 Inbox`, read the exact run-specific `.flowweave/runs/<run-id>/agent-request.json` path supplied by FlowWeave and write one Agent Inbox v2 `agent-response.json` with `protocolVersion: 2` atomically to the exact `responsePath` in that request.",
    "For artifact-analysis requests, `response.content` must be the exact structured artifact JSON requested by `request.prompt`, not an approval summary or markdown plan.",
    "Do not edit `.flowweave/architecture-review.json` or `.flowweave/sequence-review.json`; FlowWeave Core validates responses and updates review state.",
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

function contentHash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

async function findConnectionFileIssue(
  input: AgentContextInput,
  platforms: ProjectAgentPlatform[]
): Promise<{ message: string; filePath: string } | undefined> {
  const { contextFingerprint, managedBlock, projectPath } = input;
  const contextPath = connectionPaths(projectPath).contextPath;
  const context = await readOptionalText(contextPath);
  if (context === undefined) {
    return { message: `Connection file is missing: ${contextPath}`, filePath: contextPath };
  }
  const contextRoot = /^Project root:\s*(.+)$/m.exec(context)?.[1]?.trim();
  if (contextRoot !== projectPath) {
    return {
      message: `FlowWeave Agent context root is stale: expected "${projectPath}" but found "${contextRoot ?? "unknown"}".`,
      filePath: contextPath
    };
  }
  if (!context.includes(`Protocol version: ${AGENT_PROTOCOL_VERSION}`) || !context.includes(`Agent Inbox Protocol v${AGENT_PROTOCOL_VERSION}`)) {
    return { message: `FlowWeave Agent context protocol is stale: ${contextPath}`, filePath: contextPath };
  }
  if (!context.includes(`Context fingerprint: ${contextFingerprint}`)) {
    return { message: `FlowWeave Agent context fingerprint is stale: ${contextPath}`, filePath: contextPath };
  }
  if (!context.includes("runs/<run-id>/agent-request.json")) {
    return { message: `FlowWeave Agent context is missing Agent Inbox instructions: ${contextPath}`, filePath: contextPath };
  }
  for (const entry of platformEntries(projectPath, platforms)) {
    const content = await readOptionalText(entry.filePath);
    if (content === undefined) return { message: `Connection file is missing: ${entry.filePath}`, filePath: entry.filePath };
    let block: { start: number; end: number } | undefined;
    try {
      block = findManagedBlock(content, entry.filePath);
    } catch (error) {
      return { message: formatError(error), filePath: entry.filePath };
    }
    if (!block) {
      return { message: `FlowWeave managed instructions are missing from: ${entry.filePath}`, filePath: entry.filePath };
    }
    const managedContent = content.slice(block.start, block.end);
    if (managedContent !== managedBlock) {
      return { message: `FlowWeave managed instructions are stale in: ${entry.filePath}`, filePath: entry.filePath };
    }
    if (entry.platform === "cursor" && !content.includes("alwaysApply: true")) {
      return { message: `Cursor FlowWeave rule is not configured as an automatic project rule: ${entry.filePath}`, filePath: entry.filePath };
    }
  }
  return undefined;
}

async function listTaskPaths(tasksPath: string, projectPath: string, project: CodeflowProject) {
  try {
    const entries = await readdir(tasksPath, { withFileTypes: true });
    if (!entries.some((entry) => entry.isFile() && entry.name === "current.task.json")) return [];
    const taskPath = join(tasksPath, "current.task.json");
    const content = await readOptionalText(taskPath);
    if (content === undefined) return [];
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch (error) {
      throw new Error(`Invalid JSON in FlowWeave task artifact "${taskPath}": ${formatError(error)}`);
    }
    if (!isCurrentTask(value, project)) return [];
    return [relative(projectPath, taskPath).split(sep).join("/")];
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw new Error(`Reading FlowWeave task artifacts failed at "${tasksPath}": ${formatError(error)}`);
  }
}

function isCurrentTask(value: unknown, project: CodeflowProject): value is CodeflowTask {
  if (!isRecord(value) || value.version !== 2 || value.artifactState !== "current") return false;
  if (value.inputFingerprint !== project.scanFingerprint) return false;
  return isGenerationIdentity(project.generation) && isGenerationIdentity(value.generation) && sameGeneration(project.generation, value.generation);
}

async function readOptionalText(filePath: string) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw new Error(`Reading "${filePath}" failed: ${formatError(error)}`);
  }
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

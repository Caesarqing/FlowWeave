import { dialog, shell, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_CHANNELS } from "../../common/ipc-channels";
import type {
  AnalysisOperation,
  AnalysisProgressUpdate,
  ActivePage,
  ArchitectureReviewEvent,
  CodeflowCanvas,
  ProjectArtifactState,
  ProjectArtifactStatuses,
  ProjectScanOptions,
  RuntimeAgentId,
  SequenceReviewEvent,
  ModificationAcknowledgementScope,
  ModificationSnapshot,
  ProjectWorkspaceSession
} from "../../types";
import { analyzeArchitecture, readArchitectureMap } from "../services/architecture-analysis.service";
import {
  isArchitectureReviewActive,
  readArchitectureReviewStatus
} from "../services/architecture-review.service";
import {
  isSequenceReviewActive,
  readSequenceReviewStatus
} from "../services/sequence-review.service";
import {
  disableProjectAgentConnection,
  enableProjectAgentConnection,
  getProjectAgentConnection,
  getProjectAgentContextPath,
  refreshProjectAgentConnection,
  refreshProjectAgentConnectionIfEnabled
} from "../services/project-agent-connection.service";
import {
  listRegisteredProjects,
  readProjectWorkspaceSession,
  registerProject,
  resolveProjectFile,
  resolveProjectPath,
  restoreRegisteredProject,
  saveProjectWorkspaceSession
} from "../services/project-registry.service";
import { scanProject } from "../services/project-scanner.service";
import { buildSemanticIndex } from "../services/semantic-index.service";
import { assessModules } from "../../utils/module-assessment";
import { generateSequenceDiagrams, readSequenceDiagrams, reviseSequenceDiagram } from "../services/sequence-diagram.service";
import { inferGraphFromProject } from "../services/task-generator.service";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { writeFlowWeaveProject } from "../storage/flowweave-store";
import { writeJsonAtomic } from "../storage/artifact-store";
import { optionalTrimmedString, requireEnum, requireInteger, requireObject, requireSafeId, requireString, requireStringArray } from "./ipc-validation";
import { finishOperation, startOperation, updateOperation } from "../services/operation.service";
import { exportDiagnostics, recordDiagnostic } from "../services/diagnostic.service";
import { writeModificationDocs } from "../services/modification-doc.service";
import {
  acknowledgeModificationChanges,
  readModificationDelta
} from "../services/modification-delta.service";
import { handleIpc } from "./ipc-handler";
import { readRunArtifact } from "../services/run-log.service";

const TOOL_IDS = ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"] as const;
const WORKSPACE_PAGES: ActivePage[] = ["canvas", "structure", "docs", "git-review", "tools"];

export function registerProjectIpc() {
  handleIpc(PROJECT_CHANNELS.openProject, async (event, options: unknown) => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open project in FlowWeave" });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    const projectId = await registerProject(result.filePaths[0]);
    return scanAndPersistProject(projectId, event.sender, requireScanOptions(PROJECT_CHANNELS.openProject, options));
  });

  handleIpc(PROJECT_CHANNELS.listRegisteredProjects, async () => listRegisteredProjects());

  handleIpc(PROJECT_CHANNELS.restoreRegisteredProject, async (event, projectId: unknown, options: unknown) => {
    const safeProjectId = requireString(PROJECT_CHANNELS.restoreRegisteredProject, projectId, "projectId");
    await restoreRegisteredProject(safeProjectId);
    return scanAndPersistProject(
      safeProjectId,
      event.sender,
      requireScanOptions(PROJECT_CHANNELS.restoreRegisteredProject, options)
    );
  });

  handleIpc(PROJECT_CHANNELS.readWorkspaceSession, async () => readProjectWorkspaceSession());

  handleIpc(PROJECT_CHANNELS.saveWorkspaceSession, async (_event, session: unknown) => {
    await saveProjectWorkspaceSession(requireProjectWorkspaceSession(PROJECT_CHANNELS.saveWorkspaceSession, session));
  });

  handleIpc(PROJECT_CHANNELS.scanProject, (event, projectId: unknown, options: unknown) =>
    scanAndPersistProject(
      requireString(PROJECT_CHANNELS.scanProject, projectId, "projectId"),
      event.sender,
      requireScanOptions(PROJECT_CHANNELS.scanProject, options)
    ));

  handleIpc(PROJECT_CHANNELS.analyzeArchitectureWithAgent, (event, projectId: unknown, agentId: unknown) =>
    analyzeArchitectureForProject(
      requireString(PROJECT_CHANNELS.analyzeArchitectureWithAgent, projectId, "projectId"),
      requireRuntimeAgentId(PROJECT_CHANNELS.analyzeArchitectureWithAgent, agentId),
      event.sender
    ));

  handleIpc(PROJECT_CHANNELS.readArchitectureMap, (_event, projectId: unknown) =>
    readArchitectureMap(resolveProjectPath(requireString(PROJECT_CHANNELS.readArchitectureMap, projectId, "projectId"))));

  handleIpc(PROJECT_CHANNELS.generateSequenceDiagrams, (event, projectId: unknown, agentId: unknown) =>
    generateSequenceDiagramsForProject(
      requireString(PROJECT_CHANNELS.generateSequenceDiagrams, projectId, "projectId"),
      requireRuntimeAgentId(PROJECT_CHANNELS.generateSequenceDiagrams, agentId),
      event.sender
    ));

  handleIpc(PROJECT_CHANNELS.reviseSequenceDiagram, (event, projectId: unknown, agentId: unknown, instruction: unknown) =>
    reviseSequenceDiagramForProject(
      requireString(PROJECT_CHANNELS.reviseSequenceDiagram, projectId, "projectId"),
      requireRuntimeAgentId(PROJECT_CHANNELS.reviseSequenceDiagram, agentId),
      requireString(PROJECT_CHANNELS.reviseSequenceDiagram, instruction, "instruction"),
      event.sender
    ));

  handleIpc(PROJECT_CHANNELS.readSequenceDiagrams, (_event, projectId: unknown) =>
    readSequenceDiagrams(resolveProjectPath(requireString(PROJECT_CHANNELS.readSequenceDiagrams, projectId, "projectId"))));

  handleIpc(PROJECT_CHANNELS.readFile, async (_event, projectId: unknown, filePath: unknown) => {
    const requestedPath = requireString(PROJECT_CHANNELS.readFile, filePath, "filePath");
    return readOptionalProjectTextFile(
      await resolveProjectFile(
        requireString(PROJECT_CHANNELS.readFile, projectId, "projectId"),
        requestedPath
      ),
      requestedPath
    );
  });

  handleIpc(PROJECT_CHANNELS.saveDoc, async (_event, projectId: unknown, docId: unknown, content: unknown) => {
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.saveDoc, projectId, "projectId"));
    const safeDocId = requireSafeId(PROJECT_CHANNELS.saveDoc, docId, "docId");
    const docsDir = join(projectPath, FLOWWEAVE_DIR, "docs");
    await mkdir(docsDir, { recursive: true });
    const docPath = join(docsDir, `${safeDocId}.md`);
    await writeFile(docPath, requireString(PROJECT_CHANNELS.saveDoc, content, "content"), "utf8");
    return docPath;
  });

  handleIpc(PROJECT_CHANNELS.saveModificationDocs, (_event, projectId: unknown, sequenceInstruction: unknown) =>
    writeModificationDocs(
      resolveProjectPath(requireString(PROJECT_CHANNELS.saveModificationDocs, projectId, "projectId")),
      {
        sequenceInstruction: optionalTrimmedString(
          PROJECT_CHANNELS.saveModificationDocs,
          sequenceInstruction,
          "sequenceInstruction"
        )
      }
    ));

  handleIpc(PROJECT_CHANNELS.readModificationDelta, (_event, projectId: unknown, sequenceInstruction: unknown, canvas: unknown) => {
    const value = canvas === undefined
      ? undefined
      : requireCanvasV4(PROJECT_CHANNELS.readModificationDelta, canvas);
    return readModificationDelta(
      resolveProjectPath(requireString(PROJECT_CHANNELS.readModificationDelta, projectId, "projectId")),
      optionalTrimmedString(
        PROJECT_CHANNELS.readModificationDelta,
        sequenceInstruction,
        "sequenceInstruction"
      ) ?? "",
      value
    );
  });

  handleIpc(PROJECT_CHANNELS.acknowledgeModificationChanges, (_event, projectId: unknown, snapshot: unknown, scope: unknown) =>
    acknowledgeModificationChanges(
      resolveProjectPath(requireString(PROJECT_CHANNELS.acknowledgeModificationChanges, projectId, "projectId")),
      requireModificationSnapshot(PROJECT_CHANNELS.acknowledgeModificationChanges, snapshot),
      requireModificationAcknowledgementScope(PROJECT_CHANNELS.acknowledgeModificationChanges, scope)
    ));

  handleIpc(PROJECT_CHANNELS.readCanvas, async (_event, projectId: unknown) => {
    const result = await readCanvasArtifactState(resolveProjectPath(requireString(PROJECT_CHANNELS.readCanvas, projectId, "projectId")));
    if (result.state === "failed") {
      throw new Error(`FlowWeave Canvas is unreadable and was preserved: ${result.error}`);
    }
    return result.state === "loaded" ? result.canvas : undefined;
  });

  handleIpc(PROJECT_CHANNELS.saveCanvas, async (_event, projectId: unknown, canvas: unknown, options: unknown) => {
    const safeProjectId = requireString(PROJECT_CHANNELS.saveCanvas, projectId, "projectId");
    const projectPath = resolveProjectPath(safeProjectId);
    const value = requireCanvasV4(PROJECT_CHANNELS.saveCanvas, canvas);
    const saveOptions = options === undefined
      ? { allowStaleNoop: false }
      : requireObject(PROJECT_CHANNELS.saveCanvas, options, "options") as { allowStaleNoop?: unknown };
    if (value.artifactState !== "current") {
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Only a current Canvas v4 can be saved.`);
    }
    for (const node of value.nodes) {
      const override = node.assessment?.risk.override;
      if (override && !override.reason.trim()) {
        throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Risk override for "${node.id}" requires a reason.`);
      }
    }
    const projectArtifact = JSON.parse(
      await readFile(join(projectPath, FLOWWEAVE_DIR, "project.json"), "utf8")
    ) as { scanFingerprint?: string };
    const canvasPath = join(projectPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
    if (!value.scanFingerprint || value.scanFingerprint !== projectArtifact.scanFingerprint) {
      if (saveOptions.allowStaleNoop === true) return canvasPath;
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Canvas scan fingerprint is stale.`);
    }
    await mkdir(join(projectPath, FLOWWEAVE_DIR, "canvas"), { recursive: true });
    const temporaryPath = `${canvasPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ ...value, projectPath }, null, 2)}\n`, "utf8");
      await rename(temporaryPath, canvasPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    await refreshConnectionWithoutFailing(safeProjectId, projectPath);
    return canvasPath;
  });

  handleIpc(PROJECT_CHANNELS.exportDiagnostics, (_event, projectId: unknown) =>
    exportDiagnostics(resolveProjectPath(
      requireString(PROJECT_CHANNELS.exportDiagnostics, projectId, "projectId")
    )));

  handleIpc(PROJECT_CHANNELS.getAgentConnection, (_event, projectId: unknown) =>
    getProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.getAgentConnection, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.enableAgentConnection, (_event, projectId: unknown) =>
    enableProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.enableAgentConnection, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.refreshAgentConnection, (_event, projectId: unknown) =>
    refreshProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.refreshAgentConnection, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.disableAgentConnection, (_event, projectId: unknown) =>
    disableProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.disableAgentConnection, projectId, "projectId"))));
  handleIpc(PROJECT_CHANNELS.openAgentConnection, async (_event, projectId: unknown) => {
    const path = getProjectAgentContextPath(resolveProjectPath(requireString(PROJECT_CHANNELS.openAgentConnection, projectId, "projectId")));
    const error = await shell.openPath(path);
    if (error) throw new Error(`Opening FlowWeave Agent context failed: ${error}`);
  });
}

async function analyzeArchitectureForProject(
  projectId: string,
  agentId: RuntimeAgentId,
  sender: WebContents
) {
  const projectPath = resolveProjectPath(projectId);
  return runTrackedAnalysis("architecture-analysis", "Preparing architecture analysis.", sender, async (onProgress) => {
    const result = await analyzeArchitecture(await scanProjectWithCurrentProjectArtifact(projectPath), agentId, {
      onProgress,
      projectId,
      onArchitectureReview: (reviewEvent) => sendArchitectureReview(sender, reviewEvent)
    });
    if (result.outcome === "failed") throw new Error(result.error.message);
    return result;
  }, projectId, projectPath);
}

async function generateSequenceDiagramsForProject(
  projectId: string,
  agentId: RuntimeAgentId,
  sender: WebContents
) {
  const projectPath = resolveProjectPath(projectId);
  return runTrackedAnalysis("sequence-analysis", "Preparing sequence diagram analysis.", sender, async (onProgress) => {
    const result = await generateSequenceDiagrams(await scanProjectWithCurrentProjectArtifact(projectPath), agentId, {
      onProgress,
      projectId,
      onSequenceReview: (reviewEvent) => sendSequenceReview(sender, reviewEvent)
    });
    if (result.outcome === "failed") throw new Error(result.error.message);
    return result;
  }, projectId, projectPath);
}

async function scanProjectWithCurrentProjectArtifact(projectPath: string) {
  const project = await scanProject(projectPath);
  const scanFingerprint = project.scanFingerprint ?? "";
  if (!scanFingerprint) {
    throw new Error(`Project scan did not produce a scan fingerprint: ${projectPath}`);
  }
  await writeJsonAtomic(join(projectPath, FLOWWEAVE_DIR, "project.json"), {
    ...project,
    generatorVersion: "1.0.0",
    inputFingerprint: scanFingerprint,
    artifactState: "current",
    scanFingerprint
  });
  return project;
}

async function reviseSequenceDiagramForProject(
  projectId: string,
  agentId: RuntimeAgentId,
  instruction: string,
  sender: WebContents
) {
  const projectPath = resolveProjectPath(projectId);
  return runTrackedAnalysis("sequence-analysis", "Preparing sequence diagram revision.", sender, async (onProgress) => {
    return reviseSequenceDiagram(await scanProject(projectPath), agentId, instruction, { onProgress });
  }, projectId, projectPath);
}

async function scanAndPersistProject(projectId: string, sender: WebContents, options: ProjectScanOptions) {
  const started = startOperation("project-scan", "Discovering project files.", projectId);
  const notify = (operation: import("../../types").AnalysisOperation) => {
    if (!sender.isDestroyed()) sender.send(PROJECT_CHANNELS.operationProgress, operation);
  };
  notify(started.operation);
  const projectPath = resolveProjectPath(projectId);
  try {
    const project = await scanProject(projectPath, options);
    const total = project.summary.totalFiles;
    notify(updateOperation(started.operation.operationId, {
      stage: "hashing",
      completed: 0,
      total,
      failed: 0,
      message: `Discovered ${total} project files.`
    }));
    const { index } = await buildSemanticIndex(project, {
      onProgress: (progress) => notify(updateOperation(started.operation.operationId, progress))
    });
    const scanFingerprint = project.scanFingerprint ?? "";
    const inferredGraph = await inferGraphFromProject(project);
    const graph = {
      nodes: assessModules(inferredGraph.nodes, inferredGraph.edges, index, scanFingerprint, new Date().toISOString()),
      edges: inferredGraph.edges
    };
    const written = await writeFlowWeaveProject(projectPath, project, graph.nodes, graph.edges, scanFingerprint);
    await readModificationDelta(projectPath, "");
    await refreshConnectionWithoutFailing(projectId, projectPath);
    const artifacts: ProjectArtifactStatuses = {
      project: "current",
      canvas: "current",
      task: "current",
      context: "current",
      architecture: await artifactStateForFingerprint(projectPath, "architecture-map.json", scanFingerprint),
      sequences: await artifactStateForFingerprint(projectPath, "sequence-diagrams.json", scanFingerprint)
    };
    let architectureReview = await readArchitectureReviewStatus(projectPath, scanFingerprint);
    if (architectureReview.state === "reviewing" && architectureReview.runId) {
      await readRunArtifact(projectPath, architectureReview.runId).catch(() => undefined);
      architectureReview = await readArchitectureReviewStatus(projectPath, scanFingerprint);
    }
    if (
      architectureReview.state === "reviewing" &&
      architectureReview.reviewId &&
      architectureReview.agentId &&
      !isArchitectureReviewActive(architectureReview.reviewId)
    ) {
      const resumed = await analyzeArchitecture(project, architectureReview.agentId, {
        projectId,
        resumeArchitectureReview: architectureReview,
        onArchitectureReview: (reviewEvent) => sendArchitectureReview(sender, reviewEvent)
      });
      if (resumed.outcome === "generated") {
        architectureReview = resumed.review;
      }
    }
    let sequenceReview = await readSequenceReviewStatus(projectPath, scanFingerprint);
    if (sequenceReview.state === "reviewing" && sequenceReview.runId) {
      await readRunArtifact(projectPath, sequenceReview.runId).catch(() => undefined);
      sequenceReview = await readSequenceReviewStatus(projectPath, scanFingerprint);
    }
    if (
      sequenceReview.state === "reviewing" &&
      sequenceReview.reviewId &&
      sequenceReview.agentId &&
      !isSequenceReviewActive(sequenceReview.reviewId)
    ) {
      const resumed = await generateSequenceDiagrams(project, sequenceReview.agentId, {
        projectId,
        resumeSequenceReview: sequenceReview,
        onSequenceReview: (reviewEvent) => sendSequenceReview(sender, reviewEvent)
      });
      if (resumed.outcome === "generated") {
        sequenceReview = resumed.review;
      }
    }
    notify(updateOperation(started.operation.operationId, {
      stage: "completed",
      completed: total,
      total,
      failed: 0,
      message: "Project scan completed."
    }));
    return {
      canceled: false as const,
      projectId,
      scanFingerprint,
      artifacts,
      architectureReview,
      sequenceReview,
      project,
      graph,
      written
    };
  } catch (error) {
    notify(updateOperation(started.operation.operationId, {
      stage: "failed",
      completed: 0,
      total: 0,
      failed: 1,
      message: error instanceof Error ? error.message : String(error)
    }));
    await recordDiagnostic(projectPath, {
      category: "scan",
      code: "project-scan-failed",
      message: error instanceof Error ? error.message : String(error),
      context: { projectId }
    });
    throw error;
  } finally {
    finishOperation(started.operation.operationId);
  }
}

function sendArchitectureReview(sender: WebContents, event: ArchitectureReviewEvent): void {
  if (!sender.isDestroyed()) {
    sender.send(PROJECT_CHANNELS.architectureReview, event);
  }
}

function sendSequenceReview(sender: WebContents, event: SequenceReviewEvent): void {
  if (!sender.isDestroyed()) {
    sender.send(PROJECT_CHANNELS.sequenceReview, event);
  }
}

function requireScanOptions(channel: string, value: unknown): ProjectScanOptions {
  const options = requireObject(channel, value, "options");
  return {
    concurrency: requireInteger(channel, options.concurrency, "concurrency", 1, 128)
  };
}

async function runTrackedAnalysis<T>(
  kind: AnalysisOperation["kind"],
  message: string,
  sender: WebContents,
  task: (onProgress: (progress: AnalysisProgressUpdate) => void) => Promise<T>,
  projectId: string,
  projectPath: string
): Promise<T> {
  const started = startOperation(kind, message, projectId);
  const notify = (operation: AnalysisOperation) => {
    if (!sender.isDestroyed()) sender.send(PROJECT_CHANNELS.operationProgress, operation);
  };
  notify(started.operation);
  try {
    const result = await task((progress) => notify(updateOperation(started.operation.operationId, progress)));
    notify(updateOperation(started.operation.operationId, {
      stage: "completed",
      completed: 1,
      total: 1,
      failed: 0,
      message: "Analysis completed."
    }));
    return result;
  } catch (error) {
    notify(updateOperation(started.operation.operationId, {
      stage: "failed",
      completed: 0,
      total: 1,
      failed: 1,
      message: error instanceof Error ? error.message : String(error)
    }));
    await recordDiagnostic(projectPath, {
      category: "analysis",
      code: `${kind}-failed`,
      message: error instanceof Error ? error.message : String(error),
      context: { kind }
    });
    throw error;
  } finally {
    finishOperation(started.operation.operationId);
  }
}

async function readCanvasArtifactState(projectPath: string): Promise<
  { state: "missing" } | { state: "failed"; error: string } | { state: "loaded"; canvas: CodeflowCanvas }
> {
  const path = join(projectPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
  try {
    const canvas = JSON.parse(await readFile(path, "utf8")) as CodeflowCanvas;
    if (canvas.version !== 4) throw new Error("Canvas version must be 4. Re-scan the project to rebuild it.");
    return { state: "loaded", canvas };
  } catch (error) {
    if (isMissing(error)) return { state: "missing" };
    return { state: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

async function artifactStateForFingerprint(projectPath: string, fileName: string, fingerprint: string): Promise<ProjectArtifactState> {
  try {
    const artifact = JSON.parse(await readFile(join(projectPath, FLOWWEAVE_DIR, fileName), "utf8")) as {
      source?: string;
      metadata?: { inputFingerprint?: string };
    };
    return artifact.metadata?.inputFingerprint === fingerprint ? "current" : "stale";
  } catch (error) {
    return isMissing(error) ? "missing" : "failed";
  }
}

async function refreshConnectionWithoutFailing(projectId: string, projectPath: string) {
  try {
    await refreshProjectAgentConnectionIfEnabled(projectPath);
  } catch (error) {
    console.warn("FlowWeave Agent connection refresh failed.", {
      projectId,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

function requireRuntimeAgentId(channel: string, value: unknown): RuntimeAgentId {
  if (typeof value === "string" && value.startsWith("custom:") && value.length > 7) return value as RuntimeAgentId;
  return requireEnum(channel, value, "agentId", TOOL_IDS);
}

export function requireCanvasV4(channel: string, value: unknown): CodeflowCanvas {
  const canvas = requireObject(channel, value, "canvas") as Partial<CodeflowCanvas>;
  if (canvas.version !== 4 || !Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) {
    throw new Error(`[${channel}] Canvas must be a current v4 Canvas. Re-scan the project to rebuild it.`);
  }
  return canvas as CodeflowCanvas;
}

function requireModificationSnapshot(channel: string, value: unknown): ModificationSnapshot {
  const snapshot = requireObject(channel, value, "snapshot") as Partial<ModificationSnapshot>;
  if (!snapshot.canvas || !Array.isArray(snapshot.canvas.modules) || !Array.isArray(snapshot.canvas.relations)) {
    throw new Error(`[${channel}] Modification snapshot must include Canvas modules and relations.`);
  }
  return snapshot as ModificationSnapshot;
}

function requireModificationAcknowledgementScope(
  channel: string,
  value: unknown
): ModificationAcknowledgementScope {
  const scope = requireObject(channel, value, "scope") as Partial<ModificationAcknowledgementScope>;
  if (scope.kind === "all" || scope.kind === "sequence") return { kind: scope.kind };
  if (scope.kind === "module-guidance" && "moduleId" in scope) {
    return {
      kind: "module-guidance",
      moduleId: requireString(channel, scope.moduleId, "scope.moduleId")
    };
  }
  throw new Error(`[${channel}] Unsupported modification acknowledgement scope.`);
}

export function requireProjectWorkspaceSession(channel: string, value: unknown): ProjectWorkspaceSession {
  const session = requireObject(channel, value, "session");
  const openProjectIds = requireStringArray(channel, session.openProjectIds, "session.openProjectIds");
  const activeProjectId = session.activeProjectId === undefined
    ? undefined
    : requireString(channel, session.activeProjectId, "session.activeProjectId");
  const pages = requireObject(channel, session.lastPageByProject, "session.lastPageByProject");
  const lastPageByProject: ProjectWorkspaceSession["lastPageByProject"] = {};
  for (const [projectId, page] of Object.entries(pages)) {
    lastPageByProject[requireString(channel, projectId, "session.lastPageByProject key")] = requireEnum(
      channel,
      page,
      "session.lastPageByProject",
      WORKSPACE_PAGES
    );
  }
  const contexts = session.contextsByProject === undefined
    ? {}
    : requireObject(channel, session.contextsByProject, "session.contextsByProject");
  const contextsByProject: ProjectWorkspaceSession["contextsByProject"] = {};
  for (const [projectId, value] of Object.entries(contexts)) {
    const context = requireObject(channel, value, "session.contextsByProject value");
    const safeProjectId = requireString(channel, projectId, "session.contextsByProject key");
    contextsByProject[safeProjectId] = {
      activePage: requireEnum(channel, context.activePage, "session.context.activePage", WORKSPACE_PAGES),
      expandedPaths: requireStringArray(channel, context.expandedPaths, "session.context.expandedPaths"),
      selectedNodeId: requireWorkspaceText(channel, context.selectedNodeId, "session.context.selectedNodeId"),
      selectedAgentId: requireString(channel, context.selectedAgentId, "session.context.selectedAgentId") as import("../../types").AgentId,
      executionMode: requireEnum(channel, context.executionMode, "session.context.executionMode", ["plan", "execute"] as const),
      selectedRunId: requireWorkspaceText(channel, context.selectedRunId, "session.context.selectedRunId"),
      runArtifactTab: requireEnum(channel, context.runArtifactTab, "session.context.runArtifactTab", ["prompt", "plan", "log", "result"] as const),
      checkpointId: requireWorkspaceText(channel, context.checkpointId, "session.context.checkpointId")
    };
  }
  return { openProjectIds, activeProjectId, lastPageByProject, contextsByProject };
}

function requireWorkspaceText(channel: string, value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`[${channel}] Invalid "${name}": expected a string.`);
  }
  return value;
}

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function readOptionalProjectTextFile(resolvedPath: string, requestedPath: string): Promise<string | undefined> {
  try {
    return await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (isMissing(error) && isOptionalFlowWeaveDocPath(requestedPath)) return undefined;
    throw error;
  }
}

function isOptionalFlowWeaveDocPath(filePath: string): boolean {
  return /^\.flowweave\/docs\/[A-Za-z0-9_-]+\.(md|json)$/.test(filePath);
}

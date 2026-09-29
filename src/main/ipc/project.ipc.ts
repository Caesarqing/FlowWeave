import { dialog, shell, type WebContents } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_CHANNELS } from "../../common/ipc-channels";
import type {
  AnalysisOperation,
  AnalysisProgressUpdate,
  ActivePage,
  ArchitectureReviewEvent,
  CodeflowCanvas,
  CanvasReadResult,
  CodeflowProject,
  FlowWeaveStoredProject,
  ProjectArtifactState,
  ProjectArtifactStatuses,
  ProjectScanOptions,
  RuntimeAgentId,
  SequenceReviewEvent,
  ModificationAcknowledgementScope,
  ModificationSnapshot,
  ProjectWorkspaceSession
} from "../../types";
import {
  analyzeArchitecture,
  readArchitectureMap
} from "../services/architecture-analysis.service";
import { generateProject, generateRegisteredProject, registerGenerationRequest, assertArtifactGeneration } from "../services/project-generation.service";
import {
  isArchitectureReviewActive,
  readArchitectureReviewStatus,
  withArchitectureArtifactLock
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
import { generateSequenceDiagrams, readSequenceDiagrams, reviseSequenceDiagram } from "../services/sequence-diagram.service";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { assertSafeProjectWritePath, writeProjectTextAtomic } from "../storage/project-write-guard";
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
const latestScanRequests = new Map<string, string>();

export function registerProjectIpc() {
  handleIpc(PROJECT_CHANNELS.openProject, async (event, options: unknown) => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open project in FlowWeave" });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    const projectId = await registerProject(result.filePaths[0]);
    return scanAndPersistProject(projectId, event.sender, requireScanOptions(PROJECT_CHANNELS.openProject, options));
  });

  handleIpc(PROJECT_CHANNELS.listRegisteredProjects, async () => listRegisteredProjects());
  handleIpc(PROJECT_CHANNELS.readRegisteredProject, (_event, projectId: unknown) =>
    readStoredProject(requireString(PROJECT_CHANNELS.readRegisteredProject, projectId, "projectId")));

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

  handleIpc(PROJECT_CHANNELS.analyzeArchitectureWithAgent, (event, projectId: unknown, agentId: unknown, timeoutMs: unknown) =>
    analyzeArchitectureForProject(
      requireString(PROJECT_CHANNELS.analyzeArchitectureWithAgent, projectId, "projectId"),
      requireRuntimeAgentId(PROJECT_CHANNELS.analyzeArchitectureWithAgent, agentId),
      event.sender,
      requireOptionalAgentTimeout(PROJECT_CHANNELS.analyzeArchitectureWithAgent, timeoutMs)
    ));

  handleIpc(PROJECT_CHANNELS.readArchitectureMap, (_event, projectId: unknown) =>
    readArchitectureMap(resolveProjectPath(requireString(PROJECT_CHANNELS.readArchitectureMap, projectId, "projectId"))));

  handleIpc(PROJECT_CHANNELS.generateSequenceDiagrams, (event, projectId: unknown, agentId: unknown, timeoutMs: unknown) =>
    generateSequenceDiagramsForProject(
      requireString(PROJECT_CHANNELS.generateSequenceDiagrams, projectId, "projectId"),
      requireRuntimeAgentId(PROJECT_CHANNELS.generateSequenceDiagrams, agentId),
      event.sender,
      requireOptionalAgentTimeout(PROJECT_CHANNELS.generateSequenceDiagrams, timeoutMs)
    ));

  handleIpc(PROJECT_CHANNELS.reviseSequenceDiagram, (event, projectId: unknown, agentId: unknown, instruction: unknown, timeoutMs: unknown) =>
    reviseSequenceDiagramForProject(
      requireString(PROJECT_CHANNELS.reviseSequenceDiagram, projectId, "projectId"),
      requireRuntimeAgentId(PROJECT_CHANNELS.reviseSequenceDiagram, agentId),
      requireString(PROJECT_CHANNELS.reviseSequenceDiagram, instruction, "instruction"),
      event.sender,
      requireOptionalAgentTimeout(PROJECT_CHANNELS.reviseSequenceDiagram, timeoutMs)
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
    const docPath = join(docsDir, `${safeDocId}.md`);
    await writeProjectTextAtomic(projectPath, docPath, requireString(PROJECT_CHANNELS.saveDoc, content, "content"));
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
      : requireCanvasV6(PROJECT_CHANNELS.readModificationDelta, canvas);
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
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.readCanvas, projectId, "projectId"));
    return withArchitectureArtifactLock(projectPath, () => readCanvasArtifactState(projectPath));
  });

  handleIpc(PROJECT_CHANNELS.saveCanvas, async (_event, projectId: unknown, canvas: unknown, options: unknown) => {
    const safeProjectId = requireString(PROJECT_CHANNELS.saveCanvas, projectId, "projectId");
    const projectPath = resolveProjectPath(safeProjectId);
    const value = requireCanvasV6(PROJECT_CHANNELS.saveCanvas, canvas);
    if (options !== undefined) requireObject(PROJECT_CHANNELS.saveCanvas, options, "options");
    if (value.artifactState !== "current") {
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Only a current Canvas v6 can be saved.`);
    }
    for (const node of value.nodes) {
      const override = node.assessment?.risk.override;
      if (override && !override.reason.trim()) {
        throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Risk override for "${node.id}" requires a reason.`);
      }
    }
    const canvasPath = join(projectPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
    await withArchitectureArtifactLock(projectPath, async () => {
      const stored = await readCanvasArtifactState(projectPath);
      if (stored?.mode === "legacy-readonly") throw new Error(`Legacy Canvas v5 is read-only; re-scan successfully before saving: ${canvasPath}`);
      const projectArtifact = await readJsonArtifact(join(projectPath, FLOWWEAVE_DIR, "project.json")) as CodeflowProject | undefined;
      if (!projectArtifact || !value.scanFingerprint || value.scanFingerprint !== projectArtifact.scanFingerprint) {
        throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Canvas scan fingerprint is stale: ${canvasPath}`);
      }
      await assertArtifactGeneration(projectPath, canvasPath, value);
      await assertArtifactGeneration(projectPath, join(projectPath, FLOWWEAVE_DIR, "project.json"), projectArtifact);
      await assertSafeProjectWritePath(projectPath, canvasPath);
      await writeJsonAtomic(canvasPath, { ...value, projectPath });
    });
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
  sender: WebContents,
  timeoutMs: number | undefined
) {
  const projectPath = resolveProjectPath(projectId);
  return runTrackedAnalysis("architecture-analysis", "Preparing architecture analysis.", sender, async (onProgress) => {
    const result = await analyzeArchitecture(await scanProjectWithCurrentProjectArtifact(projectPath), agentId, {
      onProgress,
      projectId,
      timeoutMs,
      onArchitectureReview: (reviewEvent) => sendArchitectureReview(sender, reviewEvent)
    });
    if (result.outcome === "failed") throw new Error(result.error.message);
    return result;
  }, projectId, projectPath);
}

async function generateSequenceDiagramsForProject(
  projectId: string,
  agentId: RuntimeAgentId,
  sender: WebContents,
  timeoutMs: number | undefined
) {
  const projectPath = resolveProjectPath(projectId);
  return runTrackedAnalysis("sequence-analysis", "Preparing sequence diagram analysis.", sender, async (onProgress) => {
    const result = await generateSequenceDiagrams(await scanProjectWithCurrentProjectArtifact(projectPath), agentId, {
      onProgress,
      projectId,
      timeoutMs,
      onSequenceReview: (reviewEvent) => sendSequenceReview(sender, reviewEvent)
    });
    if (result.outcome === "failed") throw new Error(result.error.message);
    return result;
  }, projectId, projectPath);
}

async function scanProjectWithCurrentProjectArtifact(projectPath: string) {
  const generated = await generateProject(projectPath, {});
  if (generated.status === "superseded") {
    throw new Error(`Analysis generation superseded: project ${projectPath}, request ${generated.requestId}`);
  }
  return generated.project;
}

async function reviseSequenceDiagramForProject(
  projectId: string,
  agentId: RuntimeAgentId,
  instruction: string,
  sender: WebContents,
  timeoutMs: number | undefined
) {
  const projectPath = resolveProjectPath(projectId);
  return runTrackedAnalysis("sequence-analysis", "Preparing sequence diagram revision.", sender, async (onProgress) => {
    return reviseSequenceDiagram(await scanProject(projectPath), agentId, instruction, { onProgress, timeoutMs });
  }, projectId, projectPath);
}

async function scanAndPersistProject(projectId: string, sender: WebContents, options: ProjectScanOptions) {
  const projectPath = resolveProjectPath(projectId);
  const request = await registerGenerationRequest(projectPath);
  latestScanRequests.set(projectPath, request.requestId);
  const started = startOperation("project-scan", "Discovering project files.", projectId);
  const notify = (operation: import("../../types").AnalysisOperation) => {
    if (!sender.isDestroyed() && latestScanRequests.get(projectPath) === request.requestId) {
      sender.send(PROJECT_CHANNELS.operationProgress, { ...operation, requestId: request.requestId });
    }
  };
  notify(started.operation);
  try {
    const generated = await generateRegisteredProject(request, {
      scanOptions: options,
      onProgress: (progress) => notify(updateOperation(started.operation.operationId, progress))
    });
    if (generated.status === "superseded") return { canceled: false as const, status: "superseded" as const, projectId, requestId: request.requestId };
    const { project, index, architectureMap, graph, written, generation } = generated;
    const total = project.summary.totalFiles;
    const scanFingerprint = project.scanFingerprint!;
    const architectureInputFingerprint = generated.localArchitecture.metadata!.inputFingerprint;
    await refreshConnectionWithoutFailing(projectId, projectPath);
    const artifacts: ProjectArtifactStatuses = {
      project: "current",
      canvas: "current",
      task: "current",
      context: "current",
      architecture: await artifactStateForFingerprint(projectPath, "architecture-map.json", architectureInputFingerprint),
      sequences: await artifactStateForFingerprint(projectPath, "sequence-diagrams.json", scanFingerprint)
    };
    const architectureFingerprints = { scanFingerprint, inputFingerprint: architectureInputFingerprint };
    let architectureReview = await readArchitectureReviewStatus(projectPath, architectureFingerprints);
    if (architectureReview.state === "reviewing" && architectureReview.runId) {
      await readRunArtifact(projectPath, architectureReview.runId).catch(() => undefined);
      architectureReview = await readArchitectureReviewStatus(projectPath, architectureFingerprints);
    }
    if (
      architectureReview.state === "reviewing" &&
      architectureReview.reviewId &&
      architectureReview.agentId &&
      !isArchitectureReviewActive(architectureReview.reviewId)
    ) {
      const resumed = await analyzeArchitecture(project, architectureReview.agentId, {
        projectId,
        semanticIndex: index,
        timeoutMs: options.agentPlanTimeoutMs,
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
        timeoutMs: options.agentPlanTimeoutMs,
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
      status: "committed" as const,
      generation,
      projectId,
      scanFingerprint,
      artifacts,
      architectureReview,
      sequenceReview,
      project,
      graph,
      relationDiagnostics: architectureMap.relationDiagnostics ?? [],
      quality: architectureMap.quality, groups: architectureMap.groups, resources: architectureMap.resources,
      written
    };
  } catch (error) {
    const latest = await withArchitectureArtifactLock(projectPath, () =>
      readJsonArtifact(join(projectPath, FLOWWEAVE_DIR, "generation-request.json"))) as { requestId?: string } | undefined;
    if (latest?.requestId !== request.requestId) return { canceled: false as const, status: "superseded" as const, projectId, requestId: request.requestId };
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
      context: { projectId, requestId: request.requestId }
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
    concurrency: requireInteger(channel, options.concurrency, "concurrency", 1, 128),
    agentPlanTimeoutMs: options.agentPlanTimeoutMs === undefined
      ? undefined
      : requireInteger(channel, options.agentPlanTimeoutMs, "agentPlanTimeoutMs", 60_000, 120 * 60 * 1000)
  };
}

function requireOptionalAgentTimeout(channel: string, value: unknown): number | undefined {
  return value === undefined
    ? undefined
    : requireInteger(channel, value, "timeoutMs", 60_000, 120 * 60 * 1000);
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

/** Caller holds the project write lock, so a read cannot observe half a generation. */
async function readCanvasArtifactState(projectPath: string): Promise<CanvasReadResult | undefined> {
  const path = join(projectPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
  const value = await readJsonArtifact(path);
  if (value === undefined) return undefined;
  const issue = canvasArtifactShapeIssue(value);
  if (issue) throw new Error(`FlowWeave Canvas is invalid and was preserved: ${path}: ${issue}`);
  const canvas = value as CodeflowCanvas | import("../../types").LegacyCanvasV5;
  await assertArtifactGeneration(projectPath, path, canvas);
  return canvas.version === 5 ? { mode: "legacy-readonly", canvas } : { mode: "editable", canvas };
}

export function canvasArtifactShapeIssue(value: unknown): string | undefined {
  if (!isRecord(value)) return "canvas must be an object";
  if (value.version !== 5 && value.version !== 6) return "version must be 5 or 6";
  for (const field of ["id", "title", "projectPath", "generatedAt"] as const) {
    if (typeof value[field] !== "string") return `${field} must be a string`;
  }
  if (!Array.isArray(value.nodes)) return "nodes must be an array";
  if (!Array.isArray(value.edges)) return "edges must be an array";
  for (const [index, node] of value.nodes.entries()) {
    const issue = graphNodeShapeIssue(node, `nodes[${index}]`, value.version);
    if (issue) return issue;
  }
  for (const [index, edge] of value.edges.entries()) {
    const issue = graphEdgeShapeIssue(edge, `edges[${index}]`);
    if (issue) return issue;
  }
  if (value.orphanedEdges !== undefined) {
    if (!Array.isArray(value.orphanedEdges)) return "orphanedEdges must be an array";
    for (const [index, edge] of value.orphanedEdges.entries()) {
      const issue = graphEdgeShapeIssue(edge, `orphanedEdges[${index}]`);
      if (issue) return issue;
    }
  }
  return undefined;
}

function graphNodeShapeIssue(value: unknown, path: string, version: 5 | 6): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  for (const field of ["id", "title", "subtitle", "description", "guidanceDraft"] as const) {
    if (typeof value[field] !== "string") return `${path}.${field} must be a string`;
  }
  if (!enumHas(value.kind, ["module", "requirement", "task", "file", "doc", "agent", "diff"])) return `${path}.kind is invalid`;
  if (!enumHas(value.nodeType, ["module", "entrypoint", "api", "service", "data", "external", "worker", "utility", "test"])) return `${path}.nodeType is invalid`;
  if (!enumHas(value.risk, version === 5 ? ["low", "medium", "high", "unknown", "normal", "review", "blocked"] : ["low", "medium", "high", "unknown"])) return `${path}.risk is invalid`;
  if (!enumHas(value.status, ["mapped", "needs-review", "draft"])) return `${path}.status is invalid`;
  if (!Array.isArray(value.files) || value.files.some((file) => typeof file !== "string")) return `${path}.files must be an array of strings`;
  if (typeof value.x !== "number" || !Number.isFinite(value.x) || typeof value.y !== "number" || !Number.isFinite(value.y)) return `${path}.x and ${path}.y must be finite numbers`;
  if (value.evidence !== undefined) {
    const issue = evidenceArrayShapeIssue(value.evidence, `${path}.evidence`);
    if (issue) return issue;
  }
  if (value.fileRoles !== undefined && (!Array.isArray(value.fileRoles) || value.fileRoles.some((item) => !isRecord(item) || typeof item.path !== "string" || typeof item.role !== "string"))) return `${path}.fileRoles must contain path and role strings`;
  if (value.symbols !== undefined && (!Array.isArray(value.symbols) || value.symbols.some((item) => !isRecord(item) || typeof item.name !== "string" || typeof item.kind !== "string" || typeof item.filePath !== "string"))) return `${path}.symbols must contain valid symbols`;
  if (value.relationDiagnostics !== undefined && (!Array.isArray(value.relationDiagnostics) || value.relationDiagnostics.some((item) => !isRecord(item) || typeof item.code !== "string" || typeof item.message !== "string" || typeof item.filePath !== "string" || (item.candidates !== undefined && (!Array.isArray(item.candidates) || item.candidates.some((candidate) => typeof candidate !== "string"))) || (item.range !== undefined && !validRange(item.range))))) return `${path}.relationDiagnostics must contain valid diagnostics`;
  return undefined;
}

function graphEdgeShapeIssue(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  for (const field of ["id", "source", "target"] as const) {
    if (typeof value[field] !== "string" || !value[field]) return `${path}.${field} must be a non-empty string`;
  }
  if (!enumHas(value.relation, ["depends_on", "calls", "reads_writes", "external_api", "publishes_event", "subscribes_event", "tests"])) return `${path}.relation is invalid`;
  if (value.guidanceNote !== undefined && typeof value.guidanceNote !== "string") return `${path}.guidanceNote must be a string`;
  if (value.evidence !== undefined) {
    const issue = evidenceArrayShapeIssue(value.evidence, `${path}.evidence`);
    if (issue) return issue;
  }
  for (const field of ["semanticKinds", "operations", "importUsages", "sourceRelationIds", "aggregatedEdgeIds"] as const) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some((entry) => typeof entry !== "string"))) return `${path}.${field} must be an array of strings`;
  }
  return undefined;
}

function evidenceArrayShapeIssue(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value)) return `${path} must be an array`;
  for (const [index, evidence] of value.entries()) {
    if (!isRecord(evidence) || typeof evidence.detail !== "string") return `${path}[${index}] must include a detail string`;
    for (const field of ["filePath", "symbol", "eventId", "relationId", "bindingBasis"] as const) {
      if (evidence[field] !== undefined && typeof evidence[field] !== "string") return `${path}[${index}].${field} must be a string`;
    }
    if (evidence.line !== undefined && (typeof evidence.line !== "number" || !Number.isFinite(evidence.line))) return `${path}[${index}].line must be a finite number`;
    if (evidence.range !== undefined && !validRange(evidence.range)) return `${path}[${index}].range is invalid`;
    if (evidence.declarationRange !== undefined && !validRange(evidence.declarationRange)) return `${path}[${index}].declarationRange is invalid`;
  }
  return undefined;
}

function validRange(value: unknown): boolean {
  return isRecord(value) && validPosition(value.start) && validPosition(value.end);
}

function validPosition(value: unknown): boolean {
  return isRecord(value) && Number.isInteger(value.line) && Number(value.line) > 0 && Number.isInteger(value.column) && Number(value.column) > 0;
}

function enumHas(value: unknown, options: readonly string[]): boolean {
  return typeof value === "string" && options.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStoredProject(projectId: string): Promise<FlowWeaveStoredProject | undefined> {
  const projectPath = resolveProjectPath(projectId);
  const stored = await withArchitectureArtifactLock(projectPath, async () => {
    const path = join(projectPath, FLOWWEAVE_DIR, "project.json");
    const value = await readJsonArtifact(path);
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || !("files" in value) || !Array.isArray(value.files) || !("summary" in value)) {
      throw new Error(`FlowWeave project artifact is invalid and was preserved: ${path}`);
    }
    const project = value as CodeflowProject;
    await assertArtifactGeneration(projectPath, path, project);
    const canvas = await readCanvasArtifactState(projectPath);
    if (!canvas) return undefined;
    const architecture = await readArchitectureMap(projectPath);
    if (architecture) await assertArtifactGeneration(projectPath, join(projectPath, FLOWWEAVE_DIR, "architecture-map.json"), architecture);
    return { project, canvas, architecture };
  });
  if (!stored) return undefined;
  const { project, canvas, architecture } = stored;
  const scanFingerprint = project.scanFingerprint ?? canvas.canvas.scanFingerprint ?? "";
  const inputFingerprint = architecture?.metadata?.inputFingerprint;
  return {
    projectId, project, canvas, generation: project.generation, scanFingerprint,
    graph: { nodes: canvas.canvas.nodes, edges: canvas.canvas.edges },
    artifacts: { project: "current", canvas: canvas.mode === "legacy-readonly" ? "stale" : "current", task: "stale", context: "stale", architecture: architecture ? "current" : "missing", sequences: await artifactStateForFingerprint(projectPath, "sequence-diagrams.json", scanFingerprint) },
    architectureReview: await readArchitectureReviewStatus(projectPath, { scanFingerprint, inputFingerprint: inputFingerprint ?? "" }),
    sequenceReview: await readSequenceReviewStatus(projectPath, scanFingerprint),
    relationDiagnostics: architecture?.relationDiagnostics ?? [],
    quality: architecture?.quality, groups: architecture?.groups, resources: architecture?.resources
  };
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

export function requireCanvasV6(channel: string, value: unknown): CodeflowCanvas {
  const canvas = requireObject(channel, value, "canvas") as Partial<CodeflowCanvas>;
  if (canvas.version !== 6) {
    throw new Error(`[${channel}] Canvas must be a current v6 Canvas. Re-scan the project to rebuild it.`);
  }
  const issue = canvasArtifactShapeIssue(canvas);
  if (issue) throw new Error(`[${channel}] Canvas is invalid: ${issue}`);
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

import { dialog, shell, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_CHANNELS } from "../../common/ipc-channels";
import type {
  AnalysisOperation,
  AnalysisProgressUpdate,
  CodeflowCanvas,
  ProjectArtifactState,
  ProjectArtifactStatuses,
  ProjectScanOptions,
  RuntimeAgentId,
  ToolId
} from "../../types";
import { analyzeProject } from "../services/agent-analysis.service";
import { analyzeArchitecture, readArchitectureMap } from "../services/architecture-analysis.service";
import { migrateCanvasToScan } from "../services/canvas-migration.service";
import {
  disableProjectAgentConnection,
  enableProjectAgentConnection,
  getProjectAgentConnection,
  getProjectAgentContextPath,
  refreshProjectAgentConnection,
  refreshProjectAgentConnectionIfEnabled
} from "../services/project-agent-connection.service";
import { registerProject, resolveProjectFile, resolveProjectPath } from "../services/project-registry.service";
import { scanProject } from "../services/project-scanner.service";
import { buildSemanticIndex } from "../services/semantic-index.service";
import { generateSequenceDiagrams, readSequenceDiagrams, reviseSequenceDiagram } from "../services/sequence-diagram.service";
import { inferGraphFromProject } from "../services/task-generator.service";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { writeFlowWeaveProject, writeFlowWeaveProjectPreservingCanvas } from "../storage/flowweave-store";
import { requireEnum, requireInteger, requireObject, requireSafeId, requireString } from "./ipc-validation";
import { cancelOperation, finishOperation, startOperation, updateOperation } from "../services/operation.service";
import { exportDiagnostics, recordDiagnostic } from "../services/diagnostic.service";
import { handleIpc } from "./ipc-handler";

const TOOL_IDS = ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"] as const;

export function registerProjectIpc() {
  handleIpc(PROJECT_CHANNELS.openProject, async (event, options: unknown) => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open project in FlowWeave" });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    const projectId = await registerProject(result.filePaths[0]);
    return scanAndPersistProject(projectId, event.sender, requireScanOptions(PROJECT_CHANNELS.openProject, options));
  });

  handleIpc(PROJECT_CHANNELS.scanProject, (event, projectId: unknown, options: unknown) =>
    scanAndPersistProject(
      requireString(PROJECT_CHANNELS.scanProject, projectId, "projectId"),
      event.sender,
      requireScanOptions(PROJECT_CHANNELS.scanProject, options)
    ));

  handleIpc(PROJECT_CHANNELS.cancelOperation, (event, operationId: unknown) => {
    const operation = cancelOperation(requireString(PROJECT_CHANNELS.cancelOperation, operationId, "operationId"));
    event.sender.send(PROJECT_CHANNELS.operationProgress, operation);
    return operation;
  });

  handleIpc(PROJECT_CHANNELS.analyzeProject, async (_event, projectId: unknown, toolId: unknown) => {
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.analyzeProject, projectId, "projectId"));
    return analyzeProject(await scanProject(projectPath), requireEnum(PROJECT_CHANNELS.analyzeProject, toolId, "toolId", TOOL_IDS) as ToolId);
  });

  handleIpc(PROJECT_CHANNELS.analyzeArchitecture, (event, projectId: unknown, toolId: unknown) =>
    analyzeArchitectureForProject(
      requireString(PROJECT_CHANNELS.analyzeArchitecture, projectId, "projectId"),
      requireEnum(PROJECT_CHANNELS.analyzeArchitecture, toolId, "toolId", TOOL_IDS),
      event.sender
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

  handleIpc(PROJECT_CHANNELS.reviseSequenceDiagram, (event, projectId: unknown, agentId: unknown, kind: unknown, instruction: unknown) =>
    reviseSequenceDiagramForProject(
      requireString(PROJECT_CHANNELS.reviseSequenceDiagram, projectId, "projectId"),
      requireRuntimeAgentId(PROJECT_CHANNELS.reviseSequenceDiagram, agentId),
      requireEnum(PROJECT_CHANNELS.reviseSequenceDiagram, kind, "kind", ["architectural", "detailed-design"]),
      requireString(PROJECT_CHANNELS.reviseSequenceDiagram, instruction, "instruction"),
      event.sender
    ));

  handleIpc(PROJECT_CHANNELS.readSequenceDiagrams, (_event, projectId: unknown) =>
    readSequenceDiagrams(resolveProjectPath(requireString(PROJECT_CHANNELS.readSequenceDiagrams, projectId, "projectId"))));

  handleIpc(PROJECT_CHANNELS.readFile, async (_event, projectId: unknown, filePath: unknown) =>
    readFile(await resolveProjectFile(
      requireString(PROJECT_CHANNELS.readFile, projectId, "projectId"),
      requireString(PROJECT_CHANNELS.readFile, filePath, "filePath")
    ), "utf8"));

  handleIpc(PROJECT_CHANNELS.saveDoc, async (_event, projectId: unknown, docId: unknown, content: unknown) => {
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.saveDoc, projectId, "projectId"));
    const safeDocId = requireSafeId(PROJECT_CHANNELS.saveDoc, docId, "docId");
    const docsDir = join(projectPath, FLOWWEAVE_DIR, "docs");
    await mkdir(docsDir, { recursive: true });
    const docPath = join(docsDir, `${safeDocId}.md`);
    await writeFile(docPath, requireString(PROJECT_CHANNELS.saveDoc, content, "content"), "utf8");
    return docPath;
  });

  handleIpc(PROJECT_CHANNELS.readCanvas, async (_event, projectId: unknown) => {
    const result = await readCanvasArtifactState(resolveProjectPath(requireString(PROJECT_CHANNELS.readCanvas, projectId, "projectId")));
    if (result.state === "failed") {
      throw new Error(`FlowWeave Canvas is unreadable and was preserved: ${result.error}`);
    }
    return result.state === "loaded" ? result.canvas : undefined;
  });

  handleIpc(PROJECT_CHANNELS.saveCanvas, async (_event, projectId: unknown, canvas: unknown) => {
    const safeProjectId = requireString(PROJECT_CHANNELS.saveCanvas, projectId, "projectId");
    const projectPath = resolveProjectPath(safeProjectId);
    const value = requireObject(PROJECT_CHANNELS.saveCanvas, canvas, "canvas") as Partial<CodeflowCanvas>;
    if (value.version !== 3 || value.artifactState !== "current") {
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Only a current Canvas v3 can be saved.`);
    }
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Canvas nodes and edges must be arrays.`);
    }
    const projectArtifact = JSON.parse(
      await readFile(join(projectPath, FLOWWEAVE_DIR, "project.json"), "utf8")
    ) as { scanFingerprint?: string };
    if (!value.scanFingerprint || value.scanFingerprint !== projectArtifact.scanFingerprint) {
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Canvas scan fingerprint is stale.`);
    }
    const canvasPath = join(projectPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
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
  return runTrackedAnalysis("architecture-analysis", "Preparing architecture analysis.", sender, async (signal, onProgress) => {
    const result = await analyzeArchitecture(await scanProject(projectPath), agentId, { signal, onProgress });
    if (result.outcome === "failed") throw new Error(result.error.message);
    return result;
  }, projectPath);
}

async function generateSequenceDiagramsForProject(
  projectId: string,
  agentId: RuntimeAgentId,
  sender: WebContents
) {
  const projectPath = resolveProjectPath(projectId);
  return runTrackedAnalysis("sequence-analysis", "Preparing sequence diagram analysis.", sender, async (signal, onProgress) => {
    const result = await generateSequenceDiagrams(await scanProject(projectPath), agentId, { signal, onProgress });
    if (result.outcome === "failed") throw new Error(result.error.message);
    return result;
  }, projectPath);
}

async function reviseSequenceDiagramForProject(
  projectId: string,
  agentId: RuntimeAgentId,
  kind: "architectural" | "detailed-design",
  instruction: string,
  sender: WebContents
) {
  const projectPath = resolveProjectPath(projectId);
  return runTrackedAnalysis("sequence-analysis", "Preparing sequence diagram revision.", sender, async (signal, onProgress) => {
    return reviseSequenceDiagram(await scanProject(projectPath), agentId, kind, instruction, { signal, onProgress });
  }, projectPath);
}

async function scanAndPersistProject(projectId: string, sender: WebContents, options: ProjectScanOptions) {
  const started = startOperation("project-scan", "Discovering project files.");
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
    await buildSemanticIndex(project, {
      signal: started.signal,
      onProgress: (progress) => notify(updateOperation(started.operation.operationId, progress))
    });
    const scanFingerprint = project.scanFingerprint ?? "";
    const inferredGraph = await inferGraphFromProject(project);
    const canvasRead = await readCanvasArtifactState(projectPath);
    const canvas = canvasRead.state === "loaded"
      ? migrateCanvasToScan(canvasRead.canvas, projectPath, scanFingerprint, project.files)
      : undefined;
    const graph = canvas ? { nodes: canvas.nodes, edges: canvas.edges } : inferredGraph;
    const written = canvasRead.state === "failed"
      ? await writeFlowWeaveProjectPreservingCanvas(projectPath, project, graph.nodes, graph.edges, scanFingerprint)
      : await writeFlowWeaveProject(projectPath, project, graph.nodes, graph.edges, scanFingerprint, canvas);
    await refreshConnectionWithoutFailing(projectId, projectPath);
    const artifacts: ProjectArtifactStatuses = {
      project: "current",
      canvas: canvasRead.state === "failed" ? "failed" : "current",
      task: "current",
      context: "current",
      architecture: await artifactStateForFingerprint(projectPath, "architecture-map.json", scanFingerprint),
      sequences: await artifactStateForFingerprint(projectPath, "sequence-diagrams.json", scanFingerprint)
    };
    notify(updateOperation(started.operation.operationId, {
      stage: "completed",
      completed: total,
      total,
      failed: 0,
      message: "Project scan completed."
    }));
    return { canceled: false as const, projectId, scanFingerprint, artifacts, project, graph, written };
  } catch (error) {
    if (!started.signal.aborted) {
      notify(updateOperation(started.operation.operationId, {
        stage: "failed",
        completed: 0,
        total: 0,
        failed: 1,
        message: error instanceof Error ? error.message : String(error)
      }));
    }
    if (!started.signal.aborted) {
      await recordDiagnostic(projectPath, {
        category: "scan",
        code: "project-scan-failed",
        message: error instanceof Error ? error.message : String(error),
        context: { projectId }
      });
    }
    throw error;
  } finally {
    finishOperation(started.operation.operationId);
  }
}

function requireScanOptions(channel: string, value: unknown): ProjectScanOptions {
  const options = requireObject(channel, value, "options");
  return {
    maxEntries: requireInteger(channel, options.maxEntries, "maxEntries", 1_000, 100_000),
    concurrency: requireInteger(channel, options.concurrency, "concurrency", 1, 128)
  };
}

async function runTrackedAnalysis<T>(
  kind: AnalysisOperation["kind"],
  message: string,
  sender: WebContents,
  task: (signal: AbortSignal, onProgress: (progress: AnalysisProgressUpdate) => void) => Promise<T>,
  projectPath: string
): Promise<T> {
  const started = startOperation(kind, message);
  const notify = (operation: AnalysisOperation) => {
    if (!sender.isDestroyed()) sender.send(PROJECT_CHANNELS.operationProgress, operation);
  };
  notify(started.operation);
  try {
    const result = await task(
      started.signal,
      (progress) => notify(updateOperation(started.operation.operationId, progress))
    );
    notify(updateOperation(started.operation.operationId, {
      stage: "completed",
      completed: 1,
      total: 1,
      failed: 0,
      message: "Analysis completed."
    }));
    return result;
  } catch (error) {
    if (!started.signal.aborted) {
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
    }
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
    return { state: "loaded", canvas: JSON.parse(await readFile(path, "utf8")) as CodeflowCanvas };
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
    if (artifact.source === "fallback") return "missing";
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

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

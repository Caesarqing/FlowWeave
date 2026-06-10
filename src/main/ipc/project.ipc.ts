import { dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_CHANNELS } from "../../common/ipc-channels";
import type { CodeflowCanvas, ProjectArtifactState, ProjectArtifactStatuses, RuntimeAgentId, ToolId } from "../../types";
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
import { generateSequenceDiagrams, readSequenceDiagrams, reviseSequenceDiagram } from "../services/sequence-diagram.service";
import { inferGraphFromProject } from "../services/task-generator.service";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { writeFlowWeaveProject, writeFlowWeaveProjectPreservingCanvas } from "../storage/flowweave-store";
import { requireEnum, requireObject, requireSafeId, requireString } from "./ipc-validation";

const TOOL_IDS = ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor", "mock"] as const;

export function registerProjectIpc() {
  ipcMain.handle(PROJECT_CHANNELS.openProject, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open project in FlowWeave" });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    const projectId = await registerProject(result.filePaths[0]);
    return scanAndPersistProject(projectId);
  });

  ipcMain.handle(PROJECT_CHANNELS.scanProject, (_event, projectId: unknown) =>
    scanAndPersistProject(requireString(PROJECT_CHANNELS.scanProject, projectId, "projectId")));

  ipcMain.handle(PROJECT_CHANNELS.analyzeProject, async (_event, projectId: unknown, toolId: unknown) => {
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.analyzeProject, projectId, "projectId"));
    return analyzeProject(await scanProject(projectPath), requireEnum(PROJECT_CHANNELS.analyzeProject, toolId, "toolId", TOOL_IDS) as ToolId);
  });

  ipcMain.handle(PROJECT_CHANNELS.analyzeArchitecture, (_event, projectId: unknown, toolId: unknown) =>
    analyzeArchitectureForProject(
      requireString(PROJECT_CHANNELS.analyzeArchitecture, projectId, "projectId"),
      requireEnum(PROJECT_CHANNELS.analyzeArchitecture, toolId, "toolId", TOOL_IDS)
    ));

  ipcMain.handle(PROJECT_CHANNELS.analyzeArchitectureWithAgent, (_event, projectId: unknown, agentId: unknown) =>
    analyzeArchitectureForProject(
      requireString(PROJECT_CHANNELS.analyzeArchitectureWithAgent, projectId, "projectId"),
      requireRuntimeAgentId(PROJECT_CHANNELS.analyzeArchitectureWithAgent, agentId)
    ));

  ipcMain.handle(PROJECT_CHANNELS.readArchitectureMap, (_event, projectId: unknown) =>
    readArchitectureMap(resolveProjectPath(requireString(PROJECT_CHANNELS.readArchitectureMap, projectId, "projectId"))));

  ipcMain.handle(PROJECT_CHANNELS.generateSequenceDiagrams, async (_event, projectId: unknown, agentId: unknown) => {
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.generateSequenceDiagrams, projectId, "projectId"));
    return generateSequenceDiagrams(await scanProject(projectPath), requireRuntimeAgentId(PROJECT_CHANNELS.generateSequenceDiagrams, agentId));
  });

  ipcMain.handle(PROJECT_CHANNELS.reviseSequenceDiagram, async (_event, projectId: unknown, agentId: unknown, kind: unknown, instruction: unknown) => {
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.reviseSequenceDiagram, projectId, "projectId"));
    return reviseSequenceDiagram(
      await scanProject(projectPath),
      requireRuntimeAgentId(PROJECT_CHANNELS.reviseSequenceDiagram, agentId),
      requireEnum(PROJECT_CHANNELS.reviseSequenceDiagram, kind, "kind", ["architectural", "detailed-design"]),
      requireString(PROJECT_CHANNELS.reviseSequenceDiagram, instruction, "instruction")
    );
  });

  ipcMain.handle(PROJECT_CHANNELS.readSequenceDiagrams, (_event, projectId: unknown) =>
    readSequenceDiagrams(resolveProjectPath(requireString(PROJECT_CHANNELS.readSequenceDiagrams, projectId, "projectId"))));

  ipcMain.handle(PROJECT_CHANNELS.readFile, async (_event, projectId: unknown, filePath: unknown) =>
    readFile(await resolveProjectFile(
      requireString(PROJECT_CHANNELS.readFile, projectId, "projectId"),
      requireString(PROJECT_CHANNELS.readFile, filePath, "filePath")
    ), "utf8"));

  ipcMain.handle(PROJECT_CHANNELS.saveDoc, async (_event, projectId: unknown, docId: unknown, content: unknown) => {
    const projectPath = resolveProjectPath(requireString(PROJECT_CHANNELS.saveDoc, projectId, "projectId"));
    const safeDocId = requireSafeId(PROJECT_CHANNELS.saveDoc, docId, "docId");
    const docsDir = join(projectPath, FLOWWEAVE_DIR, "docs");
    await mkdir(docsDir, { recursive: true });
    const docPath = join(docsDir, `${safeDocId}.md`);
    await writeFile(docPath, requireString(PROJECT_CHANNELS.saveDoc, content, "content"), "utf8");
    return docPath;
  });

  ipcMain.handle(PROJECT_CHANNELS.readCanvas, async (_event, projectId: unknown) => {
    const result = await readCanvasArtifactState(resolveProjectPath(requireString(PROJECT_CHANNELS.readCanvas, projectId, "projectId")));
    if (result.state === "failed") {
      throw new Error(`FlowWeave Canvas is unreadable and was preserved: ${result.error}`);
    }
    return result.state === "loaded" ? result.canvas : undefined;
  });

  ipcMain.handle(PROJECT_CHANNELS.saveCanvas, async (_event, projectId: unknown, canvas: unknown) => {
    const safeProjectId = requireString(PROJECT_CHANNELS.saveCanvas, projectId, "projectId");
    const projectPath = resolveProjectPath(safeProjectId);
    const value = requireObject(PROJECT_CHANNELS.saveCanvas, canvas, "canvas") as Partial<CodeflowCanvas>;
    if (value.version !== 2 || value.artifactState !== "current") {
      throw new Error(`[${PROJECT_CHANNELS.saveCanvas}] Only a current Canvas v2 can be saved.`);
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

  ipcMain.handle(PROJECT_CHANNELS.getAgentConnection, (_event, projectId: unknown) =>
    getProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.getAgentConnection, projectId, "projectId"))));
  ipcMain.handle(PROJECT_CHANNELS.enableAgentConnection, (_event, projectId: unknown) =>
    enableProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.enableAgentConnection, projectId, "projectId"))));
  ipcMain.handle(PROJECT_CHANNELS.refreshAgentConnection, (_event, projectId: unknown) =>
    refreshProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.refreshAgentConnection, projectId, "projectId"))));
  ipcMain.handle(PROJECT_CHANNELS.disableAgentConnection, (_event, projectId: unknown) =>
    disableProjectAgentConnection(resolveProjectPath(requireString(PROJECT_CHANNELS.disableAgentConnection, projectId, "projectId"))));
  ipcMain.handle(PROJECT_CHANNELS.openAgentConnection, async (_event, projectId: unknown) => {
    const path = getProjectAgentContextPath(resolveProjectPath(requireString(PROJECT_CHANNELS.openAgentConnection, projectId, "projectId")));
    const error = await shell.openPath(path);
    if (error) throw new Error(`Opening FlowWeave Agent context failed: ${error}`);
  });
}

async function analyzeArchitectureForProject(projectId: string, agentId: RuntimeAgentId) {
  const projectPath = resolveProjectPath(projectId);
  return analyzeArchitecture(await scanProject(projectPath), agentId);
}

async function scanAndPersistProject(projectId: string) {
  const projectPath = resolveProjectPath(projectId);
  const project = await scanProject(projectPath);
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
  return { canceled: false as const, projectId, scanFingerprint, artifacts, project, graph, written };
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

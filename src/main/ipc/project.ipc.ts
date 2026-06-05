import { dialog, ipcMain } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { PROJECT_CHANNELS } from "../../common/ipc-channels";
import type { CodeflowCanvas, RuntimeAgentId, ToolId } from "../../types";
import { analyzeProject } from "../services/agent-analysis.service";
import { refreshAgentConnectorsFromProject, writeAgentConnectors } from "../services/agent-connector.service";
import { analyzeArchitecture, readArchitectureMap } from "../services/architecture-analysis.service";
import { generateSequenceDiagrams, readSequenceDiagrams, reviseSequenceDiagram } from "../services/sequence-diagram.service";
import { inferGraphFromProject } from "../services/task-generator.service";
import { scanProject } from "../services/project-scanner.service";
import { writeFlowWeaveProject } from "../storage/flowweave-store";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

export function registerProjectIpc() {
  ipcMain.handle(PROJECT_CHANNELS.openProject, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Open project in FlowWeave"
    });

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true as const };
    }

    return scanAndPersistProject(result.filePaths[0]);
  });

  ipcMain.handle(PROJECT_CHANNELS.scanProject, async (_event, projectPath: string) => {
    return scanAndPersistProject(projectPath);
  });

  ipcMain.handle(PROJECT_CHANNELS.analyzeProject, async (_event, projectPath: string, toolId: ToolId) => {
    const project = await scanProject(projectPath);
    return analyzeProject(project, toolId);
  });

  ipcMain.handle(PROJECT_CHANNELS.analyzeArchitecture, async (_event, projectPath: string, toolId: ToolId) => {
    const project = await scanProject(projectPath);
    const result = await analyzeArchitecture(project, toolId);
    await writeAgentConnectors({ project, modules: result.graph.nodes, edges: result.graph.edges });
    return result;
  });

  ipcMain.handle(PROJECT_CHANNELS.analyzeArchitectureWithAgent, async (_event, projectPath: string, agentId: RuntimeAgentId) => {
    const project = await scanProject(projectPath);
    const result = await analyzeArchitecture(project, agentId);
    await writeAgentConnectors({ project, modules: result.graph.nodes, edges: result.graph.edges });
    return result;
  });

  ipcMain.handle(PROJECT_CHANNELS.readArchitectureMap, async (_event, projectPath: string) => {
    return readArchitectureMap(projectPath);
  });

  ipcMain.handle(PROJECT_CHANNELS.generateSequenceDiagrams, async (_event, projectPath: string, agentId: RuntimeAgentId) => {
    const project = await scanProject(projectPath);
    const result = await generateSequenceDiagrams(project, agentId);
    await refreshAgentConnectorsFromProject(projectPath);
    return result;
  });

  ipcMain.handle(PROJECT_CHANNELS.reviseSequenceDiagram, async (_event, projectPath: string, agentId: RuntimeAgentId, kind: "architectural" | "detailed-design", instruction: string) => {
    const project = await scanProject(projectPath);
    const result = await reviseSequenceDiagram(project, agentId, kind, instruction);
    await refreshAgentConnectorsFromProject(projectPath);
    return result;
  });

  ipcMain.handle(PROJECT_CHANNELS.readSequenceDiagrams, async (_event, projectPath: string) => {
    return readSequenceDiagrams(projectPath);
  });

  ipcMain.handle(PROJECT_CHANNELS.readFile, async (_event, projectPath: string, filePath: string) => {
    const absolutePath = safeJoin(projectPath, filePath);
    return readFile(absolutePath, "utf8");
  });

  ipcMain.handle(PROJECT_CHANNELS.saveDoc, async (_event, projectPath: string, docId: string, content: string) => {
    const docsDir = join(projectPath, FLOWWEAVE_DIR, "docs");
    await mkdir(docsDir, { recursive: true });
    const safeDocId = docId.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "") || "doc";
    const docPath = join(docsDir, `${safeDocId}.md`);
    await writeFile(docPath, content, "utf8");
    return docPath;
  });

  ipcMain.handle(PROJECT_CHANNELS.readCanvas, async (_event, projectPath: string) => {
    return readCanvasArtifact(projectPath);
  });

  ipcMain.handle(PROJECT_CHANNELS.saveCanvas, async (_event, projectPath: string, canvas: CodeflowCanvas) => {
    const canvasDir = join(projectPath, FLOWWEAVE_DIR, "canvas");
    await mkdir(canvasDir, { recursive: true });
    const canvasPath = join(canvasDir, "main.canvas.json");
    await writeFile(canvasPath, `${JSON.stringify(canvas, null, 2)}\n`, "utf8");
    await refreshAgentConnectorsFromProject(projectPath).catch(async () => {
      const project = await scanProject(projectPath);
      await writeAgentConnectors({ project, modules: canvas.nodes, edges: canvas.edges, canvasPath });
    });
    return canvasPath;
  });
}

async function scanAndPersistProject(projectPath: string) {
  const project = await scanProject(projectPath);
  const inferredGraph = await inferGraphFromProject(project);
  const persistedCanvas = await readCanvasArtifact(projectPath);
  const graph = persistedCanvas ? { nodes: persistedCanvas.nodes, edges: persistedCanvas.edges } : inferredGraph;
  const written = await writeFlowWeaveProject(projectPath, project, graph.nodes, graph.edges);
  return {
    canceled: false as const,
    project,
    graph,
    written
  };
}

function readCanvasArtifact(projectPath: string) {
  const canvasPath = join(projectPath, FLOWWEAVE_DIR, "canvas", "main.canvas.json");
  return readFile(canvasPath, "utf8")
    .then((content) => JSON.parse(content) as CodeflowCanvas)
    .catch(() => undefined);
}

function safeJoin(rootPath: string, filePath: string) {
  const normalizedRoot = normalize(rootPath);
  const absolutePath = normalize(join(rootPath, ...filePath.split("/")));
  if (absolutePath !== normalizedRoot && !absolutePath.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("File path escapes project root.");
  }
  return absolutePath;
}

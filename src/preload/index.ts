import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentAnalysisResult,
  AgentDefinition,
  AgentId,
  ArchitectureAnalysisResult,
  ArchitectureMap,
  CodeflowCanvas,
  CustomAgentInput,
  GitDiffResult,
  GitStatus,
  FlowWeaveProjectOpenResult,
  SequenceDiagramBundle,
  SequenceDiagramGenerationResult,
  SequenceDiagramKind,
  ToolDetectionResult,
  ToolId,
  ToolOpenResult,
  ToolRunArtifact,
  ToolRunSummary
} from "../types";
import type { StartToolPlanOptions, StartToolPlanResult } from "../main/services/agent-run.service";
import { GIT_CHANNELS, PROJECT_CHANNELS, TOOL_CHANNELS } from "../common/ipc-channels";

const flowweaveApi = {
  listAgents: () => ipcRenderer.invoke(TOOL_CHANNELS.listAgents) as Promise<AgentDefinition[]>,
  saveCustomAgent: (input: CustomAgentInput) =>
    ipcRenderer.invoke(TOOL_CHANNELS.saveCustomAgent, input) as Promise<AgentDefinition>,
  deleteCustomAgent: (agentId: AgentId) => ipcRenderer.invoke(TOOL_CHANNELS.deleteCustomAgent, agentId) as Promise<void>,
  detectAgent: (agentId: AgentId | "mock") => ipcRenderer.invoke(TOOL_CHANNELS.detectAgent, agentId) as Promise<ToolDetectionResult>,
  detectTool: (toolId: ToolId) => ipcRenderer.invoke(TOOL_CHANNELS.detect, toolId) as Promise<ToolDetectionResult>,
  openProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.openProject) as Promise<FlowWeaveProjectOpenResult>,
  openToolProject: (toolId: ToolId, projectId: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.openProject, toolId, projectId) as Promise<ToolOpenResult>,
  runToolPlan: (options: StartToolPlanOptions) =>
    ipcRenderer.invoke(TOOL_CHANNELS.runPlan, options) as Promise<StartToolPlanResult>,
  listToolRuns: (projectId: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.listRuns, projectId) as Promise<ToolRunSummary[]>,
  readToolRun: (projectId: string, runId: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.readRun, projectId, runId) as Promise<ToolRunArtifact>,
  scanProject: (projectId: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.scanProject, projectId) as Promise<FlowWeaveProjectOpenResult>,
  gitStatus: (projectId: string) => ipcRenderer.invoke(GIT_CHANNELS.status, projectId) as Promise<GitStatus>,
  gitDiff: (projectId: string, checkpointId?: string) =>
    ipcRenderer.invoke(GIT_CHANNELS.diff, projectId, checkpointId) as Promise<GitDiffResult>,
  gitCheckpoint: (projectId: string) => ipcRenderer.invoke(GIT_CHANNELS.checkpoint, projectId) as Promise<string>,
  gitRollback: (projectId: string, checkpointId: string) =>
    ipcRenderer.invoke(GIT_CHANNELS.rollback, projectId, checkpointId) as Promise<void>,
  analyzeProject: (projectId: string, toolId: ToolId) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.analyzeProject, projectId, toolId) as Promise<AgentAnalysisResult>,
  analyzeArchitecture: (projectId: string, toolId: ToolId) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.analyzeArchitecture, projectId, toolId) as Promise<ArchitectureAnalysisResult>,
  analyzeArchitectureWithAgent: (projectId: string, agentId: AgentId | "mock") =>
    ipcRenderer.invoke(PROJECT_CHANNELS.analyzeArchitectureWithAgent, projectId, agentId) as Promise<ArchitectureAnalysisResult>,
  readArchitectureMap: (projectId: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.readArchitectureMap, projectId) as Promise<ArchitectureMap | undefined>,
  generateSequenceDiagrams: (projectId: string, agentId: AgentId | "mock") =>
    ipcRenderer.invoke(PROJECT_CHANNELS.generateSequenceDiagrams, projectId, agentId) as Promise<SequenceDiagramGenerationResult>,
  reviseSequenceDiagram: (projectId: string, agentId: AgentId | "mock", kind: SequenceDiagramKind, instruction: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.reviseSequenceDiagram, projectId, agentId, kind, instruction) as Promise<SequenceDiagramBundle>,
  readSequenceDiagrams: (projectId: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.readSequenceDiagrams, projectId) as Promise<SequenceDiagramBundle | undefined>,
  readProjectFile: (projectId: string, filePath: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.readFile, projectId, filePath) as Promise<string>,
  saveFlowWeaveDoc: (projectId: string, docId: string, content: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.saveDoc, projectId, docId, content) as Promise<string>,
  readCanvas: (projectId: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.readCanvas, projectId) as Promise<CodeflowCanvas | undefined>,
  saveCanvas: (projectId: string, canvas: CodeflowCanvas) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.saveCanvas, projectId, canvas) as Promise<string>,
  getProjectAgentConnection: (projectId: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.getAgentConnection, projectId),
  enableProjectAgentConnection: (projectId: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.enableAgentConnection, projectId),
  refreshProjectAgentConnection: (projectId: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.refreshAgentConnection, projectId),
  disableProjectAgentConnection: (projectId: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.disableAgentConnection, projectId),
  openProjectAgentConnection: (projectId: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.openAgentConnection, projectId)
};

contextBridge.exposeInMainWorld("flowweave", flowweaveApi);

export type FlowWeaveApi = typeof flowweaveApi;

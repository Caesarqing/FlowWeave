import { contextBridge, ipcRenderer as electronIpcRenderer } from "electron";
import type {
  AgentAnalysisResult,
  AgentPluginHostId,
  AnalysisOperation,
  AgentDefinition,
  AgentReadinessResult,
  AgentId,
  ArchitectureAnalysisResult,
  ArchitectureMap,
  ArchitectureReviewEvent,
  CodeflowCanvas,
  CustomAgentInput,
  GitDiffResult,
  GitStatus,
  FlowWeaveProjectOpenResult,
  FlowWeaveErrorData,
  ProjectScanOptions,
  SequenceReviewEvent,
  RuntimeAgentId,
  SequenceDiagramBundle,
  SequenceDiagramGenerationResult,
  ToolDetectionResult,
  ToolId,
  ToolOpenResult,
  ToolRunArtifact,
  ToolRunSummary,
  AgentPluginStatus,
  AgentDiscoveryResult
} from "../types";
import type { StartToolPlanOptions, StartToolPlanResult } from "../main/services/agent-run.service";
import { GIT_CHANNELS, PROJECT_CHANNELS, TOOL_CHANNELS } from "../common/ipc-channels";
import { shouldBroadcastFlowWeaveError } from "../main/services/flowweave-error.service";

const FLOWWEAVE_ERROR_PREFIX = "FLOWWEAVE_ERROR:";
const flowweaveErrorListeners = new Set<(error: FlowWeaveErrorData) => void>();
const ipcRenderer = {
  invoke: invokeFlowWeave,
  on: electronIpcRenderer.on.bind(electronIpcRenderer),
  removeListener: electronIpcRenderer.removeListener.bind(electronIpcRenderer)
};

const flowweaveApi = {
  onFlowWeaveError: (listener: (error: FlowWeaveErrorData) => void) => {
    flowweaveErrorListeners.add(listener);
    return () => flowweaveErrorListeners.delete(listener);
  },
  listAgents: () => ipcRenderer.invoke(TOOL_CHANNELS.listAgents) as Promise<AgentDefinition[]>,
  discoverAgents: (projectId?: string) => ipcRenderer.invoke(TOOL_CHANNELS.discoverAgents, projectId) as Promise<AgentDiscoveryResult[]>,
  saveCustomAgent: (input: CustomAgentInput) =>
    ipcRenderer.invoke(TOOL_CHANNELS.saveCustomAgent, input) as Promise<AgentDefinition>,
  deleteCustomAgent: (agentId: AgentId) => ipcRenderer.invoke(TOOL_CHANNELS.deleteCustomAgent, agentId) as Promise<void>,
  detectAgent: (agentId: AgentId | "mock", projectId?: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.detectAgent, agentId, projectId) as Promise<ToolDetectionResult>,
  healthCheckAgent: (agentId: AgentId | "mock", projectId?: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.healthCheckAgent, agentId, projectId) as Promise<AgentReadinessResult>,
  detectTool: (toolId: ToolId) => ipcRenderer.invoke(TOOL_CHANNELS.detect, toolId) as Promise<ToolDetectionResult>,
  openProject: (options: ProjectScanOptions) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.openProject, options) as Promise<FlowWeaveProjectOpenResult>,
  listRegisteredProjects: () =>
    ipcRenderer.invoke(PROJECT_CHANNELS.listRegisteredProjects) as Promise<import("../types").RegisteredProject[]>,
  restoreRegisteredProject: (projectId: string, options: ProjectScanOptions) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.restoreRegisteredProject, projectId, options) as Promise<FlowWeaveProjectOpenResult>,
  readProjectWorkspaceSession: () =>
    ipcRenderer.invoke(PROJECT_CHANNELS.readWorkspaceSession) as Promise<import("../types").ProjectWorkspaceSession>,
  saveProjectWorkspaceSession: (session: import("../types").ProjectWorkspaceSession) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.saveWorkspaceSession, session) as Promise<void>,
  openToolProject: (agentId: RuntimeAgentId, projectId: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.openProject, agentId, projectId) as Promise<ToolOpenResult>,
  getAgentPluginStatuses: (projectId: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.getAgentPluginStatuses, projectId) as Promise<AgentPluginStatus[]>,
  installAgentPlugin: (projectId: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.installAgentPlugin, projectId) as Promise<AgentPluginStatus[]>,
  openAgentPlugin: (projectId: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.openAgentPlugin, projectId) as Promise<void>,
  openAgentPluginInstructions: (projectId: string, hostId: AgentPluginHostId) =>
    ipcRenderer.invoke(TOOL_CHANNELS.openAgentPluginInstructions, projectId, hostId) as Promise<void>,
  runToolPlan: (options: StartToolPlanOptions) =>
    ipcRenderer.invoke(TOOL_CHANNELS.runPlan, options) as Promise<StartToolPlanResult>,
  listToolRuns: (projectId: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.listRuns, projectId) as Promise<ToolRunSummary[]>,
  readToolRun: (projectId: string, runId: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.readRun, projectId, runId) as Promise<ToolRunArtifact>,
  applyRunArtifact: (projectId: string, runId: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.applyRunArtifact, projectId, runId) as Promise<ToolRunSummary>,
  openAgentInbox: (projectId: string, runId: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.openAgentInbox, projectId, runId) as Promise<void>,
  openRunBridge: (projectId: string, runId: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.openRunBridge, projectId, runId) as Promise<void>,
  scanProject: (projectId: string, options: ProjectScanOptions) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.scanProject, projectId, options) as Promise<FlowWeaveProjectOpenResult>,
  cancelOperation: (operationId: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.cancelOperation, operationId) as Promise<AnalysisOperation>,
  onOperationProgress: (listener: (operation: AnalysisOperation) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, operation: AnalysisOperation) => listener(operation);
    ipcRenderer.on(PROJECT_CHANNELS.operationProgress, handler);
    return () => ipcRenderer.removeListener(PROJECT_CHANNELS.operationProgress, handler);
  },
  onArchitectureReview: (listener: (event: ArchitectureReviewEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, reviewEvent: ArchitectureReviewEvent) => listener(reviewEvent);
    ipcRenderer.on(PROJECT_CHANNELS.architectureReview, handler);
    return () => ipcRenderer.removeListener(PROJECT_CHANNELS.architectureReview, handler);
  },
  onSequenceReview: (listener: (event: SequenceReviewEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, reviewEvent: SequenceReviewEvent) => listener(reviewEvent);
    ipcRenderer.on(PROJECT_CHANNELS.sequenceReview, handler);
    return () => ipcRenderer.removeListener(PROJECT_CHANNELS.sequenceReview, handler);
  },
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
  generateSequenceDiagrams: (projectId: string, agentId: AgentId | "mock", planTimeoutMs?: number) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.generateSequenceDiagrams, projectId, agentId, planTimeoutMs) as Promise<SequenceDiagramGenerationResult>,
  reviseSequenceDiagram: (projectId: string, agentId: AgentId | "mock", instruction: string, planTimeoutMs?: number) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.reviseSequenceDiagram, projectId, agentId, instruction, planTimeoutMs) as Promise<SequenceDiagramBundle>,
  readSequenceDiagrams: (projectId: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.readSequenceDiagrams, projectId) as Promise<SequenceDiagramBundle | undefined>,
  readProjectFile: (projectId: string, filePath: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.readFile, projectId, filePath) as Promise<string | undefined>,
  saveFlowWeaveDoc: (projectId: string, docId: string, content: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.saveDoc, projectId, docId, content) as Promise<string>,
  saveModificationDocs: (projectId: string, sequenceInstruction?: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.saveModificationDocs, projectId, sequenceInstruction) as Promise<{
      guidancePath: string;
      contextPath: string;
    }>,
  readModificationDelta: (projectId: string, sequenceInstruction?: string, canvas?: CodeflowCanvas) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.readModificationDelta, projectId, sequenceInstruction, canvas) as Promise<import("../types").ModificationDeltaResult>,
  acknowledgeModificationChanges: (
    projectId: string,
    snapshot: import("../types").ModificationSnapshot,
    scope: import("../types").ModificationAcknowledgementScope
  ) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.acknowledgeModificationChanges, projectId, snapshot, scope) as Promise<import("../types").ModificationBaseline>,
  readCanvas: (projectId: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.readCanvas, projectId) as Promise<CodeflowCanvas | undefined>,
  saveCanvas: (projectId: string, canvas: CodeflowCanvas, options?: { allowStaleNoop?: boolean }) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.saveCanvas, projectId, canvas, options) as Promise<string>,
  exportDiagnostics: (projectId: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.exportDiagnostics, projectId) as Promise<string>,
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

async function invokeFlowWeave(channel: string, ...args: unknown[]): Promise<unknown> {
  try {
    return await electronIpcRenderer.invoke(channel, ...args);
  } catch (error) {
    const data = parseFlowWeaveError(error);
    if (!data) throw error;
    if (shouldBroadcastFlowWeaveError(data)) {
      flowweaveErrorListeners.forEach((listener) => listener(data));
    }
    throw new FlowWeaveClientError(data);
  }
}

class FlowWeaveClientError extends Error {
  readonly code: string;
  readonly category: FlowWeaveErrorData["category"];
  readonly context: FlowWeaveErrorData["context"];
  readonly suggestedActions: string[];
  readonly technicalDetails?: string;

  constructor(data: FlowWeaveErrorData) {
    super(data.message);
    this.name = "FlowWeaveClientError";
    this.code = data.code;
    this.category = data.category;
    this.context = data.context;
    this.suggestedActions = data.suggestedActions;
    this.technicalDetails = data.technicalDetails;
  }
}

function parseFlowWeaveError(error: unknown): FlowWeaveErrorData | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const index = message.indexOf(FLOWWEAVE_ERROR_PREFIX);
  if (index < 0) return undefined;
  try {
    return JSON.parse(message.slice(index + FLOWWEAVE_ERROR_PREFIX.length)) as FlowWeaveErrorData;
  } catch {
    return undefined;
  }
}

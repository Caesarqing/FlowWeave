import { contextBridge, ipcRenderer } from "electron";
import type { AgentAnalysisResult, CodeflowCanvas, GitDiffResult, GitStatus, FlowWeaveProjectOpenResult, ToolDetectionResult, ToolId, ToolOpenResult } from "../types";
import type { StartToolPlanOptions, StartToolPlanResult } from "../main/services/agent-run.service";
import { GIT_CHANNELS, PROJECT_CHANNELS, TOOL_CHANNELS } from "../common/ipc-channels";

const flowweaveApi = {
  detectTool: (toolId: ToolId) => ipcRenderer.invoke(TOOL_CHANNELS.detect, toolId) as Promise<ToolDetectionResult>,
  openProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.openProject) as Promise<FlowWeaveProjectOpenResult>,
  openToolProject: (toolId: ToolId, projectPath: string) =>
    ipcRenderer.invoke(TOOL_CHANNELS.openProject, toolId, projectPath) as Promise<ToolOpenResult>,
  runToolPlan: (options: StartToolPlanOptions) =>
    ipcRenderer.invoke(TOOL_CHANNELS.runPlan, options) as Promise<StartToolPlanResult>,
  scanProject: (projectPath: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.scanProject, projectPath) as Promise<FlowWeaveProjectOpenResult>,
  gitStatus: (projectPath: string) => ipcRenderer.invoke(GIT_CHANNELS.status, projectPath) as Promise<GitStatus>,
  gitDiff: (projectPath: string, checkpointId?: string) =>
    ipcRenderer.invoke(GIT_CHANNELS.diff, projectPath, checkpointId) as Promise<GitDiffResult>,
  gitCheckpoint: (projectPath: string) => ipcRenderer.invoke(GIT_CHANNELS.checkpoint, projectPath) as Promise<string>,
  gitRollback: (projectPath: string, checkpointId: string) =>
    ipcRenderer.invoke(GIT_CHANNELS.rollback, projectPath, checkpointId) as Promise<void>,
  analyzeProject: (projectPath: string, toolId: ToolId) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.analyzeProject, projectPath, toolId) as Promise<AgentAnalysisResult>,
  readProjectFile: (projectPath: string, filePath: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.readFile, projectPath, filePath) as Promise<string>,
  saveFlowWeaveDoc: (projectPath: string, docId: string, content: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.saveDoc, projectPath, docId, content) as Promise<string>,
  readCanvas: (projectPath: string) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.readCanvas, projectPath) as Promise<CodeflowCanvas | undefined>,
  saveCanvas: (projectPath: string, canvas: CodeflowCanvas) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.saveCanvas, projectPath, canvas) as Promise<string>
};

contextBridge.exposeInMainWorld("flowweave", flowweaveApi);

export type FlowWeaveApi = typeof flowweaveApi;

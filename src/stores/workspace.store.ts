import { create } from "zustand";
import type { Edge, NodeChange } from "@xyflow/react";
import type {
  ActivePage,
  AgentDefinition,
  AgentId,
  CodeflowCanvas,
  GitDiffResult,
  GitStatus,
  GraphEdge,
  GraphNode,
  ProjectFileNode,
  RuntimeAgentId,
  ExecutionMode,
  ToolRunArtifact,
  ToolRunSummary,
  ToolUiStatus
} from "../types";
import { createFlowEdge, createFlowNode, graphEdgeFromFlow, type FlowWeaveNode } from "../utils/graph-converters";

export type RunArtifactTab = "prompt" | "plan" | "log" | "result";

type WorkspaceState = {
  activePage: ActivePage;
  projectLabel: string;
  projectPath: string;
  projectStatus: string;
  isProjectLoading: boolean;
  modules: GraphNode[];
  edges: Edge[];
  nodes: FlowWeaveNode[];
  projectFiles: ProjectFileNode[];
  expandedPaths: Set<string>;
  selectedNodeId: string;
  agents: AgentDefinition[];
  selectedAgentId: AgentId;
  executionMode: ExecutionMode;
  toolStatuses: Record<string, ToolUiStatus>;
  lastRunStatus: string;
  runs: ToolRunSummary[];
  selectedRunId: string;
  selectedRunArtifact?: ToolRunArtifact;
  runArtifactTab: RunArtifactTab;
  isRunsLoading: boolean;
  checkpointId: string;
  diff?: GitDiffResult;
  gitStatus?: GitStatus;
  setActivePage: (activePage: ActivePage) => void;
  setProjectLabel: (projectLabel: string) => void;
  setProjectPath: (projectPath: string) => void;
  setProjectStatus: (projectStatus: string) => void;
  setIsProjectLoading: (isProjectLoading: boolean) => void;
  setGraph: (modules: GraphNode[], edges: GraphEdge[], files: ProjectFileNode[]) => void;
  setEdges: (updater: Edge[] | ((edges: Edge[]) => Edge[])) => void;
  setNodes: (updater: FlowWeaveNode[] | ((nodes: FlowWeaveNode[]) => FlowWeaveNode[])) => void;
  setSelectedNodeId: (selectedNodeId: string) => void;
  togglePath: (path: string) => void;
  updateModule: (nodeId: string, update: (node: GraphNode) => GraphNode) => void;
  syncNodePositions: (changes: NodeChange<FlowWeaveNode>[]) => void;
  setAgents: (agents: AgentDefinition[]) => void;
  setSelectedAgentId: (selectedAgentId: AgentId) => void;
  setExecutionMode: (executionMode: ExecutionMode) => void;
  setToolStatuses: (updater: Record<string, ToolUiStatus> | ((current: Record<string, ToolUiStatus>) => Record<string, ToolUiStatus>)) => void;
  setLastRunStatus: (lastRunStatus: string) => void;
  setRuns: (runs: ToolRunSummary[]) => void;
  setSelectedRunId: (selectedRunId: string) => void;
  setSelectedRunArtifact: (selectedRunArtifact?: ToolRunArtifact) => void;
  setRunArtifactTab: (runArtifactTab: RunArtifactTab) => void;
  setIsRunsLoading: (isRunsLoading: boolean) => void;
  setCheckpointId: (checkpointId: string) => void;
  setDiff: (diff?: GitDiffResult) => void;
  setGitStatus: (gitStatus?: GitStatus) => void;
  resetRuns: () => void;
  buildCanvasArtifact: () => CodeflowCanvas | undefined;
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  activePage: "canvas",
  projectLabel: "No project selected",
  projectPath: "",
  projectStatus: "Open a local backend project first. FlowWeave will read the file tree and generate module nodes.",
  isProjectLoading: false,
  modules: [],
  edges: [],
  nodes: [],
  projectFiles: [],
  expandedPaths: new Set(),
  selectedNodeId: "",
  agents: [],
  selectedAgentId: "claude-code",
  executionMode: "plan",
  toolStatuses: {
    "claude-code": createUnknownToolStatus("claude-code"),
    "claude-desktop": createUnknownToolStatus("claude-desktop"),
    "codex-local": createUnknownToolStatus("codex-local"),
    "codex-desktop": createUnknownToolStatus("codex-desktop"),
    "gemini-cli": createUnknownToolStatus("gemini-cli"),
    cursor: createUnknownToolStatus("cursor"),
    mock: createUnknownToolStatus("mock")
  },
  lastRunStatus: "Select a project before asking the default Agent to generate a plan.",
  runs: [],
  selectedRunId: "",
  runArtifactTab: "plan",
  isRunsLoading: false,
  checkpointId: "",
  setActivePage: (activePage) => set({ activePage }),
  setProjectLabel: (projectLabel) => set({ projectLabel }),
  setProjectPath: (projectPath) => set({ projectPath }),
  setProjectStatus: (projectStatus) => set({ projectStatus }),
  setIsProjectLoading: (isProjectLoading) => set({ isProjectLoading }),
  setGraph: (modules, edges, files) =>
    set({
      modules,
      edges: edges.map(createFlowEdge),
      nodes: modules.map(createFlowNode),
      projectFiles: files,
      expandedPaths: new Set(),
      selectedNodeId: modules[0]?.id ?? ""
    }),
  setEdges: (updater) => set((state) => ({ edges: typeof updater === "function" ? updater(state.edges) : updater })),
  setNodes: (updater) => set((state) => ({ nodes: typeof updater === "function" ? updater(state.nodes) : updater })),
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  togglePath: (path) =>
    set((state) => {
      const expandedPaths = new Set(state.expandedPaths);
      if (expandedPaths.has(path)) expandedPaths.delete(path);
      else expandedPaths.add(path);
      return { expandedPaths };
    }),
  updateModule: (nodeId, update) =>
    set((state) => {
      const modules = state.modules.map((node) => (node.id === nodeId ? update(node) : node));
      const nodes = state.nodes.map((node) => {
        const module = modules.find((item) => item.id === node.id);
        return module ? { ...node, data: { ...module } } : node;
      });
      return { modules, nodes };
    }),
  syncNodePositions: (changes) =>
    set((state) => {
      const positionChanges = changes.filter(
        (change): change is NodeChange<FlowWeaveNode> & { id: string; position: { x: number; y: number } } =>
          change.type === "position" && "position" in change && Boolean(change.position)
      );
      if (positionChanges.length === 0) return state;
      const modules = state.modules.map((module) => {
        const positionChange = positionChanges.find((change) => change.id === module.id);
        return positionChange ? { ...module, x: positionChange.position.x, y: positionChange.position.y } : module;
      });
      return { modules };
    }),
  setAgents: (agents) => set({ agents }),
  setSelectedAgentId: (selectedAgentId) => set({ selectedAgentId }),
  setExecutionMode: (executionMode) => set({ executionMode }),
  setToolStatuses: (updater) => set((state) => ({ toolStatuses: typeof updater === "function" ? updater(state.toolStatuses) : updater })),
  setLastRunStatus: (lastRunStatus) => set({ lastRunStatus }),
  setRuns: (runs) => set({ runs }),
  setSelectedRunId: (selectedRunId) => set({ selectedRunId }),
  setSelectedRunArtifact: (selectedRunArtifact) => set({ selectedRunArtifact }),
  setRunArtifactTab: (runArtifactTab) => set({ runArtifactTab }),
  setIsRunsLoading: (isRunsLoading) => set({ isRunsLoading }),
  setCheckpointId: (checkpointId) => set({ checkpointId }),
  setDiff: (diff) => set({ diff }),
  setGitStatus: (gitStatus) => set({ gitStatus }),
  resetRuns: () => set({ runs: [], selectedRunId: "", selectedRunArtifact: undefined, runArtifactTab: "plan" }),
  buildCanvasArtifact: () => {
    const state = get();
    if (!state.projectPath || state.modules.length === 0) return undefined;
    return {
      version: 1,
      id: "main",
      title: "Main Canvas",
      projectPath: state.projectPath,
      generatedAt: new Date().toISOString(),
      nodes: state.modules,
      edges: state.edges.map(graphEdgeFromFlow)
    };
  }
}));

export function currentWorkspaceGraphRelations() {
  return useWorkspaceStore.getState().edges.map(graphEdgeFromFlow);
}

function createUnknownToolStatus(toolId: RuntimeAgentId): ToolUiStatus {
  return {
    toolId,
    available: false,
    method: "none",
    checking: false
  };
}

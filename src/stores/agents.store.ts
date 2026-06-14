import { create } from "zustand";
import type {
  AgentDefinition,
  AgentId,
  AsyncOperationState,
  ExecutionMode,
  ProjectAgentConnectionStatus,
  RuntimeAgentId,
  ToolUiStatus
} from "../types";

type AgentState = {
  agents: AgentDefinition[];
  selectedAgentId: AgentId;
  executionMode: ExecutionMode;
  toolStatuses: Record<string, ToolUiStatus>;
  lastRunStatus: string;
  connection?: ProjectAgentConnectionStatus;
  connectionOperation: AsyncOperationState;
  setAgents: (agents: AgentDefinition[]) => void;
  setSelectedAgentId: (selectedAgentId: AgentId) => void;
  setExecutionMode: (executionMode: ExecutionMode) => void;
  setToolStatuses: (
    updater: Record<string, ToolUiStatus> | ((current: Record<string, ToolUiStatus>) => Record<string, ToolUiStatus>)
  ) => void;
  setLastRunStatus: (lastRunStatus: string) => void;
  setConnection: (connection?: ProjectAgentConnectionStatus) => void;
  setConnectionOperation: (connectionOperation: AsyncOperationState) => void;
};

export const useAgentStore = create<AgentState>((set) => ({
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
  connectionOperation: { status: "idle" },
  setAgents: (agents) => set({ agents }),
  setSelectedAgentId: (selectedAgentId) => set({ selectedAgentId }),
  setExecutionMode: (executionMode) => set({ executionMode }),
  setToolStatuses: (updater) => set((state) => ({
    toolStatuses: typeof updater === "function" ? updater(state.toolStatuses) : updater
  })),
  setLastRunStatus: (lastRunStatus) => set({ lastRunStatus }),
  setConnection: (connection) => set({ connection }),
  setConnectionOperation: (connectionOperation) => set({ connectionOperation })
}));

function createUnknownToolStatus(toolId: RuntimeAgentId): ToolUiStatus {
  return {
    toolId,
    available: false,
    method: "none",
    checking: false
  };
}

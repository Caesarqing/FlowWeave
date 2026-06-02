import { create } from "zustand";
import type { ExecutionMode, ToolId, ToolUiStatus } from "../types";

type ToolsState = {
  selectedToolId: ToolId;
  executionMode: ExecutionMode;
  toolStatuses: Record<ToolId, ToolUiStatus>;
  lastRunStatus: string;
  setSelectedToolId: (toolId: ToolId) => void;
  setExecutionMode: (mode: ExecutionMode) => void;
  setToolStatuses: (updater: Record<ToolId, ToolUiStatus> | ((current: Record<ToolId, ToolUiStatus>) => Record<ToolId, ToolUiStatus>)) => void;
  setLastRunStatus: (value: string) => void;
};

export const useToolsStore = create<ToolsState>((set) => ({
  selectedToolId: "codex-local",
  executionMode: "plan",
  toolStatuses: {
    "codex-local": createUnknownToolStatus("codex-local"),
    "claude-code": createUnknownToolStatus("claude-code"),
    cursor: createUnknownToolStatus("cursor"),
    mock: createUnknownToolStatus("mock")
  },
  lastRunStatus: "Select a project before asking the default Agent to generate a plan.",
  setSelectedToolId: (selectedToolId) => set({ selectedToolId }),
  setExecutionMode: (executionMode) => set({ executionMode }),
  setToolStatuses: (updater) => set((state) => ({ toolStatuses: typeof updater === "function" ? updater(state.toolStatuses) : updater })),
  setLastRunStatus: (lastRunStatus) => set({ lastRunStatus })
}));

function createUnknownToolStatus(toolId: ToolId): ToolUiStatus {
  return {
    toolId,
    available: false,
    method: "none",
    checking: false
  };
}

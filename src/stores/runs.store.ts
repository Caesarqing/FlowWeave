import { create } from "zustand";
import type { ToolRunArtifact, ToolRunSummary } from "../types";

export type RunArtifactTab = "prompt" | "plan" | "log" | "result";

type RunsState = {
  runs: ToolRunSummary[];
  selectedRunId: string;
  selectedRunArtifact?: ToolRunArtifact;
  runArtifactTab: RunArtifactTab;
  isRunsLoading: boolean;
  setRuns: (runs: ToolRunSummary[]) => void;
  setSelectedRunId: (selectedRunId: string) => void;
  setSelectedRunArtifact: (selectedRunArtifact?: ToolRunArtifact) => void;
  setRunArtifactTab: (runArtifactTab: RunArtifactTab) => void;
  setIsRunsLoading: (isRunsLoading: boolean) => void;
  resetRuns: () => void;
};

export const useRunsStore = create<RunsState>((set) => ({
  runs: [],
  selectedRunId: "",
  runArtifactTab: "plan",
  isRunsLoading: false,
  setRuns: (runs) => set({ runs }),
  setSelectedRunId: (selectedRunId) => set({ selectedRunId }),
  setSelectedRunArtifact: (selectedRunArtifact) => set({ selectedRunArtifact }),
  setRunArtifactTab: (runArtifactTab) => set({ runArtifactTab }),
  setIsRunsLoading: (isRunsLoading) => set({ isRunsLoading }),
  resetRuns: () => set({
    runs: [],
    selectedRunId: "",
    selectedRunArtifact: undefined,
    runArtifactTab: "plan"
  })
}));

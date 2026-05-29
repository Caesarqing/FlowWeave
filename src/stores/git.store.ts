import { create } from "zustand";
import type { GitDiffResult, GitStatus } from "../types";

type GitState = {
  checkpointId: string;
  diff?: GitDiffResult;
  status?: GitStatus;
  setCheckpointId: (checkpointId: string) => void;
  setDiff: (diff?: GitDiffResult) => void;
  setStatus: (status?: GitStatus) => void;
};

export const useGitStore = create<GitState>((set) => ({
  checkpointId: "",
  setCheckpointId: (checkpointId) => set({ checkpointId }),
  setDiff: (diff) => set({ diff }),
  setStatus: (status) => set({ status })
}));

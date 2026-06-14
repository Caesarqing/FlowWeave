import { create } from "zustand";
import type { ProjectArtifactStatuses } from "../types";

type ProjectState = {
  projectLabel: string;
  projectId: string;
  projectPath: string;
  scanFingerprint: string;
  artifactStatuses?: ProjectArtifactStatuses;
  projectStatus: string;
  isProjectLoading: boolean;
  setProjectLabel: (value: string) => void;
  setProjectId: (value: string) => void;
  setProjectPath: (value: string) => void;
  setScanFingerprint: (value: string) => void;
  setArtifactStatuses: (
    value: ProjectArtifactStatuses | ((current?: ProjectArtifactStatuses) => ProjectArtifactStatuses | undefined)
  ) => void;
  setProjectStatus: (value: string) => void;
  setIsProjectLoading: (value: boolean) => void;
};

export const useProjectStore = create<ProjectState>((set) => ({
  projectLabel: "No project selected",
  projectId: "",
  projectPath: "",
  scanFingerprint: "",
  projectStatus: "Open a local backend project first. FlowWeave will read the file tree and generate module nodes.",
  isProjectLoading: false,
  setProjectLabel: (projectLabel) => set({ projectLabel }),
  setProjectId: (projectId) => set({ projectId }),
  setProjectPath: (projectPath) => set({ projectPath }),
  setScanFingerprint: (scanFingerprint) => set({ scanFingerprint }),
  setArtifactStatuses: (value) => set((state) => ({
    artifactStatuses: typeof value === "function" ? value(state.artifactStatuses) : value
  })),
  setProjectStatus: (projectStatus) => set({ projectStatus }),
  setIsProjectLoading: (isProjectLoading) => set({ isProjectLoading })
}));

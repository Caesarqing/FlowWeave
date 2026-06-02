import { create } from "zustand";

type ProjectState = {
  projectLabel: string;
  projectPath: string;
  projectStatus: string;
  isProjectLoading: boolean;
  setProjectLabel: (value: string) => void;
  setProjectPath: (value: string) => void;
  setProjectStatus: (value: string) => void;
  setIsProjectLoading: (value: boolean) => void;
};

export const useProjectStore = create<ProjectState>((set) => ({
  projectLabel: "No project selected",
  projectPath: "",
  projectStatus: "Open a local backend project first. FlowWeave will read the file tree and generate module nodes.",
  isProjectLoading: false,
  setProjectLabel: (projectLabel) => set({ projectLabel }),
  setProjectPath: (projectPath) => set({ projectPath }),
  setProjectStatus: (projectStatus) => set({ projectStatus }),
  setIsProjectLoading: (isProjectLoading) => set({ isProjectLoading })
}));

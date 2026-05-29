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
  projectLabel: "未选择项目",
  projectPath: "",
  projectStatus: "请先打开一个本地后端项目，FlowWeave 会读取文件树并生成模块节点。",
  isProjectLoading: false,
  setProjectLabel: (projectLabel) => set({ projectLabel }),
  setProjectPath: (projectPath) => set({ projectPath }),
  setProjectStatus: (projectStatus) => set({ projectStatus }),
  setIsProjectLoading: (isProjectLoading) => set({ isProjectLoading })
}));

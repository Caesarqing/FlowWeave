import { create } from "zustand";
import type {
  ArchitectureRelationDiagnostic,
  ArchitectureReviewStatus,
  LocalGenerationStatus,
  ProjectArtifactStatuses,
  SequenceReviewStatus
} from "../types";

type ProjectState = {
  projectLabel: string;
  projectId: string;
  projectPath: string;
  scanFingerprint: string;
  relationDiagnostics: ArchitectureRelationDiagnostic[];
  artifactStatuses?: ProjectArtifactStatuses;
  architectureReview: ArchitectureReviewStatus;
  localGenerationStatus: LocalGenerationStatus;
  sequenceReview: SequenceReviewStatus;
  projectStatus: string;
  isProjectLoading: boolean;
  isCanvasTransitioning: boolean;
  setProjectLabel: (value: string) => void;
  setProjectId: (value: string) => void;
  setProjectPath: (value: string) => void;
  setScanFingerprint: (value: string) => void;
  setRelationDiagnostics: (value: ArchitectureRelationDiagnostic[]) => void;
  setArtifactStatuses: (
    value: ProjectArtifactStatuses | ((current?: ProjectArtifactStatuses) => ProjectArtifactStatuses | undefined)
  ) => void;
  setArchitectureReview: (
    value: ArchitectureReviewStatus | ((current: ArchitectureReviewStatus) => ArchitectureReviewStatus)
  ) => void;
  setLocalGenerationStatus: (value: LocalGenerationStatus) => void;
  setSequenceReview: (
    value: SequenceReviewStatus | ((current: SequenceReviewStatus) => SequenceReviewStatus)
  ) => void;
  setProjectStatus: (value: string) => void;
  setIsProjectLoading: (value: boolean) => void;
  setIsCanvasTransitioning: (value: boolean) => void;
};

export const useProjectStore = create<ProjectState>((set) => ({
  projectLabel: "No project selected",
  projectId: "",
  projectPath: "",
  scanFingerprint: "",
  relationDiagnostics: [],
  architectureReview: { state: "missing" },
  localGenerationStatus: "idle",
  sequenceReview: { state: "missing" },
  projectStatus: "Open a local backend project first. FlowWeave will read the file tree and generate module nodes.",
  isProjectLoading: false,
  isCanvasTransitioning: false,
  setProjectLabel: (projectLabel) => set({ projectLabel }),
  setProjectId: (projectId) => set({ projectId }),
  setProjectPath: (projectPath) => set({ projectPath }),
  setScanFingerprint: (scanFingerprint) => set({ scanFingerprint }),
  setRelationDiagnostics: (relationDiagnostics) => set({ relationDiagnostics }),
  setArtifactStatuses: (value) => set((state) => ({
    artifactStatuses: typeof value === "function" ? value(state.artifactStatuses) : value
  })),
  setArchitectureReview: (value) => set((state) => ({
    architectureReview: typeof value === "function" ? value(state.architectureReview) : value
  })),
  setLocalGenerationStatus: (localGenerationStatus) => set({ localGenerationStatus }),
  setSequenceReview: (value) => set((state) => ({
    sequenceReview: typeof value === "function" ? value(state.sequenceReview) : value
  })),
  setProjectStatus: (projectStatus) => set({ projectStatus }),
  setIsProjectLoading: (isProjectLoading) => set({ isProjectLoading }),
  setIsCanvasTransitioning: (isCanvasTransitioning) => set({ isCanvasTransitioning })
}));

export function canvasEditingEnabled(): boolean {
  const state = useProjectStore.getState();
  return Boolean(state.projectId && !state.isProjectLoading && !state.isCanvasTransitioning && state.artifactStatuses?.canvas === "current");
}

export function assertCanvasEditable(): void {
  if (!canvasEditingEnabled()) {
    const state = useProjectStore.getState();
    throw new Error(`Canvas is not editable: project ${state.projectId || "none"}, loading ${state.isProjectLoading}, switching ${state.isCanvasTransitioning}, artifact ${state.artifactStatuses?.canvas ?? "missing"}`);
  }
}

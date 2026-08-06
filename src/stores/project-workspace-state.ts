import type { CanvasLayoutState, ProjectWorkspaceContext } from '../types';
import { useAgentStore } from './agents.store';
import { useCanvasStore } from './canvas.store';
import { useNavigationStore } from './navigation.store';
import { useProjectStore } from './project.store';
import { useRunsStore } from './runs.store';
import { useGitStore } from './git.store';

type ProjectWorkspaceSnapshot = {
  project: {
    projectLabel: string;
    projectId: string;
    projectPath: string;
    scanFingerprint: string;
    artifactStatuses: ReturnType<typeof useProjectStore.getState>['artifactStatuses'];
    architectureReview: ReturnType<typeof useProjectStore.getState>['architectureReview'];
    sequenceReview: ReturnType<typeof useProjectStore.getState>['sequenceReview'];
    projectStatus: string;
    isProjectLoading: boolean;
  };
  canvas: {
    canvasLayout: CanvasLayoutState;
    modules: ReturnType<typeof useCanvasStore.getState>['modules'];
    edges: ReturnType<typeof useCanvasStore.getState>['edges'];
    nodes: ReturnType<typeof useCanvasStore.getState>['nodes'];
    projectFiles: ReturnType<typeof useCanvasStore.getState>['projectFiles'];
    expandedPaths: Set<string>;
    selectedNodeId: string;
  };
  navigation: {
    activePage: ReturnType<typeof useNavigationStore.getState>['activePage'];
  };
  runs: {
    runs: ReturnType<typeof useRunsStore.getState>['runs'];
    selectedRunId: string;
    selectedRunArtifact: ReturnType<typeof useRunsStore.getState>['selectedRunArtifact'];
    runArtifactTab: ReturnType<typeof useRunsStore.getState>['runArtifactTab'];
    isRunsLoading: boolean;
  };
  git: {
    checkpointId: string;
    diff: ReturnType<typeof useGitStore.getState>['diff'];
    status: ReturnType<typeof useGitStore.getState>['status'];
  };
  agent: {
    agents: ReturnType<typeof useAgentStore.getState>['agents'];
    selectedAgentId: ReturnType<typeof useAgentStore.getState>['selectedAgentId'];
    executionMode: ReturnType<typeof useAgentStore.getState>['executionMode'];
    toolStatuses: ReturnType<typeof useAgentStore.getState>['toolStatuses'];
    pluginStatuses: ReturnType<typeof useAgentStore.getState>['pluginStatuses'];
    lastRunStatus: string;
    connection: ReturnType<typeof useAgentStore.getState>['connection'];
    connectionOperation: ReturnType<typeof useAgentStore.getState>['connectionOperation'];
  };
};

export function captureProjectWorkspaceState(): ProjectWorkspaceSnapshot {
  const project = useProjectStore.getState();
  const canvas = useCanvasStore.getState();
  const navigation = useNavigationStore.getState();
  const runs = useRunsStore.getState();
  const git = useGitStore.getState();
  const agent = useAgentStore.getState();
  return structuredClone({
    project: {
      projectLabel: project.projectLabel,
      projectId: project.projectId,
      projectPath: project.projectPath,
      scanFingerprint: project.scanFingerprint,
      artifactStatuses: project.artifactStatuses,
      architectureReview: project.architectureReview,
      sequenceReview: project.sequenceReview,
      projectStatus: project.projectStatus,
      isProjectLoading: project.isProjectLoading
    },
    canvas: {
      canvasLayout: canvas.canvasLayout,
      modules: canvas.modules,
      edges: canvas.edges,
      nodes: canvas.nodes,
      projectFiles: canvas.projectFiles,
      expandedPaths: canvas.expandedPaths,
      selectedNodeId: canvas.selectedNodeId
    },
    navigation: { activePage: navigation.activePage },
    runs: {
      runs: runs.runs,
      selectedRunId: runs.selectedRunId,
      selectedRunArtifact: runs.selectedRunArtifact,
      runArtifactTab: runs.runArtifactTab,
      isRunsLoading: runs.isRunsLoading
    },
    git: {
      checkpointId: git.checkpointId,
      diff: git.diff,
      status: git.status
    },
    agent: {
      agents: agent.agents,
      selectedAgentId: agent.selectedAgentId,
      executionMode: agent.executionMode,
      toolStatuses: agent.toolStatuses,
      pluginStatuses: agent.pluginStatuses,
      lastRunStatus: agent.lastRunStatus,
      connection: agent.connection,
      connectionOperation: agent.connectionOperation
    }
  });
}

export function restoreProjectWorkspaceState(snapshot: ProjectWorkspaceSnapshot): void {
  useProjectStore.setState(snapshot.project);
  useCanvasStore.setState(snapshot.canvas);
  useNavigationStore.setState(snapshot.navigation);
  useRunsStore.setState(snapshot.runs);
  useGitStore.setState(snapshot.git);
  useAgentStore.setState(snapshot.agent);
}

export function capturePersistedProjectWorkspaceContext(): ProjectWorkspaceContext {
  const canvas = useCanvasStore.getState();
  const navigation = useNavigationStore.getState();
  const runs = useRunsStore.getState();
  const git = useGitStore.getState();
  const agent = useAgentStore.getState();
  return {
    activePage: navigation.activePage,
    expandedPaths: [...canvas.expandedPaths].sort(),
    selectedNodeId: canvas.selectedNodeId,
    selectedAgentId: agent.selectedAgentId,
    executionMode: agent.executionMode,
    selectedRunId: runs.selectedRunId,
    runArtifactTab: runs.runArtifactTab,
    checkpointId: git.checkpointId
  };
}

export function restorePersistedProjectWorkspaceContext(context: ProjectWorkspaceContext): void {
  useNavigationStore.getState().setActivePage(context.activePage);
  useCanvasStore.setState({
    expandedPaths: new Set(context.expandedPaths),
    selectedNodeId: context.selectedNodeId
  });
  useAgentStore.getState().setSelectedAgentId(context.selectedAgentId);
  useAgentStore.getState().setExecutionMode(context.executionMode);
  useRunsStore.getState().setSelectedRunId(context.selectedRunId);
  useRunsStore.getState().setRunArtifactTab(context.runArtifactTab);
  useGitStore.getState().setCheckpointId(context.checkpointId);
}

export function clearProjectWorkspaceState(): void {
  restoreProjectWorkspaceState({
    project: {
      projectLabel: 'No project selected',
      projectId: '',
      projectPath: '',
      scanFingerprint: '',
      artifactStatuses: undefined,
      architectureReview: { state: 'missing' },
      sequenceReview: { state: 'missing' },
      projectStatus: 'Open a local backend project first. FlowWeave will read the file tree and generate module nodes.',
      isProjectLoading: false
    },
    canvas: {
      canvasLayout: emptyCanvasLayout(),
      modules: [],
      edges: [],
      nodes: [],
      projectFiles: [],
      expandedPaths: new Set(),
      selectedNodeId: ''
    },
    navigation: { activePage: 'canvas' },
    runs: {
      runs: [],
      selectedRunId: '',
      selectedRunArtifact: undefined,
      runArtifactTab: 'plan',
      isRunsLoading: false
    },
    git: {
      checkpointId: '',
      diff: undefined,
      status: undefined
    },
    agent: {
      agents: [],
      selectedAgentId: 'claude-code',
      executionMode: 'plan',
      toolStatuses: {},
      pluginStatuses: [],
      lastRunStatus: 'Select a project before asking the default Agent to generate a plan.',
      connection: undefined,
      connectionOperation: { status: 'idle' }
    }
  });
}

function emptyCanvasLayout(): CanvasLayoutState {
  return {
    activeMode: 'manual',
    manualPositions: {},
    autoLayouts: {},
    collapsedGroups: []
  };
}

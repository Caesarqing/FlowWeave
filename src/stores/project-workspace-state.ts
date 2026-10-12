import type { CanvasLayoutState, CanvasReadResult, ProjectWorkspaceContext } from '../types';
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
    relationDiagnostics: ReturnType<typeof useProjectStore.getState>['relationDiagnostics'];
    artifactStatuses: ReturnType<typeof useProjectStore.getState>['artifactStatuses'];
    architectureReview: ReturnType<typeof useProjectStore.getState>['architectureReview'];
    localGenerationStatus: ReturnType<typeof useProjectStore.getState>['localGenerationStatus'];
    sequenceReview: ReturnType<typeof useProjectStore.getState>['sequenceReview'];
    projectStatus: string;
    isProjectLoading: boolean;
  };
  canvas: {
    hydrationVersion: number;
    canvasLayout: CanvasLayoutState;
    generation: ReturnType<typeof useCanvasStore.getState>['generation'];
    generatedAt: string;
    userRevision: number;
    hiddenGeneratedNodeIds: string[];
    hiddenGeneratedEdgeIds: string[];
    migrationPendingItems: ReturnType<typeof useCanvasStore.getState>['migrationPendingItems'];
    preservedCounts: ReturnType<typeof useCanvasStore.getState>['preservedCounts'];
    orphanedEdges: ReturnType<typeof useCanvasStore.getState>['orphanedEdges'];
    groups: ReturnType<typeof useCanvasStore.getState>['groups'];
    quality: ReturnType<typeof useCanvasStore.getState>['quality'];
    orphanedNodeEdits: ReturnType<typeof useCanvasStore.getState>['orphanedNodeEdits'];
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
      relationDiagnostics: project.relationDiagnostics,
      artifactStatuses: project.artifactStatuses,
      architectureReview: project.architectureReview,
      localGenerationStatus: project.localGenerationStatus,
      sequenceReview: project.sequenceReview,
      projectStatus: project.projectStatus,
      isProjectLoading: project.isProjectLoading
    },
    canvas: {
      hydrationVersion: canvas.hydrationVersion,
      canvasLayout: canvas.canvasLayout,
      generation: canvas.generation,
      generatedAt: canvas.generatedAt,
      userRevision: canvas.userRevision,
      hiddenGeneratedNodeIds: canvas.hiddenGeneratedNodeIds,
      hiddenGeneratedEdgeIds: canvas.hiddenGeneratedEdgeIds,
      migrationPendingItems: canvas.migrationPendingItems,
      preservedCounts: canvas.preservedCounts,
      orphanedEdges: canvas.orphanedEdges,
      groups: canvas.groups,
      quality: canvas.quality,
      orphanedNodeEdits: canvas.orphanedNodeEdits,
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

export function isProjectWorkspaceSnapshotCurrent(snapshot: ProjectWorkspaceSnapshot, current: CanvasReadResult | undefined): boolean {
  const generation = snapshot.canvas.generation;
  const committed = current?.canvas;
  return !snapshot.project.isProjectLoading && Boolean(generation && committed?.generation &&
    generation.requestId === committed.generation.requestId &&
    generation.inputFingerprint === committed.generation.inputFingerprint &&
    snapshot.canvas.generatedAt === committed.generatedAt &&
    snapshot.project.scanFingerprint === committed.scanFingerprint &&
    snapshot.canvas.userRevision === committed.userRevision);
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
      relationDiagnostics: [],
      artifactStatuses: undefined,
      architectureReview: { state: 'missing' },
      localGenerationStatus: 'idle',
      sequenceReview: { state: 'missing' },
      projectStatus: 'Open a local backend project first. FlowWeave will read the file tree and generate module nodes.',
      isProjectLoading: false
    },
    canvas: {
      hydrationVersion: 0,
      canvasLayout: emptyCanvasLayout(),
      generation: undefined,
      generatedAt: '',
      userRevision: 0,
      hiddenGeneratedNodeIds: [],
      hiddenGeneratedEdgeIds: [],
      migrationPendingItems: [],
      preservedCounts: { pending: 0, nodeEdits: 0, edges: 0 },
      orphanedEdges: [],
      groups: [],
      quality: undefined,
      orphanedNodeEdits: [],
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

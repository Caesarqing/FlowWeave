import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildCurrentModuleGuidancePrompt,
  buildExecutionAssessmentSummary,
  buildModificationDeltaAgentPrompt,
  buildModificationDeltaContextJson,
  buildModificationDeltaGuidanceMarkdown,
  createModificationGuidanceContext,
  downloadText
} from "../utils/export-artifacts";
import { useAgentStore } from "../stores/agents.store";
import { useNavigationStore } from "../stores/navigation.store";
import { useProjectStore } from "../stores/project.store";
import { assertCanvasEditable } from "../stores/project.store";
import { restoreGeneratedCanvasGraph } from "../utils/canvas-graph-crud";
import { graphEdgeFromFlow } from "../utils/graph-converters";
import { useRunsStore } from "../stores/runs.store";
import { usePreferencesStore } from "../stores/preferences.store";
import { useFlowWeaveState } from "./useFlowWeaveState";
import { useModuleActions } from "./useModuleActions";
import { useProjectActions } from "./useProjectActions";
import { useSequenceDiagramState } from "./useSequenceDiagramState";
import { useToolActions } from "./useToolActions";
import { useAgentConnection } from "./useAgentConnection";
import { useCanvasPersistence } from "./useCanvasPersistence";
import { canvasSaveCoordinator } from "./canvas-save-coordinator";
import { useCanvasStore } from "../stores/canvas.store";
import { useRunHistory } from "./useRunHistory";
import { useI18n } from "../utils/i18n";
import { sortAgentsForSelection } from "../utils/agent-display";
import { createAsyncRequestGuard } from "../utils/async-request-guard";
import type { ArtifactRunTarget, FlowWeaveProjectOpenResult, ProjectAnalysisCommittedResult, RuntimeAgentId } from "../types";

const MAX_RENDERED_TREE_ROWS = 900;
export function useAppController({
  onProjectOpenStarted,
  onProjectOpened,
  onProjectAnalysisFinished,
  restoreProjectId
}: {
  onProjectOpenStarted?: () => void;
  onProjectOpened?: (result: ProjectAnalysisCommittedResult | Extract<FlowWeaveProjectOpenResult, { status: "analyzing" }>) => void;
  onProjectAnalysisFinished?: (projectId: string) => void;
  restoreProjectId?: string;
}) {
  const { t } = useI18n();
  const requestedRestoreProjectId = useRef<string | undefined>(undefined);
  const agentDiscoveryGuard = useRef(createAsyncRequestGuard()).current;
  const activePage = useNavigationStore((state) => state.activePage);
  const projectLabel = useProjectStore((state) => state.projectLabel);
  const projectId = useProjectStore((state) => state.projectId);
  const projectPath = useProjectStore((state) => state.projectPath);
  const scanFingerprint = useProjectStore((state) => state.scanFingerprint);
  const relationDiagnostics = useProjectStore((state) => state.relationDiagnostics);
  const artifactStatuses = useProjectStore((state) => state.artifactStatuses);
  const architectureReview = useProjectStore((state) => state.architectureReview);
  const localGenerationStatus = useProjectStore((state) => state.localGenerationStatus);
  const projectStatus = useProjectStore((state) => state.projectStatus);
  const isProjectLoading = useProjectStore((state) => state.isProjectLoading);
  const agents = useAgentStore((state) => state.agents);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const executionMode = useAgentStore((state) => state.executionMode);
  const agentPlanTimeoutMinutes = usePreferencesStore((state) => state.agentPlanTimeoutMinutes);
  const agentExecuteTimeoutMinutes = usePreferencesStore((state) => state.agentExecuteTimeoutMinutes);
  const toolStatuses = useAgentStore((state) => state.toolStatuses);
  const pluginStatuses = useAgentStore((state) => state.pluginStatuses);
  const lastRunStatus = useAgentStore((state) => state.lastRunStatus);
  const runs = useRunsStore((state) => state.runs);
  const selectedRunId = useRunsStore((state) => state.selectedRunId);
  const selectedRunArtifact = useRunsStore((state) => state.selectedRunArtifact);
  const runArtifactTab = useRunsStore((state) => state.runArtifactTab);
  const isRunsLoading = useRunsStore((state) => state.isRunsLoading);
  const setActivePage = useNavigationStore((state) => state.setActivePage);
  const setProjectLabel = useProjectStore((state) => state.setProjectLabel);
  const setProjectId = useProjectStore((state) => state.setProjectId);
  const setProjectPath = useProjectStore((state) => state.setProjectPath);
  const setScanFingerprint = useProjectStore((state) => state.setScanFingerprint);
  const setRelationDiagnostics = useProjectStore((state) => state.setRelationDiagnostics);
  const setArtifactStatuses = useProjectStore((state) => state.setArtifactStatuses);
  const setArchitectureReview = useProjectStore((state) => state.setArchitectureReview);
  const setLocalGenerationStatus = useProjectStore((state) => state.setLocalGenerationStatus);
  const setSequenceReview = useProjectStore((state) => state.setSequenceReview);
  const setProjectStatus = useProjectStore((state) => state.setProjectStatus);
  const setIsProjectLoading = useProjectStore((state) => state.setIsProjectLoading);
  const setAgents = useAgentStore((state) => state.setAgents);
  const setSelectedAgentId = useAgentStore((state) => state.setSelectedAgentId);
  const setExecutionMode = useAgentStore((state) => state.setExecutionMode);
  const setToolStatuses = useAgentStore((state) => state.setToolStatuses);
  const setPluginStatuses = useAgentStore((state) => state.setPluginStatuses);
  const setLastRunStatus = useAgentStore((state) => state.setLastRunStatus);
  const setRunArtifactTab = useRunsStore((state) => state.setRunArtifactTab);
  const [moduleGuidanceOperation, setModuleGuidanceOperation] = useState<"save" | "send" | "">("");
  const [modificationResult, setModificationResult] = useState<import("../types").ModificationDeltaResult>();
  const flow = useFlowWeaveState();
  const sequence = useSequenceDiagramState({
    files: flow.projectFiles,
    projectId,
    projectPath,
    selectedAgentId,
    hasPendingInstruction: Boolean(modificationResult?.delta.sequenceInstruction),
    onModificationAcknowledged: async () => {
      await refreshModificationDelta();
    }
  });
  const canvasSnapshot = useMemo(
    () =>
      JSON.stringify({
        modules: flow.modules,
        relations: flow.graphRelations,
        orphanedEdges: flow.orphanedEdges,
      ...flow.canvasMetadata
      }),
    [flow.modules, flow.graphRelations, flow.orphanedEdges, flow.canvasMetadata]
  );
  const agentConnection = useAgentConnection(projectId, projectPath);
  const { flushCurrentCanvas } = useCanvasPersistence(
    projectId,
    projectPath,
    scanFingerprint,
    isProjectLoading,
    artifactStatuses?.canvas,
    flow.hydrationVersion,
    flow.userRevision,
    flow.modules,
    flow.graphRelations,
    flow.canvasLayout,
    flow.orphanedEdges,
    flow.canvasMetadata
  );
  const { applySelectedRunArtifact, openGitReviewFromRun, openSelectedAgentInbox, refreshRuns, selectRun } = useRunHistory(projectId);
  const projectActions = useProjectActions({
    maxRenderedTreeRows: MAX_RENDERED_TREE_ROWS,
    projectId,
    projectFiles: flow.projectFiles,
    scanFingerprint,
    flushCurrentCanvas: () => flushCurrentCanvas(buildCurrentCanvas),
    architectureReview,
    localGenerationStatus,
    loadInitialStaticGraph: flow.loadInitialStaticGraph,
    setIsProjectLoading,
    setLastRunStatus,
    setProjectLabel,
    setProjectId,
    setProjectPath,
    setScanFingerprint,
    setRelationDiagnostics,
    setArtifactStatuses,
    setArchitectureReview,
    setLocalGenerationStatus,
    setSequenceReview,
    setProjectStatus,
    onProjectOpenStarted,
    onProjectOpened,
    onProjectAnalysisFinished
  });
  const toolActions = useToolActions({
    agents,
    executionMode,
    graphRelations: flow.graphRelations,
    modules: flow.modules,
    projectLabel,
    projectId,
    projectPath,
    selectedNode: flow.selectedNode,
    onRunCompleted: refreshRuns,
    setLastRunStatus,
    setPluginStatuses,
    setSelectedAgentId,
    setToolStatuses
  });
  const restoreProjectAction = useRef(projectActions.restoreProject);
  restoreProjectAction.current = projectActions.restoreProject;
  const displayAgents = useMemo(() => sortAgentsForSelection(agents, toolStatuses), [agents, toolStatuses]);
  const moduleActions = useModuleActions({
    addModuleNode: flow.addModuleNode,
    selectedNode: flow.selectedNode,
    setSelectedNodeId: flow.setSelectedNodeId,
    togglePath: flow.togglePath,
    updateModule: flow.updateModule
  });

  useEffect(() => {
    if (!restoreProjectId || projectId === restoreProjectId || requestedRestoreProjectId.current === restoreProjectId) return;
    requestedRestoreProjectId.current = restoreProjectId;
    void restoreProjectAction.current(restoreProjectId);
    return () => {
      if (requestedRestoreProjectId.current === restoreProjectId) requestedRestoreProjectId.current = undefined;
    };
  }, [projectId, restoreProjectId]);

  useEffect(() => {
    agentDiscoveryGuard.activate();
    return () => agentDiscoveryGuard.invalidate();
  }, [agentDiscoveryGuard]);
  const hasPendingModifications = modificationResult?.hasChanges ?? false;
  const hasPendingModuleGuidance = Boolean(
    flow.selectedNode && modificationResult && (
      modificationResult.delta.modules.added.some((module) =>
        module.id === flow.selectedNode?.id && Boolean(module.guidanceDraft)
      ) ||
      modificationResult.delta.modules.updated.some((module) =>
        module.id === flow.selectedNode?.id &&
        Object.prototype.hasOwnProperty.call(module.changes, "guidanceDraft")
      )
    )
  );

  useEffect(() => {
    if (!window.flowweave || !projectId || !scanFingerprint || artifactStatuses?.canvas !== "current" || flow.modules.length === 0) {
      setModificationResult(undefined);
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      void refreshModificationDelta().catch((error) => {
        setLastRunStatus(t("status.modificationDeltaFailed", { error: formatErrorMessage(error) }));
      });
    }, 100);
    return () => window.clearTimeout(timeout);
  }, [projectId, scanFingerprint, artifactStatuses?.canvas, canvasSnapshot, sequence.instruction]);

  function buildCurrentCanvas(): import("../types").CodeflowCanvas {
    const state = useCanvasStore.getState();
    return {
      userRevision: state.userRevision,
      id: "main",
      title: "Main Canvas",
      projectPath,
      generatedAt: state.generatedAt,
      scanFingerprint,
      artifactState: "current",
      layout: state.canvasLayout,
      nodes: state.modules,
      edges: state.edges.map(graphEdgeFromFlow),
      orphanedEdges: state.orphanedEdges,
      generation: state.generation,
      groups: state.groups,
      quality: state.quality,
      orphanedNodeEdits: state.orphanedNodeEdits,
      migrationPendingItems: state.migrationPendingItems,
      preservedCounts: state.preservedCounts,
      hiddenGeneratedNodeIds: state.hiddenGeneratedNodeIds,
      hiddenGeneratedEdgeIds: state.hiddenGeneratedEdgeIds
    };
  }

  async function refreshModificationDelta() {
    if (!window.flowweave || !projectId) return undefined;
    const next = await window.flowweave.readModificationDelta(
      projectId,
      sequence.instruction.trim() || undefined,
      buildCurrentCanvas()
    );
    setModificationResult(next);
    return next;
  }

  async function saveCanvasArtifacts() {
    if (!window.flowweave || !projectId) {
      throw new Error(t("docs.needDesktop"));
    }
    if (!scanFingerprint || artifactStatuses?.canvas !== "current") {
      throw new Error(t("canvas.saveUnavailable"));
    }
    const canvas = buildCurrentCanvas();
    const receipt = await canvasSaveCoordinator.save(projectId, canvas);
    if (useProjectStore.getState().projectId === projectId && useCanvasStore.getState().generation?.requestId === receipt.generationId) {
      useCanvasStore.getState().setUserRevision(receipt.userRevision);
    }
    const canvasPath = receipt.path;
    setLastRunStatus(t("canvas.saved", { path: canvasPath }));
    return { canvas, canvasPath };
  }

  async function generateCurrentTaskArtifact() {
    if (!window.flowweave || !projectId) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }
    if (isProjectLoading || artifactStatuses?.canvas !== "current") {
      setLastRunStatus(t("agent.taskNeedsCurrentGraph"));
      return;
    }
    try {
      await flushCurrentCanvas(buildCurrentCanvas);
      if (useProjectStore.getState().projectId !== projectId) return;
      const currentCanvas = useCanvasStore.getState();
      const generationId = currentCanvas.generation?.requestId;
      if (!generationId) throw new Error("The current Canvas has no committed generation identity.");
      const result = await window.flowweave.generateTaskArtifact(projectId, generationId, currentCanvas.userRevision);
      const latestCanvas = useCanvasStore.getState();
      if (useProjectStore.getState().projectId !== projectId || latestCanvas.generation?.requestId !== result.generationId ||
        latestCanvas.userRevision !== result.userRevision) return;
      setArtifactStatuses((current) => current ? { ...current, task: "current" } : current);
      const connection = await window.flowweave.getProjectAgentConnection(projectId);
      useAgentStore.getState().setConnection(connection);
      setLastRunStatus(connection.enabled && connection.state !== "ready"
        ? t("agent.taskGeneratedContextNeedsRefresh", { path: result.taskPath, reason: connection.message })
        : t("agent.taskGenerated", { path: result.taskPath }));
    } catch (error) {
      setLastRunStatus(t("agent.taskGenerationFailed", { error: formatErrorMessage(error) }));
    }
  }

  async function restoreDeletedGeneratedItems() {
    assertCanvasEditable();
    const generationId = flow.canvasMetadata.generation?.requestId;
    if (!window.flowweave || !projectId || !generationId) throw new Error(t("canvas.saveUnavailable"));
    const generated = await window.flowweave.readGeneratedCanvasGraph(projectId, generationId);
    if (useProjectStore.getState().projectId !== projectId || useCanvasStore.getState().generation?.requestId !== generationId) return;
    const current = buildCurrentCanvas();
    const currentFiles = useCanvasStore.getState().projectFiles;
    const restored = restoreGeneratedCanvasGraph(current, generated);
    flow.loadInitialStaticGraph(restored.nodes, restored.edges, currentFiles, restored.layout, restored.orphanedEdges, restored);
    const restoredState = useCanvasStore.getState();
    try {
      const receipt = await canvasSaveCoordinator.save(projectId, restored);
      if (useProjectStore.getState().projectId === projectId && useCanvasStore.getState().generation?.requestId === generationId) {
        useCanvasStore.getState().setUserRevision(receipt.userRevision);
      }
    } catch (error) {
      const latest = useCanvasStore.getState();
      if (useProjectStore.getState().projectId === projectId && latest.generation?.requestId === generationId &&
        latest.modules === restoredState.modules && latest.edges === restoredState.edges && latest.canvasLayout === restoredState.canvasLayout) {
        flow.loadInitialStaticGraph(current.nodes, current.edges, currentFiles, current.layout, current.orphanedEdges, current);
      }
      throw error;
    }
  }

  async function saveCurrentModuleGuidance() {
    if (!flow.selectedNode?.guidanceDraft.trim()) return;
    setModuleGuidanceOperation("save");
    try {
      await saveCanvasArtifacts();
      await window.flowweave?.saveModificationDocs(projectId, sequence.instruction.trim() || undefined);
      await refreshModificationDelta();
    } catch (error) {
      setLastRunStatus(t("canvas.saveFailed", { error: formatErrorMessage(error) }));
    } finally {
      setModuleGuidanceOperation("");
    }
  }

  async function sendCurrentModuleGuidance() {
    const selectedNode = flow.selectedNode;
    const api = window.flowweave;
    if (!api || !projectId || !selectedNode?.guidanceDraft.trim()) return;
    setModuleGuidanceOperation("send");
    try {
      const { canvas } = await saveCanvasArtifacts();
      await api.saveModificationDocs(projectId, sequence.instruction.trim() || undefined);
      const sent = await api.readModificationDelta(
        projectId,
        sequence.instruction.trim() || undefined,
        canvas
      );
      const result = await runAgentPrompt(
        buildCurrentModuleGuidancePrompt(selectedNode, selectedNode.guidanceDraft),
        [selectedNode],
        []
      );
      if (result?.status === "completed") {
        await api.acknowledgeModificationChanges(
          projectId,
          sent.snapshot,
          { kind: "module-guidance", moduleId: selectedNode.id }
        );
        await api.saveModificationDocs(projectId, sequence.instruction.trim() || undefined);
        await refreshModificationDelta();
      }
    } catch (error) {
      setLastRunStatus(t("status.agentPlanFailed", {
        agent: selectedAgentName(),
        error: formatErrorMessage(error)
      }));
    } finally {
      setModuleGuidanceOperation("");
    }
  }

  async function exportGuidanceFiles() {
    if (flow.canvasMetadata.migrationPendingItems.length > 0) {
      downloadText(
        "flowweave-migration-pending.json",
        JSON.stringify({
          schemaVersion: 1,
          projectPath,
          items: flow.canvasMetadata.migrationPendingItems
        }, null, 2)
      );
    }
    const result = await refreshModificationDelta();
    if (!result) return;
    const context = createModificationGuidanceContext(projectLabel, projectPath, result);
    downloadText("flowweave-modification-guidance.md", buildModificationDeltaGuidanceMarkdown(context));
    downloadText("flowweave-modification-context.json", buildModificationDeltaContextJson(context));
    setLastRunStatus(t("sequence.exported"));
  }

  async function sendCompleteGuidanceToAgent() {
    const api = window.flowweave;
    if (!api || !projectId) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }
    try {
      const { canvas } = await saveCanvasArtifacts();
      await api.saveModificationDocs(
        projectId,
        sequence.instruction.trim() || undefined
      );
      const sent = await api.readModificationDelta(
        projectId,
        sequence.instruction.trim() || undefined,
        canvas
      );
      if (!sent.hasChanges) {
        setLastRunStatus(t("top.noPendingGuidance"));
        setModificationResult(sent);
        return;
      }
      const context = createModificationGuidanceContext(projectLabel, projectPath, sent);
      const result = await runAgentPrompt(
        buildModificationDeltaAgentPrompt(context, executionMode),
        flow.modules,
        flow.graphRelations
      );
      if (result?.status === "completed") {
        await api.acknowledgeModificationChanges(
          projectId,
          sent.snapshot,
          { kind: "all" }
        );
        await api.saveModificationDocs(projectId, sequence.instruction.trim() || undefined);
        await refreshModificationDelta();
      }
    } catch (error) {
      setLastRunStatus(t("status.agentPlanFailed", {
        agent: selectedAgentName(),
        error: formatErrorMessage(error)
      }));
    }
  }

  async function runAgentPrompt(
    prompt: string,
    assessmentNodes: import("../types").GraphNode[],
    assessmentEdges: import("../types").GraphEdge[]
  ): Promise<import("../types").ToolRunResult | undefined> {
    if (!window.flowweave || !projectId) {
      throw new Error(t("docs.needDesktop"));
    }
    const agentName = selectedAgentName();
    if (executionMode === "execute" && !window.confirm(`${t("agent.executeConfirm", {
      agent: agentName,
      project: projectPath
    })}\n\n${buildExecutionAssessmentSummary(assessmentNodes, assessmentEdges)}`)) {
      setLastRunStatus(t("agent.executeCanceled"));
      return undefined;
    }
    setLastRunStatus(t("status.agentProcessing", { agent: agentName, mode: executionMode }));
    try {
      const detection = await window.flowweave.detectAgent(selectedAgentId, projectId);
      setToolStatuses((current) => ({ ...current, [selectedAgentId]: { ...current[selectedAgentId], ...detection, checking: false } }));
      if (!detection.available) {
        setLastRunStatus(t("status.agentCannotPlan", { agent: agentName }));
        return undefined;
      }

      const result = await window.flowweave.runToolPlan({
        projectId,
        toolId: selectedAgentId,
        executionMode,
        confirmedExecute: executionMode === "execute",
        purpose: "implementation-plan",
        timeoutMs: (executionMode === "execute" ? agentExecuteTimeoutMinutes : agentPlanTimeoutMinutes) * 60 * 1000,
        prompt
      });

      setSelectedAgentId(selectedAgentId);
      setToolStatuses((current) => ({
        ...current,
        [selectedAgentId]: {
          ...current[selectedAgentId],
          lastRunStatus: result.status,
          lastOutputPath: result.planPath ?? result.logPath ?? result.resultPath
        }
      }));
      setLastRunStatus(`${agentName} ${executionMode} ${result.status} · ${result.planPath ?? result.logPath ?? "no output"}`);
      await refreshRuns(result.id);
      return result;
    } catch (error) {
      setToolStatuses((current) => ({ ...current, [selectedAgentId]: { ...current[selectedAgentId], lastRunStatus: "failed" } }));
      throw error;
    }
  }

  function selectedAgentName() {
    return agents.find((agent) => agent.id === selectedAgentId)?.name ?? selectedAgentId;
  }

  useEffect(() => {
    if (!window.flowweave) return;
    void refreshAgents();
  }, [projectId]);

  async function refreshAgents(selectAgentId?: import("../types").AgentId) {
    if (!window.flowweave) return;
    const requestId = agentDiscoveryGuard.begin();
    try {
      const discovery = await window.flowweave.discoverAgents(projectId || undefined);
      if (!agentDiscoveryGuard.isCurrent(requestId)) return;
      const nextAgents = discovery.map((result) => result.definition);
      setAgents(nextAgents);
      setToolStatuses((current) => ({
        ...current,
        ...Object.fromEntries(discovery.map((result) => [result.definition.id, {
          ...current[result.definition.id],
          ...result.availability,
          checking: false
        }]))
      }));
      const preferredAgentId = selectAgentId || selectedAgentId;
      const nextAgentId = nextAgents.some((agent) => agent.id === preferredAgentId) ? preferredAgentId : nextAgents[0]?.id;
      if (nextAgentId && nextAgentId !== selectedAgentId) {
        setSelectedAgentId(nextAgentId);
      }
    } catch (error) {
      if (!agentDiscoveryGuard.isCurrent(requestId)) return;
      setLastRunStatus(t("status.agentConfigFailed", { error: formatErrorMessage(error) }));
    }
  }

  async function saveCustomAgent(input: import("../types").CustomAgentInput) {
    if (!window.flowweave) {
      setLastRunStatus(t("agent.bridgeWarning"));
      return;
    }
    try {
      const agent = await window.flowweave.saveCustomAgent(input);
      await refreshAgents(agent.id);
      setLastRunStatus(t("status.agentAdded", { agent: agent.name }));
    } catch (error) {
      setLastRunStatus(t("status.agentAddFailed", { error: formatErrorMessage(error) }));
    }
  }

  async function deleteCustomAgent(agentId: import("../types").AgentId) {
    if (!window.flowweave) {
      setLastRunStatus(t("agent.bridgeWarning"));
      return;
    }
    try {
      await window.flowweave.deleteCustomAgent(agentId);
      await refreshAgents();
      setLastRunStatus("Custom Agent deleted.");
    } catch (error) {
      setLastRunStatus(t("status.agentDeleteFailed", { error: formatErrorMessage(error) }));
    }
  }

  async function analyzeCurrentProjectWithAgent(agentId?: RuntimeAgentId) {
    await projectActions.analyzeProject(agentId ?? selectedAgentId);
    setActivePage("canvas");
    await refreshRuns();
  }

  async function retryRunArtifact(target: ArtifactRunTarget | undefined, agentId: RuntimeAgentId) {
    if (target === "sequence-diagrams" || target === "sequence-revision") {
      await sequence.generateDiagrams(agentId);
      setActivePage("structure");
    } else {
      await analyzeCurrentProjectWithAgent(agentId);
    }
    await refreshRuns();
  }

  function selectAgent(agentId: import("../types").AgentId) {
    setSelectedAgentId(agentId);
    const agent = agents.find((item) => item.id === agentId);
    setLastRunStatus(t("status.defaultAgentChanged", { agent: agent?.name ?? agentId }));
  }

  return {
    flushCanvas: () => flushCurrentCanvas(buildCurrentCanvas),
    activePage,
    agentConnection,
    artifactStatuses,
    architectureReview,
    localGenerationStatus,
    canvas: {
      connectionPanelMode: flow.connectionPanelMode,
      canvasLayout: flow.canvasLayout,
      defaultRelation: flow.defaultRelation,
      deleteEdge: flow.deleteEdge,
      deleteModuleNode: flow.deleteModuleNode,
      edges: flow.edges,
      expandedPaths: flow.expandedPaths,
      graphRelations: flow.graphRelations,
      relationDiagnostics,
      quality: flow.canvasMetadata.quality,
      generatedAt: flow.canvasMetadata.generatedAt,
      orphanedNodeEdits: flow.canvasMetadata.orphanedNodeEdits,
      migrationPendingItems: flow.canvasMetadata.migrationPendingItems,
      preservedCounts: flow.canvasMetadata.preservedCounts,
      generationId: flow.canvasMetadata.generation?.requestId,
      userRevision: flow.userRevision,
      projectId,
      orphanedEdges: flow.orphanedEdges,
      hasPendingGuidance: hasPendingModuleGuidance,
      isProjectLoading,
      maxRenderedTreeRows: MAX_RENDERED_TREE_ROWS,
      nodes: flow.nodes,
      modules: flow.modules,
      onAddConnection: flow.addConnection,
      onAddNode: moduleActions.addNode,
      onAnalyzeProject: () => projectActions.analyzeProject(selectedAgentId),
      onClearConnectionSelection: flow.clearConnectionSelection,
      onConnect: flow.handleConnect,
      onEdgesChange: flow.onEdgesChange,
      onGuidanceChange: moduleActions.updateGuidance,
      guidanceOperation: moduleGuidanceOperation,
      onSaveGuidance: saveCurrentModuleGuidance,
      onSendGuidance: sendCurrentModuleGuidance,
      onNodesChange: flow.handleCanvasNodesChange,
      onApplyAutoLayout: flow.handleAutoLayout,
      onOpenConnectionCreator: flow.openConnectionCreator,
      onOpenProject: projectActions.openProject,
      onRefreshProject: projectActions.refreshProject,
      onRestoreManualLayout: flow.restoreManualLayout,
      onRestoreGeneratedItems: restoreDeletedGeneratedItems,
      onResolveMigrationItem: async (request: import("../types").CanvasMigrationReviewRequest) => {
        await flushCurrentCanvas(buildCurrentCanvas);
        const current = useCanvasStore.getState();
        const generationId = current.generation?.requestId;
        if (!generationId) throw new Error("The current graph generation is unavailable for migration review.");
        return flow.resolveCanvasMigrationItem({ ...request, generationId, userRevision: current.userRevision });
      },
      hiddenGeneratedCount: (flow.canvasMetadata.hiddenGeneratedNodeIds?.length ?? 0) + (flow.canvasMetadata.hiddenGeneratedEdgeIds?.length ?? 0),
      onSelectEdge: flow.selectEdge,
      onSelectNode: (nodeId: string) => {
        flow.clearConnectionSelection();
        moduleActions.selectNode(nodeId);
      },
      onSetCollapsedGroups: flow.setCollapsedGroups,
      onSetViewMode: flow.setViewMode,
      onTogglePath: moduleActions.toggleProjectPath,
      onUpdateEdgeGuidance: flow.updateEdgeGuidance,
      onUpdateEdgeEndpoints: flow.updateEdgeEndpoints,
      onUpdateEdgeRelation: flow.updateEdgeRelation,
      onUpdateModuleFields: flow.updateModuleFields,
      projectFiles: flow.projectFiles,
      projectPath,
      projectStatus,
      selectedEdge: flow.selectedEdge,
      selectedEdgeId: flow.selectedEdgeId,
      selectedNode: flow.selectedNode,
      analysisLabel: projectStatus.includes(t("status.analysisKeyword")) || projectStatus.includes("Architecture") ? t("canvas.analysisLabel") : t("canvas.subtitle")
    },
    isDesktopBridgeAvailable: Boolean(window.flowweave),
    hasPendingModifications,
    onExport: exportGuidanceFiles,
    onPageChange: setActivePage,
    onSendToTool: sendCompleteGuidanceToAgent,
    projectLabel,
    projectId,
    scanFingerprint,
    sequence,
    tools: {
      agents: displayAgents,
      architectureReview,
      executionMode,
      isRunsLoading,
      lastRunStatus,
      onAnalyzeCurrentProject: analyzeCurrentProjectWithAgent,
      canGenerateTaskArtifact: Boolean(window.flowweave && projectId && !isProjectLoading &&
        artifactStatuses?.canvas === "current" && flow.canvasMetadata.generation?.requestId),
      onGenerateTaskArtifact: generateCurrentTaskArtifact,
      onApplyRunArtifact: applySelectedRunArtifact,
      onDeleteCustomAgent: deleteCustomAgent,
      onDetectAgent: toolActions.detectAgent,
      onExecutionModeChange: setExecutionMode,
      onGoToGitReview: openGitReviewFromRun,
      onHealthCheckAgent: toolActions.healthCheckAgent,
      onInstallAgentPlugins: toolActions.installAgentPlugins,
      onOpenAgentPluginFolder: toolActions.openAgentPluginFolder,
      onOpenAgentPluginInstructions: toolActions.openAgentPluginInstructions,
      onOpenToolProject: toolActions.openToolProject,
      onOpenAgentInbox: openSelectedAgentInbox,
      onRefreshRuns: refreshRuns,
      onRefreshAgentPlugins: toolActions.refreshAgentPlugins,
      onRetryRunArtifact: retryRunArtifact,
      onRunToolPlan: toolActions.runToolPlan,
      onRunArtifactTabChange: setRunArtifactTab,
      onSaveCustomAgent: saveCustomAgent,
      onSelectRun: selectRun,
      onSelectAgent: selectAgent,
      runArtifactTab,
      runs,
      selectedRunArtifact,
      selectedRunId,
      selectedAgentId,
      pluginStatuses,
      toolStatuses
    }
  };
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

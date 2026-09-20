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
import { useRunsStore } from "../stores/runs.store";
import { useFlowWeaveState } from "./useFlowWeaveState";
import { useModuleActions } from "./useModuleActions";
import { useProjectActions } from "./useProjectActions";
import { useSequenceDiagramState } from "./useSequenceDiagramState";
import { useToolActions } from "./useToolActions";
import { useAgentConnection } from "./useAgentConnection";
import { useCanvasPersistence } from "./useCanvasPersistence";
import { useRunHistory } from "./useRunHistory";
import { useI18n } from "../utils/i18n";
import { sortAgentsForSelection } from "../utils/agent-display";
import { createAsyncRequestGuard } from "../utils/async-request-guard";
import type { ArtifactRunTarget, FlowWeaveProjectOpenResult, RuntimeAgentId } from "../types";

const MAX_RENDERED_TREE_ROWS = 900;

export function useAppController({
  onProjectOpenStarted,
  onProjectOpened,
  restoreProjectId
}: {
  onProjectOpenStarted?: () => void;
  onProjectOpened?: (result: Exclude<FlowWeaveProjectOpenResult, { canceled: true }>) => void;
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
  const artifactStatuses = useProjectStore((state) => state.artifactStatuses);
  const architectureReview = useProjectStore((state) => state.architectureReview);
  const localGenerationStatus = useProjectStore((state) => state.localGenerationStatus);
  const projectStatus = useProjectStore((state) => state.projectStatus);
  const isProjectLoading = useProjectStore((state) => state.isProjectLoading);
  const agents = useAgentStore((state) => state.agents);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const executionMode = useAgentStore((state) => state.executionMode);
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
        relations: flow.graphRelations
      }),
    [flow.modules, flow.graphRelations]
  );
  const agentConnection = useAgentConnection(projectId, projectPath);
  useCanvasPersistence(
    projectId,
    projectPath,
    scanFingerprint,
    artifactStatuses?.canvas,
    canvasSnapshot,
    flow.modules,
    flow.graphRelations,
    flow.canvasLayout
  );
  const { applySelectedRunArtifact, openGitReviewFromRun, openSelectedAgentInbox, refreshRuns, selectRun } = useRunHistory(projectId);
  const projectActions = useProjectActions({
    maxRenderedTreeRows: MAX_RENDERED_TREE_ROWS,
    projectId,
    projectFiles: flow.projectFiles,
    scanFingerprint,
    architectureReview,
    localGenerationStatus,
    replaceProjectGraph: flow.replaceProjectGraph,
    setIsProjectLoading,
    setLastRunStatus,
    setProjectLabel,
    setProjectId,
    setProjectPath,
    setScanFingerprint,
    setArtifactStatuses,
    setArchitectureReview,
    setLocalGenerationStatus,
    setSequenceReview,
    setProjectStatus,
    onProjectOpenStarted,
    onProjectOpened
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
    void projectActions.restoreProject(restoreProjectId);
  }, [projectActions.restoreProject, projectId, restoreProjectId]);

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
    return {
      version: 4,
      id: "main",
      title: "Main Canvas",
      projectPath,
      generatedAt: new Date().toISOString(),
      scanFingerprint,
      artifactState: "current",
      layout: flow.canvasLayout,
      nodes: flow.modules,
      edges: flow.graphRelations
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
    const canvasPath = await window.flowweave.saveCanvas(projectId, canvas);
    setLastRunStatus(t("canvas.saved", { path: canvasPath }));
    return { canvas, canvasPath };
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
      onSelectEdge: flow.selectEdge,
      onSelectNode: (nodeId: string) => {
        flow.clearConnectionSelection();
        moduleActions.selectNode(nodeId);
      },
      onSetCollapsedGroups: flow.setCollapsedGroups,
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

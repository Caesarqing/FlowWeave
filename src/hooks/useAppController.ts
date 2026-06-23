import { useEffect, useMemo, useState } from "react";
import {
  buildAgentPrompt,
  buildExecutionAssessmentSummary,
  buildLegacyCanvasGuidance,
  buildLegacyCanvasTaskJson,
  buildLegacySequenceGuidance,
  buildLegacySequenceTaskJson,
  buildModificationContext,
  buildModificationContextJson,
  buildModificationGuidanceMarkdown,
  downloadText
} from "../utils/export-artifacts";
import { useAgentStore } from "../stores/agents.store";
import { useNavigationStore } from "../stores/navigation.store";
import { useProjectStore } from "../stores/project.store";
import { useRunsStore } from "../stores/runs.store";
import { usePreferencesStore } from "../stores/preferences.store";
import { useFlowWeaveState } from "./useFlowWeaveState";
import { useModuleActions } from "./useModuleActions";
import { useProjectActions } from "./useProjectActions";
import { useSequenceDiagramState } from "./useSequenceDiagramState";
import { useToolActions } from "./useToolActions";
import { useAgentConnection } from "./useAgentConnection";
import { useCanvasPersistence } from "./useCanvasPersistence";
import { useRunHistory } from "./useRunHistory";
import { useI18n } from "../utils/i18n";

const MAX_RENDERED_TREE_ROWS = 900;

export function useAppController() {
  const { t } = useI18n();
  const activePage = useNavigationStore((state) => state.activePage);
  const projectLabel = useProjectStore((state) => state.projectLabel);
  const projectId = useProjectStore((state) => state.projectId);
  const projectPath = useProjectStore((state) => state.projectPath);
  const scanFingerprint = useProjectStore((state) => state.scanFingerprint);
  const artifactStatuses = useProjectStore((state) => state.artifactStatuses);
  const projectStatus = useProjectStore((state) => state.projectStatus);
  const isProjectLoading = useProjectStore((state) => state.isProjectLoading);
  const agents = useAgentStore((state) => state.agents);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const executionMode = useAgentStore((state) => state.executionMode);
  const toolStatuses = useAgentStore((state) => state.toolStatuses);
  const lastRunStatus = useAgentStore((state) => state.lastRunStatus);
  const runs = useRunsStore((state) => state.runs);
  const selectedRunId = useRunsStore((state) => state.selectedRunId);
  const selectedRunArtifact = useRunsStore((state) => state.selectedRunArtifact);
  const runArtifactTab = useRunsStore((state) => state.runArtifactTab);
  const isRunsLoading = useRunsStore((state) => state.isRunsLoading);
  const planTimeoutMinutes = usePreferencesStore((state) => state.planTimeoutMinutes);
  const executeTimeoutMinutes = usePreferencesStore((state) => state.executeTimeoutMinutes);
  const setActivePage = useNavigationStore((state) => state.setActivePage);
  const setProjectLabel = useProjectStore((state) => state.setProjectLabel);
  const setProjectId = useProjectStore((state) => state.setProjectId);
  const setProjectPath = useProjectStore((state) => state.setProjectPath);
  const setScanFingerprint = useProjectStore((state) => state.setScanFingerprint);
  const setArtifactStatuses = useProjectStore((state) => state.setArtifactStatuses);
  const setProjectStatus = useProjectStore((state) => state.setProjectStatus);
  const setIsProjectLoading = useProjectStore((state) => state.setIsProjectLoading);
  const setAgents = useAgentStore((state) => state.setAgents);
  const setSelectedAgentId = useAgentStore((state) => state.setSelectedAgentId);
  const setExecutionMode = useAgentStore((state) => state.setExecutionMode);
  const setToolStatuses = useAgentStore((state) => state.setToolStatuses);
  const setLastRunStatus = useAgentStore((state) => state.setLastRunStatus);
  const setRunArtifactTab = useRunsStore((state) => state.setRunArtifactTab);
  const [dialogText, setDialogText] = useState("");
  const flow = useFlowWeaveState();
  const sequence = useSequenceDiagramState({
    files: flow.projectFiles,
    projectId,
    projectPath,
    selectedAgentId
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
  const { openGitReviewFromRun, refreshRuns, selectRun } = useRunHistory(projectId);
  const projectActions = useProjectActions({
    maxRenderedTreeRows: MAX_RENDERED_TREE_ROWS,
    projectId,
    projectPath,
    projectFiles: flow.projectFiles,
    replaceProjectGraph: flow.replaceProjectGraph,
    setIsProjectLoading,
    setLastRunStatus,
    setProjectLabel,
    setProjectId,
    setProjectPath,
    setScanFingerprint,
    setArtifactStatuses,
    setProjectStatus
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
    setSelectedAgentId,
    setToolStatuses
  });
  const moduleActions = useModuleActions({
    addModuleNode: flow.addModuleNode,
    dialogText,
    selectedNode: flow.selectedNode,
    setDialogText,
    setSelectedNodeId: flow.setSelectedNodeId,
    togglePath: flow.togglePath,
    updateModule: flow.updateModule
  });

  function buildCurrentModificationContext() {
    return buildModificationContext({
      projectLabel,
      projectPath,
      scanFingerprint,
      nodes: flow.modules,
      edges: flow.graphRelations,
      selectedNodeId: flow.selectedNode?.id,
      sequenceBundle: sequence.bundle,
      sequenceInstruction: sequence.instruction,
      selectedSequenceMessageId: sequence.selectedMessageId,
      selectedSequenceParticipantId: sequence.selectedParticipantId
    });
  }

  function exportGuidanceFiles() {
    const context = buildCurrentModificationContext();
    downloadText("flowweave-modification-guidance.md", buildModificationGuidanceMarkdown(context));
    downloadText("flowweave-modification-context.json", buildModificationContextJson(context));
    downloadText("guidance.md", buildLegacyCanvasGuidance(context, t));
    downloadText("task.json", buildLegacyCanvasTaskJson(context, t));
    downloadText("sequence-guidance.md", buildLegacySequenceGuidance(context));
    downloadText("sequence-task.json", buildLegacySequenceTaskJson(context));
    setLastRunStatus(t("sequence.exported"));
  }

  async function sendActivePageToTool() {
    if (!window.flowweave || !projectId) {
      setLastRunStatus(t("docs.needDesktop"));
      return;
    }

    const agentName = agents.find((agent) => agent.id === selectedAgentId)?.name ?? selectedAgentId;
    if (executionMode === "execute" && !window.confirm(`${t("agent.executeConfirm", {
      agent: agentName,
      project: projectPath
    })}\n\n${buildExecutionAssessmentSummary(flow.modules, flow.graphRelations)}`)) {
      setLastRunStatus(t("agent.executeCanceled"));
      return;
    }
    setLastRunStatus(t("status.agentProcessing", { agent: agentName, mode: executionMode }));
    try {
      const detection = await window.flowweave.detectAgent(selectedAgentId);
      setToolStatuses((current) => ({ ...current, [selectedAgentId]: { ...current[selectedAgentId], ...detection, checking: false } }));
      if (!detection.available) {
        setLastRunStatus(t("status.agentCannotPlan", { agent: agentName }));
        return;
      }

      const context = buildCurrentModificationContext();
      const result = await window.flowweave.runToolPlan({
        projectId,
        toolId: selectedAgentId,
        executionMode,
        confirmedExecute: executionMode === "execute",
        planTimeoutMs: executionMode === "plan" ? planTimeoutMinutes * 60_000 : undefined,
        executeTimeoutMs: executionMode === "execute" ? executeTimeoutMinutes * 60_000 : undefined,
        purpose: "implementation-plan",
        prompt: buildAgentPrompt(context, "combined-modification-plan", executionMode)
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
    } catch (error) {
      setToolStatuses((current) => ({ ...current, [selectedAgentId]: { ...current[selectedAgentId], lastRunStatus: "failed" } }));
      setLastRunStatus(t("status.agentPlanFailed", { agent: agentName, error: formatErrorMessage(error) }));
    }
  }

  useEffect(() => {
    if (!window.flowweave) return;
    void refreshAgents();
  }, []);

  async function refreshAgents(selectAgentId?: import("../types").AgentId) {
    if (!window.flowweave) return;
    try {
      const nextAgents = await window.flowweave.listAgents();
      setAgents(nextAgents);
      const preferredAgentId = selectAgentId || selectedAgentId;
      const nextAgentId = nextAgents.some((agent) => agent.id === preferredAgentId) ? preferredAgentId : nextAgents[0]?.id;
      if (nextAgentId && nextAgentId !== selectedAgentId) {
        setSelectedAgentId(nextAgentId);
      }
    } catch (error) {
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

  async function analyzeCurrentProjectWithAgent(agentId?: import("../types").RuntimeAgentId) {
    await projectActions.analyzeProject(agentId ?? selectedAgentId);
    setActivePage("canvas");
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
    canvas: {
      connectionPanelMode: flow.connectionPanelMode,
      canvasLayout: flow.canvasLayout,
      defaultRelation: flow.defaultRelation,
      deleteEdge: flow.deleteEdge,
      deleteModuleNode: flow.deleteModuleNode,
      edges: flow.edges,
      expandedPaths: flow.expandedPaths,
      graphRelations: flow.graphRelations,
      isProjectLoading,
      maxRenderedTreeRows: MAX_RENDERED_TREE_ROWS,
      nodes: flow.nodes,
      modules: flow.modules,
      onAddConnection: flow.addConnection,
      onAddNode: moduleActions.addNode,
      onAnalyzeProject: () => projectActions.analyzeProject(selectedAgentId),
      onApplyDialog: moduleActions.applyDialog,
      onClearConnectionSelection: flow.clearConnectionSelection,
      onConnect: flow.handleConnect,
      onDialogTextChange: setDialogText,
      onEdgesChange: flow.onEdgesChange,
      onGuidanceChange: moduleActions.updateGuidance,
      onNodesChange: flow.handleCanvasNodesChange,
      onApplyAutoLayout: flow.handleAutoLayout,
      onOpenConnectionCreator: flow.openConnectionCreator,
      onOpenProject: projectActions.openProject,
      onRefreshProject: projectActions.refreshProject,
      onRestoreManualLayout: flow.restoreManualLayout,
      onCancelProjectOperation: projectActions.cancelProjectOperation,
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
      onWriteDraft: moduleActions.writeDraft,
      projectFiles: flow.projectFiles,
      projectPath,
      projectStatus,
      operation: projectActions.operation,
      selectedEdge: flow.selectedEdge,
      selectedEdgeId: flow.selectedEdgeId,
      selectedNode: flow.selectedNode,
      analysisLabel: projectStatus.includes(t("status.analysisKeyword")) || projectStatus.includes("Architecture") ? t("canvas.analysisLabel") : t("canvas.subtitle")
    },
    dialogText,
    isDesktopBridgeAvailable: Boolean(window.flowweave),
    onExport: exportGuidanceFiles,
    onPageChange: setActivePage,
    onSendToTool: sendActivePageToTool,
    projectLabel,
    projectId,
    scanFingerprint,
    sequence,
    tools: {
      agents,
      executionMode,
      isRunsLoading,
      lastRunStatus,
      onAnalyzeCurrentProject: analyzeCurrentProjectWithAgent,
      onDeleteCustomAgent: deleteCustomAgent,
      onDetectAgent: toolActions.detectAgent,
      onExecutionModeChange: setExecutionMode,
      onGoToGitReview: openGitReviewFromRun,
      onHealthCheckAgent: toolActions.healthCheckAgent,
      onOpenToolProject: toolActions.openToolProject,
      onRefreshRuns: refreshRuns,
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
      toolStatuses
    }
  };
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

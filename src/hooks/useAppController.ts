import { useEffect, useMemo, useState } from "react";
import { buildGuidanceMarkdown, buildSequenceGuidanceMarkdown, buildSequencePlanPrompt, buildSequenceTaskJson, buildTaskJson, downloadText } from "../utils/export-artifacts";
import { useWorkspaceStore } from "../stores/workspace.store";
import { useFlowWeaveState } from "./useFlowWeaveState";
import { useModuleActions } from "./useModuleActions";
import { useProjectActions } from "./useProjectActions";
import { useSequenceDiagramState } from "./useSequenceDiagramState";
import { useToolActions } from "./useToolActions";
import { useI18n } from "../utils/i18n";

const MAX_RENDERED_TREE_ROWS = 900;

export function useAppController() {
  const { t } = useI18n();
  const activePage = useWorkspaceStore((state) => state.activePage);
  const projectLabel = useWorkspaceStore((state) => state.projectLabel);
  const projectPath = useWorkspaceStore((state) => state.projectPath);
  const projectStatus = useWorkspaceStore((state) => state.projectStatus);
  const isProjectLoading = useWorkspaceStore((state) => state.isProjectLoading);
  const agents = useWorkspaceStore((state) => state.agents);
  const selectedAgentId = useWorkspaceStore((state) => state.selectedAgentId);
  const executionMode = useWorkspaceStore((state) => state.executionMode);
  const toolStatuses = useWorkspaceStore((state) => state.toolStatuses);
  const lastRunStatus = useWorkspaceStore((state) => state.lastRunStatus);
  const runs = useWorkspaceStore((state) => state.runs);
  const selectedRunId = useWorkspaceStore((state) => state.selectedRunId);
  const selectedRunArtifact = useWorkspaceStore((state) => state.selectedRunArtifact);
  const runArtifactTab = useWorkspaceStore((state) => state.runArtifactTab);
  const isRunsLoading = useWorkspaceStore((state) => state.isRunsLoading);
  const setActivePage = useWorkspaceStore((state) => state.setActivePage);
  const setProjectLabel = useWorkspaceStore((state) => state.setProjectLabel);
  const setProjectPath = useWorkspaceStore((state) => state.setProjectPath);
  const setProjectStatus = useWorkspaceStore((state) => state.setProjectStatus);
  const setIsProjectLoading = useWorkspaceStore((state) => state.setIsProjectLoading);
  const setAgents = useWorkspaceStore((state) => state.setAgents);
  const setSelectedAgentId = useWorkspaceStore((state) => state.setSelectedAgentId);
  const setExecutionMode = useWorkspaceStore((state) => state.setExecutionMode);
  const setToolStatuses = useWorkspaceStore((state) => state.setToolStatuses);
  const setLastRunStatus = useWorkspaceStore((state) => state.setLastRunStatus);
  const setRuns = useWorkspaceStore((state) => state.setRuns);
  const setSelectedRunId = useWorkspaceStore((state) => state.setSelectedRunId);
  const setSelectedRunArtifact = useWorkspaceStore((state) => state.setSelectedRunArtifact);
  const setRunArtifactTab = useWorkspaceStore((state) => state.setRunArtifactTab);
  const setIsRunsLoading = useWorkspaceStore((state) => state.setIsRunsLoading);
  const setDiff = useWorkspaceStore((state) => state.setDiff);
  const [dialogText, setDialogText] = useState("");
  const flow = useFlowWeaveState();
  const sequence = useSequenceDiagramState({
    files: flow.projectFiles,
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
  const projectActions = useProjectActions({
    maxRenderedTreeRows: MAX_RENDERED_TREE_ROWS,
    projectPath,
    projectFiles: flow.projectFiles,
    replaceProjectGraph: flow.replaceProjectGraph,
    setIsProjectLoading,
    setLastRunStatus,
    setProjectLabel,
    setProjectPath,
    setProjectStatus
  });
  async function refreshRuns(selectRunId?: string) {
    if (!window.flowweave || !projectPath) return;
    setIsRunsLoading(true);
    try {
      const nextRuns = await window.flowweave.listToolRuns(projectPath);
      setRuns(nextRuns);
      const preferredRunId = selectRunId || selectedRunId;
      const nextRunId = nextRuns.some((run) => run.id === preferredRunId) ? preferredRunId : nextRuns[0]?.id || "";
      if (nextRunId) {
        await selectRun(nextRunId);
      } else {
        setSelectedRunId("");
        setSelectedRunArtifact(undefined);
      }
    } catch (error) {
      setLastRunStatus(t("status.runHistoryFailed", { error: formatErrorMessage(error) }));
    } finally {
      setIsRunsLoading(false);
    }
  }

  async function selectRun(runId: string) {
    if (!window.flowweave || !projectPath) return;
    setSelectedRunId(runId);
    try {
      const artifact = await window.flowweave.readToolRun(projectPath, runId);
      setSelectedRunArtifact(artifact);
    } catch (error) {
      setSelectedRunArtifact(undefined);
      setLastRunStatus(t("status.runArtifactFailed", { error: formatErrorMessage(error) }));
    }
  }

  async function openGitReviewFromRun() {
    setActivePage("git-review");
    if (!window.flowweave || !projectPath) return;
    try {
      const result = await window.flowweave.gitDiff(projectPath, selectedRunArtifact?.summary.checkpointId);
      setDiff(result);
    } catch (error) {
      setLastRunStatus(t("status.gitDiffFailed", { error: formatErrorMessage(error) }));
    }
  }

  const toolActions = useToolActions({
    buildGuidanceMarkdown: (label, nodes, edges) => buildGuidanceMarkdown(label, nodes, edges, t),
    agents,
    executionMode,
    graphRelations: flow.graphRelations,
    modules: flow.modules,
    projectLabel,
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

  function exportGuidanceFiles() {
    if (activePage === "structure") {
      if (!sequence.bundle) {
        sequence.setStatus(t("sequence.exportNeedsDiagram"));
        setLastRunStatus(t("sequence.exportNeedsDiagram"));
        return;
      }
      downloadText("sequence-guidance.md", buildSequenceGuidanceMarkdown(projectLabel, sequence.bundle, sequence.activeKind));
      downloadText("sequence-task.json", buildSequenceTaskJson(projectLabel, sequence.bundle, sequence.activeKind));
      setLastRunStatus(t("sequence.exported"));
      return;
    }
    downloadText("guidance.md", buildGuidanceMarkdown(projectLabel, flow.modules, flow.graphRelations, t));
    downloadText("task.json", buildTaskJson(projectLabel, flow.modules, flow.graphRelations, t));
  }

  async function sendActivePageToTool() {
    if (activePage === "structure") {
      await runSequenceToolPlan(selectedAgentId);
      return;
    }
    await toolActions.runToolPlan(selectedAgentId);
  }

  async function runSequenceToolPlan(agentId: import("../types").RuntimeAgentId) {
    if (!window.flowweave || !projectPath) {
      setLastRunStatus(t("docs.needDesktop"));
      sequence.setStatus(t("docs.needDesktop"));
      return;
    }
    if (!sequence.bundle) {
      const message = t("sequence.sendNeedsDiagram");
      setLastRunStatus(message);
      sequence.setStatus(message);
      return;
    }

    const agentName = agents.find((agent) => agent.id === agentId)?.name ?? (agentId === "mock" ? "Mock Agent" : agentId);
    setLastRunStatus(t("status.sequenceAgentProcessing", { agent: agentName, mode: executionMode }));
    try {
      const detection = await window.flowweave.detectAgent(agentId);
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], ...detection, checking: false } }));
      if (!detection.available) {
        setLastRunStatus(t("status.agentCannotPlan", { agent: agentName }));
        return;
      }

      const result = await window.flowweave.runToolPlan({
        projectPath,
        toolId: agentId,
        executionMode,
        prompt: buildSequencePlanPrompt(projectLabel, sequence.bundle, sequence.activeKind)
      });

      if (agentId !== "mock") setSelectedAgentId(agentId);
      setToolStatuses((current) => ({
        ...current,
        [agentId]: {
          ...current[agentId],
          lastRunStatus: result.status,
          lastOutputPath: result.planPath ?? result.logPath ?? result.resultPath
        }
      }));
      setLastRunStatus(`${agentName} ${executionMode} ${result.status} · ${result.planPath ?? result.logPath ?? "no output"}`);
      sequence.setStatus(t("sequence.sentToAgent", { title: sequence.diagram?.title ?? "Sequence Diagram" }));
      await refreshRuns(result.id);
    } catch (error) {
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], lastRunStatus: "failed" } }));
      setLastRunStatus(t("status.sequencePlanFailed", { agent: agentName, error: formatErrorMessage(error) }));
    }
  }

  useEffect(() => {
    if (!window.flowweave || !projectPath || flow.modules.length === 0) return;
    const timeout = window.setTimeout(() => {
      void window.flowweave?.saveCanvas(projectPath, {
        version: 1,
        id: "main",
        title: "Main Canvas",
        projectPath,
        generatedAt: new Date().toISOString(),
        nodes: flow.modules,
        edges: flow.graphRelations
      });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [canvasSnapshot, projectPath]);

  useEffect(() => {
    void refreshRuns();
  }, [projectPath]);

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

  async function analyzeCurrentProjectWithAgent() {
    await projectActions.analyzeProject(selectedAgentId);
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
    canvas: {
      connectionPanelMode: flow.connectionPanelMode,
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
      onOpenConnectionCreator: flow.openConnectionCreator,
      onOpenProject: projectActions.openProject,
      onRefreshProject: projectActions.refreshProject,
      onSelectEdge: flow.selectEdge,
      onSelectNode: (nodeId: string) => {
        flow.clearConnectionSelection();
        moduleActions.selectNode(nodeId);
      },
      onTogglePath: moduleActions.toggleProjectPath,
      onUpdateEdgeGuidance: flow.updateEdgeGuidance,
      onUpdateEdgeEndpoints: flow.updateEdgeEndpoints,
      onUpdateEdgeRelation: flow.updateEdgeRelation,
      onUpdateModuleFields: flow.updateModuleFields,
      onWriteDraft: moduleActions.writeDraft,
      projectFiles: flow.projectFiles,
      projectPath,
      projectStatus,
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

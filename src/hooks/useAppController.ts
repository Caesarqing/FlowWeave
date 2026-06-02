import { useEffect, useMemo, useState } from "react";
import { buildGuidanceMarkdown, buildSequenceGuidanceMarkdown, buildSequencePlanPrompt, buildSequenceTaskJson, buildTaskJson, downloadText } from "../utils/export-artifacts";
import { useWorkspaceStore } from "../stores/workspace.store";
import { useFlowWeaveState } from "./useFlowWeaveState";
import { useModuleActions } from "./useModuleActions";
import { useProjectActions } from "./useProjectActions";
import { useSequenceDiagramState } from "./useSequenceDiagramState";
import { useToolActions } from "./useToolActions";

const MAX_RENDERED_TREE_ROWS = 900;

export function useAppController() {
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
      setLastRunStatus(`读取运行历史失败：${formatErrorMessage(error)}`);
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
      setLastRunStatus(`读取运行产物失败：${formatErrorMessage(error)}`);
    }
  }

  async function openGitReviewFromRun() {
    setActivePage("git-review");
    if (!window.flowweave || !projectPath) return;
    try {
      const result = await window.flowweave.gitDiff(projectPath, selectedRunArtifact?.summary.checkpointId);
      setDiff(result);
    } catch (error) {
      setLastRunStatus(`读取 Git diff 失败：${formatErrorMessage(error)}`);
    }
  }

  const toolActions = useToolActions({
    buildGuidanceMarkdown,
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
        sequence.setStatus("请先生成 Sequence Diagram，再导出指导文件。");
        setLastRunStatus("请先生成 Sequence Diagram，再导出指导文件。");
        return;
      }
      downloadText("sequence-guidance.md", buildSequenceGuidanceMarkdown(projectLabel, sequence.bundle, sequence.activeKind));
      downloadText("sequence-task.json", buildSequenceTaskJson(projectLabel, sequence.bundle, sequence.activeKind));
      setLastRunStatus("已导出 Sequence Diagram 指导文件。");
      return;
    }
    downloadText("guidance.md", buildGuidanceMarkdown(projectLabel, flow.modules, flow.graphRelations));
    downloadText("task.json", buildTaskJson(projectLabel, flow.modules, flow.graphRelations));
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
      setLastRunStatus("请先在桌面版读取一个本地项目。");
      sequence.setStatus("请先在 Electron 桌面版打开项目。");
      return;
    }
    if (!sequence.bundle) {
      const message = "请先生成 Sequence Diagram，再发送给默认 Agent 生成计划。";
      setLastRunStatus(message);
      sequence.setStatus(message);
      return;
    }

    const agentName = agents.find((agent) => agent.id === agentId)?.name ?? (agentId === "mock" ? "Mock Agent" : agentId);
    setLastRunStatus(`正在让 ${agentName} 以 ${executionMode} 模式处理 Sequence Diagram...`);
    try {
      const detection = await window.flowweave.detectAgent(agentId);
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], ...detection, checking: false } }));
      if (!detection.available) {
        setLastRunStatus(`${agentName} 未检测到，无法生成计划。`);
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
      sequence.setStatus(`已发送 ${sequence.diagram?.title ?? "Sequence Diagram"} 给默认 Agent 生成计划。`);
      await refreshRuns(result.id);
    } catch (error) {
      setToolStatuses((current) => ({ ...current, [agentId]: { ...current[agentId], lastRunStatus: "failed" } }));
      setLastRunStatus(`${agentName} 生成 Sequence Diagram 计划失败：${formatErrorMessage(error)}`);
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
      setLastRunStatus(`读取 Agent 配置失败：${formatErrorMessage(error)}`);
    }
  }

  async function saveCustomAgent(input: import("../types").CustomAgentInput) {
    if (!window.flowweave) {
      setLastRunStatus("浏览器预览模式无法保存本地 Agent。请使用 npm run dev:electron 打开桌面版。");
      return;
    }
    try {
      const agent = await window.flowweave.saveCustomAgent(input);
      await refreshAgents(agent.id);
      setLastRunStatus(`已添加 Agent：${agent.name}`);
    } catch (error) {
      setLastRunStatus(`添加 Agent 失败：${formatErrorMessage(error)}`);
    }
  }

  async function deleteCustomAgent(agentId: import("../types").AgentId) {
    if (!window.flowweave) {
      setLastRunStatus("浏览器预览模式无法删除本地 Agent。请使用 npm run dev:electron 打开桌面版。");
      return;
    }
    try {
      await window.flowweave.deleteCustomAgent(agentId);
      await refreshAgents();
      setLastRunStatus("已删除自定义 Agent。");
    } catch (error) {
      setLastRunStatus(`删除 Agent 失败：${formatErrorMessage(error)}`);
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
    setLastRunStatus(`默认 Agent 已切换为 ${agent?.name ?? agentId}`);
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
      analysisLabel: projectStatus.includes("架构图") ? "Architecture map" : "Connect nodes to define modification context"
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

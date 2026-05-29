import { useEffect, useMemo, useState } from "react";
import type { ActivePage } from "../types";
import { buildGuidanceMarkdown, buildTaskJson, downloadText } from "../utils/export-artifacts";
import { useProjectStore } from "../stores/project.store";
import { useToolsStore } from "../stores/tools.store";
import { useFlowWeaveState } from "./useFlowWeaveState";
import { useModuleActions } from "./useModuleActions";
import { useProjectActions } from "./useProjectActions";
import { useToolActions } from "./useToolActions";

const MAX_RENDERED_TREE_ROWS = 900;

export function useAppController() {
  const [activePage, setActivePage] = useState<ActivePage>("canvas");
  const projectLabel = useProjectStore((state) => state.projectLabel);
  const projectPath = useProjectStore((state) => state.projectPath);
  const projectStatus = useProjectStore((state) => state.projectStatus);
  const isProjectLoading = useProjectStore((state) => state.isProjectLoading);
  const setProjectLabel = useProjectStore((state) => state.setProjectLabel);
  const setProjectPath = useProjectStore((state) => state.setProjectPath);
  const setProjectStatus = useProjectStore((state) => state.setProjectStatus);
  const setIsProjectLoading = useProjectStore((state) => state.setIsProjectLoading);
  const selectedToolId = useToolsStore((state) => state.selectedToolId);
  const executionMode = useToolsStore((state) => state.executionMode);
  const toolStatuses = useToolsStore((state) => state.toolStatuses);
  const lastRunStatus = useToolsStore((state) => state.lastRunStatus);
  const setSelectedToolId = useToolsStore((state) => state.setSelectedToolId);
  const setExecutionMode = useToolsStore((state) => state.setExecutionMode);
  const setToolStatuses = useToolsStore((state) => state.setToolStatuses);
  const setLastRunStatus = useToolsStore((state) => state.setLastRunStatus);
  const [dialogText, setDialogText] = useState("");
  const flow = useFlowWeaveState();
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
  const toolActions = useToolActions({
    buildGuidanceMarkdown,
    executionMode,
    graphRelations: flow.graphRelations,
    modules: flow.modules,
    projectLabel,
    projectPath,
    selectedNode: flow.selectedNode,
    setLastRunStatus,
    setSelectedToolId,
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
    downloadText("guidance.md", buildGuidanceMarkdown(projectLabel, flow.modules, flow.graphRelations));
    downloadText("task.json", buildTaskJson(projectLabel, flow.modules, flow.graphRelations));
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

  return {
    activePage,
    canvas: {
      edges: flow.edges,
      expandedPaths: flow.expandedPaths,
      graphRelations: flow.graphRelations,
      isProjectLoading,
      maxRenderedTreeRows: MAX_RENDERED_TREE_ROWS,
      nodes: flow.nodes,
      onAddNode: moduleActions.addNode,
      onAnalyzeProject: () => projectActions.analyzeProject(selectedToolId),
      onApplyDialog: moduleActions.applyDialog,
      onConnect: flow.handleConnect,
      onDialogTextChange: setDialogText,
      onEdgesChange: flow.onEdgesChange,
      onGuidanceChange: moduleActions.updateGuidance,
      onNodesChange: flow.handleCanvasNodesChange,
      onOpenProject: projectActions.openProject,
      onRefreshProject: projectActions.refreshProject,
      onSelectNode: moduleActions.selectNode,
      onTogglePath: moduleActions.toggleProjectPath,
      onWriteDraft: moduleActions.writeDraft,
      projectFiles: flow.projectFiles,
      projectPath,
      projectStatus,
      selectedNode: flow.selectedNode,
      analysisLabel: projectStatus.startsWith("Agent") ? "Agent 分析" : projectStatus.startsWith("基础") ? "基础扫描" : "Connect nodes to define modification context"
    },
    dialogText,
    isDesktopBridgeAvailable: Boolean(window.flowweave),
    onExport: exportGuidanceFiles,
    onPageChange: setActivePage,
    onSendToTool: () => toolActions.runToolPlan(selectedToolId),
    projectLabel,
    tools: {
      executionMode,
      lastRunStatus,
      onDetectTool: toolActions.detectTool,
      onExecutionModeChange: setExecutionMode,
      onOpenToolProject: toolActions.openToolProject,
      onRunToolPlan: toolActions.runToolPlan,
      onSelectTool: setSelectedToolId,
      selectedToolId,
      toolStatuses
    }
  };
}

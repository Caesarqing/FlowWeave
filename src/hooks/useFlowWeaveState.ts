import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange
} from "@xyflow/react";
import { useMemo, useState } from "react";
import type { GraphEdge, GraphEdgeRelation, GraphNode, ProjectFileNode } from "../types";
import { usePreferencesStore } from "../stores/preferences.store";
import { useWorkspaceStore } from "../stores/workspace.store";
import { deleteModuleFromCanvasGraph, updateGraphEdge, updateModuleInCanvasGraph } from "../utils/canvas-graph-crud";
import { createFlowEdge, createFlowNode, decorateFlowGraph, graphEdgeFromFlow, type FlowWeaveNode } from "../utils/graph-converters";

export function useFlowWeaveState() {
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [connectionPanelMode, setConnectionPanelMode] = useState<"create" | "edit">();
  const defaultRelation = usePreferencesStore((state) => state.defaultRelation);
  const modules = useWorkspaceStore((state) => state.modules);
  const projectFiles = useWorkspaceStore((state) => state.projectFiles);
  const expandedPaths = useWorkspaceStore((state) => state.expandedPaths);
  const selectedNodeId = useWorkspaceStore((state) => state.selectedNodeId);
  const nodes = useWorkspaceStore((state) => state.nodes);
  const edges = useWorkspaceStore((state) => state.edges);
  const setGraph = useWorkspaceStore((state) => state.setGraph);
  const setEdges = useWorkspaceStore((state) => state.setEdges);
  const setNodes = useWorkspaceStore((state) => state.setNodes);
  const setSelectedNodeId = useWorkspaceStore((state) => state.setSelectedNodeId);
  const togglePath = useWorkspaceStore((state) => state.togglePath);
  const updateModule = useWorkspaceStore((state) => state.updateModule);
  const syncNodePositions = useWorkspaceStore((state) => state.syncNodePositions);
  const graphRelations = useMemo(() => edges.map(graphEdgeFromFlow), [edges]);
  const decoratedGraph = useMemo(() => decorateFlowGraph(nodes, edges, selectedEdgeId), [edges, nodes, selectedEdgeId]);
  const selectedEdge = useMemo(() => {
    if (!selectedEdgeId) return undefined;
    const edge = edges.find((item) => item.id === selectedEdgeId);
    return edge ? graphEdgeFromFlow(edge) : undefined;
  }, [edges, selectedEdgeId]);
  const selectedNode = modules.find((node) => node.id === selectedNodeId) ?? modules[0];

  function replaceProjectGraph(nextModules: GraphNode[], nextEdges: GraphEdge[], nextFiles: ProjectFileNode[]) {
    setGraph(nextModules, nextEdges, nextFiles);
  }

  function handleCanvasNodesChange(changes: NodeChange<FlowWeaveNode>[]) {
    setNodes((currentNodes) => applyNodeChanges(changes, currentNodes));
    syncNodePositions(changes);
  }

  function handleConnect(connection: Connection) {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const nextEdge = createFlowEdge({
      id: `${connection.source}-${connection.target}-${Date.now()}`,
      source: connection.source,
      target: connection.target,
      relation: defaultRelation
    });
    setEdges((currentEdges) => appendEdge(currentEdges, nextEdge));
    setSelectedEdgeId(nextEdge.id);
    setConnectionPanelMode("edit");
  }

  function addModuleNode() {
    const index = modules.filter((node) => node.id.startsWith("module-")).length + 1;
    const newModule: GraphNode = {
      id: `module-${index}`,
      title: `Module ${index}`,
      subtitle: "手动补充模块",
      kind: "module",
      nodeType: "module",
      risk: "normal",
      description: "手动新增的后端模块节点，用于定义 Agent 可参考的文件边界。",
      files: ["src/new-module/index.ts"],
      guidanceDraft: "请先确认该模块职责，再决定是否需要修改连接模块。",
      status: "draft",
      x: 180 + index * 34,
      y: 520
    };
    setNodes((currentNodes) => [...currentNodes, createFlowNode(newModule)]);
    useWorkspaceStore.setState((state) => ({ modules: [...state.modules, newModule] }));
    setSelectedNodeId(newModule.id);
  }

  function openConnectionCreator() {
    setSelectedEdgeId(undefined);
    setConnectionPanelMode("create");
  }

  function selectEdge(edgeId: string) {
    setSelectedEdgeId(edgeId);
    setConnectionPanelMode("edit");
  }

  function clearConnectionSelection() {
    setSelectedEdgeId(undefined);
    setConnectionPanelMode(undefined);
  }

  function addConnection(input: { source: string; target: string; relation: GraphEdgeRelation; guidanceNote?: string }) {
    if (!input.source || !input.target || input.source === input.target) return;
    const nextEdge = createFlowEdge({
      id: `${input.source}-${input.target}-${Date.now()}`,
      source: input.source,
      target: input.target,
      relation: input.relation,
      guidanceNote: input.guidanceNote
    });
    setEdges((currentEdges) => appendEdge(currentEdges, nextEdge));
    setSelectedEdgeId(nextEdge.id);
    setConnectionPanelMode("edit");
  }

  function updateEdgeRelation(edgeId: string, relation: GraphEdgeRelation) {
    setEdges((currentEdges) =>
      updateGraphEdge(currentEdges.map(graphEdgeFromFlow), edgeId, { relation }).map(createFlowEdge)
    );
  }

  function updateEdgeGuidance(edgeId: string, guidanceNote: string) {
    setEdges((currentEdges) =>
      updateGraphEdge(currentEdges.map(graphEdgeFromFlow), edgeId, { guidanceNote }).map(createFlowEdge)
    );
  }

  function updateEdgeEndpoints(edgeId: string, source: string, target: string) {
    if (!source || !target || source === target) return;
    setEdges((currentEdges) =>
      updateGraphEdge(currentEdges.map(graphEdgeFromFlow), edgeId, { source, target }).map(createFlowEdge)
    );
  }

  function deleteEdge(edgeId: string) {
    setEdges((currentEdges) => currentEdges.filter((edge) => edge.id !== edgeId));
    if (edgeId === selectedEdgeId) clearConnectionSelection();
  }

  function updateModuleFields(nodeId: string, patch: Partial<GraphNode>) {
    updateModule(nodeId, (node) => updateModuleInCanvasGraph([node], nodeId, patch)[0] ?? node);
  }

  function deleteModuleNode(nodeId: string) {
    const graphEdges = useWorkspaceStore.getState().edges.map(graphEdgeFromFlow);
    const deletedGraph = deleteModuleFromCanvasGraph(useWorkspaceStore.getState().modules, graphEdges, nodeId);
    useWorkspaceStore.setState((state) => ({
      modules: deletedGraph.modules,
      nodes: state.nodes.filter((node) => node.id !== nodeId),
      selectedNodeId: state.selectedNodeId === nodeId ? deletedGraph.modules[0]?.id ?? "" : state.selectedNodeId
    }));
    setEdges(deletedGraph.edges.map(createFlowEdge));
    if (selectedEdgeId && graphEdges.some((edge) => edge.id === selectedEdgeId && (edge.source === nodeId || edge.target === nodeId))) {
      clearConnectionSelection();
    }
  }

  function handleEdgesChange(changes: EdgeChange[]) {
    if (selectedEdgeId && changes.some((change) => change.type === "remove" && change.id === selectedEdgeId)) {
      clearConnectionSelection();
    }
    setEdges((currentEdges) => applyEdgeChanges(changes, currentEdges));
  }

  return {
    addModuleNode,
    addConnection,
    clearConnectionSelection,
    connectionPanelMode,
    defaultRelation,
    deleteModuleNode,
    deleteEdge,
    edges: decoratedGraph.edges,
    expandedPaths,
    graphRelations,
    handleCanvasNodesChange,
    handleConnect,
    modules,
    nodes: decoratedGraph.nodes,
    onEdgesChange: handleEdgesChange,
    openConnectionCreator,
    projectFiles,
    replaceProjectGraph,
    selectEdge,
    selectedEdge,
    selectedEdgeId,
    selectedNode,
    selectedNodeId,
    setSelectedNodeId,
    togglePath,
    updateEdgeGuidance,
    updateEdgeEndpoints,
    updateEdgeRelation,
    updateModuleFields,
    updateModule
  };
}

function appendEdge(currentEdges: ReturnType<typeof createFlowEdge>[], nextEdge: ReturnType<typeof createFlowEdge>) {
  if (currentEdges.some((edge) => edge.id === nextEdge.id)) return currentEdges;
  return [...currentEdges, nextEdge];
}

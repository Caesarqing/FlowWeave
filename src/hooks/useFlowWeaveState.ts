import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange
} from "@xyflow/react";
import { useMemo, useState } from "react";
import type { CanvasLayoutMode, CanvasLayoutState, GraphEdge, GraphEdgeRelation, GraphNode, ProjectFileNode } from "../types";
import { usePreferencesStore } from "../stores/preferences.store";
import { useCanvasStore } from "../stores/canvas.store";
import { deleteModuleFromCanvasGraph, updateGraphEdge, updateModuleInCanvasGraph } from "../utils/canvas-graph-crud";
import { createFlowEdge, createFlowNode, decorateFlowGraph, graphEdgeFromFlow, type FlowWeaveNode } from "../utils/graph-converters";
import { useI18n } from "../utils/i18n";
import { invalidateModuleAssessment, unknownAssessment } from "../utils/module-assessment";

export function useFlowWeaveState() {
  const { t } = useI18n();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [connectionPanelMode, setConnectionPanelMode] = useState<"create" | "edit">();
  const defaultRelation = usePreferencesStore((state) => state.defaultRelation);
  const modules = useCanvasStore((state) => state.modules);
  const projectFiles = useCanvasStore((state) => state.projectFiles);
  const expandedPaths = useCanvasStore((state) => state.expandedPaths);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const setGraph = useCanvasStore((state) => state.setGraph);
  const setEdges = useCanvasStore((state) => state.setEdges);
  const setNodes = useCanvasStore((state) => state.setNodes);
  const setSelectedNodeId = useCanvasStore((state) => state.setSelectedNodeId);
  const togglePath = useCanvasStore((state) => state.togglePath);
  const updateModule = useCanvasStore((state) => state.updateModule);
  const syncNodePositions = useCanvasStore((state) => state.syncNodePositions);
  const canvasLayout = useCanvasStore((state) => state.canvasLayout);
  const applyAutoLayout = useCanvasStore((state) => state.applyAutoLayout);
  const restoreManualLayout = useCanvasStore((state) => state.restoreManualLayout);
  const setCollapsedGroups = useCanvasStore((state) => state.setCollapsedGroups);
  const graphRelations = useMemo(() => edges.map(graphEdgeFromFlow), [edges]);
  const decoratedGraph = useMemo(() => decorateFlowGraph(nodes, edges, selectedEdgeId), [edges, nodes, selectedEdgeId]);
  const selectedEdge = useMemo(() => {
    if (!selectedEdgeId) return undefined;
    const edge = edges.find((item) => item.id === selectedEdgeId);
    return edge ? graphEdgeFromFlow(edge) : undefined;
  }, [edges, selectedEdgeId]);
  const selectedNode = modules.find((node) => node.id === selectedNodeId) ?? modules[0];

  function replaceProjectGraph(
    nextModules: GraphNode[],
    nextEdges: GraphEdge[],
    nextFiles: ProjectFileNode[],
    layout?: CanvasLayoutState
  ) {
    setGraph(nextModules, nextEdges, nextFiles, layout);
  }

  function handleAutoLayout(mode: CanvasLayoutMode, positions: Record<string, { x: number; y: number }>) {
    applyAutoLayout(mode, positions);
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
    invalidateAssessments([connection.source, connection.target]);
    setSelectedEdgeId(nextEdge.id);
    setConnectionPanelMode("edit");
  }

  function addModuleNode() {
    const index = modules.filter((node) => node.id.startsWith("module-")).length + 1;
    const newModule: GraphNode = {
      id: `module-${index}`,
      title: `Module ${index}`,
      subtitle: t("module.manualSubtitle"),
      kind: "module",
      nodeType: "module",
      risk: "unknown",
      assessment: unknownAssessment("", new Date().toISOString()),
      description: t("module.manualDescription"),
      files: ["src/new-module/index.ts"],
      guidanceDraft: t("module.manualGuidance"),
      status: "draft",
      x: 180 + index * 34,
      y: 520
    };
    setNodes((currentNodes) => [...currentNodes, createFlowNode(newModule)]);
    useCanvasStore.setState((state) => ({ modules: [...state.modules, newModule] }));
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
    invalidateAssessments([input.source, input.target]);
    setSelectedEdgeId(nextEdge.id);
    setConnectionPanelMode("edit");
  }

  function updateEdgeRelation(edgeId: string, relation: GraphEdgeRelation) {
    const edge = graphRelations.find((item) => item.id === edgeId);
    setEdges((currentEdges) =>
      updateGraphEdge(currentEdges.map(graphEdgeFromFlow), edgeId, { relation }).map(createFlowEdge)
    );
    if (edge) invalidateAssessments([edge.source, edge.target]);
  }

  function updateEdgeGuidance(edgeId: string, guidanceNote: string) {
    const edge = graphRelations.find((item) => item.id === edgeId);
    setEdges((currentEdges) =>
      updateGraphEdge(currentEdges.map(graphEdgeFromFlow), edgeId, { guidanceNote }).map(createFlowEdge)
    );
    if (edge) invalidateAssessments([edge.source, edge.target]);
  }

  function updateEdgeEndpoints(edgeId: string, source: string, target: string) {
    if (!source || !target || source === target) return;
    const edge = graphRelations.find((item) => item.id === edgeId);
    setEdges((currentEdges) =>
      updateGraphEdge(currentEdges.map(graphEdgeFromFlow), edgeId, { source, target }).map(createFlowEdge)
    );
    invalidateAssessments([source, target, ...(edge ? [edge.source, edge.target] : [])]);
  }

  function deleteEdge(edgeId: string) {
    const edge = graphRelations.find((item) => item.id === edgeId);
    setEdges((currentEdges) => currentEdges.filter((edge) => edge.id !== edgeId));
    if (edge) invalidateAssessments([edge.source, edge.target]);
    if (edgeId === selectedEdgeId) clearConnectionSelection();
  }

  function updateModuleFields(nodeId: string, patch: Partial<GraphNode>) {
    updateModule(nodeId, (node) => updateModuleInCanvasGraph([node], nodeId, patch)[0] ?? node);
  }

  function deleteModuleNode(nodeId: string) {
    const graphEdges = useCanvasStore.getState().edges.map(graphEdgeFromFlow);
    const deletedGraph = deleteModuleFromCanvasGraph(useCanvasStore.getState().modules, graphEdges, nodeId);
    useCanvasStore.setState((state) => ({
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
    const removedIds = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
    invalidateAssessments(graphRelations
      .filter((edge) => removedIds.has(edge.id))
      .flatMap((edge) => [edge.source, edge.target]));
  }

  function invalidateAssessments(nodeIds: string[]) {
    const affected = new Set(nodeIds);
    if (affected.size === 0) return;
    const assessedAt = new Date().toISOString();
    useCanvasStore.setState((state) => {
      const nextModules = state.modules.map((module) =>
        affected.has(module.id) ? invalidateModuleAssessment(module, assessedAt) : module
      );
      return {
        modules: nextModules,
        nodes: state.nodes.map((node) => {
          const module = nextModules.find((item) => item.id === node.id);
          return module ? { ...node, data: { ...module } } : node;
        })
      };
    });
  }

  return {
    addModuleNode,
    canvasLayout,
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
    handleAutoLayout,
    handleConnect,
    modules,
    nodes: decoratedGraph.nodes,
    onEdgesChange: handleEdgesChange,
    openConnectionCreator,
    projectFiles,
    replaceProjectGraph,
    restoreManualLayout,
    selectEdge,
    selectedEdge,
    selectedEdgeId,
    selectedNode,
    selectedNodeId,
    setSelectedNodeId,
    setCollapsedGroups,
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

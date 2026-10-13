import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange
} from "@xyflow/react";
import { useMemo, useState } from "react";
import type { AutoConnectionHandleLayout, CanvasLayoutMode, CanvasLayoutState, CanvasMigrationReviewRequest, CodeflowCanvas, GraphEdge, GraphEdgeRelation, GraphNode, ProjectFileNode } from "../types";
import { usePreferencesStore } from "../stores/preferences.store";
import { useCanvasStore } from "../stores/canvas.store";
import { assertCanvasEditable, canvasEditingEnabled, useProjectStore } from "../stores/project.store";
import { deleteModuleFromCanvasGraph, updateGraphEdge, updateModuleInCanvasGraph } from "../utils/canvas-graph-crud";
import { createFlowEdge, createFlowNode, decorateFlowGraph, graphEdgeFromFlow, type FlowWeaveNode } from "../utils/graph-converters";
import { useI18n } from "../utils/i18n";
import { invalidateModuleAssessment, unknownAssessment } from "../utils/module-assessment";

export function useFlowWeaveState() {
  const { t } = useI18n();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [selectedProjectedEdge, setSelectedProjectedEdge] = useState<GraphEdge>();
  const [connectionPanelMode, setConnectionPanelMode] = useState<"create" | "edit">();
  const defaultRelation = usePreferencesStore((state) => state.defaultRelation);
  const modules = useCanvasStore((state) => state.modules);
  const hydrationVersion = useCanvasStore((state) => state.hydrationVersion);
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
  const groups = useCanvasStore((state) => state.groups);
  const quality = useCanvasStore((state) => state.quality);
  const generation = useCanvasStore((state) => state.generation);
  const generatedAt = useCanvasStore((state) => state.generatedAt);
  const userRevision = useCanvasStore((state) => state.userRevision);
  const hiddenGeneratedNodeIds = useCanvasStore((state) => state.hiddenGeneratedNodeIds);
  const hiddenGeneratedEdgeIds = useCanvasStore((state) => state.hiddenGeneratedEdgeIds);
  const orphanedNodeEdits = useCanvasStore((state) => state.orphanedNodeEdits);
  const migrationPendingItems = useCanvasStore((state) => state.migrationPendingItems);
  const preservedCounts = useCanvasStore((state) => state.preservedCounts);
  const canvasMetadata = useMemo(() => ({ generation, generatedAt, groups, quality, orphanedNodeEdits, migrationPendingItems, preservedCounts, hiddenGeneratedNodeIds, hiddenGeneratedEdgeIds }), [generation, generatedAt, groups, quality, orphanedNodeEdits, migrationPendingItems, preservedCounts, hiddenGeneratedNodeIds, hiddenGeneratedEdgeIds]);
  const orphanedEdges = useCanvasStore((state) => state.orphanedEdges);
  const applyAutoLayout = useCanvasStore((state) => state.applyAutoLayout);
  const restoreManualLayout = useCanvasStore((state) => state.restoreManualLayout);
  const setCollapsedGroups = useCanvasStore((state) => state.setCollapsedGroups);
  const setViewMode = useCanvasStore((state) => state.setViewMode);
  const graphRelations = useMemo(() => edges.map(graphEdgeFromFlow), [edges]);
  const decoratedGraph = useMemo(() => decorateFlowGraph(nodes, edges, selectedEdgeId), [edges, nodes, selectedEdgeId]);
  const selectedEdge = useMemo(() => {
    if (selectedProjectedEdge?.id === selectedEdgeId) return selectedProjectedEdge;
    const edge = edges.find((item) => item.id === selectedEdgeId);
    return edge ? graphEdgeFromFlow(edge) : undefined;
  }, [edges, selectedEdgeId, selectedProjectedEdge]);
  const selectedNode = modules.find((node) => node.id === selectedNodeId);

  function loadInitialStaticGraph(
    nextModules: GraphNode[],
    nextEdges: GraphEdge[],
    nextFiles: ProjectFileNode[],
    layout?: CanvasLayoutState,
    nextOrphanedEdges?: GraphEdge[],
    metadata?: Pick<CodeflowCanvas, "generation" | "generatedAt" | "userRevision" | "groups" | "quality" | "orphanedNodeEdits" | "migrationPendingItems" | "preservedCounts" | "hiddenGeneratedNodeIds" | "hiddenGeneratedEdgeIds">
  ) {
    setGraph(nextModules, nextEdges, nextFiles, layout, nextOrphanedEdges, metadata);
  }

  async function resolveCanvasMigrationItem(request: CanvasMigrationReviewRequest): Promise<CodeflowCanvas> {
    const projectId = useProjectStore.getState().projectId;
    if (!window.flowweave || !projectId) throw new Error("Project data is unavailable for migration review.");
    const current = useCanvasStore.getState();
    if (current.generation?.requestId !== request.generationId || current.userRevision !== request.userRevision) {
      throw new Error("The project graph changed while preparing migration review. Refresh the review and retry.");
    }
    const receipt = await window.flowweave.resolveCanvasMigrationItem(projectId, request);
    const loaded = await window.flowweave.readCanvas(projectId);
    const active = useCanvasStore.getState();
    if (useProjectStore.getState().projectId !== projectId || !loaded ||
      loaded.canvas.generation?.requestId !== receipt.generationId || loaded.canvas.userRevision !== receipt.userRevision ||
      active.generation?.requestId !== receipt.generationId) {
      throw new Error("The project graph changed while applying migration review. Reopen the project graph to reload its state.");
    }
    active.setGraph(loaded.canvas.nodes, loaded.canvas.edges, active.projectFiles, loaded.canvas.layout,
      loaded.canvas.orphanedEdges, loaded.canvas);
    return loaded.canvas;
  }

  function handleAutoLayout(
    mode: CanvasLayoutMode,
    positions: Record<string, { x: number; y: number }>,
    topologyFingerprint: string,
    handleLayout: AutoConnectionHandleLayout
  ) {
    applyAutoLayout(mode, positions, topologyFingerprint, handleLayout);
  }

  function handleCanvasNodesChange(
    changes: NodeChange<FlowWeaveNode>[],
    displayedPositions: Record<string, { x: number; y: number }>
  ) {
    const allowed = canvasEditingEnabled() ? changes : changes.filter((change) => change.type === "select" || change.type === "dimensions");
    if (canvasEditingEnabled()) syncNodePositions(allowed, displayedPositions);
    setNodes((currentNodes) => applyNodeChanges(allowed, currentNodes));
  }

  function handleConnect(connection: Connection) {
    assertCanvasEditable();
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const nextEdge = createFlowEdge({
      id: `${connection.source}-${connection.target}-${Date.now()}`,
      source: connection.source,
      target: connection.target,
      relation: defaultRelation,
      origin: "manual"
    });
    setEdges((currentEdges) => appendEdge(currentEdges, nextEdge));
    invalidateAssessments([connection.source, connection.target]);
    setSelectedEdgeId(nextEdge.id);
    setConnectionPanelMode("edit");
  }

  function addModuleNode() {
    assertCanvasEditable();
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
      y: 520,
      origin: "manual"
    };
    setNodes((currentNodes) => [...currentNodes, createFlowNode(newModule)]);
    useCanvasStore.setState((state) => ({ modules: [...state.modules, newModule] }));
    setSelectedNodeId(newModule.id);
  }

  function openConnectionCreator() {
    setSelectedEdgeId(undefined);
    setConnectionPanelMode("create");
  }

  function selectEdge(edge: GraphEdge) {
    setSelectedEdgeId(edge.id);
    setSelectedProjectedEdge(edge);
    setConnectionPanelMode("edit");
  }

  function clearConnectionSelection() {
    setSelectedEdgeId(undefined);
    setSelectedProjectedEdge(undefined);
    setConnectionPanelMode(undefined);
  }

  function addConnection(input: { source: string; target: string; relation: GraphEdgeRelation; guidanceNote?: string }) {
    assertCanvasEditable();
    if (!input.source || !input.target || input.source === input.target) return;
    const nextEdge = createFlowEdge({
      id: `${input.source}-${input.target}-${Date.now()}`,
      source: input.source,
      target: input.target,
      relation: input.relation,
      guidanceNote: input.guidanceNote,
      origin: "manual"
    });
    setEdges((currentEdges) => appendEdge(currentEdges, nextEdge));
    invalidateAssessments([input.source, input.target]);
    setSelectedEdgeId(nextEdge.id);
    setConnectionPanelMode("edit");
  }

  function updateEdgeRelation(edgeId: string, relation: GraphEdgeRelation) {
    assertCanvasEditable();
    const edge = graphRelations.find((item) => item.id === edgeId);
    setEdges((currentEdges) =>
      updateGraphEdge(currentEdges.map(graphEdgeFromFlow), edgeId, { relation }).map(createFlowEdge)
    );
    if (edge) invalidateAssessments([edge.source, edge.target]);
  }

  function updateEdgeGuidance(edgeId: string, guidanceNote: string) {
    assertCanvasEditable();
    setEdges((currentEdges) =>
      updateGraphEdge(currentEdges.map(graphEdgeFromFlow), edgeId, { guidanceNote }).map(createFlowEdge)
    );
  }

  function updateEdgeEndpoints(edgeId: string, source: string, target: string) {
    assertCanvasEditable();
    if (!source || !target || source === target) return;
    const edge = graphRelations.find((item) => item.id === edgeId);
    setEdges((currentEdges) =>
      updateGraphEdge(currentEdges.map(graphEdgeFromFlow), edgeId, { source, target }).map(createFlowEdge)
    );
    invalidateAssessments([source, target, ...(edge ? [edge.source, edge.target] : [])]);
  }

  function deleteEdge(edgeId: string) {
    assertCanvasEditable();
    const edge = graphRelations.find((item) => item.id === edgeId);
    setEdges((currentEdges) => currentEdges.filter((edge) => edge.id !== edgeId));
    if (edge) invalidateAssessments([edge.source, edge.target]);
    if (edgeId === selectedEdgeId) clearConnectionSelection();
  }

  function updateModuleFields(nodeId: string, patch: Partial<GraphNode>) {
    assertCanvasEditable();
    updateModule(nodeId, (node) => updateModuleInCanvasGraph([node], nodeId, patch)[0] ?? node);
  }

  function deleteModuleNode(nodeId: string) {
    assertCanvasEditable();
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
    if (!canvasEditingEnabled() && changes.some((change) => change.type !== "select")) return;
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
    canvasMetadata,
    userRevision,
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
    hydrationVersion,
    nodes: decoratedGraph.nodes,
    onEdgesChange: handleEdgesChange,
    openConnectionCreator,
    orphanedEdges,
    projectFiles,
    loadInitialStaticGraph,
    restoreManualLayout,
    resolveCanvasMigrationItem,
    selectEdge,
    selectedEdge,
    selectedEdgeId,
    selectedNode,
    selectedNodeId,
    setSelectedNodeId,
    setCollapsedGroups,
    setViewMode,
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

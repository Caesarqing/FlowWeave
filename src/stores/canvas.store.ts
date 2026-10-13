import type { Edge, NodeChange } from "@xyflow/react";
import { create } from "zustand";
import type { AutoConnectionHandleLayout, CanvasLayoutMode, CanvasLayoutState, CodeflowCanvas, GraphEdge, GraphNode, GraphViewMode, ProjectFileNode } from "../types";
import { createFlowEdge, createFlowNode, graphEdgeFromFlow, type FlowWeaveNode } from "../utils/graph-converters";
import { chooseInitialGraphView } from "../utils/graph-view-projection";
import { assertCanvasEditable } from "./project.store";

type CanvasState = {
  hydrationVersion: number;
  canvasLayout: CanvasLayoutState;
  orphanedEdges: GraphEdge[];
  groups: NonNullable<CodeflowCanvas["groups"]>;
  quality: CodeflowCanvas["quality"];
  generation: CodeflowCanvas["generation"];
  generatedAt: string;
  userRevision: number;
  hiddenGeneratedNodeIds: string[];
  hiddenGeneratedEdgeIds: string[];
  migrationPendingItems: NonNullable<CodeflowCanvas["migrationPendingItems"]>;
  orphanedNodeEdits: NonNullable<CodeflowCanvas["orphanedNodeEdits"]>;
  preservedCounts: NonNullable<CodeflowCanvas["preservedCounts"]>;
  modules: GraphNode[];
  edges: Edge[];
  nodes: FlowWeaveNode[];
  projectFiles: ProjectFileNode[];
  expandedPaths: Set<string>;
  selectedNodeId: string;
  setGraph: (modules: GraphNode[], edges: GraphEdge[], files: ProjectFileNode[], layout?: CanvasLayoutState, orphanedEdges?: GraphEdge[], metadata?: Pick<CodeflowCanvas, "generation" | "generatedAt" | "userRevision" | "groups" | "quality" | "orphanedNodeEdits" | "migrationPendingItems" | "preservedCounts" | "hiddenGeneratedNodeIds" | "hiddenGeneratedEdgeIds">) => void;
  setUserRevision: (revision: number) => void;
  setEdges: (updater: Edge[] | ((edges: Edge[]) => Edge[])) => void;
  setNodes: (updater: FlowWeaveNode[] | ((nodes: FlowWeaveNode[]) => FlowWeaveNode[])) => void;
  setSelectedNodeId: (selectedNodeId: string) => void;
  togglePath: (path: string) => void;
  updateModule: (nodeId: string, update: (node: GraphNode) => GraphNode) => void;
  syncNodePositions: (changes: NodeChange<FlowWeaveNode>[], displayedPositions: Record<string, { x: number; y: number }>) => void;
  applyAutoLayout: (mode: CanvasLayoutMode, positions: Record<string, { x: number; y: number }>, topologyFingerprint?: string, handleLayout?: AutoConnectionHandleLayout) => void;
  restoreManualLayout: () => void;
  setCollapsedGroups: (groups: string[]) => void;
  setViewMode: (mode: GraphViewMode) => void;
};

export const useCanvasStore = create<CanvasState>((set) => ({
  hydrationVersion: 0,
  canvasLayout: emptyLayout(),
  orphanedEdges: [],
  groups: [],
  quality: undefined,
  generation: undefined,
  generatedAt: "",
  userRevision: 0,
  hiddenGeneratedNodeIds: [],
  hiddenGeneratedEdgeIds: [],
  migrationPendingItems: [],
  orphanedNodeEdits: [],
  preservedCounts: { pending: 0, nodeEdits: 0, edges: 0 },
  modules: [],
  edges: [],
  nodes: [],
  projectFiles: [],
  expandedPaths: new Set(),
  selectedNodeId: "",
  setGraph: (modules, edges, files, layout, orphanedEdges, metadata) => set((state) => ({
    hydrationVersion: state.hydrationVersion + 1,
    modules,
    edges: edges.map(createFlowEdge),
    nodes: modules.map(createFlowNode),
    projectFiles: files,
    canvasLayout: layout ? normalizeCanvasLayout(layout, edges) : defaultCanvasLayout(modules, edges),
    orphanedEdges: orphanedEdges ?? [],
    groups: metadata?.groups ?? [],
    quality: metadata?.quality,
    generation: metadata?.generation,
    generatedAt: metadata?.generatedAt ?? "",
    userRevision: metadata?.userRevision ?? 0,
    hiddenGeneratedNodeIds: metadata?.hiddenGeneratedNodeIds ?? [],
    hiddenGeneratedEdgeIds: metadata?.hiddenGeneratedEdgeIds ?? [],
    migrationPendingItems: metadata?.migrationPendingItems ?? [],
    orphanedNodeEdits: metadata?.orphanedNodeEdits ?? [],
    preservedCounts: metadata?.preservedCounts ?? {
      pending: metadata?.migrationPendingItems?.length ?? 0,
      nodeEdits: metadata?.orphanedNodeEdits?.length ?? 0,
      edges: orphanedEdges?.length ?? 0
    },
    expandedPaths: new Set(),
    selectedNodeId: ""
  })),
  setUserRevision: (userRevision) => set({ userRevision }),
  setEdges: (updater) => set((state) => ({ edges: typeof updater === "function" ? updater(state.edges) : updater })),
  setNodes: (updater) => set((state) => ({ nodes: typeof updater === "function" ? updater(state.nodes) : updater })),
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  togglePath: (path) => set((state) => {
    const expandedPaths = new Set(state.expandedPaths);
    if (expandedPaths.has(path)) expandedPaths.delete(path);
    else expandedPaths.add(path);
    return { expandedPaths };
  }),
  updateModule: (nodeId, update) => {
    assertCanvasEditable();
    set((state) => {
    const modules = state.modules.map((node) => node.id === nodeId ? update(node) : node);
    const nodes = state.nodes.map((node) => {
      const module = modules.find((item) => item.id === node.id);
      return module ? { ...node, data: { ...module } } : node;
    });
    return { modules, nodes };
    });
  },
  syncNodePositions: (changes, displayedPositions) => set((state) => {
    const positionChanges = changes.filter(
      (change): change is NodeChange<FlowWeaveNode> & { id: string; position: { x: number; y: number } } =>
        change.type === "position" && "position" in change && Boolean(change.position)
    );
    if (positionChanges.length === 0) return state;
    const manualPositions = state.canvasLayout.activeMode === "manual"
      ? state.canvasLayout.manualPositions
      : {
        ...Object.fromEntries(state.nodes.map((node) => [node.id, node.position])),
        ...displayedPositions
      };
    return {
      modules: state.modules.map((module) => {
        const change = positionChanges.find((item) => item.id === module.id);
        return change ? { ...module, x: change.position.x, y: change.position.y } : module;
      }),
      canvasLayout: {
        ...state.canvasLayout,
        activeMode: "manual",
        manualPositions: {
          ...manualPositions,
          ...Object.fromEntries(positionChanges.map((change) => [change.id, change.position]))
        }
      }
    };
  }),
  applyAutoLayout: (mode, positions, topologyFingerprint, handleLayout) => set((state) => ({
    modules: state.modules.map((module) => positions[module.id] ? { ...module, ...positions[module.id] } : module),
    nodes: state.nodes.map((node) => positions[node.id] ? { ...node, position: positions[node.id] } : node),
    canvasLayout: {
      ...state.canvasLayout,
      activeMode: mode,
      autoLayouts: { ...state.canvasLayout.autoLayouts, [mode]: { ...state.canvasLayout.autoLayouts[mode], ...positions } },
      autoLayoutTopologyFingerprints: topologyFingerprint
        ? { ...state.canvasLayout.autoLayoutTopologyFingerprints, [mode]: topologyFingerprint }
        : state.canvasLayout.autoLayoutTopologyFingerprints,
      ...(handleLayout ? { autoConnectionHandles: { ...state.canvasLayout.autoConnectionHandles, [mode]: handleLayout } } : {})
    }
  })),
  restoreManualLayout: () => set((state) => ({
    modules: state.modules.map((module) => {
      const position = state.canvasLayout.manualPositions[module.id];
      return position ? { ...module, ...position } : module;
    }),
    nodes: state.nodes.map((node) => {
      const position = state.canvasLayout.manualPositions[node.id];
      return position ? { ...node, position } : node;
    }),
    canvasLayout: { ...state.canvasLayout, activeMode: "manual" }
  })),
  setCollapsedGroups: (collapsedGroups) => set((state) => ({
    canvasLayout: {
      ...state.canvasLayout,
      collapsedGroups: [...new Set(collapsedGroups)].sort()
    }
  })),
  setViewMode: (viewMode) => set((state) => ({
    canvasLayout: {
      ...state.canvasLayout,
      activeMode: state.canvasLayout.activeMode === "manual" ? "manual" : viewMode,
      viewMode
    }
  }))
}));

function emptyLayout(): CanvasLayoutState {
  return {
    activeMode: "manual",
    viewMode: "execution",
    manualPositions: {},
    autoLayouts: {},
    collapsedGroups: []
  };
}

function defaultCanvasLayout(modules: GraphNode[], edges: GraphEdge[]): CanvasLayoutState {
  const viewMode = chooseInitialGraphView(edges);
  return {
    activeMode: viewMode,
    viewMode,
    manualPositions: Object.fromEntries(modules.map((node) => [node.id, { x: node.x, y: node.y }])),
    autoLayouts: {},
    collapsedGroups: []
  };
}

function normalizeCanvasLayout(layout: CanvasLayoutState, edges: GraphEdge[]): CanvasLayoutState {
  const viewMode = layout.viewMode === "dependency" ? "dependency" : chooseInitialGraphView(edges);
  const autoLayouts = Object.fromEntries(
    (["execution", "dependency"] as const)
      .flatMap((mode) => layout.autoLayouts?.[mode] ? [[mode, layout.autoLayouts[mode]]] : [])
  );
  const topologyFingerprints = Object.fromEntries(
    (["execution", "dependency"] as const)
      .flatMap((mode) => layout.autoLayoutTopologyFingerprints?.[mode]
        ? [[mode, layout.autoLayoutTopologyFingerprints[mode]]]
        : [])
  );
  return {
    activeMode: layout.activeMode === "manual" ? "manual" : viewMode,
    viewMode,
    manualPositions: layout.manualPositions ?? {},
    autoLayouts,
    ...(layout.autoConnectionHandles ? { autoConnectionHandles: layout.autoConnectionHandles } : {}),
    ...(Object.keys(topologyFingerprints).length > 0 ? { autoLayoutTopologyFingerprints: topologyFingerprints } : {}),
    collapsedGroups: [...new Set((layout.collapsedGroups ?? [])
      .filter((group): group is string => typeof group === "string")
      .map((group) => group.startsWith("domain:") ? `area:${group.slice("domain:".length)}` : group)
      .filter((group) => group.startsWith("area:") || group.startsWith("group:") || group === "view:unlinked"))].sort()
  };
}

import type { Edge, NodeChange } from "@xyflow/react";
import { create } from "zustand";
import type { CanvasLayoutMode, CanvasLayoutState, GraphEdge, GraphNode, ProjectFileNode } from "../types";
import { createFlowEdge, createFlowNode, type FlowWeaveNode } from "../utils/graph-converters";

type CanvasState = {
  canvasLayout: CanvasLayoutState;
  modules: GraphNode[];
  edges: Edge[];
  nodes: FlowWeaveNode[];
  projectFiles: ProjectFileNode[];
  expandedPaths: Set<string>;
  selectedNodeId: string;
  setGraph: (modules: GraphNode[], edges: GraphEdge[], files: ProjectFileNode[], layout?: CanvasLayoutState) => void;
  setEdges: (updater: Edge[] | ((edges: Edge[]) => Edge[])) => void;
  setNodes: (updater: FlowWeaveNode[] | ((nodes: FlowWeaveNode[]) => FlowWeaveNode[])) => void;
  setSelectedNodeId: (selectedNodeId: string) => void;
  togglePath: (path: string) => void;
  updateModule: (nodeId: string, update: (node: GraphNode) => GraphNode) => void;
  syncNodePositions: (changes: NodeChange<FlowWeaveNode>[]) => void;
  applyAutoLayout: (mode: CanvasLayoutMode, positions: Record<string, { x: number; y: number }>) => void;
  restoreManualLayout: () => void;
  setCollapsedGroups: (groups: string[]) => void;
};

export const useCanvasStore = create<CanvasState>((set) => ({
  canvasLayout: emptyLayout(),
  modules: [],
  edges: [],
  nodes: [],
  projectFiles: [],
  expandedPaths: new Set(),
  selectedNodeId: "",
  setGraph: (modules, edges, files, layout) => set({
    modules,
    edges: edges.map(createFlowEdge),
    nodes: modules.map(createFlowNode),
    projectFiles: files,
    canvasLayout: layout ?? {
      activeMode: "execution",
      manualPositions: Object.fromEntries(modules.map((node) => [node.id, { x: node.x, y: node.y }])),
      autoLayouts: {},
      collapsedGroups: []
    },
    expandedPaths: new Set(),
    selectedNodeId: modules[0]?.id ?? ""
  }),
  setEdges: (updater) => set((state) => ({ edges: typeof updater === "function" ? updater(state.edges) : updater })),
  setNodes: (updater) => set((state) => ({ nodes: typeof updater === "function" ? updater(state.nodes) : updater })),
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  togglePath: (path) => set((state) => {
    const expandedPaths = new Set(state.expandedPaths);
    if (expandedPaths.has(path)) expandedPaths.delete(path);
    else expandedPaths.add(path);
    return { expandedPaths };
  }),
  updateModule: (nodeId, update) => set((state) => {
    const modules = state.modules.map((node) => node.id === nodeId ? update(node) : node);
    const nodes = state.nodes.map((node) => {
      const module = modules.find((item) => item.id === node.id);
      return module ? { ...node, data: { ...module } } : node;
    });
    return { modules, nodes };
  }),
  syncNodePositions: (changes) => set((state) => {
    const positionChanges = changes.filter(
      (change): change is NodeChange<FlowWeaveNode> & { id: string; position: { x: number; y: number } } =>
        change.type === "position" && "position" in change && Boolean(change.position)
    );
    if (positionChanges.length === 0) return state;
    return {
      modules: state.modules.map((module) => {
        const change = positionChanges.find((item) => item.id === module.id);
        return change ? { ...module, x: change.position.x, y: change.position.y } : module;
      }),
      canvasLayout: {
        ...state.canvasLayout,
        activeMode: "manual",
        manualPositions: {
          ...state.canvasLayout.manualPositions,
          ...Object.fromEntries(positionChanges.map((change) => [change.id, change.position]))
        }
      }
    };
  }),
  applyAutoLayout: (mode, positions) => set((state) => ({
    modules: state.modules.map((module) => positions[module.id] ? { ...module, ...positions[module.id] } : module),
    nodes: state.nodes.map((node) => positions[node.id] ? { ...node, position: positions[node.id] } : node),
    canvasLayout: {
      ...state.canvasLayout,
      activeMode: mode,
      autoLayouts: { ...state.canvasLayout.autoLayouts, [mode]: positions }
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
  }))
}));

function emptyLayout(): CanvasLayoutState {
  return {
    activeMode: "manual",
    manualPositions: {},
    autoLayouts: {},
    collapsedGroups: []
  };
}

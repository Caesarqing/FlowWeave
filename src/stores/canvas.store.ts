import { create } from "zustand";
import type { Edge, NodeChange } from "@xyflow/react";
import type { GraphEdge, GraphNode, ProjectFileNode } from "../types";
import { graphEdges, graphNodes } from "../data";
import { createFlowEdge, createFlowNode, graphEdgeFromFlow, type FlowWeaveNode } from "../utils/graph-converters";

type CanvasState = {
  modules: GraphNode[];
  edges: Edge[];
  nodes: FlowWeaveNode[];
  projectFiles: ProjectFileNode[];
  expandedPaths: Set<string>;
  selectedNodeId: string;
  setGraph: (modules: GraphNode[], edges: GraphEdge[], files: ProjectFileNode[]) => void;
  setEdges: (updater: Edge[] | ((edges: Edge[]) => Edge[])) => void;
  setNodes: (updater: FlowWeaveNode[] | ((nodes: FlowWeaveNode[]) => FlowWeaveNode[])) => void;
  setSelectedNodeId: (nodeId: string) => void;
  togglePath: (path: string) => void;
  updateModule: (nodeId: string, update: (node: GraphNode) => GraphNode) => void;
  syncNodePositions: (changes: NodeChange<FlowWeaveNode>[]) => void;
};

export const useCanvasStore = create<CanvasState>((set) => ({
  modules: graphNodes,
  edges: graphEdges.map(createFlowEdge),
  nodes: graphNodes.map(createFlowNode),
  projectFiles: [],
  expandedPaths: new Set(),
  selectedNodeId: graphNodes[0]?.id ?? "",
  setGraph: (modules, edges, files) =>
    set({
      modules,
      edges: edges.map(createFlowEdge),
      nodes: modules.map(createFlowNode),
      projectFiles: files,
      expandedPaths: new Set(),
      selectedNodeId: modules[0]?.id ?? ""
    }),
  setEdges: (updater) => set((state) => ({ edges: typeof updater === "function" ? updater(state.edges) : updater })),
  setNodes: (updater) => set((state) => ({ nodes: typeof updater === "function" ? updater(state.nodes) : updater })),
  setSelectedNodeId: (nodeId) => set({ selectedNodeId: nodeId }),
  togglePath: (path) =>
    set((state) => {
      const next = new Set(state.expandedPaths);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expandedPaths: next };
    }),
  updateModule: (nodeId, update) =>
    set((state) => {
      const modules = state.modules.map((node) => (node.id === nodeId ? update(node) : node));
      const nodes = state.nodes.map((node) => {
        const module = modules.find((item) => item.id === node.id);
        return module ? { ...node, data: { ...module } } : node;
      });
      return { modules, nodes };
    }),
  syncNodePositions: (changes) =>
    set((state) => {
      const positionChanges = changes.filter(
        (change): change is NodeChange<FlowWeaveNode> & { id: string; position: { x: number; y: number } } =>
          change.type === "position" && "position" in change && Boolean(change.position)
      );
      if (positionChanges.length === 0) return state;
      const modules = state.modules.map((module) => {
        const positionChange = positionChanges.find((change) => change.id === module.id);
        return positionChange ? { ...module, x: positionChange.position.x, y: positionChange.position.y } : module;
      });
      return { modules };
    })
}));

export function currentGraphRelations() {
  return useCanvasStore.getState().edges.map(graphEdgeFromFlow);
}

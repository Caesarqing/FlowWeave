import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange
} from "@xyflow/react";
import { useMemo } from "react";
import type { GraphEdge, GraphNode, ProjectFileNode } from "../types";
import { useCanvasStore } from "../stores/canvas.store";
import { createFlowEdge, createFlowNode, graphEdgeFromFlow, type FlowWeaveNode } from "../utils/graph-converters";

export function useFlowWeaveState() {
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
  const graphRelations = useMemo(() => edges.map(graphEdgeFromFlow), [edges]);
  const selectedNode = modules.find((node) => node.id === selectedNodeId) ?? modules[0];

  function replaceProjectGraph(nextModules: GraphNode[], nextEdges: GraphEdge[], nextFiles: ProjectFileNode[]) {
    setGraph(nextModules, nextEdges, nextFiles);
  }

  function handleCanvasNodesChange(changes: NodeChange<FlowWeaveNode>[]) {
    setNodes((currentNodes) => applyNodeChanges(changes, currentNodes));
    syncNodePositions(changes);
  }

  function handleConnect(connection: Connection) {
    setEdges((currentEdges) =>
      addEdge(
        createFlowEdge({
          id: `${connection.source}-${connection.target}-${Date.now()}`,
          source: connection.source ?? "",
          target: connection.target ?? "",
          relation: "depends_on"
        }),
        currentEdges
      )
    );
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
    useCanvasStore.setState((state) => ({ modules: [...state.modules, newModule] }));
    setSelectedNodeId(newModule.id);
  }

  return {
    addModuleNode,
    edges,
    expandedPaths,
    graphRelations,
    handleCanvasNodesChange,
    handleConnect,
    modules,
    nodes,
    onEdgesChange: (changes: EdgeChange[]) => setEdges((currentEdges) => applyEdgeChanges(changes, currentEdges)),
    projectFiles,
    replaceProjectGraph,
    selectedNode,
    selectedNodeId,
    setSelectedNodeId,
    togglePath,
    updateModule
  };
}

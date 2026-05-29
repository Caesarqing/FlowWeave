import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange
} from "@xyflow/react";
import { BrainCircuit, Plus } from "lucide-react";
import { AgentNode } from "./nodes/AgentNode";
import { DiffNode } from "./nodes/DiffNode";
import { DocNode } from "./nodes/DocNode";
import { FileNode } from "./nodes/FileNode";
import { HologridScene } from "./HologridScene";
import { ModuleNode } from "./nodes/ModuleNode";
import { RequirementNode } from "./nodes/RequirementNode";
import { TaskNode } from "./nodes/TaskNode";
import type { FlowWeaveNode } from "../utils/graph-converters";

const nodeTypes = {
  moduleNode: ModuleNode,
  requirementNode: RequirementNode,
  taskNode: TaskNode,
  fileNode: FileNode,
  docNode: DocNode,
  agentNode: AgentNode,
  diffNode: DiffNode
};

export function CanvasWorkspace({
  edges,
  nodes,
  onAddNode,
  onAnalyzeProject,
  analysisLabel,
  isAnalyzing,
  onConnect,
  onEdgesChange,
  onNodesChange,
  onSelectNode
}: {
  edges: Edge[];
  nodes: FlowWeaveNode[];
  onAddNode: () => void;
  onAnalyzeProject: () => void;
  analysisLabel: string;
  isAnalyzing: boolean;
  onConnect: (connection: Connection) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onNodesChange: (changes: NodeChange<FlowWeaveNode>[]) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <main className="canvas-shell">
      <div className="canvas-toolbar">
        <div>
          <strong>Backend Module Graph</strong>
          <span>{analysisLabel}</span>
        </div>
        <div className="canvas-toolbar-actions">
          <button className="ghost-button" disabled={isAnalyzing} type="button" onClick={onAnalyzeProject}>
            <BrainCircuit size={15} />
            {isAnalyzing ? "分析中..." : "AI 分析"}
          </button>
          <button className="add-node" type="button" onClick={onAddNode}>
            <Plus size={15} />
            新增模块节点
          </button>
        </div>
      </div>
      <section className="graph-stage" aria-label="FlowWeave backend module graph">
        <HologridScene />
        <ReactFlow
          className="flow-canvas"
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          maxZoom={1.35}
          minZoom={0.45}
          nodes={nodes}
          nodeTypes={nodeTypes}
          nodesDraggable
          onConnect={onConnect}
          onEdgesChange={onEdgesChange}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => onSelectNode(node.id)}
          panOnDrag
        >
          <Background color="rgba(148, 163, 184, 0.18)" gap={28} size={1} />
          <Controls showInteractive={false} />
          <MiniMap maskColor="rgba(2, 6, 23, 0.72)" nodeColor="#475569" pannable zoomable />
        </ReactFlow>
      </section>
    </main>
  );
}

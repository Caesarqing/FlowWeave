import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeTypes,
  type NodeChange
} from "@xyflow/react";
import { BrainCircuit, Link2, Plus } from "lucide-react";
import { AgentNode } from "./nodes/AgentNode";
import { DiffNode } from "./nodes/DiffNode";
import { DocNode } from "./nodes/DocNode";
import { FileNode } from "./nodes/FileNode";
import { HologridScene } from "./HologridScene";
import { ModuleNode } from "./nodes/ModuleNode";
import { RequirementNode } from "./nodes/RequirementNode";
import { TaskNode } from "./nodes/TaskNode";
import type { FlowWeaveNode } from "../utils/graph-converters";
import { useI18n } from "../utils/i18n";

const nodeTypes = {
  moduleNode: ModuleNode,
  requirementNode: RequirementNode,
  taskNode: TaskNode,
  fileNode: FileNode,
  docNode: DocNode,
  agentNode: AgentNode,
  diffNode: DiffNode
};

type ControlledFlowCanvasProps = {
  edges: Edge[];
  nodes: FlowWeaveNode[];
  onConnect: (connection: Connection) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onNodesChange: (changes: NodeChange<FlowWeaveNode>[]) => void;
  onPaneClick: () => void;
  onSelectEdge: (edgeId: string) => void;
  onSelectNode: (nodeId: string) => void;
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
  onOpenConnectionCreator,
  onNodesChange,
  onPaneClick,
  onSelectEdge,
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
  onOpenConnectionCreator: () => void;
  onNodesChange: (changes: NodeChange<FlowWeaveNode>[]) => void;
  onPaneClick: () => void;
  onSelectEdge: (edgeId: string) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const { t } = useI18n();

  return (
    <main className="canvas-shell">
      <div className="canvas-toolbar">
        <div>
          <strong>{t("canvas.title")}</strong>
          <span>{analysisLabel}</span>
        </div>
        <div className="canvas-toolbar-actions">
          <button className="ghost-button" disabled={isAnalyzing} type="button" onClick={onAnalyzeProject}>
            <BrainCircuit size={15} />
            <span className="button-label">{isAnalyzing ? t("canvas.analyzing") : t("canvas.generate")}</span>
          </button>
          <button className="add-node" type="button" onClick={onAddNode}>
            <Plus size={15} />
            <span className="button-label">{t("canvas.addNode")}</span>
          </button>
          <button className="ghost-button" type="button" onClick={onOpenConnectionCreator}>
            <Link2 size={15} />
            <span className="button-label">{t("canvas.addConnection")}</span>
          </button>
        </div>
      </div>
      <section className="graph-stage" aria-label="FlowWeave backend module graph">
        <HologridScene />
        <ControlledFlowCanvas
          edges={edges}
          nodes={nodes}
          onConnect={onConnect}
          onEdgesChange={onEdgesChange}
          onNodesChange={onNodesChange}
          onPaneClick={onPaneClick}
          onSelectEdge={onSelectEdge}
          onSelectNode={onSelectNode}
        />
      </section>
    </main>
  );
}

function ControlledFlowCanvas({
  edges,
  nodes,
  onConnect,
  onEdgesChange,
  onNodesChange,
  onPaneClick,
  onSelectEdge,
  onSelectNode
}: ControlledFlowCanvasProps) {
  /*
   * FlowWeave persists Canvas state in Zustand so autosave and Agent export can use
   * the same graph. Keep the controlled React Flow boundary isolated here.
   */
  return (
    <ReactFlow
      className="flow-canvas"
      edges={edges}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      maxZoom={1.35}
      minZoom={0.45}
      nodes={nodes}
      nodeTypes={nodeTypes as NodeTypes}
      nodesDraggable
      onConnect={onConnect}
      onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
      onEdgesChange={onEdgesChange}
      onNodesChange={onNodesChange}
      onNodeClick={(_, node) => onSelectNode(node.id)}
      onPaneClick={onPaneClick}
      panOnDrag
    >
      <Background color="rgba(148, 163, 184, 0.18)" gap={28} size={1} />
      <Controls showInteractive={false} />
      <MiniMap maskColor="rgba(2, 6, 23, 0.72)" nodeColor="#475569" pannable zoomable />
    </ReactFlow>
  );
}

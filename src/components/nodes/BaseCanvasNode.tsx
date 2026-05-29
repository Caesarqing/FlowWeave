import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FlowWeaveNode } from "../../utils/graph-converters";

const kindLabel: Record<string, string> = {
  module: "Module",
  requirement: "Requirement",
  task: "Task",
  file: "File",
  doc: "Doc",
  agent: "Agent",
  diff: "Diff"
};

export function BaseCanvasNode({ data, selected }: NodeProps<FlowWeaveNode>) {
  return (
    <div className={`flow-module-node ${selected ? "selected" : ""} ${data.risk} kind-${data.kind}`}>
      <Handle className="flow-handle" type="target" position={Position.Left} />
      <div className="node-meta-line">
        <span>{kindLabel[data.kind]}</span>
        <strong>{data.risk}</strong>
      </div>
      <h3>{data.title}</h3>
      <p>{data.description}</p>
      <div className="node-footer">
        <span>{data.files.length} files</span>
        <small>{data.files[0] ?? data.subtitle}</small>
      </div>
      <Handle className="flow-handle" type="source" position={Position.Right} />
    </div>
  );
}

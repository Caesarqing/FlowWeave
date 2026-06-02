import { Handle, Position, type NodeProps } from "@xyflow/react";
import { nodeTypeLabel, riskLabel } from "../utils/labels";
import type { FlowWeaveNode } from "../utils/graph-converters";
import { cn } from "../utils/classnames";

export function ModuleFlowNode({ data, selected }: NodeProps<FlowWeaveNode>) {
  const node = data;
  return (
    <div className={cn("flow-module-node", selected && "selected", node.risk)}>
      <Handle className="flow-handle" type="target" position={Position.Left} />
      <div className="node-meta-line">
        <span>{nodeTypeLabel[node.nodeType]}</span>
        <strong>{riskLabel[node.risk]}</strong>
      </div>
      <h3>{node.title}</h3>
      <p>{node.description}</p>
      <div className="node-footer">
        <span>{node.files.length} files</span>
        <small>{node.files[0]}</small>
      </div>
      <Handle className="flow-handle" type="source" position={Position.Right} />
    </div>
  );
}

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ConnectionHandleSlot } from "../../types";
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
  const targetHandles = data.connectionHandles?.target ?? [{ id: `${data.id}-target-idle`, offsetPercent: 50, count: 0 }];
  const sourceHandles = data.connectionHandles?.source ?? [{ id: `${data.id}-source-idle`, offsetPercent: 50, count: 0 }];

  return (
    <div
      className={`flow-module-node ${selected ? "selected" : ""} ${data.edgeConnected ? "edge-connected" : ""} ${
        data.selectedEdgeRole ? `edge-role-${data.selectedEdgeRole}` : ""
      } ${data.risk} kind-${data.kind}`}
    >
      <ConnectionHandles handles={targetHandles} position={Position.Left} type="target" />
      <div className="node-meta-line">
        <span>{data.category ?? kindLabel[data.kind]}</span>
        <strong>{data.risk}</strong>
      </div>
      <h3>{data.title}</h3>
      <p>{data.role ?? data.description}</p>
      <div className="node-footer">
        <span>{data.files.length} files</span>
        <small>{data.symbols?.length ? `${data.symbols.length} symbols` : data.files[0] ?? data.subtitle}</small>
      </div>
      <ConnectionHandles handles={sourceHandles} position={Position.Right} type="source" />
    </div>
  );
}

function ConnectionHandles({
  handles,
  position,
  type
}: {
  handles: ConnectionHandleSlot[];
  position: Position.Left | Position.Right;
  type: "source" | "target";
}) {
  return (
    <>
      {handles.map((handle) => (
        <Handle
          className={`flow-handle ${handle.collapsed ? "bulk" : ""} ${handle.count > 0 ? "connected" : "idle"}`}
          id={handle.id}
          key={handle.id}
          position={position}
          style={{ top: `${handle.offsetPercent}%` }}
          type={type}
        />
      ))}
    </>
  );
}

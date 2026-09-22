import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CSSProperties } from "react";
import type { ConnectionHandleSlot } from "../../types";
import { cn } from "../../utils/classnames";
import type { FlowWeaveNode } from "../../utils/graph-converters";
import { useI18n } from "../../utils/i18n";
import { localizedArchitectureCategory } from "../../utils/module-text";

export function BaseCanvasNode({ data, selected }: NodeProps<FlowWeaveNode>) {
  const { t } = useI18n();
  const targetHandles = data.connectionHandles?.target ?? [{ id: `${data.id}-target-idle`, offsetPercent: 50, count: 0 }];
  const sourceHandles = data.connectionHandles?.source ?? [{ id: `${data.id}-source-idle`, offsetPercent: 50, count: 0 }];

  return (
    <div
      className={cn(
        "flow-module-node",
        selected && "selected",
        data.edgeConnected && "edge-connected",
        data.selectedEdgeRole && `edge-role-${data.selectedEdgeRole}`,
        data.risk,
        `kind-${data.kind}`
      )}
      style={data.selectedEdgeColor ? ({ "--selected-edge-color": data.selectedEdgeColor } as CSSProperties) : undefined}
    >
      <ConnectionHandles handles={targetHandles} position={Position.Left} selectedEdgeId={data.selectedEdgeId} type="target" />
      <div className="node-meta-line">
        <span>{localizedArchitectureCategory(data.category, data.nodeType, t)}</span>
        <strong>{t(`risk.${data.risk}`)}</strong>
      </div>
      <h3>{data.title}</h3>
      <p>{data.role ?? data.description}</p>
      <div className="node-footer">
        <span>{t("module.fileCount", { count: data.files.length })}</span>
        <small>{data.symbols?.length ? t("module.symbolCount", { count: data.symbols.length }) : data.files[0] ?? data.subtitle}</small>
      </div>
      <ConnectionHandles handles={sourceHandles} position={Position.Right} selectedEdgeId={data.selectedEdgeId} type="source" />
    </div>
  );
}

function ConnectionHandles({
  handles,
  position,
  selectedEdgeId,
  type
}: {
  handles: ConnectionHandleSlot[];
  position: Position.Left | Position.Right;
  selectedEdgeId?: string;
  type: "source" | "target";
}) {
  return (
    <>
      {handles.map((handle) => (
        <Handle
          className={cn(
            "flow-handle",
            handle.collapsed && "bulk",
            handle.relation && `handle-relation-${handle.relation}`,
            (handle.edgeId === selectedEdgeId || (Boolean(selectedEdgeId) && handle.collapsed && handle.count > 0)) && "selected-handle",
            handle.count > 0 ? "connected" : "idle"
          )}
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

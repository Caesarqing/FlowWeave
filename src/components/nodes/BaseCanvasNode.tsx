import { Handle, Position, type NodeProps, useUpdateNodeInternals } from "@xyflow/react";
import { useEffect, type CSSProperties } from "react";
import type { ConnectionHandleSlot } from "../../types";
import { cn } from "../../utils/classnames";
import { CANVAS_NODE_SIZE } from "../../common/canvas-geometry";
import type { FlowWeaveNode } from "../../utils/graph-converters";
import { useI18n } from "../../utils/i18n";
import { localizedArchitectureCategory } from "../../utils/module-text";

export function BaseCanvasNode({ data, selected }: NodeProps<FlowWeaveNode>) {
  const { t } = useI18n();
  const targetHandles = data.connectionHandles?.target ?? [{ id: `${data.id}-target-idle`, offsetPercent: 50, count: 0 }];
  const sourceHandles = data.connectionHandles?.source ?? [{ id: `${data.id}-source-idle`, offsetPercent: 50, count: 0 }];
  const updateNodeInternals = useUpdateNodeInternals();
  const handleLayoutSignature = JSON.stringify([...targetHandles, ...sourceHandles]
    .map(({ id, position, offsetPercent }) => [id, position, offsetPercent]));

  useEffect(() => {
    updateNodeInternals(data.id);
  }, [data.id, handleLayoutSignature, updateNodeInternals]);

  return (
    <div
      className={cn(
        "flow-module-node",
        selected && "selected",
        data.edgeConnected && "edge-connected",
        data.selectedEdgeRole && `edge-role-${data.selectedEdgeRole}`,
        data.risk,
        `kind-${data.kind}`,
        data.syntheticKind === "group" && "canvas-group-node",
        data.resource && "canvas-resource-node"
      )}
      title={data.connectionExplanation}
      style={{
        width: CANVAS_NODE_SIZE.width,
        minHeight: data.syntheticKind === "group" ? CANVAS_NODE_SIZE.height : CANVAS_NODE_SIZE.minHeight,
        ...(data.selectedEdgeColor ? { "--selected-edge-color": data.selectedEdgeColor } : {})
      } as CSSProperties}
    >
      <ConnectionHandles handles={targetHandles} position={Position.Left} selectedEdgeId={data.selectedEdgeId} type="target" />
      <div className="node-meta-line">
        <span>{data.syntheticKind === "group" ? t("canvas.group") : data.resource ? t(`canvas.resource.${data.resource.kind}`) : localizedArchitectureCategory(data.category, data.nodeType, t)}</span>
        {data.syntheticKind === "group" ? <strong>{data.memberModuleCount ? t("canvas.groupModuleCount", { count: data.memberModuleCount }) : t("canvas.groupResourceCount", { count: data.memberResourceCount ?? 0 })}{data.memberModuleCount && data.memberResourceCount ? ` · ${t("canvas.groupResourceCount", { count: data.memberResourceCount })}` : ""}</strong> : !data.resource ? <strong>{data.assessmentPending ? t("module.assessmentPending") : t(`risk.${data.risk}`)}</strong> : null}
      </div>
      <h3>{data.title}</h3>
      <p>{data.role ?? data.description}</p>
      <div className="node-footer">
        <span>{data.syntheticKind === "group" ? t("canvas.groupExpandHint") : data.resource?.detail ?? t("module.fileCount", { count: data.files.length })}</span>
        {data.syntheticKind === "group" ? <button className="nodrag" type="button" onClick={data.onExpandGroup}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            if (event.repeat) return;
            data.onExpandGroup?.();
          }}>
          {t("canvas.expandGroup")}
        </button> : null}
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
          position={handlePosition(handle, position)}
          style={handleStyle(handle, position)}
          type={type}
        />
      ))}
    </>
  );
}

function handlePosition(handle: ConnectionHandleSlot, fallback: Position.Left | Position.Right): Position {
  if (handle.position === "left") return Position.Left;
  if (handle.position === "right") return Position.Right;
  if (handle.position === "top") return Position.Top;
  if (handle.position === "bottom") return Position.Bottom;
  return fallback;
}

function handleStyle(handle: ConnectionHandleSlot, fallback: Position.Left | Position.Right): CSSProperties {
  const position = handle.position ?? (fallback === Position.Left ? "left" : "right");
  return position === "top" || position === "bottom"
    ? { left: `${handle.offsetPercent}%` }
    : { top: `${handle.offsetPercent}%` };
}

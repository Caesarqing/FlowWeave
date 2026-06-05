import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FlowWeaveNode } from "../utils/graph-converters";
import { cn } from "../utils/classnames";
import { useI18n } from "../utils/i18n";

export function ModuleFlowNode({ data, selected }: NodeProps<FlowWeaveNode>) {
  const { t } = useI18n();
  const node = data;
  return (
    <div className={cn("flow-module-node", selected && "selected", node.risk)}>
      <Handle className="flow-handle" type="target" position={Position.Left} />
      <div className="node-meta-line">
        <span>{t(`nodeType.${node.nodeType}`)}</span>
        <strong>{t(`risk.${node.risk}`)}</strong>
      </div>
      <h3>{node.title}</h3>
      <p>{node.description}</p>
      <div className="node-footer">
        <span>{t("module.fileCount", { count: node.files.length })}</span>
        <small>{node.files[0]}</small>
      </div>
      <Handle className="flow-handle" type="source" position={Position.Right} />
    </div>
  );
}

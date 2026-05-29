import { ChevronRight, FileCode2, GitPullRequestArrow, Send } from "lucide-react";
import type { GraphEdge, GraphNode } from "../types";
import { nodeTypeLabel, relationLabel, riskLabel } from "../utils/labels";

export function ModulePanel({
  dialogText,
  edges,
  node,
  onApplyDialog,
  onDialogTextChange,
  onGuidanceChange,
  onWriteDraft
}: {
  dialogText: string;
  edges: GraphEdge[];
  node: GraphNode;
  onApplyDialog: () => void;
  onDialogTextChange: (value: string) => void;
  onGuidanceChange: (value: string) => void;
  onWriteDraft: () => void;
}) {
  const relatedEdges = edges.filter((edge) => edge.source === node.id || edge.target === node.id);

  return (
    <aside className="module-panel">
      <div className="panel-header">
        <span>Module Context</span>
        <span className={`risk-chip ${node.risk}`}>{riskLabel[node.risk]}</span>
      </div>

      <section className="module-card hero-card">
        <small>{nodeTypeLabel[node.nodeType]}</small>
        <h2>{node.title}</h2>
        <p>{node.description}</p>
      </section>

      <section className="module-card">
        <h3>包含文件</h3>
        <div className="file-list">
          {node.files.map((file) => (
            <div className="file-pill" key={file}>
              <FileCode2 size={14} />
              <span>{file}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="module-card">
        <h3>连接关系</h3>
        <div className="relation-list">
          {relatedEdges.length > 0 ? (
            relatedEdges.map((edge) => (
              <div className="relation-row" key={edge.id}>
                <GitPullRequestArrow size={14} />
                <span>
                  {edge.source} <ChevronRight size={12} /> {edge.target}
                </span>
                <strong>{relationLabel[edge.relation]}</strong>
              </div>
            ))
          ) : (
            <p>还没有连接。拖拽节点左右连接点来定义修改依据。</p>
          )}
        </div>
      </section>

      <section className="module-card guidance-card">
        <h3>给 Agent 的指导草稿</h3>
        <textarea value={node.guidanceDraft} onChange={(event) => onGuidanceChange(event.target.value)} />
        <label className="dialog-box">
          <span>对话调整</span>
          <textarea
            value={dialogText}
            onChange={(event) => onDialogTextChange(event.target.value)}
            placeholder="例如：这个模块只允许修改 service 和测试，不要改 schema。"
          />
        </label>
        <div className="dialog-actions">
          <button className="ghost-button" type="button" onClick={onApplyDialog}>
            <Send size={15} />
            写入指导
          </button>
          <button className="send-button" type="button" onClick={onWriteDraft}>
            保存状态
          </button>
        </div>
      </section>
    </aside>
  );
}

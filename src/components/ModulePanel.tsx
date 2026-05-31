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
        <small>{node.category ?? nodeTypeLabel[node.nodeType]}</small>
        <h2>{node.title}</h2>
        <p>{node.description}</p>
        {node.role ? <p className="module-role">{node.role}</p> : null}
        {typeof node.confidence === "number" ? <span className="confidence-chip">Confidence {Math.round(node.confidence * 100)}%</span> : null}
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
        {node.fileRoles && node.fileRoles.length > 0 ? (
          <div className="detail-list">
            {node.fileRoles.map((fileRole) => (
              <div className="detail-row" key={`${fileRole.path}-${fileRole.role}`}>
                <strong>{fileRole.path}</strong>
                <span>{fileRole.role}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="module-card">
        <h3>关键函数 / 类</h3>
        <div className="detail-list">
          {node.symbols && node.symbols.length > 0 ? (
            node.symbols.map((symbol) => (
              <div className="detail-row" key={`${symbol.filePath}-${symbol.kind}-${symbol.name}-${symbol.line ?? ""}`}>
                <strong>{symbol.name}</strong>
                <span>
                  {symbol.kind} · {symbol.filePath}{symbol.role ? ` · ${symbol.role}` : ""}
                </span>
              </div>
            ))
          ) : (
            <p>暂无关键函数或类。重新生成架构图可补充结构细节。</p>
          )}
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
                {edge.guidanceNote ? <em>{edge.guidanceNote}</em> : null}
                {edge.evidence?.map((item) => (
                  <small key={`${edge.id}-${item.filePath ?? ""}-${item.symbol ?? ""}-${item.detail}`}>
                    {item.filePath ? `${item.filePath}: ` : ""}{item.detail}
                  </small>
                ))}
              </div>
            ))
          ) : (
            <p>还没有连接。拖拽节点左右连接点来定义修改依据。</p>
          )}
        </div>
      </section>

      {node.evidence && node.evidence.length > 0 ? (
        <section className="module-card">
          <h3>判断依据</h3>
          <div className="detail-list">
            {node.evidence.map((item) => (
              <div className="detail-row" key={`${item.filePath ?? ""}-${item.symbol ?? ""}-${item.detail}`}>
                <strong>{item.symbol ?? item.filePath ?? "Evidence"}</strong>
                <span>{item.filePath ? `${item.filePath} · ` : ""}{item.detail}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

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

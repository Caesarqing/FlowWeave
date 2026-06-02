import { ChevronDown, ChevronRight, FileCode2, Folder, GitPullRequestArrow, Send, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { GraphEdge, GraphNode, GraphNodeType, GraphRisk } from "../types";
import { nodeTypeLabel, relationLabel, riskLabel } from "../utils/labels";
import { buildModuleFileTree, type ModuleFileTreeNode } from "../utils/module-file-tree";

const nodeTypeOptions: GraphNodeType[] = ["module", "entrypoint", "api", "service", "data", "external", "worker", "utility", "test"];
const riskOptions: GraphRisk[] = ["normal", "review", "blocked"];

export function ModulePanel({
  dialogText,
  edges,
  node,
  onApplyDialog,
  onDeleteNode,
  onDialogTextChange,
  onGuidanceChange,
  onModuleChange,
  onWriteDraft
}: {
  dialogText: string;
  edges: GraphEdge[];
  node: GraphNode;
  onApplyDialog: () => void;
  onDeleteNode: (nodeId: string) => void;
  onDialogTextChange: (value: string) => void;
  onGuidanceChange: (value: string) => void;
  onModuleChange: (nodeId: string, patch: Partial<GraphNode>) => void;
  onWriteDraft: () => void;
}) {
  const [openSections, setOpenSections] = useState({
    files: true,
    symbols: false,
    evidence: false
  });
  const relatedEdges = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  const fileTree = useMemo(() => buildModuleFileTree(node.files, node.fileRoles), [node.fileRoles, node.files]);

  function toggleSection(section: keyof typeof openSections) {
    setOpenSections((current) => ({ ...current, [section]: !current[section] }));
  }

  function updateFiles(value: string) {
    const files = value
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean);
    const fileSet = new Set(files);
    onModuleChange(node.id, {
      files,
      fileRoles: node.fileRoles?.filter((fileRole) => fileSet.has(fileRole.path))
    });
  }

  function deleteNode() {
    if (window.confirm(`删除模块「${node.title}」？相关连接也会同时删除。`)) {
      onDeleteNode(node.id);
    }
  }

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

      <section className="module-card module-edit-card">
        <h3>模块变更</h3>
        <div className="module-edit-form">
          <label>
            标题
            <input value={node.title} onChange={(event) => onModuleChange(node.id, { title: event.target.value })} />
          </label>
          <label>
            类型
            <select value={node.nodeType} onChange={(event) => onModuleChange(node.id, { nodeType: event.target.value as GraphNodeType })}>
              {nodeTypeOptions.map((option) => (
                <option key={option} value={option}>
                  {nodeTypeLabel[option]}
                </option>
              ))}
            </select>
          </label>
          <label>
            风险
            <select value={node.risk} onChange={(event) => onModuleChange(node.id, { risk: event.target.value as GraphRisk })}>
              {riskOptions.map((option) => (
                <option key={option} value={option}>
                  {riskLabel[option]}
                </option>
              ))}
            </select>
          </label>
          <label className="module-edit-wide">
            描述
            <textarea value={node.description} onChange={(event) => onModuleChange(node.id, { description: event.target.value })} />
          </label>
          <label className="module-edit-wide">
            文件列表
            <textarea value={node.files.join("\n")} onChange={(event) => updateFiles(event.target.value)} />
          </label>
        </div>
        <button className="ghost-button danger-button sequence-wide-button" type="button" onClick={deleteNode}>
          <Trash2 size={15} />
          删除模块
        </button>
      </section>

      <CollapsibleCard isOpen={openSections.files} title="包含文件" onToggle={() => toggleSection("files")}>
        {fileTree.length > 0 ? (
          <div className="module-file-tree">
            {fileTree.map((item) => (
              <FileTreeRow key={item.id} node={item} />
            ))}
          </div>
        ) : (
          <p>暂无文件。可在模块变更中按行补充文件路径。</p>
        )}
      </CollapsibleCard>

      <CollapsibleCard isOpen={openSections.symbols} title="关键函数 / 类" onToggle={() => toggleSection("symbols")}>
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
      </CollapsibleCard>

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

      <CollapsibleCard isOpen={openSections.evidence} title="判断依据" onToggle={() => toggleSection("evidence")}>
        {node.evidence && node.evidence.length > 0 ? (
          <div className="detail-list">
            {node.evidence.map((item) => (
              <div className="detail-row" key={`${item.filePath ?? ""}-${item.symbol ?? ""}-${item.detail}`}>
                <strong>{item.symbol ?? item.filePath ?? "Evidence"}</strong>
                <span>{item.filePath ? `${item.filePath} · ` : ""}{item.detail}</span>
              </div>
            ))}
          </div>
        ) : (
          <p>暂无判断依据。重新生成架构图可补充 evidence。</p>
        )}
      </CollapsibleCard>

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

function CollapsibleCard({ children, isOpen, onToggle, title }: { children: ReactNode; isOpen: boolean; onToggle: () => void; title: string }) {
  return (
    <section className="module-card collapsible-card">
      <button className="collapsible-card-header" type="button" onClick={onToggle} aria-expanded={isOpen}>
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <h3>{title}</h3>
      </button>
      {isOpen ? <div className="collapsible-card-body">{children}</div> : null}
    </section>
  );
}

function FileTreeRow({ node }: { node: ModuleFileTreeNode }) {
  return (
    <>
      <div className={`module-file-tree-row ${node.type}`} style={{ paddingLeft: `${node.depth * 14}px` }}>
        {node.type === "folder" ? (
          <>
            <ChevronDown size={12} />
            <Folder size={14} />
          </>
        ) : (
          <>
            <span className="tree-indent-spacer" />
            <FileCode2 size={14} />
          </>
        )}
        <span>
          <strong>{node.name}</strong>
          {node.role ? <small>{node.role}</small> : null}
        </span>
      </div>
      {node.children.map((child) => (
        <FileTreeRow key={child.id} node={child} />
      ))}
    </>
  );
}

import { ChevronDown, ChevronRight, FileCode2, Folder, GitPullRequestArrow, Send, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { GraphEdge, GraphNode, GraphNodeType, GraphRisk } from "../types";
import { cn } from "../utils/classnames";
import { useI18n } from "../utils/i18n";
import { buildModuleFileTree, type ModuleFileTreeNode } from "../utils/module-file-tree";
import {
  localizedArchitectureCategory,
  localizedModuleDescription,
  localizedModuleGuidance,
  localizedModuleRole
} from "../utils/module-text";

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
  const { t } = useI18n();
  const [openSections, setOpenSections] = useState({
    files: true,
    symbols: false,
    evidence: false
  });
  const relatedEdges = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  const fileTree = useMemo(() => buildModuleFileTree(node.files, node.fileRoles), [node.fileRoles, node.files]);
  const localizedDescription = localizedModuleDescription(node, t);
  const localizedGuidance = localizedModuleGuidance(node, t);
  const localizedRole = localizedModuleRole(node, t);

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
    if (window.confirm(t("module.deleteConfirm", { title: node.title }))) {
      onDeleteNode(node.id);
    }
  }

  return (
    <aside className="module-panel">
      <div className="panel-header">
        <span>{t("module.context")}</span>
        <span className={cn("risk-chip", node.risk)}>{t(`risk.${node.risk}`)}</span>
      </div>

      <section className="module-card hero-card">
        <small>{localizedArchitectureCategory(node.category, node.nodeType, t)}</small>
        <h2>{node.title}</h2>
        <p>{localizedDescription}</p>
        {localizedRole ? <p className="module-role">{localizedRole}</p> : null}
        {typeof node.confidence === "number" ? <span className="confidence-chip">{t("module.confidence", { value: Math.round(node.confidence * 100) })}</span> : null}
      </section>

      <section className="module-card module-edit-card">
        <h3>{t("module.change")}</h3>
        <div className="module-edit-form">
          <label>
            {t("module.title")}
            <input value={node.title} onChange={(event) => onModuleChange(node.id, { title: event.target.value })} />
          </label>
          <label>
            {t("module.type")}
            <select value={node.nodeType} onChange={(event) => onModuleChange(node.id, { nodeType: event.target.value as GraphNodeType })}>
              {nodeTypeOptions.map((option) => (
                <option key={option} value={option}>
                  {t(`nodeType.${option}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("module.risk")}
            <select value={node.risk} onChange={(event) => onModuleChange(node.id, { risk: event.target.value as GraphRisk })}>
              {riskOptions.map((option) => (
                <option key={option} value={option}>
                  {t(`risk.${option}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="module-edit-wide">
            {t("module.description")}
            <textarea value={localizedDescription} onChange={(event) => onModuleChange(node.id, { description: event.target.value })} />
          </label>
          <label className="module-edit-wide">
            {t("module.fileList")}
            <textarea value={node.files.join("\n")} onChange={(event) => updateFiles(event.target.value)} />
          </label>
        </div>
        <button className="ghost-button danger-button sequence-wide-button" type="button" onClick={deleteNode}>
          <Trash2 size={15} />
          {t("module.delete")}
        </button>
      </section>

      <CollapsibleCard isOpen={openSections.files} title={t("module.files")} onToggle={() => toggleSection("files")}>
        {fileTree.length > 0 ? (
          <div className="module-file-tree">
            {fileTree.map((item) => (
              <FileTreeRow key={item.id} node={item} />
            ))}
          </div>
        ) : (
          <p>{t("module.noFiles")}</p>
        )}
      </CollapsibleCard>

      <CollapsibleCard isOpen={openSections.symbols} title={t("module.keySymbols")} onToggle={() => toggleSection("symbols")}>
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
            <p>{t("module.noSymbols")}</p>
          )}
        </div>
      </CollapsibleCard>

      <section className="module-card">
        <h3>{t("module.relations")}</h3>
        <div className="relation-list">
          {relatedEdges.length > 0 ? (
            relatedEdges.map((edge) => (
              <div className="relation-row" key={edge.id}>
                <GitPullRequestArrow size={14} />
                <span>
                  {edge.source} <ChevronRight size={12} /> {edge.target}
                </span>
                <strong>{t(`relation.${edge.relation}Accent`)}</strong>
                {edge.guidanceNote ? <em>{edge.guidanceNote}</em> : null}
                {edge.evidence?.map((item) => (
                  <small key={`${edge.id}-${item.filePath ?? ""}-${item.symbol ?? ""}-${item.detail}`}>
                    {item.filePath ? `${item.filePath}: ` : ""}{item.detail}
                  </small>
                ))}
              </div>
            ))
          ) : (
            <p>{t("module.noConnections")}</p>
          )}
        </div>
      </section>

      <CollapsibleCard isOpen={openSections.evidence} title={t("module.evidence")} onToggle={() => toggleSection("evidence")}>
        {node.evidence && node.evidence.length > 0 ? (
          <div className="detail-list">
            {node.evidence.map((item) => (
              <div className="detail-row" key={`${item.filePath ?? ""}-${item.symbol ?? ""}-${item.detail}`}>
                <strong>{item.symbol ?? item.filePath ?? t("module.evidence")}</strong>
                <span>{item.filePath ? `${item.filePath} · ` : ""}{item.detail}</span>
              </div>
            ))}
          </div>
        ) : (
          <p>{t("module.noEvidence")}</p>
        )}
      </CollapsibleCard>

      <section className="module-card guidance-card">
        <h3>{t("module.guidanceDraft")}</h3>
        <textarea value={localizedGuidance} onChange={(event) => onGuidanceChange(event.target.value)} />
        <label className="dialog-box">
          <span>{t("module.dialog")}</span>
          <textarea
            value={dialogText}
            onChange={(event) => onDialogTextChange(event.target.value)}
            placeholder={t("module.dialogPlaceholder")}
          />
        </label>
        <div className="dialog-actions">
          <button className="ghost-button" type="button" onClick={onApplyDialog}>
            <Send size={15} />
            {t("module.writeGuidance")}
          </button>
          <button className="send-button" type="button" onClick={onWriteDraft}>
            {t("module.saveStatus")}
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
  const [isOpen, setIsOpen] = useState(true);
  const hasChildren = node.type === "folder" && node.children.length > 0;

  return (
    <>
      <div className={cn("module-file-tree-row", node.type)} style={{ paddingLeft: `${node.depth * 14}px` }}>
        {hasChildren ? (
          <button className="module-file-tree-toggle" type="button" onClick={() => setIsOpen((current) => !current)} aria-label={node.name} aria-expanded={isOpen}>
            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : node.type === "folder" ? (
          <span className="tree-indent-spacer" />
        ) : (
          <span className="tree-indent-spacer" />
        )}
        {node.type === "folder" ? <Folder size={14} /> : <FileCode2 size={14} />}
        <span>
          <strong>{node.name}</strong>
          {node.role ? <small>{node.role}</small> : null}
        </span>
      </div>
      {isOpen ? node.children.map((child) => <FileTreeRow key={child.id} node={child} />) : null}
    </>
  );
}

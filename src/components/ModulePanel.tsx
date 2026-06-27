import { ChevronDown, ChevronRight, FileCode2, Folder, GitPullRequestArrow, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { AssessmentLevel, GraphEdge, GraphNode, GraphNodeType } from "../types";
import { cn } from "../utils/classnames";
import { useI18n } from "../utils/i18n";
import { buildModuleFileTree, type ModuleFileTreeNode } from "../utils/module-file-tree";
import { applyRiskOverride, clearRiskOverride } from "../utils/module-assessment";
import {
  localizedArchitectureCategory,
  localizedModuleDescription,
  localizedModuleGuidance,
  localizedModuleRole
} from "../utils/module-text";
import { AgentGuidanceComposer } from "./AgentGuidanceComposer";

const nodeTypeOptions: GraphNodeType[] = ["module", "entrypoint", "api", "service", "data", "external", "worker", "utility", "test"];
const riskOptions: AssessmentLevel[] = ["low", "medium", "high", "unknown"];

export function ModulePanel({
  edges,
  guidanceOperation,
  node,
  onDeleteNode,
  onGuidanceChange,
  onModuleChange,
  onSaveGuidance,
  onSendGuidance,
  sendGuidanceDisabled
}: {
  edges: GraphEdge[];
  guidanceOperation: "save" | "send" | "";
  node: GraphNode;
  onDeleteNode: (nodeId: string) => void;
  onGuidanceChange: (value: string) => void;
  onModuleChange: (nodeId: string, patch: Partial<GraphNode>) => void;
  onSaveGuidance: () => void;
  onSendGuidance: () => void;
  sendGuidanceDisabled: boolean;
}) {
  const { t } = useI18n();
  const [openSections, setOpenSections] = useState({
    files: true,
    symbols: false,
    evidence: false,
    assessment: true,
    relations: true
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

  function updateRisk(level: AssessmentLevel) {
    if (level === "unknown") return;
    const reason = window.prompt(t("module.riskOverridePrompt"), node.assessment?.risk.override?.reason ?? "");
    if (reason === null) return;
    try {
      const updated = applyRiskOverride(node, level, reason, new Date().toISOString());
      onModuleChange(node.id, { risk: updated.risk, assessment: updated.assessment });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }

  function removeRiskOverride() {
    const updated = clearRiskOverride(node);
    onModuleChange(node.id, { risk: updated.risk, assessment: updated.assessment });
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
        {node.assessment ? (
          <div className="assessment-summary">
            <span className="confidence-chip">
              {t("module.confidenceLevel", {
                level: t(`assessment.${node.assessment.confidence.level}`),
                value: node.assessment.confidence.score ?? t("assessment.unscored")
              })}
            </span>
            <span className={cn("risk-chip", node.assessment.risk.systemLevel)}>
              {t("module.systemRisk", { level: t(`assessment.${node.assessment.risk.systemLevel}`) })}
            </span>
          </div>
        ) : typeof node.confidence === "number" ? (
          <span className="confidence-chip">{t("module.confidence", { value: Math.round(node.confidence * 100) })}</span>
        ) : null}
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
            <select value={node.risk} onChange={(event) => updateRisk(event.target.value as AssessmentLevel)}>
              {riskOptions.map((option) => (
                <option disabled={option === "unknown"} key={option} value={option}>
                  {t(`assessment.${option}`)}
                </option>
              ))}
            </select>
          </label>
          {node.assessment?.risk.override ? (
            <div className="module-edit-wide assessment-override">
              <strong>{t("module.riskOverride")}</strong>
              <span>{node.assessment.risk.override.reason}</span>
              {node.assessment.risk.systemLevelChanged ? (
                <span>{t("module.systemRiskChanged", {
                  previous: t(`assessment.${node.assessment.risk.previousSystemLevel ?? "unknown"}`),
                  current: t(`assessment.${node.assessment.risk.systemLevel}`)
                })}</span>
              ) : null}
              <button className="ghost-button" type="button" onClick={removeRiskOverride}>{t("module.clearRiskOverride")}</button>
            </div>
          ) : null}
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

      {node.assessment ? (
        <CollapsibleCard isOpen={openSections.assessment} title={t("module.assessment")} onToggle={() => toggleSection("assessment")}>
          <AssessmentDetails
            confidence={node.assessment.confidence}
            risk={node.assessment.risk}
            t={t}
          />
        </CollapsibleCard>
      ) : null}

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

      <CollapsibleCard isOpen={openSections.relations} title={t("module.relations")} onToggle={() => toggleSection("relations")}>
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
      </CollapsibleCard>

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

      <AgentGuidanceComposer
        disabled={false}
        isSaving={guidanceOperation === "save"}
        isSending={guidanceOperation === "send"}
        placeholder={t("module.guidancePlaceholder")}
        saveLabel={t("guidance.save")}
        sendDisabled={sendGuidanceDisabled}
        sendLabel={t("module.sendCurrentGuidance")}
        title={t("module.guidance")}
        value={localizedGuidance}
        onChange={onGuidanceChange}
        onSave={onSaveGuidance}
        onSend={onSendGuidance}
      />
    </aside>
  );
}

function AssessmentDetails({
  confidence,
  risk,
  t
}: {
  confidence: NonNullable<GraphNode["assessment"]>["confidence"];
  risk: NonNullable<GraphNode["assessment"]>["risk"];
  t: ReturnType<typeof useI18n>["t"];
}) {
  return (
    <div className="assessment-details">
      <div className="assessment-heading">
        <strong>{t("module.confidenceAssessment")}</strong>
        <span>{confidence.score ?? t("assessment.unscored")} / 100 · {t(`assessment.${confidence.level}`)}</span>
      </div>
      {confidence.factors.map((factor) => <AssessmentFactorRow factor={factor} key={factor.id} t={t} />)}
      <div className="assessment-heading">
        <strong>{t("module.riskAssessment")}</strong>
        <span>{risk.systemScore ?? t("assessment.unscored")} / 100 · {t(`assessment.${risk.systemLevel}`)}</span>
      </div>
      {risk.factors.map((factor) => <AssessmentFactorRow factor={factor} key={factor.id} t={t} />)}
    </div>
  );
}

function AssessmentFactorRow({
  factor,
  t
}: {
  factor: NonNullable<GraphNode["assessment"]>["confidence"]["factors"][number];
  t: ReturnType<typeof useI18n>["t"];
}) {
  const label = translatedFactorText(t, `assessmentFactor.${factor.id}.label`, factor.label);
  const reason = translatedFactorText(t, `assessmentFactor.${factor.id}.reason`, factor.reason);

  return (
    <div className="assessment-factor">
      <div>
        <strong>{label}</strong>
        <span>{factor.score} / {factor.maxScore}</span>
      </div>
      <p>{reason}</p>
      {factor.evidence[0] ? (
        <small>
          {factor.evidence[0].filePath ? `${factor.evidence[0].filePath}${factor.evidence[0].line ? `:${factor.evidence[0].line}` : ""} · ` : ""}
          {factor.evidence[0].detail}
        </small>
      ) : null}
    </div>
  );
}

function translatedFactorText(t: ReturnType<typeof useI18n>["t"], key: string, fallback: string) {
  const translated = t(key);
  return translated === key ? fallback : translated;
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

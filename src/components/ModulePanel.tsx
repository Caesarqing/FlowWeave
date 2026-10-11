import { ChevronDown, ChevronRight, FileCode2, Folder, GitPullRequestArrow, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AssessmentLevel, GraphEdge, GraphNode, GraphNodeType, StaticGraphDetailUiTiming } from "../types";
import { nodeConnectionExplanation } from "../utils/graph-view-projection";
import { cn } from "../utils/classnames";
import { useI18n } from "../utils/i18n";
import { useCanvasStore } from "../stores/canvas.store";
import { buildModuleFileTree, type ModuleFileTreeNode } from "../utils/module-file-tree";
import { applyRiskOverride, clearRiskOverride } from "../utils/module-assessment";
import {
  editableModuleGuidance,
  localizedArchitectureCategory,
  localizedModuleDescription,
  localizedModuleRole
} from "../utils/module-text";
import { AgentGuidanceComposer } from "./AgentGuidanceComposer";

export type ModuleDisplaySummary = {
  entrySymbol?: string;
  upstreamCount: number;
  downstreamCount: number;
  evidenceState: "confirmed" | "partial" | "unavailable";
};

type StaticGraphMeasurementWindow = Window & {
  __flowweaveStaticGraphMeasurement?: {
    collectMetrics: boolean;
    detailClickStartedAtEpochMs?: number;
    detailTimings: StaticGraphDetailUiTiming[];
  };
};
type DetailRequestTiming = Omit<StaticGraphDetailUiTiming, "panelPresentedAtEpochMs">;
const performanceEpochMs = () => performance.timeOrigin + performance.now();

export function buildModuleDisplaySummary(node: GraphNode, edges: GraphEdge[]): ModuleDisplaySummary {
  const related = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  const confirmedCount = related.filter((edge) => (edge.evidence?.length ?? 0) > 0).length;
  return {
    entrySymbol: node.symbols?.find((symbol) => symbol.role === "entry")?.name,
    upstreamCount: related.filter((edge) => edge.target === node.id).length,
    downstreamCount: related.filter((edge) => edge.source === node.id).length,
    evidenceState: related.length === 0 ? "unavailable" : confirmedCount === related.length ? "confirmed" : "partial"
  };
}

export function relationDisplayTitle(edge: GraphEdge, titles: Map<string, string>): string {
  return `${titles.get(edge.source) ?? edge.source} -> ${titles.get(edge.target) ?? edge.target}`;
}

const nodeTypeOptions: GraphNodeType[] = ["module", "entrypoint", "api", "service", "data", "external", "worker", "utility", "test"];
const riskOptions: AssessmentLevel[] = ["low", "medium", "high", "unknown"];

export function formatModuleRelation(edge: GraphEdge, modules: GraphNode[]): string {
  const titleById = new Map(modules.map((module) => [module.id, module.title]));
  return `${titleById.get(edge.source) ?? edge.source} -> ${titleById.get(edge.target) ?? edge.target}`;
}

export function ModulePanel({
  readOnly,
  userRevision,
  onEnsureSaved,
  projectId,
  generationId,
  edges,
  modules,
  guidanceOperation,
  node: canvasNode,
  onDeleteNode,
  onGuidanceChange,
  onModuleChange,
  onSaveGuidance,
  onSendGuidance,
  sendGuidanceDisabled
}: {
  readOnly: boolean;
  userRevision: number;
  onEnsureSaved: () => Promise<void>;
  projectId: string;
  generationId?: string;
  edges: GraphEdge[];
  modules: GraphNode[];
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
  const ensureSaved = useRef(onEnsureSaved);
  ensureSaved.current = onEnsureSaved;
  const filesKey = canvasNode.files.join("\u0000");
  const detailKey = `${projectId}:${generationId ?? ""}:${userRevision}:${canvasNode.id}:${filesKey}`;
  const [detailResult, setDetailResult] = useState<{ key: string; detail?: Pick<GraphNode, "symbols" | "fileRoles" | "evidence" | "assessment" | "relationDiagnostics">; error?: string; timing?: DetailRequestTiming }>();
  useEffect(() => {
    if (!projectId || !generationId || canvasNode.origin === "manual") return;
    const api = window.flowweave;
    if (!api) {
      setDetailResult({ key: detailKey, error: "Desktop API unavailable" });
      return;
    }
    let active = true;
    const measurement = (window as StaticGraphMeasurementWindow).__flowweaveStaticGraphMeasurement;
    const clickStartedAtEpochMs = measurement?.collectMetrics ? measurement.detailClickStartedAtEpochMs : undefined;
    void ensureSaved.current()
      .then(() => {
        const liveMeasurement = (window as StaticGraphMeasurementWindow).__flowweaveStaticGraphMeasurement;
        const ipcStartedAtEpochMs = liveMeasurement?.collectMetrics ? performanceEpochMs() : undefined;
        return api.readCanvasNodeDetail(projectId, generationId, useCanvasStore.getState().userRevision, canvasNode.id)
          .then((response) => ({ response, clickStartedAtEpochMs, ipcStartedAtEpochMs,
            ipcResponseAtEpochMs: ipcStartedAtEpochMs === undefined ? undefined : performanceEpochMs() }));
      })
      .then(({ response, clickStartedAtEpochMs, ipcStartedAtEpochMs, ipcResponseAtEpochMs }) => {
        if (active && response.generationId === generationId && response.nodeId === canvasNode.id &&
          response.userRevision === useCanvasStore.getState().userRevision) {
          const timing = clickStartedAtEpochMs === undefined || ipcStartedAtEpochMs === undefined || ipcResponseAtEpochMs === undefined ? undefined : {
            projectId, generationId, userRevision: response.userRevision, nodeId: response.nodeId,
            clickStartedAtEpochMs, ipcStartedAtEpochMs, ipcResponseAtEpochMs
          };
          setDetailResult({ key: detailKey, detail: response.detail, timing });
        }
      })
      .catch((error) => { if (active) setDetailResult({ key: detailKey, error: error instanceof Error ? error.message : String(error) }); });
    return () => { active = false; };
  }, [projectId, generationId, canvasNode.id, canvasNode.origin, detailKey]);
  useLayoutEffect(() => {
    if (!detailResult?.timing || detailResult.key !== detailKey || !detailResult.detail) return;
    const measurement = (window as StaticGraphMeasurementWindow).__flowweaveStaticGraphMeasurement;
    if (!measurement?.collectMetrics || !detailResult.timing) return;
    measurement.detailTimings.push({ ...detailResult.timing, panelPresentedAtEpochMs: performanceEpochMs() });
  }, [detailResult, detailKey]);
  const currentDetail = detailResult?.key === detailKey ? detailResult.detail : undefined;
  const node = useMemo(() => {
    const files = new Set(canvasNode.files);
    return { ...canvasNode, ...currentDetail,
      symbols: (currentDetail?.symbols ?? canvasNode.symbols)?.filter((symbol) => files.has(symbol.filePath)),
      fileRoles: (currentDetail?.fileRoles ?? canvasNode.fileRoles)?.filter((role) => files.has(role.path)),
      evidence: (currentDetail?.evidence ?? canvasNode.evidence)?.filter((item) => !item.filePath || files.has(item.filePath)),
      relationDiagnostics: (currentDetail?.relationDiagnostics ?? canvasNode.relationDiagnostics)?.filter((diagnostic) => files.has(diagnostic.filePath)),
      assessment: canvasNode.assessmentPending ? canvasNode.assessment : currentDetail?.assessment ?? canvasNode.assessment };
  }, [canvasNode, currentDetail]);
  const [openSections, setOpenSections] = useState({
    files: true,
    symbols: false,
    evidence: false,
    assessment: true,
    relations: true,
    diagnostics: true
  });
  const relatedEdges = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  const displaySummary = buildModuleDisplaySummary(node, edges);
  const moduleTitles = new Map(modules.map((module) => [module.id, module.title]));
  const fileTree = useMemo(() => buildModuleFileTree(node.files, node.fileRoles), [node.fileRoles, node.files]);
  const localizedDescription = localizedModuleDescription(node, t);
  const guidanceValue = editableModuleGuidance(node, t);
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
    <aside className="module-panel" data-detail-node-id={canvasNode.id} data-detail-state={canvasNode.origin === "manual" || detailResult?.key === detailKey && detailResult.detail
      ? "ready" : detailResult?.key === detailKey && detailResult.error ? "error" : "loading"}>
      <div className="panel-header">
        <span>{t("module.context")}</span>
        <span className={cn("risk-chip", node.risk)}>{t(`risk.${node.risk}`)}</span>
      </div>
      {node.assessmentPending ? <p role="status">{t("module.assessmentPending")}</p> : null}

      <section className="module-card hero-card">
        <small>{localizedArchitectureCategory(node.category, node.nodeType, t)}</small>
        <h2>{node.title}</h2>
        <p>{localizedDescription}</p>
        {localizedRole ? <p className="module-role">{localizedRole}</p> : null}
        <p>{displaySummary.entrySymbol ?? t("module.noSymbols")} · {displaySummary.upstreamCount} ↑ / {displaySummary.downstreamCount} ↓ · {t(`module.evidenceState.${displaySummary.evidenceState}`)}</p>
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
        {canvasNode.origin !== "manual" && generationId && detailResult?.key !== detailKey ? <p>{t("canvas.detailLoading")}</p> : null}
        {detailResult?.key === detailKey && detailResult.error ? <p role="alert">{t("canvas.detailLoadFailed", { error: detailResult.error })}</p> : null}
        <h3>{t("module.change")}</h3>
        <fieldset className="module-edit-form" disabled={readOnly}>
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
              {currentDetail && node.assessment.risk.systemLevelChanged ? (
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
        </fieldset>
        <button className="ghost-button danger-button sequence-wide-button" disabled={readOnly} type="button" onClick={deleteNode}>
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
                  {relationDisplayTitle(edge, moduleTitles)}
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
            <p>{t(`canvas.nodeConnections.${nodeConnectionExplanation(node, edges) ?? "none"}`)}</p>
          )}
        </div>
      </CollapsibleCard>

      {node.relationDiagnostics?.length ? (
        <CollapsibleCard isOpen={openSections.diagnostics} title={t("canvas.relationshipDiagnostics")} onToggle={() => toggleSection("diagnostics")}>
          <div className="detail-list">
            {node.relationDiagnostics.map((diagnostic, index) => <div className="detail-row" key={`${diagnostic.relationId ?? diagnostic.code}:${index}`}>
              <strong>{diagnostic.message}</strong>
              <code>{diagnostic.filePath}{diagnostic.range ? `:${diagnostic.range.start.line}:${diagnostic.range.start.column}` : ""}</code>
              {diagnostic.candidates?.length ? <small>{t("canvas.relationshipCandidates")}: {diagnostic.candidates.join(" · ")}</small> : null}
              {diagnostic.relationId ? <small>{diagnostic.relationId}</small> : null}
            </div>)}
          </div>
        </CollapsibleCard>
      ) : null}

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
        disabled={readOnly}
        isSaving={guidanceOperation === "save"}
        isSending={guidanceOperation === "send"}
        placeholder={t("module.guidancePlaceholder")}
        saveLabel={t("guidance.save")}
        sendDisabled={sendGuidanceDisabled}
        sendLabel={t("module.sendCurrentGuidance")}
        title={t("module.guidance")}
        value={guidanceValue}
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

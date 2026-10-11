import { Link2, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphEdgeRelation, GraphNode } from "../types";
import { useI18n } from "../utils/i18n";
import { useCanvasStore } from "../stores/canvas.store";
import { relationOptions, relationStyle } from "../utils/relation-styles";

export type ConnectionDisplayDetails = {
  confidence: "confirmed" | "inferred";
  representativeEvidence: NonNullable<GraphEdge["evidence"]>[number] | undefined;
  additionalEvidenceCount: number;
};

export function buildConnectionDisplayDetails(edge: GraphEdge): ConnectionDisplayDetails {
  const evidence = edge.evidence ?? [];
  return {
    confidence: edge.confidence ?? "inferred",
    representativeEvidence: evidence[0],
    additionalEvidenceCount: Math.max(0, evidence.length - 1)
  };
}

export function ConnectionPanel({
  readOnly,
  userRevision,
  onEnsureSaved,
  projectId,
  generationId,
  defaultRelation,
  mode,
  modules,
  onClose,
  onCreateConnection,
  onDeleteEdge,
  onUpdateEdgeEndpoints,
  onUpdateEdgeGuidance,
  onUpdateEdgeRelation,
  selectedEdge: canvasEdge
}: {
  readOnly: boolean;
  userRevision: number;
  onEnsureSaved: () => Promise<void>;
  projectId: string;
  generationId?: string;
  defaultRelation: GraphEdgeRelation;
  mode: "create" | "edit";
  modules: GraphNode[];
  onClose: () => void;
  onCreateConnection: (input: { source: string; target: string; relation: GraphEdgeRelation; guidanceNote?: string }) => void;
  onDeleteEdge: (edgeId: string) => void;
  onUpdateEdgeEndpoints: (edgeId: string, source: string, target: string) => void;
  onUpdateEdgeGuidance: (edgeId: string, guidanceNote: string) => void;
  onUpdateEdgeRelation: (edgeId: string, relation: GraphEdgeRelation) => void;
  selectedEdge?: GraphEdge;
}) {
  const { t } = useI18n();
  const ensureSaved = useRef(onEnsureSaved);
  ensureSaved.current = onEnsureSaved;
  const detailKey = `${projectId}:${generationId ?? ""}:${userRevision}:${canvasEdge?.id ?? ""}:${canvasEdge?.source ?? ""}:${canvasEdge?.target ?? ""}:${canvasEdge?.relation ?? ""}`;
  const [detailResult, setDetailResult] = useState<{ key: string; detail?: Pick<GraphEdge, "source" | "target" | "relation" | "evidence" | "semanticKinds" | "operations" | "importUsages" | "sourceRelationIds" | "confidence">; error?: string }>();
  useEffect(() => {
    if (!projectId || !generationId || !canvasEdge || canvasEdge.origin === "manual") return;
    const api = window.flowweave;
    if (!api) {
      setDetailResult({ key: detailKey, error: "Desktop API unavailable" });
      return;
    }
    let active = true;
    void ensureSaved.current()
      .then(() => api.readCanvasEdgeDetail(projectId, generationId, useCanvasStore.getState().userRevision, canvasEdge.id))
      .then((response) => {
        if (active && response.generationId === generationId && response.edgeId === canvasEdge.id &&
          response.userRevision === useCanvasStore.getState().userRevision) setDetailResult({ key: detailKey, detail: response.detail });
      })
      .catch((error) => { if (active) setDetailResult({ key: detailKey, error: error instanceof Error ? error.message : String(error) }); });
    return () => { active = false; };
  }, [projectId, generationId, canvasEdge?.id, canvasEdge?.origin, detailKey]);
  const currentDetail = detailResult?.key === detailKey && canvasEdge && detailResult.detail?.source === canvasEdge.source &&
    detailResult.detail?.target === canvasEdge.target && detailResult.detail?.relation === canvasEdge.relation
    ? detailResult.detail : undefined;
  const selectedEdge = useMemo(() => canvasEdge ? { ...canvasEdge, ...currentDetail } : undefined, [canvasEdge, currentDetail]);
  const [source, setSource] = useState(modules[0]?.id ?? "");
  const [target, setTarget] = useState(modules[1]?.id ?? modules[0]?.id ?? "");
  const [relation, setRelation] = useState<GraphEdgeRelation>(defaultRelation);
  const [guidanceNote, setGuidanceNote] = useState("");
  const sourceNode = useMemo(() => modules.find((node) => node.id === selectedEdge?.source), [modules, selectedEdge?.source]);
  const targetNode = useMemo(() => modules.find((node) => node.id === selectedEdge?.target), [modules, selectedEdge?.target]);
  const selectedEdgeDetails = selectedEdge ? buildConnectionDisplayDetails(selectedEdge) : undefined;
  const isProjected = Boolean(selectedEdge && (selectedEdge.aggregatedEdgeIds?.length ||
    !modules.some((node) => node.id === selectedEdge.source) || !modules.some((node) => node.id === selectedEdge.target)));

  useEffect(() => {
    if (mode !== "create") return;
    setSource((current) => current || modules[0]?.id || "");
    setTarget((current) => current || modules.find((node) => node.id !== source)?.id || modules[0]?.id || "");
    setRelation(defaultRelation);
  }, [defaultRelation, mode, modules, source]);

  useEffect(() => {
    if (mode !== "edit" || !selectedEdge) return;
    setGuidanceNote(selectedEdge.guidanceNote ?? "");
  }, [mode, selectedEdge]);

  const canCreate = mode === "create" && source && target && source !== target;

  function createConnection() {
    if (!canCreate) return;
    onCreateConnection({ source, target, relation, guidanceNote: guidanceNote.trim() || undefined });
  }

  function updateSource(edge: GraphEdge, nextSource: string) {
    if (nextSource === edge.target) return;
    onUpdateEdgeEndpoints(edge.id, nextSource, edge.target);
  }

  function updateTarget(edge: GraphEdge, nextTarget: string) {
    if (edge.source === nextTarget) return;
    onUpdateEdgeEndpoints(edge.id, edge.source, nextTarget);
  }

  function closePanel() {
    onClose();
  }

  return (
    <aside className="module-panel connection-panel" aria-label={mode === "create" ? t("connection.create") : t("connection.details")}>
      <div className="panel-header">
        <span>{mode === "create" ? t("connection.create") : t("connection.details")}</span>
        <button className="icon-button" type="button" onClick={closePanel} aria-label={t("connection.close")}>
          <X size={15} />
        </button>
      </div>

      {mode === "edit" && selectedEdge ? (
        <>
          <section className="module-card hero-card">
            <small>{t("connection.selectedEdge")}</small>
            <h2>{t(`relation.${selectedEdge.relation}Accent`)}</h2>
            <p>
              {moduleOptionLabel(sourceNode, selectedEdge.source)} {"->"} {moduleOptionLabel(targetNode, selectedEdge.target)}
            </p>
            <p>{t("connection.direction", { source: moduleOptionLabel(sourceNode, selectedEdge.source), target: moduleOptionLabel(targetNode, selectedEdge.target) })}</p>
            <p>{t("connection.confidence", { value: t(`connection.confidence.${selectedEdgeDetails?.confidence ?? "inferred"}`) })}</p>
          </section>
          <section className="module-card connection-form">
            {canvasEdge?.origin !== "manual" && generationId && detailResult?.key !== detailKey ? <p>{t("canvas.detailLoading")}</p> : null}
            {detailResult?.key === detailKey && detailResult.error ? <p role="alert">{t("canvas.detailLoadFailed", { error: detailResult.error })}</p> : null}
            {isProjected ? <p>{t("connection.projectedReadOnly")}</p> : null}
            <div className="connection-endpoints">
              <span><strong>{t("connection.directionLabel")}</strong>{moduleOptionLabel(sourceNode, selectedEdge.source)} {"->"} {moduleOptionLabel(targetNode, selectedEdge.target)}</span>
              <span><strong>{t("connection.relationType")}</strong>{t(`relation.${selectedEdge.relation}`)}</span>
              <span><strong>{t("connection.confidenceLabel")}</strong>{t(`connection.confidence.${selectedEdgeDetails?.confidence ?? "inferred"}`)}</span>
            </div>
            <fieldset disabled={isProjected || readOnly}>
              <label>
                {t("connection.source")}
                <NodeSelect modules={modules} value={selectedEdge.source} onChange={(nextSource) => updateSource(selectedEdge, nextSource)} />
              </label>
              <label>
                {t("connection.target")}
                <NodeSelect modules={modules} value={selectedEdge.target} onChange={(nextTarget) => updateTarget(selectedEdge, nextTarget)} />
              </label>
              <label>
                {t("connection.relationType")}
                <RelationSelect value={selectedEdge.relation} onChange={(nextRelation) => onUpdateEdgeRelation(selectedEdge.id, nextRelation)} />
              </label>
              <label>
                {t("connection.guidance")}
                <textarea
                  value={guidanceNote}
                  onChange={(event) => {
                    setGuidanceNote(event.target.value);
                    if (selectedEdge && !isProjected) onUpdateEdgeGuidance(selectedEdge.id, event.target.value);
                  }}
                />
              </label>
              <div className="connection-endpoints">
                <span><strong>{t("connection.source")}</strong>{moduleOptionLabel(sourceNode, selectedEdge.source)}</span>
                <span><strong>{t("connection.target")}</strong>{moduleOptionLabel(targetNode, selectedEdge.target)}</span>
              </div>
            </fieldset>
            {selectedEdge.semanticKinds?.length ? <div className="connection-evidence"><strong>{t("connection.semanticKinds")}</strong><span>{selectedEdge.semanticKinds.map((kind) => t(`connection.semantic.${kind}`)).join(" · ")}</span></div> : null}
            {selectedEdge.operations?.length ? <div className="connection-evidence"><strong>{t("connection.operations")}</strong><span>{selectedEdge.operations.map((operation) => t(`connection.operation.${operation}`)).join(" · ")}</span></div> : null}
            {selectedEdge.sourceRelationIds?.length ? <details className="connection-evidence"><summary>{t("connection.sourceReferences")}</summary>{selectedEdge.sourceRelationIds.map((id) => <code key={id}>{id}</code>)}</details> : null}
            <div className="connection-evidence">
              <strong>{t("connection.representativeEvidence")}</strong>
              {selectedEdgeDetails?.representativeEvidence ? (
                <article>
                  <code>{evidenceLocation(selectedEdgeDetails.representativeEvidence.filePath, selectedEdgeDetails.representativeEvidence.symbol, selectedEdgeDetails.representativeEvidence.line)}</code>
                  <span>{selectedEdgeDetails.representativeEvidence.detail}</span>
                  {selectedEdgeDetails.additionalEvidenceCount > 0 ? <small>{t("connection.additionalEvidence", { count: selectedEdgeDetails.additionalEvidenceCount })}</small> : null}
                </article>
              ) : (
                <small>{t("connection.noEvidence")}</small>
              )}
            </div>
            {selectedEdge.aggregatedEdgeIds && selectedEdge.aggregatedEdgeIds.length > 1 ? (
              <div className="connection-evidence">
                <strong>{t("connection.aggregated", { count: selectedEdge.aggregatedEdgeIds.length })}</strong>
                {selectedEdge.aggregatedEdgeIds.map((edgeId) => <code key={edgeId}>{edgeId}</code>)}
              </div>
            ) : null}
            <button className="ghost-button danger-button" disabled={isProjected || readOnly} type="button" onClick={() => onDeleteEdge(selectedEdge.id)}>
              <Trash2 size={15} />
              {t("connection.delete")}
            </button>
          </section>
        </>
      ) : (
        <>
          <section className="module-card hero-card">
            <small>{t("connection.draft")}</small>
            <h2>{t("connection.title")}</h2>
            <p>{t("connection.newDescription")}</p>
          </section>
          <section className="module-card connection-form">
            <fieldset disabled={readOnly}>
            <label>
              {t("connection.source")}
              <NodeSelect modules={modules} value={source} onChange={setSource} />
            </label>
            <label>
              {t("connection.target")}
              <NodeSelect modules={modules} value={target} onChange={setTarget} />
            </label>
            <label>
              {t("connection.relationType")}
              <RelationSelect value={relation} onChange={setRelation} />
            </label>
            <label>
              {t("connection.guidance")}
              <textarea value={guidanceNote} onChange={(event) => setGuidanceNote(event.target.value)} />
            </label>
            </fieldset>
            <button className="send-button" disabled={!canCreate || readOnly} type="button" onClick={createConnection}>
              <Plus size={15} />
              {t("connection.create")}
            </button>
          </section>
        </>
      )}

      <section className="module-card connection-legend">
        <h3><Link2 size={14} />{t("connection.colorLegend")}</h3>
        <div>
          {relationOptions.map((option) => (
            <span key={option}>
              <i style={{ background: relationStyle[option].color }} />
              <strong>{t(`relation.${option}Accent`)}</strong>
              <small>{t(`relation.${option}Description`)}</small>
            </span>
          ))}
        </div>
      </section>
    </aside>
  );
}

function RelationSelect({ value, onChange }: { value: GraphEdgeRelation; onChange: (relation: GraphEdgeRelation) => void }) {
  const { t } = useI18n();
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as GraphEdgeRelation)}>
      {relationOptions.map((option) => (
        <option key={option} value={option}>
          {t(`relation.${option}Accent`)}
        </option>
      ))}
    </select>
  );
}

function NodeSelect({ modules, value, onChange }: { modules: GraphNode[]; value: string; onChange: (nodeId: string) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {modules.map((node) => (
        <option key={node.id} value={node.id}>
          {moduleOptionLabel(node, node.id)}
        </option>
      ))}
    </select>
  );
}

function moduleOptionLabel(node: GraphNode | undefined, fallbackId: string) {
  if (!node) return fallbackId;
  return node.title === node.id ? node.title : `${node.title} (${node.id})`;
}

function evidenceLocation(filePath: string | undefined, symbol: string | undefined, line: number | undefined) {
  const location = filePath && line ? `${filePath}:${line}` : filePath;
  if (location && symbol) return `${location} · ${symbol}`;
  return location ?? symbol ?? "inferred";
}

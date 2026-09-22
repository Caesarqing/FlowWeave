import { Link2, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { GraphEdge, GraphEdgeRelation, GraphNode } from "../types";
import { useI18n } from "../utils/i18n";
import { relationOptions, relationStyle } from "../utils/relation-styles";

export type ConnectionDisplayDetails = {
  confidence: "confirmed" | "inferred";
  representativeEvidence: NonNullable<GraphEdge["evidence"]>[number] | undefined;
  additionalEvidenceCount: number;
};

export function buildConnectionDisplayDetails(edge: GraphEdge): ConnectionDisplayDetails {
  const evidence = edge.evidence ?? [];
  return {
    confidence: edge.relation === "depends_on" || evidence.length === 0 ? "inferred" : "confirmed",
    representativeEvidence: evidence[0],
    additionalEvidenceCount: Math.max(0, evidence.length - 1)
  };
}

export function ConnectionPanel({
  defaultRelation,
  mode,
  modules,
  onClose,
  onCreateConnection,
  onDeleteEdge,
  onUpdateEdgeEndpoints,
  onUpdateEdgeGuidance,
  onUpdateEdgeRelation,
  selectedEdge
}: {
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
  const [source, setSource] = useState(modules[0]?.id ?? "");
  const [target, setTarget] = useState(modules[1]?.id ?? modules[0]?.id ?? "");
  const [relation, setRelation] = useState<GraphEdgeRelation>(defaultRelation);
  const [guidanceNote, setGuidanceNote] = useState("");
  const sourceNode = useMemo(() => modules.find((node) => node.id === selectedEdge?.source), [modules, selectedEdge?.source]);
  const targetNode = useMemo(() => modules.find((node) => node.id === selectedEdge?.target), [modules, selectedEdge?.target]);
  const selectedEdgeDetails = selectedEdge ? buildConnectionDisplayDetails(selectedEdge) : undefined;

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

  useEffect(() => {
    if (mode !== "edit" || !selectedEdge) return;
    if (guidanceNote === (selectedEdge.guidanceNote ?? "")) return;
    const timeout = window.setTimeout(() => onUpdateEdgeGuidance(selectedEdge.id, guidanceNote), 450);
    return () => window.clearTimeout(timeout);
  }, [guidanceNote, mode, onUpdateEdgeGuidance, selectedEdge]);

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

  function commitGuidanceNote() {
    if (mode !== "edit" || !selectedEdge) return;
    onUpdateEdgeGuidance(selectedEdge.id, guidanceNote);
  }

  function closePanel() {
    commitGuidanceNote();
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
            <p>{t("connection.confidence", { value: t(`connection.confidence.${selectedEdge.confidence ?? "confirmed"}`) })}</p>
          </section>
          <section className="module-card connection-form">
            <div className="connection-endpoints">
              <span><strong>{t("connection.directionLabel")}</strong>{moduleOptionLabel(sourceNode, selectedEdge.source)} {"->"} {moduleOptionLabel(targetNode, selectedEdge.target)}</span>
              <span><strong>{t("connection.relationType")}</strong>{t(`relation.${selectedEdge.relation}`)}</span>
              <span><strong>{t("connection.confidenceLabel")}</strong>{t(`connection.confidence.${selectedEdgeDetails?.confidence ?? "inferred"}`)}</span>
            </div>
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
                onBlur={commitGuidanceNote}
                onChange={(event) => setGuidanceNote(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    commitGuidanceNote();
                  }
                }}
              />
            </label>
            <div className="connection-endpoints">
              <span><strong>{t("connection.source")}</strong>{moduleOptionLabel(sourceNode, selectedEdge.source)}</span>
              <span><strong>{t("connection.target")}</strong>{moduleOptionLabel(targetNode, selectedEdge.target)}</span>
            </div>
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
            <button className="ghost-button danger-button" type="button" onClick={() => onDeleteEdge(selectedEdge.id)}>
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
            <button className="send-button" disabled={!canCreate} type="button" onClick={createConnection}>
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

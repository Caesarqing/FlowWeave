import { Link2, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { GraphEdge, GraphEdgeRelation, GraphNode } from "../types";
import { relationOptions, relationStyle } from "../utils/relation-styles";

export function ConnectionPanel({
  defaultRelation,
  mode,
  modules,
  onClose,
  onCreateConnection,
  onDeleteEdge,
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
  onUpdateEdgeGuidance: (edgeId: string, guidanceNote: string) => void;
  onUpdateEdgeRelation: (edgeId: string, relation: GraphEdgeRelation) => void;
  selectedEdge?: GraphEdge;
}) {
  const [source, setSource] = useState(modules[0]?.id ?? "");
  const [target, setTarget] = useState(modules[1]?.id ?? modules[0]?.id ?? "");
  const [relation, setRelation] = useState<GraphEdgeRelation>(defaultRelation);
  const [guidanceNote, setGuidanceNote] = useState("");
  const sourceNode = useMemo(() => modules.find((node) => node.id === selectedEdge?.source), [modules, selectedEdge?.source]);
  const targetNode = useMemo(() => modules.find((node) => node.id === selectedEdge?.target), [modules, selectedEdge?.target]);

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

  return (
    <aside className="module-panel connection-panel" aria-label={mode === "create" ? "新增连接" : "连接详情"}>
      <div className="panel-header">
        <span>{mode === "create" ? "新增连接" : "连接详情"}</span>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭连接面板">
          <X size={15} />
        </button>
      </div>

      {mode === "edit" && selectedEdge ? (
        <>
          <section className="module-card hero-card">
            <small>Selected edge</small>
            <h2>{relationStyle[selectedEdge.relation].accent}</h2>
            <p>
              {sourceNode?.title ?? selectedEdge.source} {"->"} {targetNode?.title ?? selectedEdge.target}
            </p>
          </section>
          <section className="module-card connection-form">
            <label>
              关系类型
              <RelationSelect value={selectedEdge.relation} onChange={(nextRelation) => onUpdateEdgeRelation(selectedEdge.id, nextRelation)} />
            </label>
            <label>
              修改依据
              <textarea value={guidanceNote} onChange={(event) => {
                const nextValue = event.target.value;
                setGuidanceNote(nextValue);
                onUpdateEdgeGuidance(selectedEdge.id, nextValue);
              }} />
            </label>
            <div className="connection-endpoints">
              <span><strong>Source</strong>{sourceNode?.title ?? selectedEdge.source}</span>
              <span><strong>Target</strong>{targetNode?.title ?? selectedEdge.target}</span>
            </div>
            <button className="ghost-button danger-button" type="button" onClick={() => onDeleteEdge(selectedEdge.id)}>
              <Trash2 size={15} />
              删除连接
            </button>
          </section>
        </>
      ) : (
        <>
          <section className="module-card hero-card">
            <small>Connection draft</small>
            <h2>定义模块关系</h2>
            <p>新连接会进入 Canvas 关系数据，并随指导文件提交给 Agent 作为修改依据。</p>
          </section>
          <section className="module-card connection-form">
            <label>
              Source
              <NodeSelect modules={modules} value={source} onChange={setSource} />
            </label>
            <label>
              Target
              <NodeSelect modules={modules} value={target} onChange={setTarget} />
            </label>
            <label>
              关系类型
              <RelationSelect value={relation} onChange={setRelation} />
            </label>
            <label>
              修改依据
              <textarea value={guidanceNote} onChange={(event) => setGuidanceNote(event.target.value)} />
            </label>
            <button className="send-button" disabled={!canCreate} type="button" onClick={createConnection}>
              <Plus size={15} />
              新增连接
            </button>
          </section>
        </>
      )}

      <section className="module-card connection-legend">
        <h3><Link2 size={14} />关系颜色</h3>
        <div>
          {relationOptions.map((option) => (
            <span key={option}>
              <i style={{ background: relationStyle[option].color }} />
              {relationStyle[option].accent}
            </span>
          ))}
        </div>
      </section>
    </aside>
  );
}

function RelationSelect({ value, onChange }: { value: GraphEdgeRelation; onChange: (relation: GraphEdgeRelation) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as GraphEdgeRelation)}>
      {relationOptions.map((option) => (
        <option key={option} value={option}>
          {relationStyle[option].accent}
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
          {node.title}
        </option>
      ))}
    </select>
  );
}

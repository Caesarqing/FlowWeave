import { Background, Controls, ReactFlow, type NodeProps, type NodeTypes } from "@xyflow/react";
import type { CSSProperties } from "react";
import { useMemo } from "react";
import { Code2, GitBranch, RefreshCcw, Send, Workflow } from "lucide-react";
import type { SequenceDiagram, SequenceDiagramKind, SequenceMessage, SequenceParticipant } from "../types";
import type { SequenceDiagramState } from "../hooks/useSequenceDiagramState";
import { buildSequenceFlowNodes, getSequenceFlowBounds, type SequenceFlowNode } from "../utils/sequence-diagram-flow";
import { useI18n } from "../utils/i18n";

const diagramLabelKeys: Record<SequenceDiagramKind, string> = {
  architectural: "structure.architectural",
  "detailed-design": "structure.detailedDesign"
};

const messageKindLabelKeys: Record<SequenceMessage["kind"], string> = {
  sync: "structure.messageSync",
  async: "structure.messageAsync",
  return: "structure.messageReturn",
  event: "structure.messageEvent",
  external: "structure.messageExternal"
};

const sequenceNodeTypes: NodeTypes = {
  sequenceParticipant: SequenceParticipantNode,
  sequenceLifeline: SequenceLifelineNode,
  sequenceMessage: SequenceMessageNode
};

export function StructureWorkspace({ sequence }: { sequence: SequenceDiagramState }) {
  const { t } = useI18n();
  return (
    <main className="workspace-page structure-workspace sequence-workspace">
      <section className="workspace-main sequence-main">
        <div className="sequence-toolbar">
          <div className="sequence-toolbar-title">
            <Workflow size={17} />
            <div>
              <strong>{sequence.diagram ? sequence.diagram.title : t("nav.sequence")}</strong>
              <span>
                {t("structure.sourceFiles", {
                  count: sequence.fileCount,
                  messageCount: sequence.diagram ? t("structure.messages", { count: sequence.diagram.messages.length }) : t("structure.noDiagramShort")
                })}
              </span>
            </div>
          </div>
          <div className="sequence-toolbar-actions">
            <div className="segmented-control" aria-label={t("structure.diagramType")}>
              {(["architectural", "detailed-design"] as SequenceDiagramKind[]).map((kind) => (
                <button className={sequence.activeKind === kind ? "active" : ""} key={kind} type="button" onClick={() => sequence.setActiveKind(kind)}>
                  {kind === "architectural" ? <GitBranch size={14} /> : <Code2 size={14} />}
                  {t(diagramLabelKeys[kind])}
                </button>
              ))}
            </div>
            <button className="send-button" disabled={sequence.isBusy} type="button" onClick={() => void sequence.generateDiagrams()}>
              <RefreshCcw size={15} />
              {sequence.isBusy ? t("structure.generating") : t("structure.generate")}
            </button>
          </div>
        </div>

        {sequence.diagram ? (
          <SequenceCanvas
            diagram={sequence.diagram}
            selectedMessageId={sequence.selectedMessageId}
            selectedParticipantId={sequence.selectedParticipantId}
            onSelectMessage={sequence.selectMessage}
            onSelectParticipant={sequence.selectParticipant}
          />
        ) : (
          <div className="sequence-empty-state">
            <Workflow size={34} />
            <strong>{t("structure.emptyTitle")}</strong>
            <span>{t("structure.emptyBody")}</span>
          </div>
        )}
      </section>

      <section className="workspace-column sequence-detail-panel">
        <div className="panel-header">
          <span>{t("structure.details")}</span>
        </div>
        <div className="sequence-detail-stack">
          <SequenceDetails diagram={sequence.diagram} message={sequence.selectedMessage} participant={sequence.selectedParticipant} />
          <section className="module-card sequence-agent-card">
            <small>{t("structure.agentRevision")}</small>
            <h3>{t("structure.sendRevision")}</h3>
            <label className="sequence-revision-box">
              <span>{t("structure.instruction")}</span>
              <textarea
                value={sequence.instruction}
                onChange={(event) => sequence.setInstruction(event.target.value)}
                placeholder={t("structure.instructionPlaceholder")}
              />
            </label>
            <button className="ghost-button sequence-wide-button" disabled={sequence.isBusy || !sequence.bundle} type="button" onClick={() => void sequence.reviseDiagram()}>
              <Send size={15} />
              {t("structure.sendRevision")}
            </button>
            <p className="sequence-status">{sequence.status}</p>
          </section>
        </div>
      </section>
    </main>
  );
}

function SequenceCanvas({
  diagram,
  selectedMessageId,
  selectedParticipantId,
  onSelectMessage,
  onSelectParticipant
}: {
  diagram: SequenceDiagram;
  selectedMessageId: string;
  selectedParticipantId: string;
  onSelectMessage: (messageId: string) => void;
  onSelectParticipant: (participantId: string) => void;
}) {
  const bounds = useMemo(() => getSequenceFlowBounds(diagram), [diagram]);
  const nodes = useMemo(
    () =>
      buildSequenceFlowNodes(diagram).map((node) => {
        const isSelected =
          (node.type === "sequenceParticipant" && node.id === `participant:${selectedParticipantId}`) ||
          (node.type === "sequenceMessage" && node.id === `message:${selectedMessageId}`);
        return {
          ...node,
          className: isSelected ? "selected" : undefined
        };
      }),
    [diagram, selectedMessageId, selectedParticipantId]
  );

  return (
    <div className="sequence-canvas-stage" style={{ minWidth: bounds.width, minHeight: bounds.height }}>
      <ReactFlow
        key={diagram.id}
        nodes={nodes}
        edges={[]}
        nodeTypes={sequenceNodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.25}
        maxZoom={1.6}
        panOnScroll
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          if (node.type === "sequenceParticipant") {
            onSelectParticipant(node.id.replace("participant:", ""));
          } else if (node.type === "sequenceMessage") {
            onSelectMessage(node.id.replace("message:", ""));
          }
        }}
      >
        <Background color="rgba(137, 236, 255, 0.28)" gap={18} size={1} />
        <Controls position="bottom-left" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function SequenceParticipantNode({ data }: NodeProps<SequenceFlowNode>) {
  if (!("participant" in data)) return null;
  return (
    <div className="sequence-flow-participant" style={{ "--participant-accent": data.accent } as CSSProperties}>
      <span className="sequence-flow-accent" />
      <strong>{data.participant.title}</strong>
      <small>{data.participant.kind}</small>
    </div>
  );
}

function SequenceLifelineNode({ data }: NodeProps<SequenceFlowNode>) {
  if (!("height" in data)) return null;
  return <div className="sequence-flow-lifeline" style={{ height: data.height, "--participant-accent": data.accent } as CSSProperties} />;
}

function SequenceMessageNode({ data }: NodeProps<SequenceFlowNode>) {
  const { t } = useI18n();
  if (!("message" in data)) return null;
  return (
    <div
      className={`sequence-flow-message ${data.message.kind} ${data.direction}`}
      style={{ width: data.width, "--message-width": `${data.width}px` } as CSSProperties}
    >
      <span className="sequence-flow-arrow" />
      <div className="sequence-flow-message-card">
        <span className="sequence-message-order">{data.message.sequence}</span>
        <strong>{data.message.label}</strong>
        <span className="sequence-message-kind">{t(messageKindLabelKeys[data.message.kind])}</span>
      </div>
      <span className="sequence-flow-route">
        {data.fromTitle} {"->"} {data.toTitle}
      </span>
    </div>
  );
}

function SequenceDetails({
  diagram,
  message,
  participant
}: {
  diagram?: SequenceDiagram;
  message?: SequenceMessage;
  participant?: SequenceParticipant;
}) {
  const { t } = useI18n();
  if (!diagram) {
    return (
      <section className="module-card">
        <h3>{t("structure.noDiagram")}</h3>
        <p>{t("structure.noDiagramBody")}</p>
      </section>
    );
  }

  if (message) {
    return (
      <>
        <section className="module-card">
          <small>{t("structure.messageKindLabel", { kind: t(messageKindLabelKeys[message.kind]) })}</small>
          <h3>{message.label}</h3>
          {message.description ? <p>{message.description}</p> : null}
        </section>
        <section className="module-card detail-list">
          <DetailRow label={t("structure.from")} value={participantTitle(diagram, message.from)} />
          <DetailRow label={t("structure.to")} value={participantTitle(diagram, message.to)} />
          <DetailRow label={t("structure.method")} value={message.methodName ?? t("structure.notSpecified")} />
          <DetailRow label={t("structure.input")} value={message.input ?? t("structure.notSpecified")} />
          <DetailRow label={t("structure.output")} value={message.output ?? t("structure.notSpecified")} />
        </section>
        <EvidenceList evidence={message.evidence} />
      </>
    );
  }

  if (participant) {
    return (
      <>
        <section className="module-card">
          <small>{participant.kind}</small>
          <h3>{participant.title}</h3>
          <p>{participant.description}</p>
        </section>
        <section className="module-card detail-list">
          <DetailRow label={t("structure.file")} value={participant.filePath ?? t("structure.notMapped")} />
          <DetailRow label={t("structure.symbol")} value={participant.symbol ?? t("structure.notMapped")} />
        </section>
      </>
    );
  }

  return (
    <section className="module-card">
      <small>{t("structure.diagram")}</small>
      <h3>{diagram.title}</h3>
      <p>{diagram.summary}</p>
      <p>
        {t("structure.participantsMessages", { participants: diagram.participants.length, messages: diagram.messages.length })}
      </p>
    </section>
  );
}

function EvidenceList({ evidence }: { evidence?: SequenceMessage["evidence"] }) {
  const { t } = useI18n();
  if (!evidence || evidence.length === 0) {
    return (
      <section className="module-card">
        <h3>{t("structure.evidence")}</h3>
        <p>{t("structure.noEvidence")}</p>
      </section>
    );
  }
  return (
    <section className="module-card">
      <h3>{t("structure.evidence")}</h3>
      <div className="detail-list">
        {evidence.map((item) => (
          <div className="detail-row" key={`${item.filePath ?? ""}-${item.symbol ?? ""}-${item.detail}`}>
            <strong>{item.symbol ?? item.filePath ?? t("structure.evidence")}</strong>
            <span>
              {item.filePath ? `${item.filePath} · ` : ""}
              {item.detail}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function participantTitle(diagram: SequenceDiagram, participantId: string) {
  return diagram.participants.find((participant) => participant.id === participantId)?.title ?? participantId;
}

import { Background, Controls, ReactFlow, type NodeProps, type NodeTypes } from "@xyflow/react";
import type { CSSProperties } from "react";
import { useMemo } from "react";
import { Code2, GitBranch, RefreshCcw, Send, Workflow } from "lucide-react";
import type { SequenceDiagram, SequenceDiagramKind, SequenceMessage, SequenceParticipant } from "../types";
import type { SequenceDiagramState } from "../hooks/useSequenceDiagramState";
import { buildSequenceFlowNodes, getSequenceFlowBounds, type SequenceFlowNode } from "../utils/sequence-diagram-flow";

const diagramLabels: Record<SequenceDiagramKind, string> = {
  architectural: "Architectural",
  "detailed-design": "Detailed Design"
};

const messageKindLabels: Record<SequenceMessage["kind"], string> = {
  sync: "Sync",
  async: "Async",
  return: "Return",
  event: "Event",
  external: "External"
};

const sequenceNodeTypes: NodeTypes = {
  sequenceParticipant: SequenceParticipantNode,
  sequenceLifeline: SequenceLifelineNode,
  sequenceMessage: SequenceMessageNode
};

export function StructureWorkspace({ sequence }: { sequence: SequenceDiagramState }) {
  return (
    <main className="workspace-page structure-workspace sequence-workspace">
      <section className="workspace-main sequence-main">
        <div className="sequence-toolbar">
          <div className="sequence-toolbar-title">
            <Workflow size={17} />
            <div>
              <strong>{sequence.diagram ? sequence.diagram.title : "Sequence Diagram"}</strong>
              <span>
                {sequence.fileCount} source files · Agent-ready · {sequence.diagram ? `${sequence.diagram.messages.length} messages` : "no diagram"}
              </span>
            </div>
          </div>
          <div className="sequence-toolbar-actions">
            <div className="segmented-control" aria-label="Sequence diagram type">
              {(["architectural", "detailed-design"] as SequenceDiagramKind[]).map((kind) => (
                <button className={sequence.activeKind === kind ? "active" : ""} key={kind} type="button" onClick={() => sequence.setActiveKind(kind)}>
                  {kind === "architectural" ? <GitBranch size={14} /> : <Code2 size={14} />}
                  {diagramLabels[kind]}
                </button>
              ))}
            </div>
            <button className="send-button" disabled={sequence.isBusy} type="button" onClick={() => void sequence.generateDiagrams()}>
              <RefreshCcw size={15} />
              {sequence.isBusy ? "处理中..." : "生成 / 重新生成"}
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
            <strong>尚未生成 Sequence Diagram</strong>
            <span>点击顶部生成按钮后，这里会显示可缩放、可拖拽的架构时序图和详细设计时序图。</span>
          </div>
        )}
      </section>

      <section className="workspace-column sequence-detail-panel">
        <div className="panel-header">
          <span>Details & Agent</span>
        </div>
        <div className="sequence-detail-stack">
          <SequenceDetails diagram={sequence.diagram} message={sequence.selectedMessage} participant={sequence.selectedParticipant} />
          <section className="module-card sequence-agent-card">
            <small>Agent revision</small>
            <h3>发送给 Agent 修订</h3>
            <label className="sequence-revision-box">
              <span>修改要求</span>
              <textarea
                value={sequence.instruction}
                onChange={(event) => sequence.setInstruction(event.target.value)}
                placeholder="例如：把支付网关调用拆成授权、扣款、回调三步，并标注 requestId 和 paymentId。"
              />
            </label>
            <button className="ghost-button sequence-wide-button" disabled={sequence.isBusy || !sequence.bundle} type="button" onClick={() => void sequence.reviseDiagram()}>
              <Send size={15} />
              发送给 Agent 修订
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
        <span className="sequence-message-kind">{messageKindLabels[data.message.kind]}</span>
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
  if (!diagram) {
    return (
      <section className="module-card">
        <h3>No diagram</h3>
        <p>生成序列图后可查看消息、参数、返回值和代码证据。</p>
      </section>
    );
  }

  if (message) {
    return (
      <>
        <section className="module-card">
          <small>{messageKindLabels[message.kind]} message</small>
          <h3>{message.label}</h3>
          {message.description ? <p>{message.description}</p> : null}
        </section>
        <section className="module-card detail-list">
          <DetailRow label="From" value={participantTitle(diagram, message.from)} />
          <DetailRow label="To" value={participantTitle(diagram, message.to)} />
          <DetailRow label="Method" value={message.methodName ?? "not specified"} />
          <DetailRow label="Input" value={message.input ?? "not specified"} />
          <DetailRow label="Output" value={message.output ?? "not specified"} />
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
          <DetailRow label="File" value={participant.filePath ?? "not mapped"} />
          <DetailRow label="Symbol" value={participant.symbol ?? "not mapped"} />
        </section>
      </>
    );
  }

  return (
    <section className="module-card">
      <small>Diagram</small>
      <h3>{diagram.title}</h3>
      <p>{diagram.summary}</p>
      <p>
        {diagram.participants.length} participants · {diagram.messages.length} messages
      </p>
    </section>
  );
}

function EvidenceList({ evidence }: { evidence?: SequenceMessage["evidence"] }) {
  if (!evidence || evidence.length === 0) {
    return (
      <section className="module-card">
        <h3>Evidence</h3>
        <p>暂无代码证据。</p>
      </section>
    );
  }
  return (
    <section className="module-card">
      <h3>Evidence</h3>
      <div className="detail-list">
        {evidence.map((item) => (
          <div className="detail-row" key={`${item.filePath ?? ""}-${item.symbol ?? ""}-${item.detail}`}>
            <strong>{item.symbol ?? item.filePath ?? "Evidence"}</strong>
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

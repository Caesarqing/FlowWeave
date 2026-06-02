import type { Node } from "@xyflow/react";
import type { SequenceDiagram, SequenceMessage, SequenceParticipant } from "../types";

const LANE_WIDTH = 260;
const PARTICIPANT_WIDTH = 190;
const PARTICIPANT_HEIGHT = 68;
const HEADER_Y = 0;
const LIFELINE_Y = 92;
const MESSAGE_START_Y = 132;
const MESSAGE_GAP_Y = 106;
const LIFELINE_PADDING_BOTTOM = 140;
const MESSAGE_MARGIN_X = 18;
const MIN_MESSAGE_WIDTH = 186;

export type SequenceFlowParticipantNodeData = {
  participant: SequenceParticipant;
  accent: string;
};

export type SequenceFlowLifelineNodeData = {
  participantId: string;
  height: number;
  accent: string;
};

export type SequenceFlowMessageNodeData = {
  message: SequenceMessage;
  fromTitle: string;
  toTitle: string;
  direction: "forward" | "backward" | "self";
  width: number;
};

export type SequenceFlowNodeData = SequenceFlowParticipantNodeData | SequenceFlowLifelineNodeData | SequenceFlowMessageNodeData;

export type SequenceFlowNode = Node<SequenceFlowNodeData>;

export function buildSequenceFlowNodes(diagram: SequenceDiagram): SequenceFlowNode[] {
  const participantIndex = new Map(diagram.participants.map((participant, index) => [participant.id, index]));
  const participantTitle = new Map(diagram.participants.map((participant) => [participant.id, participant.title]));
  const lifelineHeight = Math.max(460, MESSAGE_START_Y + diagram.messages.length * MESSAGE_GAP_Y + LIFELINE_PADDING_BOTTOM - LIFELINE_Y);
  const nodes: SequenceFlowNode[] = [];

  diagram.participants.forEach((participant, index) => {
    const centerX = index * LANE_WIDTH + LANE_WIDTH / 2;
    const accent = participantAccent(index);
    nodes.push({
      id: `participant:${participant.id}`,
      type: "sequenceParticipant",
      position: { x: centerX - PARTICIPANT_WIDTH / 2, y: HEADER_Y },
      data: { participant, accent },
      draggable: false,
      selectable: true,
      width: PARTICIPANT_WIDTH,
      height: PARTICIPANT_HEIGHT
    });
    nodes.push({
      id: `lifeline:${participant.id}`,
      type: "sequenceLifeline",
      position: { x: centerX - 1, y: LIFELINE_Y },
      data: { participantId: participant.id, height: lifelineHeight, accent },
      draggable: false,
      selectable: false,
      width: 2,
      height: lifelineHeight
    });
  });

  diagram.messages
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .forEach((message, index) => {
      const fromIndex = participantIndex.get(message.from) ?? 0;
      const toIndex = participantIndex.get(message.to) ?? fromIndex;
      const startIndex = Math.min(fromIndex, toIndex);
      const endIndex = Math.max(fromIndex, toIndex);
      const startCenterX = startIndex * LANE_WIDTH + LANE_WIDTH / 2;
      const endCenterX = endIndex * LANE_WIDTH + LANE_WIDTH / 2;
      const laneSpanWidth = Math.max(MIN_MESSAGE_WIDTH, endCenterX - startCenterX + PARTICIPANT_WIDTH);
      const width = Math.max(MIN_MESSAGE_WIDTH, laneSpanWidth - MESSAGE_MARGIN_X * 2);
      const x = startCenterX - PARTICIPANT_WIDTH / 2 + MESSAGE_MARGIN_X;
      const y = MESSAGE_START_Y + index * MESSAGE_GAP_Y;
      const direction = fromIndex === toIndex ? "self" : fromIndex < toIndex ? "forward" : "backward";

      nodes.push({
        id: `message:${message.id}`,
        type: "sequenceMessage",
        position: { x, y },
        data: {
          message,
          fromTitle: participantTitle.get(message.from) ?? message.from,
          toTitle: participantTitle.get(message.to) ?? message.to,
          direction,
          width
        },
        draggable: false,
        selectable: true,
        width,
        height: 74
      });
    });

  return nodes;
}

export function getSequenceFlowBounds(diagram: SequenceDiagram) {
  return {
    width: Math.max(860, diagram.participants.length * LANE_WIDTH + 160),
    height: Math.max(620, MESSAGE_START_Y + diagram.messages.length * MESSAGE_GAP_Y + LIFELINE_PADDING_BOTTOM)
  };
}

function participantAccent(index: number) {
  const palette = ["#42f5a7", "#fb923c", "#60a5fa", "#8b5cf6", "#fbbf24", "#f472b6", "#2dd4bf", "#e879f9"];
  return palette[index % palette.length];
}

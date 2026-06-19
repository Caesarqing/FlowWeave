import type { SequenceDiagram, SequenceMessage, SequenceParticipant } from "../types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function localizedSequenceDiagram(diagram: SequenceDiagram, t: Translate): SequenceDiagram {
  return {
    ...diagram,
    title: localizedDiagramTitle(diagram, t),
    summary: localizedDiagramSummary(diagram.summary, t),
    participants: diagram.participants.map((participant) => localizeParticipant(participant, t)),
    messages: diagram.messages.map((message) => localizeMessage(message, diagram, t)),
    evidence: diagram.evidence?.map((evidence) => ({
      ...evidence,
      detail: localizedEvidenceDetail(evidence.detail, t)
    }))
  };
}

function localizedDiagramTitle(diagram: SequenceDiagram, t: Translate): string {
  if (diagram.title === "Architectural Sequence Diagram") return t("structure.architectural");
  return diagram.title;
}

function localizedDiagramSummary(summary: string, t: Translate): string {
  if (summary === "Macro collaboration inferred from architecture modules and relationships.") {
    return t("structure.architecturalSummary");
  }
  return summary;
}

function localizeParticipant(participant: SequenceParticipant, t: Translate): SequenceParticipant {
  const sourceFileMatch = /^Source file (.+)\.$/.exec(participant.description);
  const symbolMatch = /^(.+) in (.+)\.$/.exec(participant.description);
  let description = participant.description;
  if (sourceFileMatch) {
    description = t("structure.sourceFileDescription", { path: sourceFileMatch[1] });
  } else if (symbolMatch) {
    description = t("structure.symbolDescription", {
      kind: symbolMatch[1],
      path: symbolMatch[2]
    });
  }
  return { ...participant, description };
}

function localizeMessage(message: SequenceMessage, diagram: SequenceDiagram, t: Translate): SequenceMessage {
  const collaborationMatch = /^(.+) collaborates with (.+)$/.exec(message.label);
  const importMatch = /^imports (.+)$/.exec(message.label);
  const from = participantTitle(diagram, message.from);
  const to = participantTitle(diagram, message.to);
  return {
    ...message,
    label: collaborationMatch
      ? t("structure.fallbackMessage", { from, to })
      : importMatch
        ? t("structure.imports", { path: importMatch[1] })
        : message.label,
    description: message.description === "Inferred sequence relation from available project structure."
      ? t("structure.fallbackMessageDescription")
      : message.description,
    input: message.input === "project context"
      ? t("structure.fallbackInput")
      : message.input === "inferred from caller context"
        ? t("structure.inferredCallerInput")
        : message.input,
    output: message.output === "next step result"
      ? t("structure.fallbackOutput")
      : message.output === "inferred return value"
        ? t("structure.inferredReturnValue")
        : message.output,
    evidence: message.evidence?.map((evidence) => ({
      ...evidence,
      detail: localizedEvidenceDetail(evidence.detail, t)
    }))
  };
}

function localizedEvidenceDetail(detail: string, t: Translate): string {
  if (detail === "Fallback sequence participant.") return t("structure.fallbackEvidence");
  const importMatch = /^Import reference: (.+)$/.exec(detail);
  if (importMatch) return t("structure.importReference", { path: importMatch[1] });
  const symbolsMatch = /^Symbols: (.+)$/.exec(detail);
  if (symbolsMatch) return t("structure.symbolsEvidence", { symbols: symbolsMatch[1] });
  return detail;
}

function participantTitle(diagram: SequenceDiagram, participantId: string): string {
  return diagram.participants.find((participant) => participant.id === participantId)?.title ?? participantId;
}

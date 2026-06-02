import type { GraphEdge, GraphNode, SequenceDiagram, SequenceDiagramBundle, SequenceDiagramKind } from "../types";
import { relationStyle } from "./relation-styles";

export function buildGuidanceMarkdown(projectLabel: string, nodes: GraphNode[], edges: GraphEdge[]) {
  return `# FlowWeave Guidance

Project: ${projectLabel}
Target agents: Codex Local / Claude Code / Cursor

## Graph Rule

Use the module nodes and connection relations as the modification boundary. Prefer files listed on the selected node; follow connected nodes only when the relation requires it.

## Module Relations

${edges.map((edge) => `- ${edge.source} -> ${edge.target}: ${relationStyle[edge.relation].accent} (${edge.relation}) - ${relationStyle[edge.relation].description}${edge.guidanceNote ? ` Guidance: ${edge.guidanceNote}` : ""}`).join("\n")}

## Modules

${nodes
  .map(
    (node) => `### ${node.title}

Type: ${node.nodeType}
Risk: ${node.risk}

${node.description}

Files:
${node.files.map((file) => `- ${file}`).join("\n")}

Guidance:
${node.guidanceDraft}
`
  )
  .join("\n")}
`;
}

export function buildTaskJson(projectLabel: string, nodes: GraphNode[], edges: GraphEdge[]) {
  return JSON.stringify(
    {
      project: projectLabel,
      source: "FlowWeave",
      targetTools: ["codex-local", "claude-code", "cursor"],
      outputFiles: ["guidance.md", "task.json", "plan.md"],
      modules: nodes.map((node) => ({
        id: node.id,
        title: node.title,
        kind: node.kind,
        nodeType: node.nodeType,
        risk: node.risk,
        description: node.description,
        files: node.files,
        guidance: node.guidanceDraft,
        position: { x: node.x, y: node.y }
      })),
      relations: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
        relationLabel: relationStyle[edge.relation].accent,
        relationDescription: relationStyle[edge.relation].description,
        guidanceNote: edge.guidanceNote
      }))
    },
    null,
    2
  );
}

export function buildSequenceGuidanceMarkdown(projectLabel: string, bundle: SequenceDiagramBundle, activeKind: SequenceDiagramKind) {
  const currentDiagram = selectSequenceDiagram(bundle, activeKind);
  return `# FlowWeave Sequence Diagram Guidance

Project: ${projectLabel}
Source: ${bundle.source}
Generated at: ${bundle.generatedAt}
Current diagram: ${currentDiagram.title} (${currentDiagram.kind})
Target agents: Codex Local / Claude Code / Cursor

## Sequence Diagram Rule

Use the sequence diagrams as the modification and design context. Keep participant responsibilities, message order, parameters, return values, and code evidence aligned with the project implementation. For detailed design work, prefer files and symbols listed in evidence.

## Current Focus

${formatSequenceDiagramMarkdown(currentDiagram)}

## All Sequence Diagrams

${formatSequenceDiagramMarkdown(bundle.architectural)}

${formatSequenceDiagramMarkdown(bundle.detailedDesign)}

## Revision Guidance

- Preserve the persisted .flowweave/sequence-diagrams.json schema.
- Update participants and messages together when component, class, method, input, or return contracts change.
- Keep architectural messages at system/component granularity.
- Keep detailed-design messages mapped to classes, interfaces, controllers, and method calls when evidence is available.
`;
}

export function buildSequenceTaskJson(projectLabel: string, bundle: SequenceDiagramBundle, activeKind: SequenceDiagramKind) {
  return JSON.stringify(
    {
      project: projectLabel,
      source: "FlowWeave",
      artifact: "sequence-diagram",
      activeKind,
      generatedAt: bundle.generatedAt,
      targetTools: ["codex-local", "claude-code", "cursor"],
      outputFiles: ["sequence-guidance.md", "sequence-task.json", "plan.md"],
      diagrams: {
        architectural: serializeSequenceDiagram(bundle.architectural),
        detailedDesign: serializeSequenceDiagram(bundle.detailedDesign)
      }
    },
    null,
    2
  );
}

export function buildSequencePlanPrompt(projectLabel: string, bundle: SequenceDiagramBundle, activeKind: SequenceDiagramKind) {
  const diagram = selectSequenceDiagram(bundle, activeKind);
  return `FlowWeave plan request for Sequence Diagram "${diagram.title}".

Use the current sequence diagram as the modification/design context. Do not require a selected Canvas module node.

${buildSequenceGuidanceMarkdown(projectLabel, bundle, activeKind)}

Return an implementation plan, affected files, risks, and tests. Do not edit files from FlowWeave.`;
}

export function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function selectSequenceDiagram(bundle: SequenceDiagramBundle, kind: SequenceDiagramKind) {
  return kind === "architectural" ? bundle.architectural : bundle.detailedDesign;
}

function formatSequenceDiagramMarkdown(diagram: SequenceDiagram) {
  return `### ${diagram.title}

Kind: ${diagram.kind}
Summary: ${diagram.summary}

Participants:
${diagram.participants
  .map((participant) => `- ${participant.id}: ${participant.title} (${participant.kind})${participant.filePath ? ` file=${participant.filePath}` : ""}${participant.symbol ? ` symbol=${participant.symbol}` : ""}`)
  .join("\n")}

Messages:
${diagram.messages
  .slice()
  .sort((left, right) => left.sequence - right.sequence)
  .map(
    (message) => `- ${message.sequence}. ${message.from} -> ${message.to} [${message.kind}] ${message.label}${message.methodName ? ` method=${message.methodName}` : ""}${message.input ? ` input=${message.input}` : ""}${message.output ? ` output=${message.output}` : ""}${formatEvidenceInline(message.evidence)}`
  )
  .join("\n")}`;
}

function serializeSequenceDiagram(diagram: SequenceDiagram) {
  return {
    id: diagram.id,
    title: diagram.title,
    kind: diagram.kind,
    summary: diagram.summary,
    participants: diagram.participants.map((participant) => ({
      id: participant.id,
      title: participant.title,
      kind: participant.kind,
      description: participant.description,
      filePath: participant.filePath,
      symbol: participant.symbol
    })),
    messages: diagram.messages
      .slice()
      .sort((left, right) => left.sequence - right.sequence)
      .map((message) => ({
        id: message.id,
        sequence: message.sequence,
        from: message.from,
        to: message.to,
        kind: message.kind,
        label: message.label,
        description: message.description,
        methodName: message.methodName,
        input: message.input,
        output: message.output,
        evidence: message.evidence
      })),
    evidence: diagram.evidence
  };
}

function formatEvidenceInline(evidence: SequenceDiagram["messages"][number]["evidence"]) {
  if (!evidence || evidence.length === 0) return "";
  return ` evidence=${evidence.map((item) => [item.filePath, item.symbol, item.detail].filter(Boolean).join(":")).join("; ")}`;
}

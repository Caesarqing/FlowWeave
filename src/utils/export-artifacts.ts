import type { GraphEdge, GraphNode, SequenceDiagram, SequenceDiagramBundle, SequenceDiagramKind } from "../types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function buildGuidanceMarkdown(projectLabel: string, nodes: GraphNode[], edges: GraphEdge[], t?: Translate) {
  return `# FlowWeave Guidance

Project: ${projectLabel}
Target agents: Codex Local / Claude Code / Cursor

## Graph Rule

Use the module nodes and connection relations as the modification boundary. Prefer files listed on the selected node; follow connected nodes only when the relation requires it.

## Module Relations

${edges.map((edge) => `- ${edge.source} -> ${edge.target}: ${relationTitle(edge, t)} (${edge.relation}) - ${relationDescription(edge, t)}${edge.guidanceNote ? ` Guidance: ${edge.guidanceNote}` : ""}`).join("\n")}

## Modules

${nodes
  .map(
    (node) => `### ${node.title}

Type: ${node.nodeType}
Risk: ${node.risk}
${formatAssessmentMarkdown(node)}

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

export function buildExecutionAssessmentSummary(nodes: GraphNode[], edges: GraphEdge[]): string {
  const assessed = nodes.filter((node) => node.assessment);
  if (assessed.length === 0) return "Assessment: unavailable. Refresh the project scan before relying on module guidance.";
  const riskOrder = { unknown: 4, high: 3, medium: 2, low: 1 };
  const highestRisk = [...assessed].sort((left, right) =>
    riskOrder[right.assessment!.risk.effectiveLevel] - riskOrder[left.assessment!.risk.effectiveLevel]
  )[0];
  const scoredConfidence = assessed.filter((node) => node.assessment?.confidence.score !== undefined);
  const lowestConfidence = [...scoredConfidence].sort((left, right) =>
    left.assessment!.confidence.score! - right.assessment!.confidence.score!
  )[0];
  const unknownConfidence = assessed.filter((node) => node.assessment?.confidence.level === "unknown");
  const overrides = assessed.filter((node) => node.assessment?.risk.override);
  const central = assessed.filter((node) =>
    (node.assessment?.risk.factors.find((factor) => factor.id === "dependency-centrality")?.score ?? 0) >= 15
  );
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const crossStack = edges.filter((edge) => {
    const source = nodeById.get(edge.source)?.technologyStack;
    const target = nodeById.get(edge.target)?.technologyStack;
    return source && target && source !== "unknown" && target !== "unknown" && source !== target;
  });
  return [
    `Highest module risk: ${highestRisk?.title ?? "unknown"} (${highestRisk?.assessment?.risk.effectiveLevel ?? "unknown"}).`,
    lowestConfidence
      ? `Lowest confidence: ${lowestConfidence.title} (${lowestConfidence.assessment!.confidence.score}/100).`
      : `Confidence unavailable for ${unknownConfidence.length} module(s).`,
    `High-centrality modules: ${central.map((node) => node.title).join(", ") || "none"}.`,
    `Cross-stack connections: ${crossStack.map((edge) => `${nodeById.get(edge.source)?.title ?? edge.source} -> ${nodeById.get(edge.target)?.title ?? edge.target}`).join(", ") || "none"}.`,
    `Manual risk overrides: ${overrides.map((node) => node.title).join(", ") || "none"}.`,
    "Git Diff safety is evaluated independently after the Agent run."
  ].join("\n");
}

export function scopeGraphForModule(nodes: GraphNode[], edges: GraphEdge[], selectedNodeId: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const scopedIds = new Set<string>([selectedNodeId]);
  for (const edge of edges) {
    if (edge.source === selectedNodeId) scopedIds.add(edge.target);
    if (edge.target === selectedNodeId) scopedIds.add(edge.source);
  }
  const scopedEdges = edges.filter((edge) =>
    scopedIds.has(edge.source) &&
    scopedIds.has(edge.target) &&
    (edge.source === selectedNodeId || edge.target === selectedNodeId)
  );
  return {
    nodes: nodes.filter((node) => scopedIds.has(node.id)),
    edges: scopedEdges
  };
}

function formatAssessmentMarkdown(node: GraphNode): string {
  if (!node.assessment) return "Assessment: unavailable";
  const topRiskFactors = node.assessment.risk.factors
    .filter((factor) => factor.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((factor) => `${factor.label} ${factor.score}/${factor.maxScore}: ${factor.reason}`)
    .join("; ");
  return [
    `System risk: ${node.assessment.risk.systemLevel}${node.assessment.risk.systemScore === undefined ? "" : ` (${node.assessment.risk.systemScore}/100)`}`,
    `Effective risk: ${node.assessment.risk.effectiveLevel}`,
    `Confidence: ${node.assessment.confidence.level}${node.assessment.confidence.score === undefined ? "" : ` (${node.assessment.confidence.score}/100)`}`,
    node.assessment.risk.override ? `Manual override: ${node.assessment.risk.override.reason}` : "",
    topRiskFactors ? `Risk evidence: ${topRiskFactors}` : "Risk evidence: unavailable",
    node.assessment.confidence.level === "low" || node.assessment.confidence.level === "unknown"
      ? "Guidance: verify source evidence and refresh the semantic scan before broad changes."
      : "Guidance: validate the highest-scoring risk factors and connected modules."
  ].filter(Boolean).join("\n");
}

export function buildTaskJson(projectLabel: string, nodes: GraphNode[], edges: GraphEdge[], t?: Translate) {
  return JSON.stringify(
    {
      project: projectLabel,
      source: "FlowWeave",
      targetTools: ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor"],
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
        relationLabel: relationTitle(edge, t),
        relationDescription: relationDescription(edge, t),
        guidanceNote: edge.guidanceNote
      }))
    },
    null,
    2
  );
}

function relationTitle(edge: GraphEdge, t?: Translate) {
  return t ? t(`relation.${edge.relation}Accent`) : edge.relation;
}

function relationDescription(edge: GraphEdge, t?: Translate) {
  return t ? t(`relation.${edge.relation}Description`) : "";
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
      targetTools: ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor"],
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

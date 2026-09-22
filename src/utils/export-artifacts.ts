import type {
  ExecutionMode,
  GraphEdge,
  GraphNode,
  ModificationDeltaResult,
  ModificationGuidanceContext,
  SequenceDiagram,
  SequenceDiagramBundle
} from "../types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export type AgentPromptKind =
  | "combined-modification-plan"
  | "canvas-implementation-plan"
  | "sequence-revision"
  | "execute-change"
  | "artifact-analysis";

export type FlowWeaveModificationContext = {
  schemaVersion: 1;
  source: "FlowWeave";
  generatedAt: string;
  project: {
    label: string;
    path?: string;
    scanFingerprint?: string;
  };
  canvas: {
    selectedModuleId?: string;
    modules: GraphNode[];
    relations: GraphEdge[];
  };
  sequence?: {
    source: SequenceDiagramBundle["source"];
    generatedAt: string;
    activeKind: "architectural";
    revisionInstruction?: string;
    selectedMessageId?: string;
    selectedParticipantId?: string;
    diagrams: {
      architectural: ReturnType<typeof serializeSequenceDiagram>;
    };
  };
  userInstructions: {
    canvas: Array<{ moduleId: string; title: string; guidance: string }>;
    sequence?: string;
  };
};

export type BuildModificationContextInput = {
  projectLabel: string;
  projectPath?: string;
  scanFingerprint?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId?: string;
  sequenceBundle?: SequenceDiagramBundle;
  sequenceInstruction?: string;
  selectedSequenceMessageId?: string;
  selectedSequenceParticipantId?: string;
  generatedAt?: string;
};

export function buildModificationContext(input: BuildModificationContextInput): FlowWeaveModificationContext {
  const sequenceInstruction = input.sequenceInstruction?.trim() || undefined;
  return {
    schemaVersion: 1,
    source: "FlowWeave",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    project: {
      label: input.projectLabel,
      path: input.projectPath,
      scanFingerprint: input.scanFingerprint
    },
    canvas: {
      selectedModuleId: input.selectedNodeId,
      modules: input.nodes,
      relations: input.edges
    },
    sequence: input.sequenceBundle
      ? {
          source: input.sequenceBundle.source,
          generatedAt: input.sequenceBundle.generatedAt,
          activeKind: "architectural",
          revisionInstruction: sequenceInstruction,
          selectedMessageId: input.selectedSequenceMessageId,
          selectedParticipantId: input.selectedSequenceParticipantId,
          diagrams: {
            architectural: serializeSequenceDiagram(input.sequenceBundle.architectural)
          }
        }
      : undefined,
    userInstructions: {
      canvas: input.nodes
        .filter((node) => node.guidanceDraft.trim())
        .map((node) => ({ moduleId: node.id, title: node.title, guidance: node.guidanceDraft })),
      sequence: sequenceInstruction
    }
  };
}

export function buildCurrentModuleGuidancePrompt(node: GraphNode, guidance: string): string {
  return `# FlowWeave Current Module Guidance

Send only this user guidance to the agent for the identified Canvas module.

Module ID: ${node.id}
Module title: ${node.title}

Guidance:
${guidance.trim()}

Return a focused implementation plan for this guidance. Verify the relevant source files before proposing changes.
`;
}

export function buildModificationGuidanceMarkdown(context: FlowWeaveModificationContext): string {
  return `# FlowWeave Modification Guidance

Generated: ${context.generatedAt}
Project: ${context.project.label}
Project path: ${context.project.path ?? "unknown"}
Scan fingerprint: ${context.project.scanFingerprint ?? "unknown"}

This document is generated from the current Canvas and Sequence Diagram modification context.

## Canvas Guidance

${buildLegacyCanvasGuidance(context)}

## Sequence Diagram Guidance

${context.sequence ? buildLegacySequenceGuidance(context) : "No sequence diagram is currently available."}
`;
}

export function buildModificationContextJson(context: FlowWeaveModificationContext): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}

export function buildModificationDeltaContextJson(context: ModificationGuidanceContext): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}

export function createModificationGuidanceContext(
  projectLabel: string,
  projectPath: string,
  result: ModificationDeltaResult
): ModificationGuidanceContext {
  return {
    schemaVersion: 2,
    source: "FlowWeave",
    generatedAt: new Date().toISOString(),
    project: {
      label: projectLabel,
      path: projectPath,
      scanFingerprint: result.snapshot.scanFingerprint
    },
    delta: result.delta,
    hasChanges: result.hasChanges,
    artifactReferences: [
      ".flowweave/project.json",
      ".flowweave/canvas/main.canvas.json",
      ".flowweave/architecture-map.json",
      ".flowweave/sequence-diagrams.json"
    ]
  };
}

export function buildModificationDeltaGuidanceMarkdown(context: ModificationGuidanceContext): string {
  const delta = context.delta;
  return `# FlowWeave Pending Modification Guidance

Generated: ${context.generatedAt}
Project: ${context.project.label}
Project path: ${context.project.path}

Read existing project and FlowWeave artifacts when historical context is needed:
${context.artifactReferences.map((path) => `- ${path}`).join("\n")}

${context.hasChanges ? formatPendingChanges(delta) : "No unacknowledged user modifications."}
`;
}

export function buildModificationDeltaAgentPrompt(
  context: ModificationGuidanceContext,
  executionMode: ExecutionMode
): string {
  return `You are FlowWeave's agent.

Prompt kind: ${executionMode === "execute" ? "execute-change" : "combined-modification-plan"}
Execution mode: ${executionMode}

Use only the pending user modifications below as new instructions.
Read the referenced project and FlowWeave artifacts when historical context is needed.
Do not treat omitted generated content as deleted or irrelevant.

Context JSON:
\`\`\`json
${buildModificationDeltaContextJson(context).trimEnd()}
\`\`\``;
}

export function buildAgentPrompt(
  context: FlowWeaveModificationContext,
  promptKind: AgentPromptKind,
  executionMode: ExecutionMode
): string {
  const effectiveKind: AgentPromptKind = executionMode === "execute" && promptKind !== "artifact-analysis" ? "execute-change" : promptKind;
  return `You are FlowWeave's agent.

Prompt kind: ${effectiveKind}
Execution mode: ${executionMode}

Rules:
- Use the JSON context as the source of truth.
- Do not infer files, APIs, symbols, or behavior not present in context or source code.
- In plan mode, do not edit files.
- Return the requested output contract.

Output contract:
${outputContract(effectiveKind)}

Context JSON:
\`\`\`json
${buildModificationContextJson(context).trimEnd()}
\`\`\``;
}

export function buildLegacyCanvasGuidance(context: FlowWeaveModificationContext, t?: Translate): string {
  return `# FlowWeave Guidance

Project: ${context.project.label}
Target agents: Codex Local / Claude Code / Cursor

## Graph Rule

Use the module nodes and connection relations as the modification boundary. Prefer files listed on the selected node; follow connected nodes only when the relation requires it.

Selected module: ${context.canvas.selectedModuleId ?? "none"}

## Module Relations

${context.canvas.relations.map((edge) => `- ${edge.source} -> ${edge.target}: ${relationTitle(edge, t)} (${edge.relation}) - ${relationDescription(edge, t)}${edge.guidanceNote ? ` Guidance: ${edge.guidanceNote}` : ""}`).join("\n") || "- No module relations recorded."}

## Modules

${context.canvas.modules.map(formatCanvasModule).join("\n")}`;
}

export function buildLegacyCanvasTaskJson(context: FlowWeaveModificationContext, t?: Translate): string {
  return `${JSON.stringify(
    {
      project: context.project.label,
      source: "FlowWeave",
      schemaVersion: context.schemaVersion,
      selectedModuleId: context.canvas.selectedModuleId,
      targetTools: ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor"],
      outputFiles: [
        "flowweave-modification-guidance.md",
        "flowweave-modification-context.json",
        "guidance.md",
        "task.json",
        "sequence-guidance.md",
        "sequence-task.json",
        "plan.md"
      ],
      modules: context.canvas.modules.map((node) => ({
        id: node.id,
        title: node.title,
        kind: node.kind,
        nodeType: node.nodeType,
        risk: node.risk,
        assessment: node.assessment,
        description: node.description,
        files: node.files,
        guidance: node.guidanceDraft,
        position: { x: node.x, y: node.y }
      })),
      relations: context.canvas.relations.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
        relationLabel: relationTitle(edge, t),
        relationDescription: relationDescription(edge, t),
        guidanceNote: edge.guidanceNote,
        evidence: edge.evidence
      }))
    },
    null,
    2
  )}\n`;
}

export function buildLegacySequenceGuidance(context: FlowWeaveModificationContext): string {
  if (!context.sequence) return "# FlowWeave Sequence Diagram Guidance\n\nNo sequence diagram is currently available.\n";
  const currentDiagram = context.sequence.diagrams.architectural;
  return `# FlowWeave Sequence Diagram Guidance

Project: ${context.project.label}
Source: ${context.sequence.source}
Generated at: ${context.sequence.generatedAt}
Current diagram: ${currentDiagram.title} (${currentDiagram.kind})
Revision instruction: ${context.sequence.revisionInstruction ?? "none"}
Target agents: Codex Local / Claude Code / Cursor

## Sequence Diagram Rule

Use the architectural sequence diagram JSON as the modification and design context. Keep participant responsibilities, message order, parameters, return values, and code evidence aligned with the project implementation.

## Current Focus

${formatSequenceDiagramMarkdown(currentDiagram)}

## Revision Guidance

- Preserve the persisted .flowweave/sequence-diagrams.json schema.
- Update participants and messages together when component, class, method, input, or return contracts change.
- Keep architectural messages at system/component granularity.
`;
}

export function buildLegacySequenceTaskJson(context: FlowWeaveModificationContext): string {
  return `${JSON.stringify(
    {
      project: context.project.label,
      source: "FlowWeave",
      schemaVersion: context.schemaVersion,
      artifact: "sequence-diagram",
      activeKind: "architectural",
      generatedAt: context.sequence?.generatedAt,
      revisionInstruction: context.sequence?.revisionInstruction,
      targetTools: ["claude-code", "claude-desktop", "codex-local", "codex-desktop", "gemini-cli", "cursor"],
      outputFiles: [
        "flowweave-modification-guidance.md",
        "flowweave-modification-context.json",
        "sequence-guidance.md",
        "sequence-task.json",
        "plan.md"
      ],
      diagrams: context.sequence?.diagrams ?? {}
    },
    null,
    2
  )}\n`;
}

export function buildGuidanceMarkdown(projectLabel: string, nodes: GraphNode[], edges: GraphEdge[], t?: Translate) {
  return buildLegacyCanvasGuidance(buildModificationContext({ projectLabel, nodes, edges }), t);
}

export function buildSequenceGuidanceMarkdown(projectLabel: string, bundle: SequenceDiagramBundle) {
  return buildLegacySequenceGuidance(buildModificationContext({ projectLabel, nodes: [], edges: [], sequenceBundle: bundle }));
}

export function buildSequenceTaskJson(projectLabel: string, bundle: SequenceDiagramBundle) {
  return buildLegacySequenceTaskJson(buildModificationContext({ projectLabel, nodes: [], edges: [], sequenceBundle: bundle }));
}

export function buildSequencePlanPrompt(projectLabel: string, bundle: SequenceDiagramBundle) {
  return buildAgentPrompt(
    buildModificationContext({ projectLabel, nodes: [], edges: [], sequenceBundle: bundle }),
    "sequence-revision",
    "plan"
  );
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

export function downloadText(filename: string, content: string) {
  const environment = globalThis as unknown as {
    Blob: new (parts: string[], options: { type: string }) => unknown;
    URL: {
      createObjectURL(blob: unknown): string;
      revokeObjectURL(url: string): void;
    };
    document: {
      createElement(tagName: "a"): {
        href: string;
        download: string;
        click(): void;
        remove(): void;
      };
      body: {
        appendChild(node: unknown): void;
      };
    };
  };
  const blob = new environment.Blob([content], { type: "text/plain;charset=utf-8" });
  const url = environment.URL.createObjectURL(blob);
  const anchor = environment.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  environment.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  environment.URL.revokeObjectURL(url);
}

function outputContract(promptKind: AgentPromptKind): string {
  if (promptKind === "sequence-revision") {
    return [
      "Return a complete updated architectural sequence diagram JSON object when revising the diagram.",
      "If code changes are needed instead, return a plan with affected files, risks, and tests.",
      "Do not return a patch fragment."
    ].join("\n");
  }
  if (promptKind === "execute-change") {
    return [
      "Modify only files justified by the JSON context and source verification.",
      "Report changed files, verification commands, risks, and any skipped tests."
    ].join("\n");
  }
  if (promptKind === "artifact-analysis") {
    return "Return the requested FlowWeave artifact JSON only, following the schema in the prompt.";
  }
  if (promptKind === "canvas-implementation-plan") {
    return "Return an implementation plan for the selected Canvas module with affected files, risks, and tests.";
  }
  return "Return a combined implementation plan across Canvas and Sequence context with affected files, risks, and tests.";
}

function formatPendingChanges(delta: ModificationGuidanceContext["delta"]): string {
  const sections: string[] = [];
  if (delta.modules.added.length) {
    sections.push(`## Added Modules\n\n${delta.modules.added.map((module) =>
      `### ${module.title} (${module.id})\n\n${JSON.stringify(module, null, 2)}`
    ).join("\n\n")}`);
  }
  if (delta.modules.updated.length) {
    sections.push(`## Updated Modules\n\n${delta.modules.updated.map((module) =>
      `### ${module.title} (${module.id})\n\n${JSON.stringify(module.changes, null, 2)}`
    ).join("\n\n")}`);
  }
  if (delta.modules.deleted.length) {
    sections.push(`## Deleted Modules\n\n${delta.modules.deleted.map((module) =>
      `- ${module.title} (${module.id})`
    ).join("\n")}`);
  }
  if (delta.relations.added.length) {
    sections.push(`## Added Relations\n\n${delta.relations.added.map((relation) =>
      `- ${relation.source} -> ${relation.target}: ${relation.relation}${relation.guidanceNote ? ` — ${relation.guidanceNote}` : ""}`
    ).join("\n")}`);
  }
  if (delta.relations.updated.length) {
    sections.push(`## Updated Relations\n\n${delta.relations.updated.map((relation) =>
      `- ${relation.id}: ${JSON.stringify(relation.changes)}`
    ).join("\n")}`);
  }
  if (delta.relations.deleted.length) {
    sections.push(`## Deleted Relations\n\n${delta.relations.deleted.map((relation) =>
      `- ${relation.source} -> ${relation.target} (${relation.id})`
    ).join("\n")}`);
  }
  if (delta.sequenceInstruction) {
    sections.push(`## Sequence Diagram Instruction\n\n${delta.sequenceInstruction}`);
  }
  return sections.join("\n\n");
}

function formatCanvasModule(node: GraphNode): string {
  return `### ${node.title}

Type: ${node.nodeType}
Risk: ${node.risk}
${formatAssessmentMarkdown(node)}

${node.description}

Files:
${node.files.map((file) => `- ${file}`).join("\n") || "- No files recorded."}

Guidance:
${node.guidanceDraft || "No guidance recorded."}
`;
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
    node.assessment.risk.override ? `Manual override: ${node.assessment.risk.override.level} (${node.assessment.risk.override.reason})` : "",
    topRiskFactors ? `Risk evidence: ${topRiskFactors}` : "Risk evidence: unavailable",
    node.assessment.confidence.level === "low" || node.assessment.confidence.level === "unknown"
      ? "Guidance: verify source evidence and refresh the semantic scan before broad changes."
      : "Guidance: validate the highest-scoring risk factors and connected modules."
  ].filter(Boolean).join("\n");
}

function relationTitle(edge: GraphEdge, t?: Translate) {
  return t ? t(`relation.${edge.relation}Accent`) : edge.relation;
}

function relationDescription(edge: GraphEdge, t?: Translate) {
  return t ? t(`relation.${edge.relation}Description`) : "";
}

function formatSequenceDiagramMarkdown(diagram: ReturnType<typeof serializeSequenceDiagram>) {
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

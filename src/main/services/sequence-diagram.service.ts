import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AnalysisGenerationOptions,
  ArchitectureMap,
  ArchitectureEvidence,
  CodeflowProject,
  FileInsight,
  ProjectStructureFacts,
  RuntimeAgentId,
  SequenceDiagram,
  SequenceDiagramBundle,
  SequenceDiagramGenerationResult,
  SequenceMessage,
  SequenceMessageKind,
  SequenceParticipant,
  SequenceParticipantKind,
  ToolRunResult
} from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { readArchitectureMap } from "./architecture-analysis.service";
import { startToolPlan } from "./agent-run.service";
import { registerProject } from "./project-registry.service";
import { buildSemanticIndex, semanticIndexToStructureFacts } from "./semantic-index.service";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { extractStructuredJson } from "./structured-output.service";
import { writeModificationDocs } from "./modification-doc.service";
import {
  startSequenceReview,
  writeSequenceReviewStatus,
  type SequenceReviewRunResult
} from "./sequence-review.service";
import { waitForArtifactRunResponse } from "./artifact-review-wait.service";
import { readCurrentProjectScanFingerprint } from "./project-scan-fingerprint.service";

const SEQUENCE_DIAGRAM_FILE = "sequence-diagrams.json";
export const SEQUENCE_DIAGRAM_PROMPT_TARGET_CHARS = 12_000;
export const SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS = 16_000;
const SEQUENCE_PROMPT_EVIDENCE_DETAIL_MAX_CHARS = 160;
const sequenceFlights = new Map<string, Promise<SequenceDiagramGenerationResult>>();

export type SequenceDiagramPrompt = {
  text: string;
  metrics: {
    promptChars: number;
    promptCoreChars: number;
    promptEvidenceChars: number;
    promptEvidenceCount: number;
    promptEvidenceOmittedCount: number;
    promptEvidenceTruncatedCount: number;
    promptParticipantCount: number;
    promptMessageCount: number;
    promptMessageOmittedCount: number;
  };
};

type SequencePromptContext = {
  evidence: ArchitectureEvidence[];
  messageEvidenceIndexes: number[][];
  supportedMessageIndexes: number[];
  omittedMessageCount: number;
  diagramEvidenceIndexes: number[];
};

type CompactSequencePromptRender = {
  text: string;
  participantCount: number;
  messageCount: number;
};

type SequencePromptBudgetDiagnostics = {
  participantCount: number;
  messageCount: number;
  mandatoryEvidenceCount: number;
  largestEvidenceContribution: {
    chars: number;
    filePath: string | undefined;
    symbol: string | undefined;
  } | null;
};

export class SequenceDiagramPromptBudgetExceededError extends Error {
  readonly code = "SEQUENCE_DIAGRAM_PROMPT_BUDGET_EXCEEDED";
  readonly actualChars: number;
  readonly budgetChars = SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS;
  readonly diagnostics: SequencePromptBudgetDiagnostics;

  constructor(actualChars: number, diagnostics: SequencePromptBudgetDiagnostics) {
    const largestEvidence = diagnostics.largestEvidenceContribution;
    const largestEvidenceText = largestEvidence
      ? ` largestEvidenceChars=${largestEvidence.chars} largestEvidencePath=${largestEvidence.filePath ?? "unknown"}`
      : " largestEvidenceChars=0";
    super(
      `SEQUENCE_DIAGRAM_PROMPT_BUDGET_EXCEEDED: actualChars=${actualChars} budget=${SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS} participants=${diagnostics.participantCount} messages=${diagnostics.messageCount} mandatoryEvidence=${diagnostics.mandatoryEvidenceCount}${largestEvidenceText}`
    );
    this.name = "SequenceDiagramPromptBudgetExceededError";
    this.actualChars = actualChars;
    this.diagnostics = diagnostics;
  }
}

export async function generateSequenceDiagrams(
  project: CodeflowProject,
  agentId: RuntimeAgentId,
  options?: AnalysisGenerationOptions
): Promise<SequenceDiagramGenerationResult> {
  const flightKey = `${project.rootPath}:${agentId}`;
  const existing = sequenceFlights.get(flightKey);
  if (existing) return existing;
  const flight = generateSequenceDiagramsOnce(project, agentId, options)
    .finally(() => sequenceFlights.delete(flightKey));
  sequenceFlights.set(flightKey, flight);
  return flight;
}

async function generateSequenceDiagramsOnce(
  project: CodeflowProject,
  agentId: RuntimeAgentId,
  options: AnalysisGenerationOptions | undefined
): Promise<SequenceDiagramGenerationResult> {
  const { index } = await buildSemanticIndex(project, { onProgress: options?.onProgress });
  const facts = semanticIndexToStructureFacts(project, index);
  const storedArchitecture = await readArchitectureMap(project.rootPath);
  const architectureMap = storedArchitecture;
  const inputFingerprint = await readCurrentProjectScanFingerprint(project.rootPath);
  const localBundleBase = createLocalSequenceBundle(project, facts, architectureMap, "local");
  const localQuality = validateSequenceBundle(localBundleBase, facts);
  const localBundle = withLocalSequenceMetadata(localBundleBase, inputFingerprint, localQuality);
  options?.onProgress?.({
    stage: "analyzing",
    completed: 0,
    total: 1,
    failed: 0,
    message: `Analyzing architectural sequence diagram with ${agentId}.`
  });

  if (agentId === "mock") {
    const inferred = createLocalSequenceBundle(project, facts, architectureMap, "agent");
    const parsed = parseSequenceDiagramBundleJson(mockSequenceBundleJson(inferred), project, facts, architectureMap);
    if (!parsed) return failedSequenceResult(agentId, "invalid-output", "Mock agent returned invalid sequence diagram JSON.", []);
    const quality = validateSequenceBundle(parsed, facts);
    if (!quality.valid) return failedSequenceResult(agentId, "quality-rejected", quality.reasons.join("; "), []);
    const bundle = withSequenceMetadata(parsed, agentId, "mock", inputFingerprint, quality);
    await writeSequenceDiagramBundle(project.rootPath, bundle, undefined);
    const review = {
      state: "reviewed",
      reviewId: `sequence-review-${randomUUID()}`,
      scanFingerprint: inputFingerprint,
      agentId,
      runId: "mock",
      completedAt: bundle.generatedAt
    } as const;
    await writeSequenceReviewStatus(project.rootPath, review);
    return { bundle, outcome: "generated", review };
  }

  const publishedBundle = await writeLocalSequenceDiagramBundle(project.rootPath, localBundle);
  const projectId = options?.projectId ?? await registerProject(project.rootPath);
  const reviewId = options?.resumeSequenceReview?.reviewId ?? `sequence-review-${randomUUID()}`;
  const review = await startSequenceReview({
    projectId,
    projectPath: project.rootPath,
    reviewId,
    scanFingerprint: inputFingerprint,
    agentId,
    localBundle: publishedBundle,
    startedAt: publishedBundle.generatedAt,
    persist: (bundle) => writeSequenceDiagramBundle(project.rootPath, bundle, undefined),
    run: (onRunId) => {
      const prompt = buildSequenceDiagramPrompt(project.projectName, localBundleBase.architectural);
      return runSequenceReview(
        project,
        agentId,
        prompt.text,
        facts,
        architectureMap,
        inputFingerprint,
        reviewId,
        onRunId,
        options?.timeoutMs
      );
    },
    onEvent: options?.onSequenceReview ?? (() => undefined)
  });
  return { bundle: publishedBundle, outcome: "generated", review };
}

export async function reviseSequenceDiagram(
  project: CodeflowProject,
  agentId: RuntimeAgentId,
  instruction: string,
  options?: AnalysisGenerationOptions
): Promise<SequenceDiagramBundle> {
  const current = await readSequenceDiagrams(project.rootPath);
  if (!current) throw new Error("No trusted sequence diagram exists to revise.");
  const currentDiagram = current.architectural;
  const prompt = buildSequenceDiagramRevisionPrompt(currentDiagram, instruction);
  options?.onProgress?.({
    stage: "analyzing",
    completed: 0,
    total: 1,
    failed: 0,
    message: `Revising architectural sequence diagram with ${agentId}.`
  });

  if (agentId === "mock") {
    const parsed = parseSequenceDiagramJson(mockRevisedDiagramJson(currentDiagram, instruction));
    const bundle = parsed ? replaceDiagram(current, parsed) : current;
    await writeSequenceDiagramBundle(project.rootPath, bundle, instruction);
    return bundle;
  }

  const result = await startToolPlan({
    projectId: await registerProject(project.rootPath),
    toolId: agentId,
    prompt: prompt.text,
    executionMode: "plan",
    purpose: "artifact-analysis",
    artifactTarget: "sequence-revision",
    scanFingerprint: current.metadata?.inputFingerprint,
    timeoutMs: options?.timeoutMs
  });
  if (result.status !== "completed") {
    throw new Error(result.stderr ?? result.summary ?? "Agent sequence diagram revision failed");
  }

  const parsed = parseSequenceDiagramJson(collectStdout(result.events));
  if (!parsed) {
    throw new Error("Agent did not return a valid sequence diagram JSON object.");
  }
  const bundle = replaceDiagram(current, parsed);
  await writeSequenceDiagramBundle(project.rootPath, bundle, instruction);
  return bundle;
}

export async function readSequenceDiagrams(projectPath: string): Promise<SequenceDiagramBundle | undefined> {
  const filePath = join(projectPath, FLOWWEAVE_DIR, SEQUENCE_DIAGRAM_FILE);
  const value = await readJsonArtifact(filePath);
  if (value === undefined) return undefined;
  const bundle = value as SequenceDiagramBundle;
  if (bundle.version !== 2) {
    throw new Error(`FlowWeave sequence diagram artifact must be v2. Regenerate it: ${filePath}`);
  }
  return bundle;
}

export function buildSequenceDiagramPrompt(projectName: string, diagram: SequenceDiagram): SequenceDiagramPrompt {
  return buildCompactSequencePrompt(projectName, diagram, undefined);
}

export function buildSequenceDiagramRevisionPrompt(
  currentDiagram: SequenceDiagram,
  instruction: string
): SequenceDiagramPrompt {
  return buildCompactSequencePrompt(undefined, currentDiagram, instruction);
}

function buildCompactSequencePrompt(
  projectName: string | undefined,
  diagram: SequenceDiagram,
  instruction: string | undefined
): SequenceDiagramPrompt {
  const context = prepareSequencePromptContext(diagram);
  const coreContext: SequencePromptContext = {
    ...context,
    supportedMessageIndexes: [],
    omittedMessageCount: diagram.messages.length
  };
  const coreText = renderCompactSequencePrompt(
    projectName,
    { ...diagram, messages: [] },
    instruction,
    coreContext,
    new Set()
  ).text;

  const mandatoryEvidence = new Set<number>();
  for (const messageIndex of context.supportedMessageIndexes) {
    const firstEvidenceIndex = context.messageEvidenceIndexes[messageIndex][0];
    if (firstEvidenceIndex !== undefined) mandatoryEvidence.add(firstEvidenceIndex);
  }

  const mandatoryRender = renderCompactSequencePrompt(projectName, diagram, instruction, context, mandatoryEvidence);
  if (mandatoryRender.text.length > SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS) {
    throw new SequenceDiagramPromptBudgetExceededError(
      mandatoryRender.text.length,
      sequencePromptBudgetDiagnostics(diagram, context, mandatoryEvidence)
    );
  }

  const selectedEvidence = new Set(mandatoryEvidence);
  let rendered = mandatoryRender;
  if (mandatoryRender.text.length <= SEQUENCE_DIAGRAM_PROMPT_TARGET_CHARS) {
    for (let index = 0; index < context.evidence.length; index += 1) {
      if (selectedEvidence.has(index)) continue;
      selectedEvidence.add(index);
      const candidate = renderCompactSequencePrompt(projectName, diagram, instruction, context, selectedEvidence);
      if (candidate.text.length <= SEQUENCE_DIAGRAM_PROMPT_TARGET_CHARS) {
        rendered = candidate;
      } else {
        selectedEvidence.delete(index);
      }
    }
  }

  if (rendered.text.length > SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS) {
    throw new SequenceDiagramPromptBudgetExceededError(
      rendered.text.length,
      sequencePromptBudgetDiagnostics(diagram, context, mandatoryEvidence)
    );
  }
  if (rendered.messageCount !== context.supportedMessageIndexes.length) {
    throw new Error(
      `SEQUENCE_DIAGRAM_PROMPT_MESSAGE_LOSS: expected=${context.supportedMessageIndexes.length} actual=${rendered.messageCount}`
    );
  }
  return {
    text: rendered.text,
    metrics: {
      promptChars: rendered.text.length,
      promptCoreChars: coreText.length,
      promptEvidenceChars: rendered.text.length - coreText.length,
      promptEvidenceCount: selectedEvidence.size,
      promptEvidenceOmittedCount: context.evidence.length - selectedEvidence.size,
      promptEvidenceTruncatedCount: [...selectedEvidence].filter((index) => context.evidence[index].detail.length > SEQUENCE_PROMPT_EVIDENCE_DETAIL_MAX_CHARS).length,
      promptParticipantCount: rendered.participantCount,
      promptMessageCount: rendered.messageCount,
      promptMessageOmittedCount: context.omittedMessageCount
    }
  };
}

function prepareSequencePromptContext(diagram: SequenceDiagram): SequencePromptContext {
  const evidence: ArchitectureEvidence[] = [];
  const sourceIndexByKey = new Map<string, number>();
  const indexesForEvidence = (items: ArchitectureEvidence[] | undefined): number[] => (items ?? []).map((item) => {
    const key = sequenceEvidenceKey(item);
    const existingIndex = sourceIndexByKey.get(key);
    if (existingIndex !== undefined) return existingIndex;
    const sourceIndex = evidence.length;
    evidence.push(item);
    sourceIndexByKey.set(key, sourceIndex);
    return sourceIndex;
  });
  const messageEvidenceIndexes = diagram.messages.map((message) => indexesForEvidence(message.evidence));
  const supportedMessageIndexes = messageEvidenceIndexes.flatMap((indexes, index) => indexes.length > 0 ? [index] : []);
  const diagramEvidenceIndexes = indexesForEvidence(diagram.evidence);
  return {
    evidence,
    messageEvidenceIndexes,
    supportedMessageIndexes,
    omittedMessageCount: diagram.messages.length - supportedMessageIndexes.length,
    diagramEvidenceIndexes
  };
}

function sequencePromptBudgetDiagnostics(
  diagram: SequenceDiagram,
  context: SequencePromptContext,
  mandatoryEvidence: Set<number>
): SequencePromptBudgetDiagnostics {
  let largestEvidenceContribution: SequencePromptBudgetDiagnostics["largestEvidenceContribution"] = null;
  for (const index of mandatoryEvidence) {
    const item = context.evidence[index];
    if (!item) {
      throw new Error(`SEQUENCE_DIAGRAM_PROMPT_EVIDENCE_CONTEXT_MISSING: index=${index}`);
    }
    const chars = JSON.stringify([
      item.filePath,
      item.symbol,
      item.line ?? null,
      truncateEvidenceDetail(item.detail)
    ]).length;
    if (largestEvidenceContribution && largestEvidenceContribution.chars >= chars) continue;
    largestEvidenceContribution = {
      chars,
      filePath: item.filePath,
      symbol: item.symbol
    };
  }
  return {
    participantCount: diagram.participants.length,
    messageCount: context.supportedMessageIndexes.length,
    mandatoryEvidenceCount: mandatoryEvidence.size,
    largestEvidenceContribution
  };
}

function sequenceEvidenceKey(evidence: ArchitectureEvidence): string {
  return JSON.stringify([
    evidence.filePath ?? null,
    evidence.symbol ?? null,
    evidence.line ?? null,
    evidence.eventId ?? null,
    evidence.detail
  ]);
}

function renderCompactSequencePrompt(
  projectName: string | undefined,
  diagram: SequenceDiagram,
  instruction: string | undefined,
  context: SequencePromptContext,
  selectedEvidence: Set<number>
): CompactSequencePromptRender {
  const participantIndexes = new Map(diagram.participants.map((participant, index) => [participant.id, index]));
  const evidenceIndexes = selectedEvidenceOutputIndexes([...selectedEvidence]);
  const referenceIndexes = (sourceIndexes: number[]) => sourceIndexes.flatMap((sourceIndex) => {
    const outputIndex = evidenceIndexes.get(sourceIndex);
    return outputIndex === undefined ? [] : [outputIndex];
  });
  const messages = context.supportedMessageIndexes.map((messageIndex) => {
    const item = diagram.messages[messageIndex];
    if (!item) {
      throw new Error(`SEQUENCE_DIAGRAM_PROMPT_MESSAGE_CONTEXT_MISSING: index=${messageIndex}`);
    }
    const evidenceReferences = referenceIndexes(context.messageEvidenceIndexes[messageIndex]);
    if (evidenceReferences.length === 0) {
      throw new Error(`SEQUENCE_DIAGRAM_PROMPT_EVIDENCE_MISSING: messageId=${item.id} sequence=${item.sequence}`);
    }
    return [
      item.id,
      item.sequence,
      participantIndexes.get(item.from),
      participantIndexes.get(item.to),
      item.kind,
      item.label,
      item.description,
      item.methodName,
      item.input,
      item.output,
      evidenceReferences
    ];
  });
  const input = {
    diagram: [diagram.id, diagram.title, diagram.kind, diagram.summary],
    participants: diagram.participants.map((item) => [item.id, item.title, item.kind, item.description, item.filePath, item.symbol]),
    messages,
    diagramEvidence: referenceIndexes(context.diagramEvidenceIndexes),
    evidence: [...selectedEvidence].map((index) => {
      const item = context.evidence[index];
      return [item.filePath, item.symbol, item.line ?? null, truncateEvidenceDetail(item.detail)];
    })
  };
  const diagramSchema = {
    id: "architectural-sequence",
    title: "Architectural Sequence Diagram",
    kind: "architectural",
    summary: "macro collaboration across system components",
    participants: [{ id: "stable-kebab-id", title: "Service", kind: "service", description: "role", filePath: "path", symbol: "name" }],
    messages: [{ id: "stable-kebab-id", sequence: 1, from: "participant-id", to: "participant-id", kind: "sync", label: "call", description: "behavior", methodName: "optional", input: "optional", output: "optional", evidence: [{ filePath: "path", symbol: "optional", line: 12, detail: "evidence row text" }] }],
    evidence: [{ filePath: "path", symbol: "optional", line: 12, detail: "evidence row text" }]
  };
  const schema = instruction === undefined ? {
    architectural: diagramSchema
  } : diagramSchema;
  const text = [
    instruction === undefined
      ? `Create one detailed architectural sequence diagram for ${projectName}. Return only {"architectural":diagram}.`
      : `Revise this complete architectural diagram as instructed. Return the complete updated diagram object, not a patch.\nInstruction: ${instruction}`,
    "Input tuples: diagram=[id,title,kind,summary]; participants=[id,title,kind,description,filePath,symbol]; messages=[id,sequence,fromParticipantIndex,toParticipantIndex,kind,label,description,methodName,input,output,evidenceIndexes]; evidence=[filePath,symbol,lineOrNull,detail]. Copy evidence objects from evidence rows into message.evidence or diagram.evidence by index.",
    `Input: ${JSON.stringify(input)}`,
    "Return shape:",
    JSON.stringify(schema),
    "Create a detailed architectural sequence for the real end-to-end workflow. Use only supplied participants, messages and evidence; do not invent files, symbols, calls, endpoints, databases, queues or third-party systems. Cover entry/user action, UI, desktop shell, IPC/API boundary, services, data access, integrations, events/workers and return paths when present. Use macro-level participants, preserve execution order and valid participant ids; keep kind exactly \"architectural\" and do not return detailedDesign. Prefer 6-14 participants and 8-24 messages when supported. Fill methodName, input and output when supplied. Return valid JSON only.",
    instruction === undefined ? "" : "Preserve reliable existing evidence. Update participants and messages together when the instruction changes components, calls or order."
  ].join("\n\n");
  return {
    text,
    participantCount: input.participants.length,
    messageCount: input.messages.length
  };
}

function selectedEvidenceOutputIndexes(selectedSourceIndexes: number[]): Map<number, number> {
  return new Map(selectedSourceIndexes.map((sourceIndex, outputIndex) => [sourceIndex, outputIndex]));
}

function truncateEvidenceDetail(detail: string): string {
  if (detail.length <= SEQUENCE_PROMPT_EVIDENCE_DETAIL_MAX_CHARS) return detail;
  return `${detail.slice(0, SEQUENCE_PROMPT_EVIDENCE_DETAIL_MAX_CHARS - 1)}…`;
}

export function parseSequenceDiagramBundleJson(
  output: string,
  project: CodeflowProject,
  _facts: ProjectStructureFacts,
  _architectureMap?: ArchitectureMap
): SequenceDiagramBundle | undefined {
  const parsed = parseFirstJsonObject(output) as Partial<SequenceDiagramBundle> | undefined;
  if (!parsed) return undefined;
  const architectural = normalizeDiagram(parsed.architectural, "architectural");
  if (!architectural) return undefined;
  if (!isUsableDiagram(architectural)) return undefined;
  return {
    version: 2,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt: new Date().toISOString(),
    source: "agent",
    architectural
  };
}

export function parseSequenceDiagramJson(output: string): SequenceDiagram | undefined {
  const parsed = parseFirstJsonObject(output) as Partial<SequenceDiagram> | undefined;
  if (!parsed) return undefined;
  return normalizeDiagram(parsed, "architectural");
}

function normalizeDiagram(diagram: Partial<SequenceDiagram> | undefined, kind: SequenceDiagram["kind"]): SequenceDiagram | undefined {
  if (!diagram || diagram.kind !== kind) return undefined;
  const { participants, idAliases } = normalizeParticipants(diagram.participants);
  const participantIds = new Set(participants.map((participant) => participant.id));
  const messages = normalizeMessages(diagram.messages, participantIds, idAliases);
  const normalized: SequenceDiagram = {
    id: safeId(diagram.id ?? `${kind}-sequence`),
    title: diagram.title?.trim() || defaultDiagramTitle(),
    kind,
    summary: diagram.summary?.trim() || defaultDiagramSummary(),
    participants,
    messages,
    evidence: normalizeEvidence(diagram.evidence)
  };
  return isUsableDiagram(normalized) ? normalized : undefined;
}

function normalizeParticipants(participants: SequenceDiagram["participants"] | undefined) {
  const seen = new Set<string>();
  const idAliases = new Map<string, string>();
  const normalizedParticipants = (participants ?? [])
    .map((participant, index): SequenceParticipant | undefined => {
      const id = safeId(participant.id || participant.title || `participant-${index + 1}`);
      if (!id || seen.has(id)) return undefined;
      seen.add(id);
      const normalizedParticipant = {
        id,
        title: participant.title?.trim() || titleFromId(id),
        kind: isParticipantKind(participant.kind) ? participant.kind : "component",
        description: participant.description?.trim() || "Sequence participant.",
        filePath: stringOrUndefined(participant.filePath),
        symbol: stringOrUndefined(participant.symbol)
      };
      addParticipantAlias(idAliases, participant.id, id);
      addParticipantAlias(idAliases, id, id);
      addParticipantAlias(idAliases, participant.title, id);
      addParticipantAlias(idAliases, normalizedParticipant.title, id);
      return normalizedParticipant;
    })
    .filter((participant): participant is SequenceParticipant => Boolean(participant))
    .slice(0, 16);
  return { participants: normalizedParticipants, idAliases };
}

function normalizeMessages(messages: SequenceDiagram["messages"] | undefined, participantIds: Set<string>, idAliases: Map<string, string>) {
  const seen = new Set<string>();
  return (messages ?? [])
    .map((message, index): SequenceMessage | undefined => {
      const from = resolveParticipantId(message.from, idAliases);
      const to = resolveParticipantId(message.to, idAliases);
      if (!from || !to || !participantIds.has(from) || !participantIds.has(to) || from === to) {
        return undefined;
      }
      const id = safeId(message.id || `${from}-${to}-${index + 1}`);
      if (!id || seen.has(id)) return undefined;
      seen.add(id);
      return {
        id,
        sequence: typeof message.sequence === "number" && Number.isFinite(message.sequence) ? message.sequence : index + 1,
        from,
        to,
        kind: isMessageKind(message.kind) ? message.kind : "sync",
        label: message.label?.trim() || message.methodName?.trim() || `${from} calls ${to}`,
        description: stringOrUndefined(message.description),
        methodName: stringOrUndefined(message.methodName),
        input: stringOrUndefined(message.input),
        output: stringOrUndefined(message.output),
        evidence: normalizeEvidence(message.evidence)
      };
    })
    .filter((message): message is SequenceMessage => Boolean(message))
    .sort((a, b) => a.sequence - b.sequence)
    .map((message, index) => ({ ...message, sequence: index + 1 }))
    .slice(0, 40);
}

function normalizeEvidence(evidence: ArchitectureEvidence[] | undefined) {
  return (evidence ?? [])
    .map((item) => ({
      filePath: stringOrUndefined(item.filePath),
      symbol: stringOrUndefined(item.symbol),
      line: Number.isInteger(item.line) ? item.line : undefined,
      detail: item.detail?.trim() || "Sequence evidence"
    }))
    .slice(0, 30);
}

function createLocalSequenceBundle(
  project: CodeflowProject,
  facts: ProjectStructureFacts,
  architectureMap: ArchitectureMap | undefined,
  source: SequenceDiagramBundle["source"]
): SequenceDiagramBundle {
  return {
    version: 2,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt: new Date().toISOString(),
    source,
    architectural: createLocalArchitecturalDiagram(facts, architectureMap)
  };
}

function createLocalArchitecturalDiagram(facts: ProjectStructureFacts, architectureMap?: ArchitectureMap): SequenceDiagram {
  const architectureModules = architectureMap?.modules
    .slice()
    .sort((left, right) => participantPriority(left.category) - participantPriority(right.category))
    .slice(0, 14) ?? [];
  const participants = architectureModules.length > 0
    ? architectureModules.map((module): SequenceParticipant => ({
        id: module.id,
        title: module.title,
        kind: participantKindFromCategory(module.category),
        description: module.role,
        filePath: module.files[0],
        symbol: module.symbols[0]?.name
      }))
    : fallbackFileParticipants(facts.files.slice(0, 6));
  const participantIds = new Set(participants.map((participant) => participant.id));
  const relationships = architectureMap?.relationships ?? [];
  const relationshipMessages = relationships
    .filter((relationship) => participantIds.has(relationship.source) && participantIds.has(relationship.target))
    .sort((left, right) => relationPriority(left.relation) - relationPriority(right.relation))
    .slice(0, 18)
    .map((relationship, index): SequenceMessage => ({
      id: safeId(relationship.id || `${relationship.source}-${relationship.target}-${index + 1}`),
      sequence: index + 1,
      from: relationship.source,
      to: relationship.target,
      kind: relationship.relation === "publishes_event" || relationship.relation === "subscribes_event" ? "event" : relationship.relation === "external_api" ? "external" : "sync",
      label: relationship.description || `${relationship.source} -> ${relationship.target}`,
      description: relationship.description,
      evidence: relationship.evidence
    }));
  const returnMessages = relationshipMessages
    .filter((message) => message.kind === "sync" || message.kind === "external")
    .slice(0, Math.max(0, 24 - relationshipMessages.length))
    .map((message, index): SequenceMessage => ({
      id: safeId(`${message.id}-return`) || `return-${index + 1}`,
      sequence: relationshipMessages.length + index + 1,
      from: message.to,
      to: message.from,
      kind: "return",
      label: `${message.to} returns to ${message.from}`,
      description: "Response path inferred from the request relationship.",
      output: "response",
      evidence: message.evidence
    }));
  const messages = [...relationshipMessages, ...returnMessages].slice(0, 24);
  return {
    id: "architectural-sequence",
    title: "Architectural Sequence Diagram",
    kind: "architectural",
    summary: "Macro collaboration inferred from architecture modules and relationships.",
    participants,
    messages: messages.length > 0 ? messages : fallbackMessages(participants),
    evidence: architectureMap?.relationships.slice(0, 6).flatMap((relationship) => relationship.evidence) ?? []
  };
}

function fallbackFileParticipants(files: FileInsight[]) {
  return files.slice(0, 10).map((file, index): SequenceParticipant => {
    const symbol = file.symbols[0];
    const id = safeId(symbol?.name ?? file.path) || `participant-${index + 1}`;
    return {
      id,
      title: symbol?.name ?? titleFromPath(file.path),
      kind: participantKindFromPath(file.path),
      description: symbol ? `${symbol.kind} in ${file.path}.` : `Source file ${file.path}.`,
      filePath: file.path,
      symbol: symbol?.name
    };
  });
}

function fallbackMessages(participants: SequenceParticipant[]) {
  return participants.slice(0, -1).map((participant, index): SequenceMessage => ({
    id: safeId(`${participant.id}-${participants[index + 1].id}`),
    sequence: index + 1,
    from: participant.id,
    to: participants[index + 1].id,
    kind: "sync",
    label: `${participant.title} collaborates with ${participants[index + 1].title}`,
    description: "Inferred sequence relation from available project structure.",
    methodName: participants[index + 1].symbol,
    input: "project context",
    output: "next step result",
    evidence: participant.filePath ? [{ filePath: participant.filePath, symbol: participant.symbol, detail: "Inferred sequence participant." }] : []
  }));
}

function replaceDiagram(bundle: SequenceDiagramBundle, diagram: SequenceDiagram): SequenceDiagramBundle {
  return {
    ...bundle,
    generatedAt: new Date().toISOString(),
    source: "agent",
    architectural: diagram
  };
}

async function runSequenceReview(
  project: CodeflowProject,
  agentId: RuntimeAgentId,
  prompt: string,
  facts: ProjectStructureFacts,
  architectureMap: ArchitectureMap | undefined,
  inputFingerprint: string,
  reviewId: string,
  onRunId: (runId: string) => Promise<void>,
  timeoutMs: number | undefined
): Promise<SequenceReviewRunResult> {
  const projectId = await registerProject(project.rootPath);
  const result = await startToolPlan({
    projectId,
    toolId: agentId,
    prompt,
    executionMode: "plan",
    purpose: "artifact-analysis",
    artifactTarget: "sequence-diagrams",
    scanFingerprint: inputFingerprint,
    reviewId,
    timeoutMs
  });
  await onRunId(result.id);
  const firstRun = await waitForSequenceRun(project.rootPath, result);
  if (firstRun.status !== "completed") {
    return {
      outcome: "failed",
      runId: firstRun.id,
      error: {
        code: "agent-failed",
        message: firstRun.stderr ?? firstRun.summary ?? "Agent sequence diagram review failed."
      }
    };
  }
  const output = firstRun.outputText ?? collectStdout(firstRun.events);
  const parsed = parseSequenceDiagramBundleJson(output, project, facts, architectureMap);
  const quality = parsed ? validateSequenceBundle(parsed, facts) : undefined;
  if (parsed && quality?.valid) {
    const bundle = withSequenceMetadata(parsed, agentId, firstRun.id, inputFingerprint, quality);
    const { updateRunArtifactAdoption } = await import("./run-log.service");
    await updateRunArtifactAdoption(project.rootPath, firstRun.id, {
      status: "applied",
      message: "Run completed and applied to sequence diagrams.",
      appliedAt: bundle.generatedAt
    });
    return { outcome: "reviewed", bundle, runId: firstRun.id };
  }

  return {
    outcome: "failed",
    runId: firstRun.id,
    error: parsed
      ? {
          code: "quality-rejected",
          message: quality?.reasons.join("; ") ?? "Sequence quality validation failed."
        }
      : {
          code: "invalid-output",
          message: "Agent returned invalid sequence diagram JSON."
        }
  };
}

async function waitForSequenceRun(
  projectPath: string,
  initial: ToolRunResult
): Promise<ToolRunResult> {
  return waitForArtifactRunResponse(projectPath, initial, {
    pollIntervalMs: 1_000
  });
}

export function validateSequenceBundle(
  bundle: SequenceDiagramBundle,
  facts: ProjectStructureFacts
): { valid: boolean; reasons: string[]; fileCoverage: number; evidenceCoverage: number } {
  const files = new Set(facts.files.map((file) => file.path));
  const diagram = bundle.architectural;
  const evidence = [
    ...(diagram.evidence ?? []),
    ...diagram.messages.flatMap((message) => message.evidence ?? [])
  ];
  const coveredFiles = new Set(evidence.map((item) => item.filePath).filter((file): file is string => typeof file === "string" && files.has(file)));
  const validEvidence = evidence.filter((item) => Boolean(item.filePath) && files.has(item.filePath as string));
  const fileCoverage = facts.files.length === 0 ? 0 : coveredFiles.size / facts.files.length;
  const evidenceCoverage = evidence.length === 0 ? 0 : validEvidence.length / evidence.length;
  const reasons: string[] = [];

  const participantIds = new Set(diagram.participants.map((participant) => participant.id));
  if (diagram.messages.length === 0) reasons.push(`${diagram.kind} has no messages.`);
  for (const message of diagram.messages) {
    if (!participantIds.has(message.from) || !participantIds.has(message.to)) {
      reasons.push(`${diagram.kind} message ${message.id} has an invalid endpoint.`);
    }
    if (!message.evidence?.some((item) => item.filePath && files.has(item.filePath))) {
      reasons.push(`${diagram.kind} message ${message.id} has no valid source evidence.`);
    }
  }
  const firstMessage = bundle.architectural.messages[0];
  const firstParticipant = bundle.architectural.participants.find((participant) => participant.id === firstMessage?.from);
  const firstPath = firstParticipant?.filePath?.toLowerCase();
  if (!firstPath || !/(^|\/)(main|index|app|server|bootstrap)\.|ipc|controller|route|handler|page|view|screen/.test(firstPath)) {
    reasons.push("Architectural sequence does not start from a verified source entry.");
  }
  if (evidenceCoverage < 0.7) reasons.push(`Evidence coverage ${evidenceCoverage.toFixed(2)} is below 0.70.`);
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], fileCoverage, evidenceCoverage };
}

export function withSequenceMetadata(
  bundle: SequenceDiagramBundle,
  agentId: RuntimeAgentId,
  runId: string,
  inputFingerprint: string,
  quality: { fileCoverage: number; evidenceCoverage: number }
): SequenceDiagramBundle {
  const generatedAt = new Date().toISOString();
  return {
    ...bundle,
    version: 2,
    source: "agent",
    generatedAt,
    metadata: {
      source: "agent",
      agentId,
      runId,
      generatedAt,
      inputFingerprint,
      fileCoverage: quality.fileCoverage,
      evidenceCoverage: quality.evidenceCoverage
    }
  };
}

function withLocalSequenceMetadata(
  bundle: SequenceDiagramBundle,
  inputFingerprint: string,
  quality: { fileCoverage: number; evidenceCoverage: number }
): SequenceDiagramBundle {
  const generatedAt = new Date().toISOString();
  return {
    ...bundle,
    version: 2,
    source: "local",
    generatedAt,
    metadata: {
      source: "local",
      generatedAt,
      inputFingerprint,
      fileCoverage: quality.fileCoverage,
      evidenceCoverage: quality.evidenceCoverage
    }
  };
}

function failedSequenceResult(
  agentId: RuntimeAgentId,
  code: "agent-failed" | "invalid-output" | "quality-rejected",
  message: string,
  runIds: string[]
): SequenceDiagramGenerationResult {
  return { outcome: "failed", error: failedSequenceError(agentId, code, message, runIds) };
}

function failedSequenceError(
  agentId: RuntimeAgentId,
  code: "agent-failed" | "invalid-output" | "quality-rejected",
  message: string,
  runIds: string[],
  firstFailure?: string,
  retryFailure?: string
) {
  return {
    code,
    message,
    agentId,
    runId: runIds.at(-1),
    attemptRunIds: runIds,
    firstFailure,
    retryFailure
  } as const;
}

export async function writeSequenceDiagramBundle(
  projectPath: string,
  bundle: SequenceDiagramBundle,
  sequenceInstruction: string | undefined
) {
  if (bundle.version !== 2) {
    throw new Error("FlowWeave sequence diagram writes require a v2 bundle.");
  }
  await readSequenceDiagrams(projectPath);
  const root = join(projectPath, FLOWWEAVE_DIR);
  await writeJsonAtomic(join(root, SEQUENCE_DIAGRAM_FILE), bundle);
  await writeModificationDocs(projectPath, { sequence: bundle, sequenceInstruction });
}

async function writeLocalSequenceDiagramBundle(projectPath: string, bundle: SequenceDiagramBundle): Promise<SequenceDiagramBundle> {
  const previous = await readSequenceDiagrams(projectPath);
  if (previous?.source === "agent") return bundle;
  await writeSequenceDiagramBundle(projectPath, bundle, undefined);
  return bundle;
}

function parseFirstJsonObject(output: string): unknown {
  const extracted = extractStructuredJson(output);
  return "value" in extracted ? extracted.value : undefined;
}

function mockSequenceBundleJson(bundle: SequenceDiagramBundle) {
  return JSON.stringify(
    {
      architectural: bundle.architectural
    },
    null,
    2
  );
}

function mockRevisedDiagramJson(diagram: SequenceDiagram, instruction: string) {
  return JSON.stringify(
    {
      ...diagram,
      summary: `${diagram.summary} Revision request: ${instruction}`,
      evidence: [...(diagram.evidence ?? []), { detail: `User revision: ${instruction}` }]
    },
    null,
    2
  );
}

function collectStdout(events: Awaited<ReturnType<typeof startToolPlan>>["events"]) {
  return events
    .filter((event) => event.type === "stdout")
    .map((event) => event.content)
    .join("\n");
}

function participantKindFromCategory(category: ArchitectureMap["modules"][number]["category"]): SequenceParticipantKind {
  const map: Record<ArchitectureMap["modules"][number]["category"], SequenceParticipantKind> = {
    "api-boundary": "gateway",
    "domain-service": "service",
    "data-access": "database",
    "external-integration": "external",
    "job-worker": "worker",
    "shared-utility": "utility",
    "test-surface": "component",
    "unknown": "component"
  };
  return map[category];
}

function participantKindFromPath(filePath: string): SequenceParticipantKind {
  if (/gateway|api|controller|route|router/i.test(filePath)) return "gateway";
  if (/repository|db|database|schema/i.test(filePath)) return "database";
  if (/worker|queue|job/i.test(filePath)) return "worker";
  if (/client|external|payment|webhook/i.test(filePath)) return "external";
  return "service";
}

function isUsableDiagram(diagram: SequenceDiagram) {
  return diagram.participants.length >= 2 && diagram.messages.length >= 1;
}

function isParticipantKind(value: unknown): value is SequenceParticipantKind {
  return (
    value === "actor" ||
    value === "component" ||
    value === "service" ||
    value === "gateway" ||
    value === "database" ||
    value === "external" ||
    value === "controller" ||
    value === "class" ||
    value === "interface" ||
    value === "repository" ||
    value === "worker" ||
    value === "utility"
  );
}

function participantPriority(category: ArchitectureMap["modules"][number]["category"]) {
  const priorities: Record<ArchitectureMap["modules"][number]["category"], number> = {
    "api-boundary": 0,
    "domain-service": 1,
    "job-worker": 2,
    "data-access": 3,
    "external-integration": 4,
    "shared-utility": 5,
    "test-surface": 6,
    "unknown": 7
  };
  return priorities[category];
}

function relationPriority(relation: ArchitectureMap["relationships"][number]["relation"]) {
  const priorities: Record<ArchitectureMap["relationships"][number]["relation"], number> = {
    calls: 0,
    depends_on: 1,
    reads_writes: 2,
    external_api: 3,
    publishes_event: 4,
    subscribes_event: 5,
    tests: 6
  };
  return priorities[relation];
}

function isMessageKind(value: unknown): value is SequenceMessageKind {
  return value === "sync" || value === "async" || value === "return" || value === "event" || value === "external";
}

function addParticipantAlias(aliases: Map<string, string>, value: unknown, id: string) {
  const alias = stringOrUndefined(value);
  if (!alias) return;
  aliases.set(alias, id);
  aliases.set(safeId(alias), id);
}

function resolveParticipantId(value: unknown, aliases: Map<string, string>) {
  const candidate = stringOrUndefined(value);
  if (!candidate) return undefined;
  return aliases.get(candidate) ?? aliases.get(safeId(candidate));
}

function defaultDiagramTitle() {
  return "Architectural Sequence Diagram";
}

function defaultDiagramSummary() {
  return "System component collaboration sequence.";
}

function titleFromPath(path: string) {
  return path.split("/").at(-1)?.replace(/\.[^.]+$/, "") || "Participant";
}

function titleFromId(id: string) {
  return id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function safeId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sequence-item";
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

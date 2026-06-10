import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AnalysisFailure,
  ArchitectureMap,
  ArchitectureEvidence,
  CodeflowProject,
  FileInsight,
  ProjectStructureFacts,
  RuntimeAgentId,
  SequenceDiagram,
  SequenceDiagramBundle,
  SequenceDiagramGenerationResult,
  SequenceDiagramKind,
  SequenceMessage,
  SequenceMessageKind,
  SequenceParticipant,
  SequenceParticipantKind
} from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { readArchitectureMap } from "./architecture-analysis.service";
import { startToolPlan } from "./agent-run.service";
import { createScanFingerprint, registerProject } from "./project-registry.service";
import { buildProjectStructureFacts, selectRepresentativeStructureFacts } from "./structure-extractor.service";

const SEQUENCE_DIAGRAM_FILE = "sequence-diagrams.json";
const MAX_PROMPT_FILES = 180;
const MAX_SYMBOLS_PER_FILE = 14;
const REPRESENTATIVE_FILE_LIMIT = 50;
const sequenceFlights = new Map<string, Promise<SequenceDiagramGenerationResult>>();

export async function generateSequenceDiagrams(project: CodeflowProject, agentId: RuntimeAgentId): Promise<SequenceDiagramGenerationResult> {
  const flightKey = `${project.rootPath}:${agentId}`;
  const existing = sequenceFlights.get(flightKey);
  if (existing) return existing;
  const flight = generateSequenceDiagramsOnce(project, agentId).finally(() => sequenceFlights.delete(flightKey));
  sequenceFlights.set(flightKey, flight);
  return flight;
}

async function generateSequenceDiagramsOnce(project: CodeflowProject, agentId: RuntimeAgentId): Promise<SequenceDiagramGenerationResult> {
  const facts = await buildProjectStructureFacts(project);
  const representativeFacts = { ...facts, files: selectRepresentativeStructureFacts(facts, REPRESENTATIVE_FILE_LIMIT) };
  const storedArchitecture = await readArchitectureMap(project.rootPath);
  const architectureMap = storedArchitecture?.source === "agent" && storedArchitecture.metadata ? storedArchitecture : undefined;
  const inputFingerprint = project.scanFingerprint ?? createScanFingerprint({ representativeFacts, architecture: architectureMap?.metadata?.inputFingerprint });
  const prompt = buildSequenceDiagramPrompt(representativeFacts, architectureMap);

  if (agentId === "mock") {
    const inferred = createFallbackSequenceBundle(project, representativeFacts, architectureMap, "agent");
    const parsed = parseSequenceDiagramBundleJson(mockSequenceBundleJson(inferred), project, facts, architectureMap);
    if (!parsed) return failedSequenceResult(agentId, "invalid-output", "Mock agent returned invalid sequence diagram JSON.", []);
    const quality = validateSequenceBundle(parsed, representativeFacts);
    if (!quality.valid) return failedSequenceResult(agentId, "quality-rejected", quality.reasons.join("; "), []);
    const bundle = withSequenceMetadata(parsed, agentId, "mock", inputFingerprint, quality);
    await writeSequenceDiagramBundle(project.rootPath, bundle);
    return { bundle, outcome: "generated" };
  }

  const projectId = await registerProject(project.rootPath);
  const runIds: string[] = [];
  try {
    const result = await startToolPlan({
      projectId,
      toolId: agentId,
      prompt,
      executionMode: "plan",
      purpose: "artifact-analysis"
    });
    runIds.push(result.id);
    if (result.status !== "completed") {
      return cachedOrFailed(project.rootPath, failedSequenceError(agentId, "agent-failed", result.stderr ?? result.summary ?? "Agent sequence diagram generation failed.", runIds));
    }
    const output = collectStdout(result.events);
    const parsed = parseSequenceDiagramBundleJson(output, project, facts, architectureMap);
    const quality = parsed ? validateSequenceBundle(parsed, representativeFacts) : undefined;
    if (parsed && quality?.valid) {
      const bundle = withSequenceMetadata(parsed, agentId, result.id, inputFingerprint, quality);
      await writeSequenceDiagramBundle(project.rootPath, bundle);
      return { bundle, outcome: "generated" };
    }
    const firstFailure = parsed ? quality?.reasons.join("; ") ?? "Sequence quality validation failed." : "Agent returned invalid sequence diagram JSON.";
    const retry = await startToolPlan({
      projectId,
      toolId: agentId,
      prompt: buildSequenceRepairPrompt(prompt, output, firstFailure),
      executionMode: "plan",
      purpose: "artifact-analysis"
    });
    runIds.push(retry.id);
    if (retry.status !== "completed") {
      return cachedOrFailed(project.rootPath, failedSequenceError(agentId, "agent-failed", retry.stderr ?? retry.summary ?? "Sequence repair run failed.", runIds, firstFailure));
    }
    const retryOutput = collectStdout(retry.events);
    const retryParsed = parseSequenceDiagramBundleJson(retryOutput, project, facts, architectureMap);
    const retryQuality = retryParsed ? validateSequenceBundle(retryParsed, representativeFacts) : undefined;
    if (!retryParsed || !retryQuality?.valid) {
      const retryFailure = retryParsed ? retryQuality?.reasons.join("; ") ?? "Sequence quality validation failed." : "Repair run returned invalid sequence diagram JSON.";
      return cachedOrFailed(
        project.rootPath,
        failedSequenceError(agentId, retryParsed ? "quality-rejected" : "invalid-output", retryFailure, runIds, firstFailure, retryFailure)
      );
    }
    const bundle = withSequenceMetadata(retryParsed, agentId, retry.id, inputFingerprint, retryQuality);
    await writeSequenceDiagramBundle(project.rootPath, bundle);
    return { bundle, outcome: "generated" };
  } catch (error) {
    return cachedOrFailed(project.rootPath, failedSequenceError(agentId, "agent-failed", formatErrorMessage(error), runIds));
  }
}

export async function reviseSequenceDiagram(
  project: CodeflowProject,
  agentId: RuntimeAgentId,
  kind: SequenceDiagramKind,
  instruction: string
): Promise<SequenceDiagramBundle> {
  const facts = await buildProjectStructureFacts(project);
  const architectureMap = await readArchitectureMap(project.rootPath);
  const current = await readSequenceDiagrams(project.rootPath);
  if (!current) throw new Error("No trusted sequence diagram exists to revise.");
  const currentDiagram = selectDiagram(current, kind);
  const prompt = buildSequenceDiagramRevisionPrompt(currentDiagram, instruction, facts, architectureMap);

  if (agentId === "mock") {
    const parsed = parseSequenceDiagramJson(mockRevisedDiagramJson(currentDiagram, instruction), kind);
    const bundle = parsed ? replaceDiagram(current, parsed) : current;
    await writeSequenceDiagramBundle(project.rootPath, bundle);
    return bundle;
  }

  const result = await startToolPlan({
    projectId: await registerProject(project.rootPath),
    toolId: agentId,
    prompt,
    executionMode: "plan",
    purpose: "artifact-analysis"
  });
  if (result.status !== "completed") {
    throw new Error(result.stderr ?? result.summary ?? "Agent sequence diagram revision failed");
  }

  const parsed = parseSequenceDiagramJson(collectStdout(result.events), kind);
  if (!parsed) {
    throw new Error("Agent did not return a valid sequence diagram JSON object.");
  }
  const bundle = replaceDiagram(current, parsed);
  await writeSequenceDiagramBundle(project.rootPath, bundle);
  return bundle;
}

export async function readSequenceDiagrams(projectPath: string): Promise<SequenceDiagramBundle | undefined> {
  const filePath = join(projectPath, FLOWWEAVE_DIR, SEQUENCE_DIAGRAM_FILE);
  return readFile(filePath, "utf8")
    .then((content) => JSON.parse(content) as SequenceDiagramBundle)
    .catch(() => undefined);
}

export function buildSequenceDiagramPrompt(facts: ProjectStructureFacts, architectureMap?: ArchitectureMap) {
  return `You are FlowWeave's sequence diagram analyst. Return only JSON.

Goal:
Create two project sequence diagrams from the code structure and architecture map so a user can understand the real end-to-end workflow and the concrete code-level call sequence.

Project: ${facts.projectName}
Languages: ${JSON.stringify(facts.languages)}

ArchitectureMap:
${JSON.stringify(compactArchitectureMap(architectureMap), null, 2)}

ProjectStructureFacts:
${JSON.stringify(compactFactsForPrompt(facts), null, 2)}

Analysis priorities:
- Use only the supplied ArchitectureMap and ProjectStructureFacts. Do not invent files, symbols, calls, endpoints, databases, queues, or third-party systems.
- The architectural diagram should show the end-to-end workflow across macro participants such as actor, frontend/component, gateway/API boundary, service, database, external system, and worker.
- The detailed-design diagram should show the code-level call sequence across real controllers, classes, interfaces, repositories, utilities, workers, and methods.
- Order messages by the real execution flow: entry/request, validation or orchestration, domain work, data access, external calls or events, return/response.
- Fill methodName, input, output, and evidence whenever the facts provide calls, symbols, imports, exports, or externalCalls.
- When the code facts are incomplete, label the detail as inferred from imports/calls/file role instead of presenting it as certain.

Return this exact JSON shape:
{
  "architectural": {
    "id": "architectural-sequence",
    "title": "Architectural Sequence Diagram",
    "kind": "architectural",
    "summary": "macro collaboration across system components",
    "participants": [{
      "id": "stable-kebab-id",
      "title": "Frontend App|Gateway|Order Service|Payment Gateway",
      "kind": "actor|component|service|gateway|database|external|controller|class|interface|repository|worker|utility",
      "description": "one sentence role",
      "filePath": "optional source path",
      "symbol": "optional source symbol"
    }],
    "messages": [{
      "id": "stable-kebab-id",
      "sequence": 1,
      "from": "participant-id",
      "to": "participant-id",
      "kind": "sync|async|return|event|external",
      "label": "request, response, event, or integration call",
      "description": "what happens",
      "methodName": "optional method or endpoint",
      "input": "important input parameters",
      "output": "important return value",
      "evidence": [{"filePath": "path", "symbol": "optional", "detail": "specific evidence"}]
    }],
    "evidence": [{"filePath": "path", "symbol": "optional", "detail": "why this diagram is credible"}]
  },
  "detailedDesign": {
    "id": "detailed-design-sequence",
    "title": "Detailed Design Sequence Diagram",
    "kind": "detailed-design",
    "summary": "code-level method call sequence",
    "participants": [],
    "messages": [],
    "evidence": []
  }
}

Rules:
- The architectural diagram uses macro participants: frontend app, gateway, services, databases, workers, and third-party systems.
- The detailed-design diagram maps directly to code structure: Controller, Service, Repository, Interface, Class, and concrete method calls.
- Detailed-design messages must include methodName, input, output, and evidence when the code facts provide them.
- Every message must reference valid participant ids from its diagram.
- Prefer 4-10 participants and 4-14 messages per diagram.
- Return valid JSON only.`;
}

export function buildSequenceDiagramRevisionPrompt(
  currentDiagram: SequenceDiagram,
  instruction: string,
  facts: ProjectStructureFacts,
  architectureMap?: ArchitectureMap
) {
  return `You are FlowWeave's sequence diagram editor. Return only JSON.

Goal:
Revise the current ${currentDiagram.kind} sequence diagram according to the user instruction. Return the complete updated diagram object, not a patch.

User instruction:
${instruction}

Current diagram:
${JSON.stringify(currentDiagram, null, 2)}

ArchitectureMap:
${JSON.stringify(compactArchitectureMap(architectureMap), null, 2)}

ProjectStructureFacts:
${JSON.stringify(compactFactsForPrompt(facts), null, 2)}

Revision priorities:
- Preserve reliable existing evidence and participant mappings unless the user instruction or code facts require a change.
- Update participants and messages together when the requested change affects components, classes, methods, inputs, outputs, or ordering.
- Keep the workflow truthful to the supplied ArchitectureMap and ProjectStructureFacts. Do not invent files, symbols, calls, endpoints, databases, queues, or third-party systems.
- Keep message order aligned with the real execution flow and fill methodName, input, output, and evidence for changed method calls when possible.

Return this exact JSON shape:
{
  "id": "stable-diagram-id",
  "title": "Diagram title",
  "kind": "${currentDiagram.kind}",
  "summary": "updated summary",
  "participants": [],
  "messages": [],
  "evidence": []
}

Rules:
- Keep kind exactly "${currentDiagram.kind}".
- Every message must reference existing participant ids.
- Preserve useful evidence and add code evidence for changed method calls when possible.
- Return valid JSON only.`;
}

export function parseSequenceDiagramBundleJson(
  output: string,
  project: CodeflowProject,
  facts: ProjectStructureFacts,
  architectureMap?: ArchitectureMap
): SequenceDiagramBundle | undefined {
  const parsed = parseFirstJsonObject(output) as Partial<SequenceDiagramBundle> | undefined;
  if (!parsed) return undefined;
  const architectural = normalizeDiagram(parsed.architectural, "architectural");
  const detailedDesign = normalizeDiagram(parsed.detailedDesign, "detailed-design");
  if (!architectural || !detailedDesign) return undefined;
  if (!isUsableDiagram(architectural) || !isUsableDiagram(detailedDesign)) return undefined;
  return {
    version: 1,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt: new Date().toISOString(),
    source: "agent",
    architectural,
    detailedDesign
  };
}

export function parseSequenceDiagramJson(output: string, kind: SequenceDiagramKind): SequenceDiagram | undefined {
  const parsed = parseFirstJsonObject(output) as Partial<SequenceDiagram> | undefined;
  if (!parsed) return undefined;
  return normalizeDiagram(parsed, kind);
}

function normalizeDiagram(diagram: Partial<SequenceDiagram> | undefined, kind: SequenceDiagramKind): SequenceDiagram | undefined {
  if (!diagram || diagram.kind !== kind) return undefined;
  const { participants, idAliases } = normalizeParticipants(diagram.participants);
  const participantIds = new Set(participants.map((participant) => participant.id));
  const messages = normalizeMessages(diagram.messages, participantIds, idAliases);
  const normalized: SequenceDiagram = {
    id: safeId(diagram.id ?? `${kind}-sequence`),
    title: diagram.title?.trim() || defaultDiagramTitle(kind),
    kind,
    summary: diagram.summary?.trim() || defaultDiagramSummary(kind),
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
      detail: item.detail?.trim() || "Sequence evidence"
    }))
    .slice(0, 30);
}

function createFallbackSequenceBundle(
  project: CodeflowProject,
  facts: ProjectStructureFacts,
  architectureMap: ArchitectureMap | undefined,
  source: SequenceDiagramBundle["source"]
): SequenceDiagramBundle {
  return {
    version: 1,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt: new Date().toISOString(),
    source,
    architectural: createFallbackArchitecturalDiagram(facts, architectureMap),
    detailedDesign: createFallbackDetailedDiagram(facts)
  };
}

function createFallbackArchitecturalDiagram(facts: ProjectStructureFacts, architectureMap?: ArchitectureMap): SequenceDiagram {
  const architectureModules = architectureMap?.modules.slice(0, 10) ?? [];
  const participants = architectureModules.length > 0
    ? architectureModules.map((module): SequenceParticipant => ({
        id: module.id,
        title: module.title,
        kind: participantKindFromCategory(module.category),
        description: module.role,
        filePath: module.files[0],
        symbol: module.symbols[0]?.name
      }))
    : fallbackFileParticipants(facts.files.slice(0, 6), "architectural");
  const participantIds = new Set(participants.map((participant) => participant.id));
  const relationships = architectureMap?.relationships ?? [];
  const messages = relationships
    .filter((relationship) => participantIds.has(relationship.source) && participantIds.has(relationship.target))
    .slice(0, 14)
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

function createFallbackDetailedDiagram(facts: ProjectStructureFacts): SequenceDiagram {
  const symbolFiles = facts.files.filter((file) => file.symbols.length > 0).slice(0, 10);
  const participants = fallbackFileParticipants(symbolFiles.length > 0 ? symbolFiles : facts.files.slice(0, 8), "detailed-design");
  const participantByFile = new Map(participants.map((participant) => [participant.filePath, participant.id]));
  const messages: SequenceMessage[] = [];
  for (const file of symbolFiles) {
    const source = participantByFile.get(file.path);
    if (!source) continue;
    for (const importPath of file.imports.slice(0, 4)) {
      const targetFile = findImportedFile(importPath, symbolFiles);
      const target = targetFile ? participantByFile.get(targetFile.path) : undefined;
      if (!target || target === source) continue;
      messages.push({
        id: safeId(`${source}-${target}-${messages.length + 1}`),
        sequence: messages.length + 1,
        from: source,
        to: target,
        kind: "sync",
        label: file.calls[0] ?? `imports ${importPath}`,
        methodName: file.calls[0],
        input: "inferred from caller context",
        output: "inferred return value",
        evidence: [{ filePath: file.path, symbol: file.symbols[0]?.name, detail: `Import reference: ${importPath}` }]
      });
      if (messages.length >= 14) break;
    }
    if (messages.length >= 14) break;
  }
  return {
    id: "detailed-design-sequence",
    title: "Detailed Design Sequence Diagram",
    kind: "detailed-design",
    summary: "Code-level call sequence inferred from imports, symbols, and call expressions.",
    participants,
    messages: messages.length > 0 ? messages : fallbackMessages(participants),
    evidence: symbolFiles.slice(0, 8).map((file) => ({ filePath: file.path, symbol: file.symbols[0]?.name, detail: `Symbols: ${file.symbols.map((symbol) => symbol.name).slice(0, 4).join(", ")}` }))
  };
}

function fallbackFileParticipants(files: FileInsight[], kind: SequenceDiagramKind) {
  return files.slice(0, 10).map((file, index): SequenceParticipant => {
    const symbol = file.symbols[0];
    const id = safeId(symbol?.name ?? file.path) || `participant-${index + 1}`;
    return {
      id,
      title: symbol?.name ?? titleFromPath(file.path),
      kind: kind === "detailed-design" ? participantKindFromSymbol(symbol?.kind, file.path) : participantKindFromPath(file.path),
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
    evidence: participant.filePath ? [{ filePath: participant.filePath, symbol: participant.symbol, detail: "Fallback sequence participant." }] : []
  }));
}

function replaceDiagram(bundle: SequenceDiagramBundle, diagram: SequenceDiagram): SequenceDiagramBundle {
  return {
    ...bundle,
    generatedAt: new Date().toISOString(),
    source: "agent",
    architectural: diagram.kind === "architectural" ? diagram : bundle.architectural,
    detailedDesign: diagram.kind === "detailed-design" ? diagram : bundle.detailedDesign
  };
}

function selectDiagram(bundle: SequenceDiagramBundle, kind: SequenceDiagramKind) {
  return kind === "architectural" ? bundle.architectural : bundle.detailedDesign;
}

async function cachedOrFailed(
  projectPath: string,
  error: AnalysisFailure
): Promise<SequenceDiagramGenerationResult> {
  const cached = await readSequenceDiagrams(projectPath);
  if (cached) {
    return { bundle: cached, outcome: "cached", error };
  }
  return { outcome: "failed", error };
}

function validateSequenceBundle(
  bundle: SequenceDiagramBundle,
  facts: ProjectStructureFacts
): { valid: boolean; reasons: string[]; fileCoverage: number; evidenceCoverage: number } {
  const files = new Set(facts.files.map((file) => file.path));
  const diagrams = [bundle.architectural, bundle.detailedDesign];
  const evidence = diagrams.flatMap((diagram) => [
    ...(diagram.evidence ?? []),
    ...diagram.messages.flatMap((message) => message.evidence ?? [])
  ]);
  const coveredFiles = new Set(evidence.map((item) => item.filePath).filter((file): file is string => typeof file === "string" && files.has(file)));
  const validEvidence = evidence.filter((item) => Boolean(item.filePath) && files.has(item.filePath as string));
  const fileCoverage = facts.files.length === 0 ? 0 : coveredFiles.size / facts.files.length;
  const evidenceCoverage = evidence.length === 0 ? 0 : validEvidence.length / evidence.length;
  const reasons: string[] = [];

  for (const diagram of diagrams) {
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
  }
  const firstMessage = bundle.architectural.messages[0];
  const firstParticipant = bundle.architectural.participants.find((participant) => participant.id === firstMessage?.from);
  const firstPath = firstParticipant?.filePath?.toLowerCase();
  if (!firstPath || !/(^|\/)(main|index|app|server|bootstrap)\.|ipc|controller|route|handler/.test(firstPath)) {
    reasons.push("Architectural sequence does not start from a verified source entry.");
  }
  if (evidenceCoverage < 0.7) reasons.push(`Evidence coverage ${evidenceCoverage.toFixed(2)} is below 0.70.`);
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], fileCoverage, evidenceCoverage };
}

function withSequenceMetadata(
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
      agentId,
      runId,
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

function buildSequenceRepairPrompt(originalPrompt: string, output: string, failure: string) {
  return `${originalPrompt}

The previous response failed validation: ${failure}
Return one corrected JSON object only. Do not include Markdown fences or explanatory text.

Previous response:
${output.slice(0, 40_000)}`;
}

async function writeSequenceDiagramBundle(projectPath: string, bundle: SequenceDiagramBundle) {
  const root = join(projectPath, FLOWWEAVE_DIR);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, SEQUENCE_DIAGRAM_FILE), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
}

function parseFirstJsonObject(output: string): unknown {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
}

function compactFactsForPrompt(facts: ProjectStructureFacts) {
  return {
    ...facts,
    files: facts.files.slice(0, MAX_PROMPT_FILES).map((file) => ({
      path: file.path,
      language: file.language,
      imports: file.imports.slice(0, 24),
      exports: file.exports.slice(0, 20),
      symbols: file.symbols.slice(0, MAX_SYMBOLS_PER_FILE),
      calls: file.calls.slice(0, 24),
      externalCalls: file.externalCalls.slice(0, 12),
      moduleId: file.moduleId,
      role: file.role
    }))
  };
}

function compactArchitectureMap(map?: ArchitectureMap) {
  if (!map) return undefined;
  return {
    architectureStyle: map.architectureStyle,
    modules: map.modules.map((module) => ({
      id: module.id,
      title: module.title,
      category: module.category,
      role: module.role,
      files: module.files.slice(0, 10),
      symbols: module.symbols.slice(0, 12)
    })),
    relationships: map.relationships.slice(0, 80)
  };
}

function mockSequenceBundleJson(bundle: SequenceDiagramBundle) {
  return JSON.stringify(
    {
      architectural: bundle.architectural,
      detailedDesign: bundle.detailedDesign
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

function findImportedFile(importPath: string, files: FileInsight[]) {
  const normalized = importPath.replace(/^\.\.?\//, "").replace(/\.(ts|tsx|js|jsx|py|go|java|rs|php|cs)$/i, "");
  return files.find((file) => file.path.includes(normalized) || file.path.replace(/\.(ts|tsx|js|jsx|py|go|java|rs|php|cs)$/i, "").endsWith(normalized));
}

function participantKindFromCategory(category: ArchitectureMap["modules"][number]["category"]): SequenceParticipantKind {
  const map: Record<ArchitectureMap["modules"][number]["category"], SequenceParticipantKind> = {
    "api-boundary": "gateway",
    "domain-service": "service",
    "data-access": "database",
    "external-integration": "external",
    "job-worker": "worker",
    "shared-utility": "utility",
    "test-surface": "component"
  };
  return map[category];
}

function participantKindFromSymbol(kind: FileInsight["symbols"][number]["kind"] | undefined, filePath: string): SequenceParticipantKind {
  if (/controller|route|router/i.test(filePath)) return "controller";
  if (/repository|db|database/i.test(filePath)) return "repository";
  if (kind === "class") return "class";
  return "interface";
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

function defaultDiagramTitle(kind: SequenceDiagramKind) {
  return kind === "architectural" ? "Architectural Sequence Diagram" : "Detailed Design Sequence Diagram";
}

function defaultDiagramSummary(kind: SequenceDiagramKind) {
  return kind === "architectural" ? "System component collaboration sequence." : "Code-level method call sequence.";
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

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

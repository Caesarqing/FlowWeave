import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS,
  ARCHITECTURE_REVIEW_PROMPT_TARGET_CHARS,
  buildArchitectureReviewPrompt,
  type ArchitectureReviewPromptInput,
  type ArchitectureReviewPromptEvidence
} from "../src/main/services/architecture-review-prompt.service";
import {
  SEQUENCE_DIAGRAM_PROMPT_TARGET_CHARS,
  SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS,
  buildSequenceDiagramPrompt
} from "../src/main/services/sequence-diagram.service";
import { buildSemanticIndex } from "../src/main/services/semantic-index.service";
import { scanProject } from "../src/main/services/project-scanner.service";
import type { ArchitectureModule, ArchitectureRelationship, SequenceDiagram } from "../src/types";

const FILE_COUNTS = [1_000, 5_000, 10_000];
const NODE_COUNTS = [100, 500, 1_000];
const SCAN_COLD_ITERATIONS = 5;
const WARM_ITERATIONS = 20;
const REFERENCE_INDEX_FILES = 250;
const WRITE_CONCURRENCY = 64;

type BenchmarkResult = {
  scenario: string;
  size: number;
  iterations: number;
  p50Ms: number;
  p95Ms: number;
  nodesBefore: number;
  nodesAfter: number;
  edgesBefore: number;
  edgesAfter: number;
  threshold: string;
  promptChars?: number;
  promptCoreChars?: number;
  promptEvidenceChars?: number;
  promptEvidenceCount?: number;
  promptEvidenceOmittedCount?: number;
  promptEvidenceTruncatedCount?: number;
  promptParticipantCount?: number;
  promptMessageCount?: number;
  promptMessageOmittedCount?: number;
  promptEvidenceInputCount?: number;
  promptEvidenceCoveredModuleCount?: number;
  promptModuleWithoutSourceEvidenceCount?: number;
};

const temporaryRoot = await mkdtemp(join(tmpdir(), "flowweave-benchmark-"));
const results: BenchmarkResult[] = [];

try {
  await benchmarkProjectScanning(temporaryRoot, results);
  const reference = await benchmarkSemanticIndex(temporaryRoot, results);
  benchmarkPromptConstruction(results);
  benchmarkSequencePromptConstruction(results);
  await benchmarkLayout(results);
  assertCacheImprovement(reference.coldDurations, reference.warmDurations, reference.size, results);
  reportLocalReadyReference(reference.localReadyColdDurations, reference.localReadyWarmDurations, reference.edgeCount, results);
  assertAllGraphCounts(results);

  console.table(results.map((result) => ({
    ...result,
    p50Ms: Number(result.p50Ms.toFixed(1)),
    p95Ms: Number(result.p95Ms.toFixed(1))
  })));
  console.log("Local-ready reference includes project scan and semantic index; graph clustering and renderer work are not measured.");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

async function benchmarkProjectScanning(root: string, output: BenchmarkResult[]): Promise<void> {
  for (const count of FILE_COUNTS) {
    const coldDurations: number[] = [];
    for (let iteration = 0; iteration < SCAN_COLD_ITERATIONS; iteration += 1) {
      const projectRoot = await mkdtemp(join(root, `scan-cold-${count}-`));
      await createTextFiles(projectRoot, count);
      const startedAt = performance.now();
      let project: Awaited<ReturnType<typeof scanProject>>;
      try {
        project = await scanProject(projectRoot);
      } catch (error) {
        coldDurations.push(performance.now() - startedAt);
        const row = resultRow("project-scan-cold", count, coldDurations, count, 0, 0, 0, `exactly ${count} files`);
        throwGateFailure(row, errorMessage(error), "successful scan", `cold scan iteration ${iteration + 1} failed`);
      }
      coldDurations.push(performance.now() - startedAt);
      assertExactFileCount("project-scan-cold", count, iteration + 1, coldDurations, project.summary.totalFiles);
    }
    output.push(resultRow("project-scan-cold", count, coldDurations, count, count, 0, 0, "report only"));

    const warmRoot = await mkdtemp(join(root, `scan-warm-${count}-`));
    await createTextFiles(warmRoot, count);
    const warmDurations: number[] = [];
    for (let iteration = 0; iteration < WARM_ITERATIONS; iteration += 1) {
      const startedAt = performance.now();
      let project: Awaited<ReturnType<typeof scanProject>>;
      try {
        project = await scanProject(warmRoot);
      } catch (error) {
        warmDurations.push(performance.now() - startedAt);
        const row = resultRow("project-scan-warm", count, warmDurations, count, 0, 0, 0, `exactly ${count} files`);
        throwGateFailure(row, errorMessage(error), "successful scan", `warm scan iteration ${iteration + 1} failed`);
      }
      warmDurations.push(performance.now() - startedAt);
      assertExactFileCount("project-scan-warm", count, iteration + 1, warmDurations, project.summary.totalFiles);
    }
    output.push(resultRow("project-scan-warm", count, warmDurations, count, count, 0, 0, "report only"));
  }
}

async function benchmarkSemanticIndex(
  root: string,
  output: BenchmarkResult[]
): Promise<{
  size: number;
  coldDurations: number[];
  warmDurations: number[];
  edgeCount: number;
  localReadyColdDurations: number[];
  localReadyWarmDurations: number[];
}> {
  const coldDurations: number[] = [];
  const localReadyColdDurations: number[] = [];
  let expectedEdgeCount: number | undefined;
  for (let iteration = 0; iteration < SCAN_COLD_ITERATIONS; iteration += 1) {
    const projectRoot = await mkdtemp(join(root, `index-cold-${REFERENCE_INDEX_FILES}-`));
    await createCodeFiles(projectRoot, REFERENCE_INDEX_FILES);
    const localReadyStartedAt = performance.now();
    let project: Awaited<ReturnType<typeof scanProject>>;
    try {
      project = await scanProject(projectRoot);
    } catch (error) {
      localReadyColdDurations.push(performance.now() - localReadyStartedAt);
      const row = resultRow("local-ready-reference-cold", REFERENCE_INDEX_FILES, localReadyColdDurations, REFERENCE_INDEX_FILES, 0, expectedEdgeCount ?? 0, 0, "successful scan and index");
      throwGateFailure(row, errorMessage(error), "successful project scan", `cold local-ready iteration ${iteration + 1} failed`);
    }
    const indexStartedAt = performance.now();
    let index: Awaited<ReturnType<typeof buildSemanticIndex>>["index"];
    try {
      ({ index } = await buildSemanticIndex(project));
    } catch (error) {
      const duration = performance.now() - indexStartedAt;
      coldDurations.push(duration);
      const row = resultRow("semantic-index-cold", REFERENCE_INDEX_FILES, coldDurations, REFERENCE_INDEX_FILES, 0, expectedEdgeCount ?? 0, 0, "successful cold index build");
      throwGateFailure(row, errorMessage(error), "successful index build", `cold index iteration ${iteration + 1} failed`);
    }
    const indexDuration = performance.now() - indexStartedAt;
    localReadyColdDurations.push(performance.now() - localReadyStartedAt);
    coldDurations.push(indexDuration);
    assertIndexCounts("semantic-index-cold", REFERENCE_INDEX_FILES, iteration + 1, coldDurations, index);
    expectedEdgeCount ??= index.relations.length;
    if (index.relations.length !== expectedEdgeCount) {
      const row = resultRow("semantic-index-cold", REFERENCE_INDEX_FILES, coldDurations, REFERENCE_INDEX_FILES, REFERENCE_INDEX_FILES, expectedEdgeCount, index.relations.length, "unchanged graph counts");
      throwGateFailure(row, index.relations.length, expectedEdgeCount, "cold independent roots produced different relation counts");
    }
  }
  output.push(resultRow("semantic-index-cold", REFERENCE_INDEX_FILES, coldDurations, REFERENCE_INDEX_FILES, REFERENCE_INDEX_FILES, expectedEdgeCount ?? 0, expectedEdgeCount ?? 0, "5 independent roots"));

  const warmRoot = await mkdtemp(join(root, `index-warm-${REFERENCE_INDEX_FILES}-`));
  await createCodeFiles(warmRoot, REFERENCE_INDEX_FILES);
  let warmProject: Awaited<ReturnType<typeof scanProject>>;
  try {
    warmProject = await scanProject(warmRoot);
  } catch (error) {
    const row = resultRow("local-ready-reference-warm", REFERENCE_INDEX_FILES, [0], REFERENCE_INDEX_FILES, 0, expectedEdgeCount ?? 0, 0, "successful scan and index");
    throwGateFailure(row, errorMessage(error), "successful project scan", "warm reference project scan failed");
  }
  const coldStartedAt = performance.now();
  let coldWarmRoot: Awaited<ReturnType<typeof buildSemanticIndex>>;
  try {
    coldWarmRoot = await buildSemanticIndex(warmProject);
  } catch (error) {
    const duration = performance.now() - coldStartedAt;
    const row = resultRow("semantic-index-cold", REFERENCE_INDEX_FILES, [...coldDurations, duration], REFERENCE_INDEX_FILES, 0, expectedEdgeCount ?? 0, 0, "successful cold index build");
    throwGateFailure(row, errorMessage(error), "successful index build", "warm reference cold index setup failed");
  }
  const warmRootColdDuration = performance.now() - coldStartedAt;
  assertIndexCounts("semantic-index-reference-cold", REFERENCE_INDEX_FILES, 1, [warmRootColdDuration], coldWarmRoot.index);
  const warmDurations: number[] = [];
  const localReadyWarmDurations: number[] = [];
  for (let iteration = 0; iteration < WARM_ITERATIONS; iteration += 1) {
    const localReadyStartedAt = performance.now();
    let project: Awaited<ReturnType<typeof scanProject>>;
    try {
      project = await scanProject(warmRoot);
    } catch (error) {
      localReadyWarmDurations.push(performance.now() - localReadyStartedAt);
      const row = resultRow("local-ready-reference-warm", REFERENCE_INDEX_FILES, localReadyWarmDurations, REFERENCE_INDEX_FILES, 0, expectedEdgeCount ?? 0, 0, "successful scan and warm index");
      throwGateFailure(row, errorMessage(error), "successful project scan", `warm local-ready iteration ${iteration + 1} failed`);
    }
    const indexStartedAt = performance.now();
    let index: Awaited<ReturnType<typeof buildSemanticIndex>>["index"];
    try {
      ({ index } = await buildSemanticIndex(project));
    } catch (error) {
      const duration = performance.now() - indexStartedAt;
      warmDurations.push(duration);
      const row = resultRow("semantic-index-warm", REFERENCE_INDEX_FILES, warmDurations, REFERENCE_INDEX_FILES, 0, expectedEdgeCount ?? 0, 0, "successful warm index build");
      throwGateFailure(row, errorMessage(error), "successful index build", `warm index iteration ${iteration + 1} failed`);
    }
    const indexDuration = performance.now() - indexStartedAt;
    warmDurations.push(indexDuration);
    localReadyWarmDurations.push(performance.now() - localReadyStartedAt);
    assertIndexCounts("semantic-index-warm", REFERENCE_INDEX_FILES, iteration + 1, warmDurations, index);
    if (index.relations.length !== expectedEdgeCount) {
      const row = resultRow("semantic-index-warm", REFERENCE_INDEX_FILES, warmDurations, REFERENCE_INDEX_FILES, REFERENCE_INDEX_FILES, expectedEdgeCount ?? 0, index.relations.length, "unchanged graph counts");
      throwGateFailure(row, index.relations.length, expectedEdgeCount ?? 0, "warm index changed semantic relation count");
    }
  }
  output.push(resultRow("semantic-index-warm", REFERENCE_INDEX_FILES, warmDurations, REFERENCE_INDEX_FILES, REFERENCE_INDEX_FILES, expectedEdgeCount ?? 0, expectedEdgeCount ?? 0, "20 warm iterations"));

  return {
    size: REFERENCE_INDEX_FILES,
    coldDurations,
    warmDurations,
    edgeCount: expectedEdgeCount ?? 0,
    localReadyColdDurations,
    localReadyWarmDurations
  };
}

function benchmarkPromptConstruction(output: BenchmarkResult[]): void {
  const input = promptFixture(40, 8);
  const durations: number[] = [];
  let nodeCount = 0;
  let edgeCount = 0;
  let promptChars = 0;
  let promptCoreChars = 0;
  let promptEvidenceChars = 0;
  let promptEvidenceCount = 0;
  let promptEvidenceOmittedCount = 0;
  let promptEvidenceTruncatedCount = 0;
  let promptEvidenceCoveredModuleCount = 0;
  let promptModuleWithoutSourceEvidenceCount = 0;
  const sourceBackedModuleCount = new Set(input.evidence
    .filter((item) => !item.relationshipId)
    .flatMap((item) => item.moduleIds)).size;
  for (let iteration = 0; iteration < WARM_ITERATIONS; iteration += 1) {
    const startedAt = performance.now();
    let prompt: ReturnType<typeof buildArchitectureReviewPrompt>;
    try {
      prompt = buildArchitectureReviewPrompt(input);
    } catch (error) {
      durations.push(performance.now() - startedAt);
      const row = resultRow("module-graph-prompt-build", 250, durations, input.modules.length, 0, input.relationships.length, 0, `<= ${ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS} chars`);
      throwGateFailure(row, errorMessage(error), `<= ${ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS} chars`, "prompt build failed");
    }
    durations.push(performance.now() - startedAt);
    nodeCount = prompt.metrics.promptModuleCount;
    edgeCount = prompt.metrics.promptEdgeCount;
    promptChars = prompt.metrics.promptChars;
    promptCoreChars = prompt.metrics.promptCoreChars;
    promptEvidenceChars = prompt.metrics.promptEvidenceChars;
    promptEvidenceCount = prompt.metrics.promptEvidenceCount;
    promptEvidenceOmittedCount = prompt.metrics.promptEvidenceOmittedCount;
    promptEvidenceTruncatedCount = prompt.metrics.promptEvidenceTruncatedCount;
    promptEvidenceCoveredModuleCount = prompt.metrics.promptEvidenceCoveredModuleCount;
    promptModuleWithoutSourceEvidenceCount = prompt.metrics.promptModuleWithoutSourceEvidenceCount;
    if (promptChars > ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS) {
      const row = resultRow("module-graph-prompt-build", input.modules.length, durations, input.modules.length, nodeCount, input.relationships.length, edgeCount, `<= ${ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS} chars`);
      throwGateFailure(row, promptChars, ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS, "prompt character budget exceeded");
    }
    if (promptEvidenceCoveredModuleCount !== sourceBackedModuleCount) {
      const row = resultRow("module-graph-prompt-build", promptChars, durations, input.modules.length, nodeCount, input.relationships.length, edgeCount, `all ${sourceBackedModuleCount} source-backed modules covered`);
      throwGateFailure(row, promptEvidenceCoveredModuleCount, sourceBackedModuleCount, "source-backed module evidence coverage is incomplete");
    }
  }
  output.push({
    ...resultRow("module-graph-prompt-build", promptChars, durations, input.modules.length, nodeCount, input.relationships.length, edgeCount, `<= ${ARCHITECTURE_REVIEW_PROMPT_MAX_CHARS} chars; target <= ${ARCHITECTURE_REVIEW_PROMPT_TARGET_CHARS}`),
    promptChars,
    promptCoreChars,
    promptEvidenceChars,
    promptEvidenceCount,
    promptEvidenceOmittedCount,
    promptEvidenceTruncatedCount,
    promptEvidenceCoveredModuleCount,
    promptModuleWithoutSourceEvidenceCount
  });
}

function benchmarkSequencePromptConstruction(output: BenchmarkResult[]): void {
  const diagram = sequencePromptFixture();
  const durations: number[] = [];
  let prompt: ReturnType<typeof buildSequenceDiagramPrompt>;
  for (let iteration = 0; iteration < WARM_ITERATIONS; iteration += 1) {
    const startedAt = performance.now();
    try {
      prompt = buildSequenceDiagramPrompt("250-file-benchmark-reference", diagram);
    } catch (error) {
      durations.push(performance.now() - startedAt);
      const row = resultRow("sequence-diagram-prompt-build", 250, durations, diagram.participants.length, 0, diagram.messages.length, 0, `<= ${SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS} chars`);
      throwGateFailure(row, errorMessage(error), `<= ${SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS} chars`, "sequence diagram prompt build failed");
    }
    durations.push(performance.now() - startedAt);
    if (prompt.metrics.promptChars > SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS) {
      const row = resultRow("sequence-diagram-prompt-build", 250, durations, diagram.participants.length, prompt.metrics.promptParticipantCount, diagram.messages.length, prompt.metrics.promptMessageCount, `<= ${SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS} chars`);
      throwGateFailure(row, prompt.metrics.promptChars, SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS, "sequence prompt character budget exceeded");
    }
  }
  output.push({
    ...resultRow("sequence-diagram-prompt-build", prompt.metrics.promptChars, durations, diagram.participants.length, prompt.metrics.promptParticipantCount, diagram.messages.length, prompt.metrics.promptMessageCount, `<= ${SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS} chars; target <= ${SEQUENCE_DIAGRAM_PROMPT_TARGET_CHARS}`),
    promptChars: prompt.metrics.promptChars,
    promptCoreChars: prompt.metrics.promptCoreChars,
    promptEvidenceChars: prompt.metrics.promptEvidenceChars,
    promptEvidenceCount: prompt.metrics.promptEvidenceCount,
    promptEvidenceOmittedCount: prompt.metrics.promptEvidenceOmittedCount,
    promptEvidenceTruncatedCount: prompt.metrics.promptEvidenceTruncatedCount,
    promptParticipantCount: prompt.metrics.promptParticipantCount,
    promptMessageCount: prompt.metrics.promptMessageCount,
    promptMessageOmittedCount: prompt.metrics.promptMessageOmittedCount,
    promptEvidenceInputCount: prompt.metrics.promptEvidenceCount + prompt.metrics.promptEvidenceOmittedCount
  });
  benchmarkMaxEvidenceSequencePromptConstruction(output);
}

function benchmarkMaxEvidenceSequencePromptConstruction(output: BenchmarkResult[]): void {
  const diagram = maxEvidenceSequencePromptFixture();
  const inputEvidenceCount = diagram.messages.reduce((count, message) => count + (message.evidence?.length ?? 0), 0) + diagram.evidence.length;
  const durations: number[] = [];
  let expectedText: string | undefined;
  let prompt: ReturnType<typeof buildSequenceDiagramPrompt>;
  for (let iteration = 0; iteration < WARM_ITERATIONS; iteration += 1) {
    const startedAt = performance.now();
    try {
      prompt = buildSequenceDiagramPrompt("sequence-max-evidence-benchmark", diagram);
    } catch (error) {
      durations.push(performance.now() - startedAt);
      const row = resultRow("sequence-diagram-prompt-build-max-evidence", inputEvidenceCount, durations, diagram.participants.length, 0, diagram.messages.length, 0, `<= ${SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS} chars`);
      throwGateFailure(row, errorMessage(error), `<= ${SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS} chars`, "maximum evidence sequence prompt build failed");
    }
    durations.push(performance.now() - startedAt);
    if (expectedText === undefined) expectedText = prompt.text;
    if (prompt.text !== expectedText) {
      const row = resultRow("sequence-diagram-prompt-build-max-evidence", inputEvidenceCount, durations, diagram.participants.length, prompt.metrics.promptParticipantCount, diagram.messages.length, prompt.metrics.promptMessageCount, "identical prompt across iterations");
      throwGateFailure(row, "non-deterministic prompt", "identical prompt across iterations", "maximum evidence prompt changed between iterations");
    }
    if (prompt.metrics.promptChars > SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS) {
      const row = resultRow("sequence-diagram-prompt-build-max-evidence", inputEvidenceCount, durations, diagram.participants.length, prompt.metrics.promptParticipantCount, diagram.messages.length, prompt.metrics.promptMessageCount, `<= ${SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS} chars`);
      throwGateFailure(row, prompt.metrics.promptChars, SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS, "maximum evidence sequence prompt exceeded its character budget");
    }
  }

  const compactInput = parseSequencePromptInput(prompt.text);
  const validMessageReferences = compactInput.messages.every((message) => {
    const references = message.at(-1);
    return Array.isArray(references) && references.length > 0 && references.every((index) =>
      typeof index === "number" && Number.isInteger(index) && index >= 0 && index < compactInput.evidence.length
    );
  });
  const row = resultRow(
    "sequence-diagram-prompt-build-max-evidence",
    inputEvidenceCount,
    durations,
    diagram.participants.length,
    prompt.metrics.promptParticipantCount,
    diagram.messages.length,
    prompt.metrics.promptMessageCount,
    `<= ${SEQUENCE_DIAGRAM_PROMPT_MAX_CHARS} chars; all ${diagram.messages.length} message evidence references valid`
  );
  if (prompt.metrics.promptChars <= SEQUENCE_DIAGRAM_PROMPT_TARGET_CHARS) {
    throwGateFailure(
      row,
      prompt.metrics.promptChars,
      `> ${SEQUENCE_DIAGRAM_PROMPT_TARGET_CHARS} chars`,
      "maximum evidence sequence fixture did not exercise the soft-target overflow path"
    );
  }
  if (!validMessageReferences || prompt.metrics.promptMessageOmittedCount !== 0) {
    throwGateFailure(row, `${prompt.metrics.promptMessageCount} messages with valid references`, `${diagram.messages.length} messages`, "maximum evidence sequence prompt lost message evidence");
  }
  if (prompt.metrics.promptEvidenceCount + prompt.metrics.promptEvidenceOmittedCount !== inputEvidenceCount) {
    throwGateFailure(row, prompt.metrics.promptEvidenceCount + prompt.metrics.promptEvidenceOmittedCount, inputEvidenceCount, "maximum evidence sequence prompt reported an inconsistent evidence count");
  }
  output.push({
    ...row,
    promptChars: prompt.metrics.promptChars,
    promptCoreChars: prompt.metrics.promptCoreChars,
    promptEvidenceChars: prompt.metrics.promptEvidenceChars,
    promptEvidenceCount: prompt.metrics.promptEvidenceCount,
    promptEvidenceOmittedCount: prompt.metrics.promptEvidenceOmittedCount,
    promptEvidenceTruncatedCount: prompt.metrics.promptEvidenceTruncatedCount,
    promptParticipantCount: prompt.metrics.promptParticipantCount,
    promptMessageCount: prompt.metrics.promptMessageCount,
    promptMessageOmittedCount: prompt.metrics.promptMessageOmittedCount,
    promptEvidenceInputCount: inputEvidenceCount
  });
}

function sequencePromptFixture(): SequenceDiagram {
  const participants = Array.from({ length: 14 }, (_, index) => ({
    id: `module-${index}`,
    title: `Module ${index}`,
    kind: "service" as const,
    description: `Handles benchmark workflow stage ${index}.`,
    filePath: `src/module-${index}.ts`,
    symbol: `Module${index}`
  }));
  const messages = Array.from({ length: 24 }, (_, index) => ({
    id: `message-${index}`,
    sequence: index + 1,
    from: participants[index % participants.length].id,
    to: participants[(index + 1) % participants.length].id,
    kind: "sync" as const,
    label: `Run stage ${index}`,
    description: `Passes the request through stage ${index}.`,
    methodName: `runStage${index}`,
    input: `Input${index}`,
    output: `Output${index}`,
    evidence: [{ filePath: `src/module-${index % participants.length}.ts`, symbol: `Module${index % participants.length}`, detail: `Stage ${index} delegates to the next module using the scanned call relationship.` }]
  }));
  return {
    id: "architectural-sequence",
    title: "Architectural Sequence Diagram",
    kind: "architectural",
    summary: "Benchmark request flow across service boundaries.",
    participants,
    messages,
    evidence: [{ filePath: "src/module-0.ts", symbol: "Module0", detail: "The entry point begins the benchmark flow." }]
  };
}

function maxEvidenceSequencePromptFixture(): SequenceDiagram {
  const participants = Array.from({ length: 14 }, (_, index) => ({
    id: `module-${index}`,
    title: `Module ${index}`,
    kind: "service" as const,
    description: `Handles benchmark workflow stage ${index}.`,
    filePath: `src/module-${index}.ts`,
    symbol: `Module${index}`
  }));
  const messages = Array.from({ length: 40 }, (_, messageIndex) => ({
    id: `message-${messageIndex}`,
    sequence: messageIndex + 1,
    from: participants[messageIndex % participants.length].id,
    to: participants[(messageIndex + 1) % participants.length].id,
    kind: "sync" as const,
    label: `Run stage ${messageIndex}`,
      description: `Routes stage ${messageIndex} through the next service ${"d".repeat(20)}.`,
    evidence: Array.from({ length: 30 }, (_, evidenceIndex) => ({
      filePath: `src/stages/${messageIndex}/evidence-${evidenceIndex}.ts`,
      symbol: `stage${messageIndex}Evidence${evidenceIndex}`,
      detail: `Evidence ${evidenceIndex} supports stage ${messageIndex}.`
    }))
  }));
  return {
    id: "architectural-sequence-max-evidence",
    title: "Architectural Sequence Diagram",
    kind: "architectural",
    summary: "Maximum evidence benchmark across service stages.",
    participants,
    messages,
    evidence: [{ filePath: "src/main.ts", symbol: "main", detail: "The entry point begins the workflow." }]
  };
}

function parseSequencePromptInput(text: string): { messages: unknown[][]; evidence: unknown[] } {
  const input = text.match(/Input: (.+)\n\nReturn shape:/)?.[1];
  if (!input) throw new Error("Sequence prompt is missing its compact Input JSON.");
  const parsed = JSON.parse(input) as { messages?: unknown; evidence?: unknown };
  if (!Array.isArray(parsed.messages) || !Array.isArray(parsed.evidence)) {
    throw new Error("Sequence prompt Input JSON must contain messages and evidence arrays.");
  }
  if (!parsed.messages.every(Array.isArray)) throw new Error("Sequence prompt messages must be compact tuples.");
  return { messages: parsed.messages, evidence: parsed.evidence };
}

async function benchmarkLayout(output: BenchmarkResult[]): Promise<void> {
  const elk = new ELK();
  for (const count of NODE_COUNTS) {
    const edges = Array.from({ length: count - 1 }, (_, index) => ({
      id: `edge-${index}`,
      sources: [`node-${index}`],
      targets: [`node-${index + 1}`]
    }));
    const durations: number[] = [];
    let outputNodes = 0;
    let outputEdges = 0;
    for (let iteration = 0; iteration < WARM_ITERATIONS; iteration += 1) {
      const graph = {
        id: `layout-${count}`,
        layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT" },
        children: Array.from({ length: count }, (_, index) => ({ id: `node-${index}`, width: 280, height: 150 })),
        edges
      };
      const startedAt = performance.now();
      let laidOut: Awaited<ReturnType<typeof elk.layout>>;
      try {
        laidOut = await elk.layout(graph);
      } catch (error) {
        durations.push(performance.now() - startedAt);
        const row = resultRow("layout", count, durations, count, 0, edges.length, 0, "successful layout; node/edge count unchanged");
        throwGateFailure(row, errorMessage(error), "successful layout", `layout iteration ${iteration + 1} failed`);
      }
      durations.push(performance.now() - startedAt);
      outputNodes = laidOut.children?.length ?? 0;
      outputEdges = laidOut.edges?.length ?? 0;
    }
    output.push(resultRow("layout", count, durations, count, outputNodes, edges.length, outputEdges, "node/edge count unchanged"));
  }
}

function assertCacheImprovement(
  coldDurations: number[],
  warmDurations: number[],
  size: number,
  output: BenchmarkResult[]
): void {
  const coldP50 = percentile(coldDurations, 0.5);
  const warmP50 = percentile(warmDurations, 0.5);
  const improvement = 1 - warmP50 / coldP50;
  const row = resultRow(
    "semantic-index-cache-improvement",
    size,
    coldDurations,
    0,
    0,
    0,
    0,
    `required improvement >= 70%; cold ${sampleSummary(coldDurations)}; warm ${sampleSummary(warmDurations)}`
  );
  output.push(row);
  if (improvement < 0.7) {
    throwGateFailure(row, `${(improvement * 100).toFixed(1)}%`, row.threshold, "warm semantic index p50 improvement was below threshold");
  }
}

function sampleSummary(durations: number[]): string {
  return `n=${durations.length} p50=${percentile(durations, 0.5).toFixed(1)} ms p95=${percentile(durations, 0.95).toFixed(1)} ms`;
}

function reportLocalReadyReference(
  coldDurations: number[],
  warmDurations: number[],
  edgeCount: number,
  output: BenchmarkResult[]
): void {
  const cold = resultRow("local-ready-reference-cold", REFERENCE_INDEX_FILES, coldDurations, REFERENCE_INDEX_FILES, REFERENCE_INDEX_FILES, edgeCount, edgeCount, "report only; p95 <= 3000 ms");
  const warm = resultRow("local-ready-reference-warm", REFERENCE_INDEX_FILES, warmDurations, REFERENCE_INDEX_FILES, REFERENCE_INDEX_FILES, edgeCount, edgeCount, "report only; p95 <= 500 ms");
  output.push(cold, warm);
  if (cold.p95Ms > 3_000) console.warn(`Report-only local-ready cold target exceeded: ${formatResult(cold, cold.p95Ms, "<= 3000 ms")}`);
  if (warm.p95Ms > 500) console.warn(`Report-only local-ready warm target exceeded: ${formatResult(warm, warm.p95Ms, "<= 500 ms")}`);
}

function assertAllGraphCounts(results: BenchmarkResult[]): void {
  for (const result of results) {
    if (result.nodesBefore !== result.nodesAfter) {
      throwGateFailure(result, result.nodesAfter, result.nodesBefore, "scenario changed node count");
    }
    if (result.edgesBefore !== result.edgesAfter) {
      throwGateFailure(result, result.edgesAfter, result.edgesBefore, "scenario changed edge count");
    }
  }
}

function assertExactFileCount(
  scenario: string,
  size: number,
  iteration: number,
  durations: number[],
  actualCount: number
): void {
  if (actualCount === size) return;
  const row = resultRow(scenario, size, durations, size, actualCount, 0, 0, `exactly ${size} files`);
  throwGateFailure(row, actualCount, size, `iteration ${iteration} scanned an unexpected number of files`);
}

function assertIndexCounts(
  scenario: string,
  size: number,
  iteration: number,
  durations: number[],
  index: Awaited<ReturnType<typeof buildSemanticIndex>>["index"]
): void {
  if (index.files.length === size) return;
  const row = resultRow(scenario, size, durations, size, index.files.length, 0, index.relations.length, `exactly ${size} indexed files`);
  throwGateFailure(row, index.files.length, size, `iteration ${iteration} indexed an unexpected number of files`);
}

function resultRow(
  scenario: string,
  size: number,
  durations: number[],
  nodesBefore: number,
  nodesAfter: number,
  edgesBefore: number,
  edgesAfter: number,
  threshold: string
): BenchmarkResult {
  return {
    scenario,
    size,
    iterations: durations.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    nodesBefore,
    nodesAfter,
    edgesBefore,
    edgesAfter,
    threshold
  };
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) throw new Error("Cannot calculate a percentile from no benchmark samples.");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

function throwGateFailure(result: BenchmarkResult, actual: string | number, threshold: string | number, reason: string): never {
  throw new Error(`${reason}; ${formatResult(result, actual, threshold)}`);
}

function formatResult(result: BenchmarkResult, actual: string | number, threshold: string | number): string {
  return `scenario=${result.scenario} size=${result.size} iterations=${result.iterations} ` +
    `p50Ms=${result.p50Ms.toFixed(1)} p95Ms=${result.p95Ms.toFixed(1)} actual=${actual} threshold=${threshold}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createTextFiles(projectPath: string, count: number): Promise<void> {
  await mkdir(projectPath, { recursive: true });
  const indexes = Array.from({ length: count }, (_, index) => index);
  await mapWithConcurrency(indexes, WRITE_CONCURRENCY, async (index) => {
    await writeFile(join(projectPath, `fixture-${String(index).padStart(5, "0")}.txt`), `fixture ${index}\n`, "utf8");
  });
}

async function createCodeFiles(projectPath: string, count: number): Promise<void> {
  await mkdir(projectPath, { recursive: true });
  const indexes = Array.from({ length: count }, (_, index) => index);
  await mapWithConcurrency(indexes, WRITE_CONCURRENCY, async (index) => {
    const dependency = index > 0 ? `import { value${index - 1} } from "./module-${String(index - 1).padStart(4, "0")}";\n` : "";
    const expression = index > 0 ? `value${index - 1} + ${index}` : `${index}`;
    await writeFile(
      join(projectPath, `module-${String(index).padStart(4, "0")}.ts`),
      `${dependency}export const value${index} = ${expression};\n`,
      "utf8"
    );
  });
}

function promptFixture(moduleCount: number, evidencePerModule: number): ArchitectureReviewPromptInput {
  const modules = Array.from({ length: moduleCount }, (_, index) => benchmarkModule(index, moduleCount));
  const relationships = Array.from({ length: moduleCount * 2 }, (_, index) => benchmarkRelationship(index, moduleCount));
  const evidence = modules.flatMap((module, index) => Array.from({ length: evidencePerModule }, (_, evidenceIndex) => ({
    id: `benchmark-evidence-${String(index).padStart(3, "0")}-${String(evidenceIndex).padStart(2, "0")}`,
    moduleIds: [module.id],
    filePath: module.files[evidenceIndex % module.files.length],
    symbol: module.symbols[evidenceIndex % module.symbols.length].name,
    detail: `Representative behavior ${evidenceIndex} from ${module.id}.`,
    severity: evidenceIndex === 0 ? "warning" as const : "info" as const,
    confidence: evidenceIndex < 2 ? "confirmed" as const : "inferred" as const
  } satisfies ArchitectureReviewPromptEvidence)));
  return { projectName: "250-file-benchmark-reference", modules, relationships, evidence };
}

function benchmarkModule(index: number, moduleCount: number): ArchitectureModule {
  const id = `service-module-${String(index).padStart(3, "0")}`;
  const fileCount = moduleCount === 40 && index < 10 ? 7 : 6;
  const files = Array.from({ length: fileCount }, (_, fileIndex) => `src/features/feature-${index}/part-${fileIndex}.ts`);
  const symbols = Array.from({ length: 5 }, (_, symbolIndex) => ({
    name: `feature${index}Function${symbolIndex}`,
    kind: "function" as const,
    filePath: files[symbolIndex % files.length]
  }));
  return {
    id,
    title: `Feature Service ${index}`,
    category: "domain-service",
    nodeType: "service",
    role: `Coordinates feature workflow ${index}.`,
    description: `Local architecture summary for feature workflow ${index}.`,
    files,
    fileRoles: [],
    symbols,
    evidence: [],
    risk: "unknown"
  };
}

function benchmarkRelationship(index: number, moduleCount: number): ArchitectureRelationship {
  const sourceIndex = index % moduleCount;
  const targetIndex = (sourceIndex + 1) % moduleCount;
  return {
    id: `edge-${String(index).padStart(3, "0")}`,
    source: `service-module-${String(sourceIndex).padStart(3, "0")}`,
    target: `service-module-${String(targetIndex).padStart(3, "0")}`,
    relation: "calls",
    description: "The source module calls the target module.",
    evidence: []
  };
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
}

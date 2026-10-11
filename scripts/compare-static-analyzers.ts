import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type FileScopeEntry = {
  fileId: string;
  path: string;
  contentSha256: string;
};

export type AnalyzerDependencyIdentity = {
  name: string;
  version: string;
};

/** Stable cross-tool relation target; symbol/external names must be trimmed NFC strings. */
export type AnalyzerTargetIdentity =
  | { kind: "file"; fileId: string }
  | { kind: "symbol"; fileId: string; identity: string }
  | { kind: "external"; identity: string }
  | { kind: "unresolved"; identity: string };

export type AnalyzerIdentity = {
  sourceManifestSha256: string;
  comparisonConfigSha256: string;
  analyzerConfigSha256: string;
  tool: { name: string; version: string };
  dependencies: AnalyzerDependencyIdentity[];
};

export type AnalyzerFact =
  | { factId: string; fileId: string; kind: "dependency"; targetIdentity?: AnalyzerTargetIdentity }
  | { factId: string; fileId: string; kind: "call"; confidence: "confirmed" | "inferred"; targetIdentity?: AnalyzerTargetIdentity };

export type AnalyzerEvidenceSet = {
  identity: AnalyzerIdentity;
  fileScope: FileScopeEntry[];
  facts: AnalyzerFact[];
};

export type LabeledEvidenceFact = {
  factId: string;
  fileId: string;
  kind: "dependency" | "confirmed-call";
  status: "present" | "absent" | "ambiguous";
  targetIdentity?: AnalyzerTargetIdentity;
};

export type LabeledEvidenceSet = {
  identity: {
    sourceManifestSha256: string;
    comparisonConfigSha256: string;
    labelSetSha256: string;
  };
  fileScope: FileScopeEntry[];
  facts: LabeledEvidenceFact[];
};

export type AnalyzerCategoryMetrics = {
  labeledFactCount: number;
  labeledPositiveCount: number;
  labeledNegativeCount: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
};

export type AnalyzerComparison = {
  schemaVersion: 1;
  identities: {
    sourceManifestSha256: string;
    comparisonConfigSha256: string;
    labelSetSha256: string;
    baseline: AnalyzerIdentity;
    candidate: AnalyzerIdentity;
  };
  baseline: { dependencies: AnalyzerCategoryMetrics; confirmedCalls: AnalyzerCategoryMetrics };
  candidate: { dependencies: AnalyzerCategoryMetrics; confirmedCalls: AnalyzerCategoryMetrics };
};

type ComparisonCategory = "dependency" | "confirmed-call";
type CliOptions = { baseline: string; candidate: string; labels: string; out: string };

/** Compare two analyzer runs against the same, explicitly labeled source facts. */
export function compareAnalyzerResults(baseline: AnalyzerEvidenceSet, candidate: AnalyzerEvidenceSet, labels: LabeledEvidenceSet): AnalyzerComparison {
  validateEvidenceSet(baseline, "baseline");
  validateEvidenceSet(candidate, "candidate");
  validateLabeledEvidenceSet(labels);

  const sourceManifestSha256 = labels.identity.sourceManifestSha256;
  const comparisonConfigSha256 = labels.identity.comparisonConfigSha256;
  assertSameScope(baseline.fileScope, candidate.fileScope, "baseline", "candidate");
  assertSameScope(baseline.fileScope, labels.fileScope, "baseline", "labels");
  assertEqual(baseline.identity.sourceManifestSha256, sourceManifestSha256, "baseline source manifest does not match labels");
  assertEqual(candidate.identity.sourceManifestSha256, sourceManifestSha256, "candidate source manifest does not match labels");
  assertEqual(baseline.identity.comparisonConfigSha256, comparisonConfigSha256, "baseline comparison config does not match labels");
  assertEqual(candidate.identity.comparisonConfigSha256, comparisonConfigSha256, "candidate comparison config does not match labels");

  const labelsById = new Map(labels.facts.map((fact) => [fact.factId, fact]));
  assertFactsHaveLabels(baseline, labelsById, "baseline");
  assertFactsHaveLabels(candidate, labelsById, "candidate");
  assertSharedFactIdentities(baseline.facts, candidate.facts);

  return {
    schemaVersion: 1,
    identities: {
      sourceManifestSha256,
      comparisonConfigSha256,
      labelSetSha256: labels.identity.labelSetSha256,
      baseline: copyIdentity(baseline.identity),
      candidate: copyIdentity(candidate.identity)
    },
    baseline: {
      dependencies: scoreCategory(baseline.facts, labels.facts, "dependency"),
      confirmedCalls: scoreCategory(baseline.facts, labels.facts, "confirmed-call")
    },
    candidate: {
      dependencies: scoreCategory(candidate.facts, labels.facts, "dependency"),
      confirmedCalls: scoreCategory(candidate.facts, labels.facts, "confirmed-call")
    }
  };
}

/** Compute the deterministic source identity expected in each run manifest. */
export function createSourceManifestSha256(fileScope: FileScopeEntry[]): string {
  return hashJson(canonicalFileScope(fileScope));
}

/** Compute the deterministic label identity expected in a label manifest. */
export function createLabelSetSha256(facts: LabeledEvidenceFact[]): string {
  return hashJson(canonicalLabeledFacts(facts));
}

function validateEvidenceSet(value: unknown, label: string): asserts value is AnalyzerEvidenceSet {
  if (!isRecord(value) || !isRecord(value.identity) || !Array.isArray(value.fileScope) || !Array.isArray(value.facts)) {
    throw new Error(`${label} analyzer evidence must contain identity, fileScope, and facts.`);
  }
  const identity = value.identity;
  assertSha256(identity.sourceManifestSha256, `${label} source manifest SHA-256`);
  assertSha256(identity.comparisonConfigSha256, `${label} comparison config SHA-256`);
  assertSha256(identity.analyzerConfigSha256, `${label} analyzer config SHA-256`);
  validateTool(identity.tool, label);
  validateDependencies(identity.dependencies, label);
  validateFileScope(value.fileScope, label);
  const expectedSourceHash = createSourceManifestSha256(value.fileScope as FileScopeEntry[]);
  assertEqual(identity.sourceManifestSha256, expectedSourceHash, `${label} source manifest SHA-256 does not match its file scope`);
  validateAnalyzerFacts(value.facts, value.fileScope as FileScopeEntry[], label);
}

function validateLabeledEvidenceSet(value: unknown): asserts value is LabeledEvidenceSet {
  if (!isRecord(value) || !isRecord(value.identity) || !Array.isArray(value.fileScope) || !Array.isArray(value.facts)) {
    throw new Error("Labeled evidence must contain identity, fileScope, and facts.");
  }
  const identity = value.identity;
  assertSha256(identity.sourceManifestSha256, "label source manifest SHA-256");
  assertSha256(identity.comparisonConfigSha256, "label comparison config SHA-256");
  assertSha256(identity.labelSetSha256, "label set SHA-256");
  validateFileScope(value.fileScope, "labels");
  const expectedSourceHash = createSourceManifestSha256(value.fileScope as FileScopeEntry[]);
  assertEqual(identity.sourceManifestSha256, expectedSourceHash, "label source manifest SHA-256 does not match its file scope");
  if (value.facts.length === 0) throw new Error("Label evidence contains no labeled facts.");
  validateLabeledFacts(value.facts, value.fileScope as FileScopeEntry[]);
  const expectedLabelHash = createLabelSetSha256(value.facts as LabeledEvidenceFact[]);
  assertEqual(identity.labelSetSha256, expectedLabelHash, "label set SHA-256 does not match its facts");
}

function validateTool(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} analyzer tool identity is missing.`);
  validateRequiredText(value.name, `${label} tool name`);
  validateExactVersion(value.version, `${label} tool version`);
}

function validateDependencies(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label} dependency identities must be an array, even when empty.`);
  const names = new Set<string>();
  for (const dependency of value) {
    if (!isRecord(dependency)) throw new Error(`${label} dependency identity must contain a package name and exact version.`);
    validateRequiredText(dependency.name, `${label} dependency name`);
    validateExactVersion(dependency.version, `${label} dependency version for ${dependency.name}`);
    if (names.has(dependency.name)) throw new Error(`${label} dependency identity has duplicate package ${dependency.name}.`);
    names.add(dependency.name);
  }
}

function validateFileScope(value: unknown[], label: string): void {
  if (value.length === 0) throw new Error(`${label} file scope is empty.`);
  const fileIds = new Set<string>();
  const paths = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) throw new Error(`${label} file scope entry must contain fileId, path, and content SHA-256.`);
    validateRequiredText(item.fileId, `${label} file ID`);
    validateRequiredText(item.path, `${label} file path`);
    if (isAbsolute(item.path) || item.path.includes("\\") || item.path.split("/").some((part) => part === ".." || part === ".") || posix.normalize(item.path) !== item.path) {
      throw new Error(`${label} file path must be a normalized, relative POSIX path: ${item.path}`);
    }
    assertSha256(item.contentSha256, `${label} content SHA-256 for ${item.path}`);
    if (fileIds.has(item.fileId)) throw new Error(`${label} file scope has duplicate file ID ${item.fileId}.`);
    if (paths.has(item.path)) throw new Error(`${label} file scope has duplicate path ${item.path}.`);
    fileIds.add(item.fileId);
    paths.add(item.path);
  }
}

function validateAnalyzerFacts(value: unknown[], fileScope: FileScopeEntry[], label: string): void {
  const fileIds = new Set(fileScope.map((file) => file.fileId));
  const factIds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) throw new Error(`${label} analyzer fact must identify its file and relation kind.`);
    validateRequiredText(item.factId, `${label} fact ID`);
    validateRequiredText(item.fileId, `${label} fact file ID`);
    if (factIds.has(item.factId)) throw new Error(`${label} analyzer evidence has duplicate fact ID ${item.factId}.`);
    if (!fileIds.has(item.fileId)) throw new Error(`${label} analyzer fact ${item.factId} refers to a file outside its scope.`);
    if (item.targetIdentity !== undefined) validateTargetIdentity(item.targetIdentity, fileIds, `${label} target for fact ${item.factId}`);
    if (item.kind === "dependency") {
      if (item.confidence !== undefined) throw new Error(`${label} dependency fact ${item.factId} cannot carry call confidence.`);
    } else if (item.kind === "call") {
      if (item.confidence !== "confirmed" && item.confidence !== "inferred") throw new Error(`${label} call fact ${item.factId} must identify confirmed or inferred confidence.`);
    } else {
      throw new Error(`${label} analyzer fact ${item.factId} has unsupported kind.`);
    }
    factIds.add(item.factId);
  }
}

function validateLabeledFacts(value: unknown[], fileScope: FileScopeEntry[]): void {
  const fileIds = new Set(fileScope.map((file) => file.fileId));
  const factIds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) throw new Error("Labeled fact must identify its file, category, and status.");
    validateRequiredText(item.factId, "labeled fact ID");
    validateRequiredText(item.fileId, `file ID for labeled fact ${item.factId}`);
    if (factIds.has(item.factId)) throw new Error(`Duplicate labeled fact ID ${item.factId}.`);
    if (!fileIds.has(item.fileId)) throw new Error(`Labeled fact ${item.factId} refers to a file outside the label scope.`);
    if (item.targetIdentity !== undefined) validateTargetIdentity(item.targetIdentity, fileIds, `target for labeled fact ${item.factId}`);
    if (item.kind !== "dependency" && item.kind !== "confirmed-call") throw new Error(`Labeled fact ${item.factId} has unsupported comparison category.`);
    if (item.status !== "present" && item.status !== "absent" && item.status !== "ambiguous") throw new Error(`Labeled fact ${item.factId} has unsupported status.`);
    if (item.status === "ambiguous") throw new Error(`Ambiguous label for fact ${item.factId}; resolve it before comparing analyzers.`);
    factIds.add(item.factId);
  }
}

function validateTargetIdentity(value: unknown, fileIds: Set<string>, label: string): asserts value is AnalyzerTargetIdentity {
  if (!isRecord(value)) throw new Error(`${label} target identity must be a supported object.`);
  const allowedKeys = value.kind === "file" ? ["kind", "fileId"] :
    value.kind === "symbol" ? ["kind", "fileId", "identity"] :
      value.kind === "external" || value.kind === "unresolved" ? ["kind", "identity"] : undefined;
  if (!allowedKeys) throw new Error(`${label} target identity has unsupported kind.`);
  const unsupportedKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unsupportedKey) throw new Error(`${label} target identity has unsupported field ${unsupportedKey}.`);
  if (value.kind === "file") {
    validateRequiredText(value.fileId, `${label} target file ID`);
    if (value.identity !== undefined) throw new Error(`${label} file target identity cannot include a symbol or external identity.`);
    if (!fileIds.has(value.fileId)) throw new Error(`${label} target file ${value.fileId} is outside its hash-bound scope.`);
    return;
  }
  if (value.kind === "symbol") {
    validateRequiredText(value.fileId, `${label} target file ID`);
    if (!fileIds.has(value.fileId)) throw new Error(`${label} target file ${value.fileId} is outside its hash-bound scope.`);
    validateNormalizedTargetName(value.identity, `${label} symbol identity`);
    return;
  }
  if (value.kind === "external" || value.kind === "unresolved") {
    if (value.fileId !== undefined) throw new Error(`${label} ${value.kind} target cannot reference a source file.`);
    validateNormalizedTargetName(value.identity, `${label} ${value.kind} identity`);
    return;
  }
}

function validateNormalizedTargetName(value: unknown, label: string): asserts value is string {
  validateRequiredText(value, label);
  if (value.normalize("NFC") !== value) throw new Error(`${label} must use normalized Unicode (NFC).`);
}

function assertFactsHaveLabels(evidence: AnalyzerEvidenceSet, labelsById: Map<string, LabeledEvidenceFact>, label: string): void {
  for (const fact of evidence.facts) {
    const labeledFact = labelsById.get(fact.factId);
    if (labeledFact === undefined) throw new Error(`${label} fact ${fact.factId} is missing label evidence.`);
    const expectedKind: ComparisonCategory = fact.kind === "dependency" ? "dependency" : "confirmed-call";
    if (labeledFact.fileId !== fact.fileId || labeledFact.kind !== expectedKind ||
      targetIdentityKey(labeledFact.targetIdentity) !== targetIdentityKey(fact.targetIdentity)) {
      throw new Error(`${label} fact ${fact.factId} has a conflicting file, category, or target identity in the labels.`);
    }
  }
}

function assertSharedFactIdentities(baselineFacts: AnalyzerFact[], candidateFacts: AnalyzerFact[]): void {
  const baselineById = new Map(baselineFacts.map((fact) => [fact.factId, fact]));
  for (const candidateFact of candidateFacts) {
    const baselineFact = baselineById.get(candidateFact.factId);
    if (baselineFact === undefined) continue;
    const baselineKind = baselineFact.kind === "dependency" ? "dependency" : "confirmed-call";
    const candidateKind = candidateFact.kind === "dependency" ? "dependency" : "confirmed-call";
    if (baselineFact.fileId !== candidateFact.fileId || baselineKind !== candidateKind ||
      targetIdentityKey(baselineFact.targetIdentity) !== targetIdentityKey(candidateFact.targetIdentity)) {
      throw new Error(`Fact ${candidateFact.factId} has ambiguous file, category, or target identity between baseline and candidate evidence.`);
    }
  }
}

function scoreCategory(facts: AnalyzerFact[], labels: LabeledEvidenceFact[], category: ComparisonCategory): AnalyzerCategoryMetrics {
  const categoryLabels = labels.filter((fact) => fact.kind === category);
  const predictedIds = new Set(facts.filter((fact) => isPredictionForCategory(fact, category)).map((fact) => fact.factId));
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;
  let labeledPositiveCount = 0;
  let labeledNegativeCount = 0;

  for (const fact of categoryLabels) {
    const predicted = predictedIds.has(fact.factId);
    if (fact.status === "present") {
      labeledPositiveCount += 1;
      if (predicted) truePositives += 1;
      else falseNegatives += 1;
    } else {
      labeledNegativeCount += 1;
      if (predicted) falsePositives += 1;
      else trueNegatives += 1;
    }
  }

  const precision = rate(truePositives, truePositives + falsePositives);
  const recall = rate(truePositives, truePositives + falseNegatives);
  const f1 = rate(2 * truePositives, 2 * truePositives + falsePositives + falseNegatives);
  return {
    labeledFactCount: categoryLabels.length,
    labeledPositiveCount,
    labeledNegativeCount,
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    precision,
    recall,
    f1
  };
}

function isPredictionForCategory(fact: AnalyzerFact, category: ComparisonCategory): boolean {
  return category === "dependency" ? fact.kind === "dependency" : fact.kind === "call" && fact.confidence === "confirmed";
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function canonicalFileScope(fileScope: FileScopeEntry[]): FileScopeEntry[] {
  return fileScope.map((file) => ({ fileId: file.fileId, path: file.path, contentSha256: file.contentSha256 })).sort((left, right) => left.fileId.localeCompare(right.fileId));
}

function canonicalLabeledFacts(facts: LabeledEvidenceFact[]): LabeledEvidenceFact[] {
  return facts.map((fact) => ({ factId: fact.factId, fileId: fact.fileId, kind: fact.kind, status: fact.status,
    ...(fact.targetIdentity ? { targetIdentity: canonicalTargetIdentity(fact.targetIdentity) } : {})
  })).sort((left, right) => left.factId.localeCompare(right.factId));
}

function targetIdentityKey(targetIdentity: AnalyzerTargetIdentity | undefined): string | undefined {
  return targetIdentity === undefined ? undefined : JSON.stringify(canonicalTargetIdentity(targetIdentity));
}

function canonicalTargetIdentity(targetIdentity: AnalyzerTargetIdentity): AnalyzerTargetIdentity {
  switch (targetIdentity.kind) {
    case "file": return { kind: "file", fileId: targetIdentity.fileId };
    case "symbol": return { kind: "symbol", fileId: targetIdentity.fileId, identity: targetIdentity.identity };
    case "external": return { kind: "external", identity: targetIdentity.identity };
    case "unresolved": return { kind: "unresolved", identity: targetIdentity.identity };
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function copyIdentity(identity: AnalyzerIdentity): AnalyzerIdentity {
  return {
    sourceManifestSha256: identity.sourceManifestSha256,
    comparisonConfigSha256: identity.comparisonConfigSha256,
    analyzerConfigSha256: identity.analyzerConfigSha256,
    tool: { name: identity.tool.name, version: identity.tool.version },
    dependencies: identity.dependencies.map((dependency) => ({ name: dependency.name, version: dependency.version }))
  };
}

function assertSameScope(left: FileScopeEntry[], right: FileScopeEntry[], leftLabel: string, rightLabel: string): void {
  const leftCanonical = JSON.stringify(canonicalFileScope(left));
  const rightCanonical = JSON.stringify(canonicalFileScope(right));
  if (leftCanonical !== rightCanonical) throw new Error(`${leftLabel} and ${rightLabel} must use the identical file scope and content hashes.`);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} is missing or invalid.`);
}

function validateExactVersion(value: unknown, label: string): void {
  validateRequiredText(value, label);
  const version = value.trim();
  if (/^(latest|unknown|unspecified|\*|x|\^|~|>=|<=|>|<)/i.test(version) ||
    /[|*^~<>]/.test(version) || /(?:^|[.\s])[xX](?:$|[.\s])/.test(version) || /\s+-\s+/.test(version)) {
    throw new Error(`${label} must be an exact, recorded version; received ${value}.`);
  }
}

function validateRequiredText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) throw new Error(`${label} is missing or invalid.`);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCliArgs(args: string[]): CliOptions {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--baseline" && flag !== "--candidate" && flag !== "--labels" && flag !== "--out") throw new Error(`Unknown argument ${flag}. Expected --baseline, --candidate, --labels, and --out.`);
    if (options.has(flag)) throw new Error(`Argument ${flag} must be provided once.`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Argument ${flag} requires a file path.`);
    options.set(flag, value);
    index += 1;
  }
  const baseline = options.get("--baseline");
  const candidate = options.get("--candidate");
  const labels = options.get("--labels");
  const out = options.get("--out");
  if (baseline === undefined || candidate === undefined || labels === undefined || out === undefined) {
    throw new Error("Required arguments: --baseline <json>, --candidate <json>, --labels <json>, --out <json>.");
  }
  return { baseline, candidate, labels, out };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const absolutePath = resolve(filePath);
  const content = await readFile(absolutePath, "utf8");
  try {
    return JSON.parse(content) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse analyzer evidence JSON at ${absolutePath}: ${detail}`);
  }
}

async function runCli(args: string[]): Promise<void> {
  const options = parseCliArgs(args);
  const [baseline, candidate, labels] = await Promise.all([
    readJsonFile(options.baseline),
    readJsonFile(options.candidate),
    readJsonFile(options.labels)
  ]);
  const result = compareAnalyzerResults(baseline as AnalyzerEvidenceSet, candidate as AnalyzerEvidenceSet, labels as LabeledEvidenceSet);
  const outputPath = resolve(options.out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote analyzer comparison evidence to ${outputPath}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Analyzer comparison failed: ${message}\n`);
    process.exitCode = 1;
  });
}

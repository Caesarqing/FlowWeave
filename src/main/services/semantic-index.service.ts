import { createHash } from "node:crypto";

import { dirname, extname, join, sep } from "node:path";
import type {
  CodeflowProject,
  FileInsight,
  AnalysisProgressUpdate,
  ScanDelta,
  SemanticFile,
  SemanticIndex,
  SemanticIndexManifest,
  SemanticIndexManifestEntry,
  SemanticRelation,
  ProjectStructureFacts, ProjectAnalysisContext, SemanticDiagnostic, SemanticOperationFact, StaticAnalysisQuality, StructureSymbol,
  AnalysisLanguage, SemanticAnalysisCapability, SemanticImportUsage, SemanticOperation, SemanticRelationKind, SourceRange
} from "../../types";
import { createSourceSnapshot, type SourceSnapshot } from "./source-snapshot.service";
import type { ArtifactUpdate } from "../storage/flowweave-store";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { readJsonArtifact } from "../storage/artifact-store";
import { flattenProjectFilePaths, resolveProjectImport, resolvePythonProjectImport } from "./project-import-resolver.service";
import { analyzeTypeScriptProject } from "./typescript-semantic.service";
import { analyzeTreeSitterProject } from "./project-language-binding.service";
import { discoverProjectAnalysisContext, isTypeScriptProjectConfiguration } from "./project-analysis-context.service";
import { buildResourceRelations } from "./semantic-resource.service";
import { analyzeSourceFile } from "./language-analyzer.service";
import { buildCrossStackHttpRelations } from "./cross-stack-relation.service";

export const SEMANTIC_INDEX_GENERATOR_VERSION = "5.0.9";
const INDEX_VERSION = 5;
const DEFAULT_PARSE_CONCURRENCY = 8;
const MAX_FILE_BYTES = 220_000;
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".py", ".go", ".java", ".rs", ".php", ".cs"
]);

export type BuildSemanticIndexOptions = {
  concurrency?: number;
  onProgress?: (progress: AnalysisProgressUpdate) => void;
};

export async function buildSemanticIndex(
  project: CodeflowProject,
  options?: BuildSemanticIndexOptions
): Promise<{ index: SemanticIndex; delta: ScanDelta; updates: ArtifactUpdate[]; removedPaths: string[]; snapshot: SourceSnapshot }> {
  const projectPaths = flattenProjectFilePaths(project.files).sort();
  const paths = projectPaths
    .filter((path) => CODE_EXTENSIONS.has(extname(path).toLowerCase()))
    .sort();
  const previousManifest = await readManifest(project.rootPath);
  const previousInputState = previousManifest?.generatorVersion === SEMANTIC_INDEX_GENERATOR_VERSION
    ? previousManifest.inputState
    : undefined;
  const snapshot = createSourceSnapshot(paths.map((path) => join(project.rootPath, path)), previousInputState);
  let context = await discoverProjectAnalysisContext(project.rootPath, projectPaths, snapshot);
  const previousIndex = await readSemanticIndex(project.rootPath);
  const currentInputFingerprint = snapshot.fingerprint();
  const canReuseIndex = Boolean(previousManifest?.inputState && previousManifest.generatorVersion === SEMANTIC_INDEX_GENERATOR_VERSION &&
    previousManifest.scanFingerprint === project.scanFingerprint && previousManifest.configurationFingerprint === currentInputFingerprint &&
    previousIndex?.version === INDEX_VERSION && previousIndex.generatorVersion === SEMANTIC_INDEX_GENERATOR_VERSION &&
    previousIndex.scanFingerprint === project.scanFingerprint && previousIndex.configurationFingerprint === currentInputFingerprint &&
    previousIndex.projectName === project.projectName && previousIndex.rootPath === project.rootPath);
  if (canReuseIndex && previousManifest && previousIndex) {
    const generatedAt = new Date().toISOString();
    const delta = createScanDelta(previousManifest.files, previousManifest.files);
    const index = { ...previousIndex, generatedAt };
    const manifest: SemanticIndexManifest = { ...previousManifest, generatedAt, configurationFingerprint: currentInputFingerprint, inputState: snapshot.inputState() };
    options?.onProgress?.({ stage: "linking", completed: paths.length, total: paths.length, failed: 0, message: "Reusing unchanged project bindings." });
    options?.onProgress?.({ stage: "persisting", completed: paths.length, total: paths.length, failed: 0, message: "Preparing the unchanged semantic index for the generation transaction." });
    return { index, delta, updates: prepareSemanticIndex(project.rootPath, index, manifest), snapshot, removedPaths: [] };
  }
  snapshot.resetForRebuild();
  context = await discoverProjectAnalysisContext(project.rootPath, projectPaths, snapshot);
  const previousByPath = new Map(previousManifest?.files.map((file) => [file.path, file]) ?? []);
  const previousFileByPath = new Map(previousIndex?.files.map((file) => [file.path, file]) ?? []);
  const projectFileSet = new Set(paths);
  const concurrency = normalizeConcurrency(options?.concurrency);
  let completed = 0;
  let failed = 0;
  options?.onProgress?.({
    stage: "hashing",
    completed: 0,
    total: paths.length,
    failed: 0,
    message: `Preparing ${paths.length} source files.`
  });
  const semanticFiles = await mapWithConcurrency(paths, concurrency, async (path) =>
    {
      const file = await buildSemanticFile(project, path,
        previousManifest?.generatorVersion === SEMANTIC_INDEX_GENERATOR_VERSION ? previousByPath.get(path) : undefined,
        previousFileByPath.get(path), snapshot);
      completed += 1;
      if (file?.status === "failed") failed += 1;
      options?.onProgress?.({
        stage: "parsing",
        completed,
        total: paths.length,
        failed,
        message: `Analyzed ${completed} of ${paths.length} source files.`
      });
      return file;
    }
  );
  const files = semanticFiles.filter((file): file is SemanticFile => Boolean(file));
  const manifestEntries = files.map(toManifestEntry);
  const delta = createScanDelta(previousManifest?.files ?? [], manifestEntries);
  options?.onProgress?.({
    stage: "linking", completed: paths.length, total: paths.length, failed,
    message: "Binding project imports, symbols and resources."
  });
  const parsedFiles = files.filter((file) => file.status === "parsed");
  const typeScriptResult = analyzeProjectTypeScript(project, parsedFiles, context, snapshot);
  const languageResult = await analyzeTreeSitterProject(project.rootPath, parsedFiles, context, snapshot);
  const symbolsByFile = new Map([...typeScriptResult.symbolsByFile, ...languageResult.symbolsByFile]);
  const bindingDiagnostics = [...typeScriptResult.diagnostics, ...languageResult.diagnostics];
  const enrichedFiles = files.map((file) => enrichLinkedSymbols(file, symbolsByFile.get(file.path), bindingDiagnostics));
  const operations = [...typeScriptResult.operations, ...languageResult.operations];
  const httpEndpoints = [
    ...enrichedFiles.flatMap((file) => file.httpEndpoints).filter((endpoint) => endpoint.kind === "route"),
    ...operations.flatMap(httpEndpointFromOperation)
  ];
  const importsAndCalls = [...buildSemanticRelations(enrichedFiles, projectFileSet, typeScriptResult.relations), ...typeScriptResult.relations, ...languageResult.relations];
  const resourceResult = buildResourceRelations(operations, importsAndCalls.filter((relation) => relation.kind === "import"));
  const resourceImports = new Map(resourceResult.relations.filter((relation) => relation.kind === "import").map((relation) => [relation.id, relation]));
  const relations = dedupeRelations([
    ...importsAndCalls.map((relation) => resourceImports.get(relation.id) ?? relation),
    ...resourceResult.relations.filter((relation) => relation.kind !== "import"),
    ...buildCrossStackHttpRelations(httpEndpoints)
  ]);
  const diagnostics = [
    ...context.diagnostics, ...enrichedFiles.flatMap((file) => file.diagnostics),
    ...bindingDiagnostics, ...resourceResult.diagnostics
  ];
  const quality = calculateAnalysisQuality(enrichedFiles, importsAndCalls, diagnostics);
  const analysisCapabilities = buildAnalysisCapabilities(enrichedFiles, context, diagnostics);
  const generatedAt = new Date().toISOString();
  const index: SemanticIndex = {
    version: INDEX_VERSION,
    configurationFingerprint: snapshot.fingerprint(),
    generatorVersion: SEMANTIC_INDEX_GENERATOR_VERSION,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt,
    scanFingerprint: project.scanFingerprint ?? "",
    files: enrichedFiles,
    symbols: enrichedFiles.flatMap((file) => file.insight?.symbols ?? []),
    relations,
    httpEndpoints,
    diagnostics,
    scopes: context.scopes,
    resources: resourceResult.resources,
    quality,
    analysisCapabilities
  };
  const manifest: SemanticIndexManifest = {
    version: INDEX_VERSION,
    generatorVersion: SEMANTIC_INDEX_GENERATOR_VERSION,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt,
    scanFingerprint: project.scanFingerprint ?? "",
    configurationFingerprint: snapshot.fingerprint(),
    inputState: snapshot.inputState(),
    files: enrichedFiles.map(toManifestEntry)
  };

  options?.onProgress?.({
    stage: "persisting",
    completed: paths.length,
    total: paths.length,
    failed,
    message: "Persisting semantic index."
  });
  const updates = prepareSemanticIndex(project.rootPath, index, manifest);
  return { index, delta, updates, snapshot, removedPaths: [] };
}

export type SemanticAnalysisScope = {
  configurationRoot: string;
  paths: string[];
};

export function semanticAnalysisScopes(projectPaths: string[], codePaths: string[]): SemanticAnalysisScope[] {
  const configRoots = projectPaths
    .filter((path) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(path) && isTypeScriptProjectConfiguration(path))
    .map((path) => dirname(path));
  const packageRoots = projectPaths
    .filter((path) => /(^|\/)package\.json$/.test(path))
    .map((path) => dirname(path));
  const scopes = new Map<string, string[]>();
  for (const path of codePaths) {
    const configurationRoot = nearestRoot(path, configRoots) ?? nearestRoot(path, packageRoots) ?? "";
    scopes.set(configurationRoot, [...(scopes.get(configurationRoot) ?? []), path]);
  }
  return [...scopes.entries()]
    .map(([configurationRoot, paths]) => ({ configurationRoot, paths: paths.sort() }))
    .sort((left, right) => left.configurationRoot.localeCompare(right.configurationRoot));
}

function analyzeProjectTypeScript(
  project: CodeflowProject,
  files: SemanticFile[],
  context: ProjectAnalysisContext,
  snapshot: SourceSnapshot
): import("./typescript-semantic.service").TypeScriptSemanticResult {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const relations: SemanticRelation[] = [];
  const diagnostics: SemanticDiagnostic[] = [];
  const operations: SemanticOperationFact[] = [];
  const symbolsByFile = new Map<string, StructureSymbol[]>();
  for (const scope of context.scopes.filter((item) => item.language === "typescript")) {
    const scopeFiles = scope.paths.flatMap((path) => filesByPath.get(path) ?? []);
    const result = analyzeTypeScriptProject(project.rootPath, join(project.rootPath, scope.rootPath),
      scopeFiles.map((file) => ({ ...file, path: relativeScopePath(file.path, scope.rootPath) })), context, snapshot);
    relations.push(...result.relations);
    diagnostics.push(...result.diagnostics);
    operations.push(...result.operations);
    result.symbolsByFile.forEach((symbols, path) => symbolsByFile.set(path, symbols));
  }
  return { relations: dedupeRelations(relations), symbolsByFile, diagnostics, operations };
}

function httpEndpointFromOperation(operation: SemanticOperationFact): import("../../types").SemanticHttpEndpoint[] {
  if (operation.kind !== "http" || !operation.target || operation.unresolvedReason) return [];
  const url = /^https?:\/\//.test(operation.target) ? new URL(operation.target) : undefined;
  return [{ id: relationId("http-request", operation.filePath, JSON.stringify(operation.range)), normalizedPath: url?.pathname ?? operation.target.split("?")[0], kind: "request", method: operation.method ?? "UNKNOWN", path: url?.pathname ?? operation.target.split("?")[0],
    origin: url?.origin ?? operation.origin, filePath: operation.filePath, symbol: operation.apiName,
    confidence: operation.confidence, range: operation.range }];
}

function calculateAnalysisQuality(files: SemanticFile[], relations: SemanticRelation[], diagnostics: SemanticDiagnostic[]): StaticAnalysisQuality {
  const imports = relations.filter((relation) => relation.kind === "import" && relation.targetRef?.kind !== "external" && relation.targetRef?.kind !== "resource");
  const calls = relations.filter((relation) => relation.kind === "call" || relation.kind === "render");
  const failedFiles = files.filter((file) => file.status === "failed").length;
  const unsupportedFiles = files.filter((file) => !/\.(?:[cm]?[tj]sx?|py|java|go)$/.test(file.path)).length;
  return {
    eligibleFiles: files.length, parsedFiles: files.filter((file) => file.status === "parsed").length, failedFiles, unsupportedFiles,
    internalImports: imports.length, resolvedInternalImports: imports.filter((item) => Boolean(item.targetFile)).length,
    unresolvedInternalImports: imports.filter((item) => !item.targetFile).length,
    calls: calls.length, resolvedCalls: calls.filter((item) => item.targetRef?.kind === "file").length,
    ambiguousCalls: calls.filter((item) => item.targetRef?.kind === "unresolved" && item.targetRef.candidates.length > 1).length,
    complete: failedFiles === 0 && unsupportedFiles === 0 && !diagnostics.some((item) => item.severity === "error")
  };
}

function buildAnalysisCapabilities(
  files: SemanticFile[],
  context: ProjectAnalysisContext,
  diagnostics: SemanticDiagnostic[]
): SemanticAnalysisCapability[] {
  const groups = new Map<string, { scope: ProjectAnalysisContext["scopes"][number] | undefined; language: string; parserId: string; files: SemanticFile[] }>();
  for (const file of files) {
    const scope = context.scopes.find((candidate) => candidate.paths.includes(file.path));
    const language = file.language ?? "Unknown";
    const parserId = parserIdForFile(file, scope?.language);
    const key = `${scope?.id ?? "unscoped"}\0${language}\0${parserId}`;
    const group = groups.get(key) ?? { scope, language, parserId, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ scope, language, parserId, files: sourceFiles }) => {
    const paths = new Set(sourceFiles.map((file) => file.path));
    const configurationPaths = scope?.configurationPaths ?? [];
    const relevantDiagnostics = diagnostics.filter((diagnostic) => paths.has(diagnostic.filePath) || configurationPaths.includes(diagnostic.filePath));
    const failedFiles = sourceFiles.filter((file) => file.status === "failed").length;
    const unsupportedFiles = sourceFiles.filter((file) => file.status === "unsupported").length;
    const parsedFiles = sourceFiles.filter((file) => file.status === "parsed").length;
    const limitations = new Map<string, { code: string; reason: string; files: Set<string> }>();
    for (const diagnostic of relevantDiagnostics) {
      const key = `${diagnostic.code}\0${diagnostic.message}`;
      const limitation = limitations.get(key) ?? { code: diagnostic.code, reason: diagnostic.message, files: new Set<string>() };
      limitation.files.add(diagnostic.filePath);
      limitations.set(key, limitation);
      if (/Tree-sitter (?:runtime initialization|.+ grammar loading) failed|WASM asset not found/.test(diagnostic.message)) {
        const dependencyKey = `parser-dependency-unavailable\0${diagnostic.message}`;
        const dependency = limitations.get(dependencyKey) ?? {
          code: "parser-dependency-unavailable",
          reason: `The bundled parser runtime or grammar is unavailable: ${diagnostic.message}`,
          files: new Set<string>()
        };
        dependency.files.add(diagnostic.filePath);
        limitations.set(dependencyKey, dependency);
      }
    }
    if (scope?.language === "java") {
      limitations.set("classpath-not-loaded", {
        code: "classpath-not-loaded",
        reason: "Java bindings use scanned source files only; Maven or Gradle classpaths and external bytecode are not loaded.",
        files: new Set(sourceFiles.map((file) => file.path))
      });
    }
    const configurationUnavailable = relevantDiagnostics.some((diagnostic) => diagnostic.code === "configuration-unreadable");
    const configurationStatus: SemanticAnalysisCapability["configurationStatus"] = configurationUnavailable
      ? "unavailable"
      : configurationPaths.length > 0 ? "readable" : "not-present";
    const allUnsupported = unsupportedFiles === sourceFiles.length;
    const status: SemanticAnalysisCapability["status"] = allUnsupported
      ? "unsupported"
      : failedFiles === sourceFiles.length ? "unavailable"
      : failedFiles > 0 || configurationUnavailable ? "partial"
      : "available";
    return {
      language, scopeId: scope?.id, parserId, status,
      sourceFiles: sourceFiles.length, parsedFiles, failedFiles, unsupportedFiles,
      capabilities: parserCapabilities(parserId),
      limitations: [...limitations.values()].map(({ code, reason, files: affected }) => ({ code, reason, count: affected.size }))
        .sort((left, right) => left.code.localeCompare(right.code) || left.reason.localeCompare(right.reason)),
      configurationPaths: [...configurationPaths].sort(),
      configurationStatus,
      offline: true as const
    };
  }).sort((left, right) => left.language.localeCompare(right.language) || (left.scopeId ?? "").localeCompare(right.scopeId ?? ""));
}

function parserIdForFile(file: SemanticFile, language: AnalysisLanguage | undefined): string {
  if (file.analyzerId === "unavailable") {
    if (language === "typescript") return "typescript-compiler-api";
    if (language) return `tree-sitter-${language}-wasm`;
    return "unavailable";
  }
  if (file.status === "unsupported") return "lightweight-language";
  if (file.path.endsWith(".vue")) return "vue-compiler-sfc";
  if (language === "typescript" && file.analyzerId === "typescript-ast") return "typescript-ast";
  if (language === "typescript") return "typescript-program";
  if (language) return `tree-sitter-${language}-wasm`;
  return file.analyzerId;
}

function parserCapabilities(parserId: string): string[] {
  if (parserId === "typescript-program") return ["syntax", "source-ranges", "project-import-resolution", "symbol-targets", "call-binding", "source-operations"];
  if (parserId === "typescript-ast") return ["syntax", "source-ranges"];
  if (parserId.startsWith("tree-sitter-")) return ["syntax", "source-ranges", "source-import-resolution", "source-call-binding"];
  if (parserId === "vue-compiler-sfc") return ["component-syntax", "script-insight", "template-render-targets"];
  if (parserId === "lightweight-language") return ["syntax-outline"];
  return [];
}

function nearestRoot(path: string, roots: string[]): string | undefined {
  return roots
    .filter((root) => isWithinRoot(path, root))
    .sort((left, right) => rootDepth(right) - rootDepth(left) || left.localeCompare(right))[0];
}

function isWithinRoot(path: string, root: string): boolean {
  return root === "." || root === "" || path === root || path.startsWith(`${root}/`);
}

function rootDepth(path: string): number {
  return path === "." || path === "" ? 0 : path.split(sep).length;
}

function relativeScopePath(path: string, root: string): string {
  return root === "." || root === "" ? path : path.slice(`${root}/`.length);
}

function enrichLinkedSymbols(file: SemanticFile, symbols: StructureSymbol[] | undefined, diagnostics: SemanticDiagnostic[]): SemanticFile {
  const errors = diagnostics.filter((item) => item.filePath === file.path && item.severity === "error");
  if (!file.insight || !symbols) return file;
  return { ...file, analyzerId: /\.[cm]?[tj]sx?$/.test(file.path) ? "typescript-program" : "tree-sitter-project",
    analysisDepth: "semantic", status: errors.length ? "failed" : file.status,
    diagnostics: [...file.diagnostics, ...errors], insight: { ...file.insight, symbols } };
}

export async function readSemanticIndex(projectPath: string): Promise<SemanticIndex | undefined> {
  const value = await readJsonArtifact(join(indexRoot(projectPath), "semantic-index.json"));
  return isSemanticIndex(value) ? value : undefined;
}

export function semanticIndexToStructureFacts(
  project: CodeflowProject,
  index: SemanticIndex
): ProjectStructureFacts {
  return {
    projectName: project.projectName,
    rootPath: project.rootPath,
    languages: project.summary.languages,
    files: index.files.flatMap((file) => file.insight ? [file.insight] : []),
    relations: index.relations,
    scopes: index.scopes, resources: index.resources, quality: index.quality,
    diagnostics: index.diagnostics, analysisCapabilities: index.analysisCapabilities
  };
}

export function moduleClusteringRelations(index: SemanticIndex): SemanticRelation[] {
  const moduleKinds = new Set<SemanticRelation["kind"]>(["call", "render", "database", "filesystem", "event"]);
  return index.relations
    .filter((relation) =>
      relation.confidence === "confirmed" &&
      moduleKinds.has(relation.kind) &&
      Boolean(relation.targetFile)
    )
    .sort((left, right) =>
      left.sourceFile.localeCompare(right.sourceFile) ||
      (left.targetFile ?? "").localeCompare(right.targetFile ?? "") ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
    );
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PARSE_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1 || value > 32) {
    throw new Error(`Semantic index concurrency must be an integer between 1 and 32: ${value}`);
  }
  return value;
}

async function buildSemanticFile(
  project: CodeflowProject,
  path: string,
  previous: SemanticIndexManifestEntry | undefined,
  previousFile: SemanticFile | undefined,
  snapshot: SourceSnapshot
): Promise<SemanticFile | undefined> {
  const absolutePath = join(project.rootPath, ...path.split("/"));
  const info = snapshot.info(absolutePath);
  const modifiedAt = info.modifiedAt;
  if (info.size > MAX_FILE_BYTES) {
    const contentHash = createHash("sha256").update(`${path}:${info.size}:${modifiedAt}`).digest("hex");
    return {
      path,
      language: languageForPath(path),
      size: info.size,
      modifiedAt,
      contentHash,
      cacheKey: cacheKeyForPath(path),
      analyzerId: "size-guard",
      analysisDepth: "lightweight",
      status: "failed",
      httpEndpoints: [],
      renderTargets: [],
      diagnostics: [{
        code: "file-too-large",
        severity: "warning",
        message: `File exceeds the ${MAX_FILE_BYTES} byte semantic analysis limit.`,
        filePath: path
      }]
    };
  }
  try {
    const content = snapshot.read(absolutePath);
    if (content === undefined) throw new Error(`Missing source snapshot: ${absolutePath}`);
    const contentHash = createHash("sha256").update(content).digest("hex");
    if (previous && previous.contentHash === contentHash) {
      if (previousFile?.path === path && previousFile.contentHash === contentHash) return { ...previousFile, size: info.size, modifiedAt };
    }
    const analysis = await analyzeSourceFile(path, content, project.files);
    return {
      path,
      language: analysis.insight.language,
      framework: detectFramework(path, content),
      size: info.size,
      modifiedAt,
      contentHash,
      cacheKey: cacheKeyForPath(path),
      analyzerId: analysis.analyzerId,
      analysisDepth: analysis.analysisDepth,
      status: analysis.diagnostics?.some((item) => item.severity === "error") ? "failed" : analysis.analysisDepth === "lightweight" ? "unsupported" : "parsed",
      diagnostics: [...(analysis.diagnostics ?? []), ...(analysis.analysisDepth === "lightweight" ? [{ code: "unsupported-semantic-language", severity: "warning" as const, filePath: path, message: "Only structural facts are available for this language; project symbol binding is not supported." }] : [])],
      insight: analysis.insight,
      httpEndpoints: analysis.httpEndpoints,
      renderTargets: analysis.renderTargets
    };
  } catch (error) {
    const contentHash = createHash("sha256").update(`${path}:${info.size}:${modifiedAt}`).digest("hex");
    return {
      path,
      language: languageForPath(path),
      size: info.size,
      modifiedAt,
      contentHash,
      cacheKey: cacheKeyForPath(path),
      analyzerId: "unavailable",
      analysisDepth: "lightweight",
      status: "failed",
      httpEndpoints: [],
      renderTargets: [],
      diagnostics: [{
        code: "parse-failed",
        severity: "error",
        stage: "parsing",
        message: error instanceof Error ? error.message : String(error),
        filePath: path
      }]
    };
  }
}

function buildSemanticRelations(files: SemanticFile[], projectFiles: Set<string>, programRelations: SemanticRelation[]): SemanticRelation[] {
  const relations: SemanticRelation[] = [];
  const resolvedImports = new Set(programRelations.filter((relation) => relation.kind === "import" && relation.targetFile)
    .map((relation) => `${relation.sourceFile}\0${relation.symbol}`));
  for (const file of files) {
    const insight = file.insight;
    if (!insight || file.analysisDepth === "lightweight" || /\.(?:[cm]?[tj]sx?|py|java|go)$/.test(file.path)) continue;
    for (const specifier of insight.imports) {
      if (resolvedImports.has(`${file.path}\0${specifier}`)) continue;
      const pythonResolution = file.path.endsWith(".py")
        ? resolvePythonProjectImport(file.path, specifier, projectFiles)
        : undefined;
      const targetFile = file.path.endsWith(".py")
        ? pythonResolution?.targetFile
        : resolveProjectImport(file.path, specifier, projectFiles);
      relations.push({
        id: relationId("import", file.path, targetFile ?? specifier),
        kind: "import",
        source: file.path,
        target: targetFile ?? specifier,
        sourceFile: file.path,
        targetFile,
        detail: targetFile ? `${file.path} imports ${targetFile}` : `${file.path} imports unresolved module ${specifier}`,
        confidence: pythonResolution?.confidence ?? (targetFile ? "confirmed" : "inferred")
      });
    }
    for (const external of insight.externalCalls) {
      relations.push({
        id: relationId(external.kind, file.path, external.target),
        kind: externalKind(external.kind),
        source: file.path,
        target: external.target,
        sourceFile: file.path,
        symbol: external.symbol,
        detail: `${file.path} performs ${external.kind} operation ${external.target}`,
        confidence: external.symbol ? "confirmed" : "inferred"
      });
    }
  }
  return dedupeRelations(relations);
}

function prepareSemanticIndex(projectPath: string, index: SemanticIndex, manifest: SemanticIndexManifest): ArtifactUpdate[] {
  const root = indexRoot(projectPath);
  return [
    { path: join(root, "manifest.json"), content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: join(root, "semantic-index.json"), content: `${JSON.stringify(index, null, 2)}\n` }
  ];
}

async function readManifest(projectPath: string): Promise<SemanticIndexManifest | undefined> {
  const value = await readJsonArtifact(join(indexRoot(projectPath), "manifest.json"));
  return isManifest(value) ? value : undefined;
}

function createScanDelta(
  previousFiles: SemanticIndexManifestEntry[],
  currentFiles: SemanticIndexManifestEntry[]
): ScanDelta {
  const previous = new Map(previousFiles.map((file) => [file.path, file]));
  const current = new Map(currentFiles.map((file) => [file.path, file]));
  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];
  for (const file of currentFiles) {
    const before = previous.get(file.path);
    if (!before) added.push(file.path);
    else if (before.contentHash !== file.contentHash) modified.push(file.path);
    else unchanged.push(file.path);
  }
  const deleted = previousFiles.filter((file) => !current.has(file.path)).map((file) => file.path);
  return { added, modified, deleted, unchanged };
}

function toManifestEntry(file: SemanticFile): SemanticIndexManifestEntry {
  return {
    path: file.path,
    size: file.size,
    modifiedAt: file.modifiedAt,
    contentHash: file.contentHash,
    cacheKey: file.cacheKey
  };
}

function indexRoot(projectPath: string): string {
  return join(projectPath, FLOWWEAVE_DIR, "index");
}


function cacheKeyForPath(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

function relationId(kind: string, source: string, target: string): string {
  return createHash("sha256").update(`${kind}\0${source}\0${target}`).digest("hex").slice(0, 24);
}

function dedupeRelations(relations: SemanticRelation[]): SemanticRelation[] {
  const seen = new Set<string>();
  return [...relations].sort((left, right) => left.id.localeCompare(right.id)).filter((relation) => {
    if (seen.has(relation.id)) return false;
    seen.add(relation.id);
    return true;
  });
}

function externalKind(kind: FileInsight["externalCalls"][number]["kind"]): SemanticRelation["kind"] {
  if (kind === "queue") return "event";
  if (kind === "unknown") return "call";
  return kind;
}

function languageForPath(path: string): string | undefined {
  const labels: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript React",
    ".js": "JavaScript",
    ".jsx": "JavaScript React",
    ".vue": "Vue",
    ".py": "Python",
    ".go": "Go",
    ".java": "Java",
    ".rs": "Rust",
    ".php": "PHP",
    ".cs": "C#"
  };
  return labels[extname(path).toLowerCase()];
}

function detectFramework(path: string, content: string): string | undefined {
  if (path.endsWith(".vue")) return "Vue";
  if (/\.(tsx|jsx)$/.test(path) && /(?:from\s+["']react["']|use[A-Z]\w*\s*\()/.test(content)) return "React";
  return undefined;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function isManifest(value: unknown): value is SemanticIndexManifest {
  if (!isRecord(value) || value.version !== INDEX_VERSION || !Array.isArray(value.files)) return false;
  const inputState = value.inputState;
  const validInputState = inputState === undefined || isRecord(inputState) && Array.isArray(inputState.filePaths) && inputState.filePaths.every((path) => typeof path === "string") &&
    Array.isArray(inputState.observations) && inputState.observations.every((entry) => Array.isArray(entry) && entry.length === 2 && entry.every((part) => typeof part === "string")) &&
    (inputState.trackedFileHashes === undefined || Array.isArray(inputState.trackedFileHashes) && inputState.trackedFileHashes.every((entry) => Array.isArray(entry) && entry.length === 3 && entry.every((part) => typeof part === "string")));
  return typeof value.projectName === "string" &&
    typeof value.rootPath === "string" &&
    typeof value.scanFingerprint === "string" &&
    (value.configurationFingerprint === undefined || typeof value.configurationFingerprint === "string") &&
    validInputState &&
    value.files.every(isManifestEntry);
}

function isManifestEntry(value: unknown): value is SemanticIndexManifestEntry {
  return isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.size === "number" &&
    typeof value.modifiedAt === "string" &&
    typeof value.contentHash === "string" &&
    typeof value.cacheKey === "string";
}

function isSemanticIndex(value: unknown): value is SemanticIndex {
  return isRecord(value) &&
    value.version === INDEX_VERSION &&
    value.generatorVersion === SEMANTIC_INDEX_GENERATOR_VERSION &&
    typeof value.projectName === "string" &&
    typeof value.rootPath === "string" &&
    Array.isArray(value.files) &&
    value.files.every(isSemanticFile) &&
    Array.isArray(value.relations) &&
    value.relations.every(isSemanticRelation) &&
    Array.isArray(value.httpEndpoints) &&
    Array.isArray(value.symbols) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isSemanticDiagnostic);
}

function isSemanticDiagnostic(value: unknown): value is SemanticDiagnostic {
  return isRecord(value) &&
    typeof value.code === "string" &&
    isOneOf(value.severity, ["warning", "error"]) &&
    typeof value.message === "string" &&
    typeof value.filePath === "string" &&
    (value.stage === undefined || isOneOf(value.stage, ["parsing", "binding"])) &&
    (value.severity !== "error" || value.stage !== undefined) &&
    (value.relationId === undefined || typeof value.relationId === "string") &&
    (value.range === undefined || isSourceRange(value.range)) &&
    (value.candidates === undefined || Array.isArray(value.candidates) && value.candidates.every((candidate) => typeof candidate === "string"));
}

function isSemanticRelation(value: unknown): value is SemanticRelation {
  if (!isRecord(value) ||
    typeof value.id !== "string" ||
    !isOneOf(value.kind, ["import", "call", "inherit", "render", "http", "database", "filesystem", "process", "event", "test"] satisfies readonly SemanticRelationKind[]) ||
    typeof value.source !== "string" ||
    typeof value.target !== "string" ||
    typeof value.sourceFile !== "string" ||
    (value.targetFile !== undefined && typeof value.targetFile !== "string") ||
    (value.symbol !== undefined && typeof value.symbol !== "string") ||
    typeof value.detail !== "string" ||
    !isOneOf(value.confidence, ["confirmed", "inferred"]) ||
    (value.role !== undefined && !isOneOf(value.role, ["source", "target"])) ||
    (value.targetRef !== undefined && !isSemanticTarget(value.targetRef)) ||
    (value.sourceRange !== undefined && !isSourceRange(value.sourceRange)) ||
    (value.scopeId !== undefined && typeof value.scopeId !== "string") ||
    (value.bindingBasis !== undefined && typeof value.bindingBasis !== "string") ||
    (value.importUsage !== undefined && !isOneOf(value.importUsage, ["value", "type", "side-effect", "inherit"] satisfies readonly SemanticImportUsage[])) ||
    (value.operation !== undefined && !isOneOf(value.operation, ["read", "write", "publish", "subscribe", "invoke"] satisfies readonly SemanticOperation[]))) return false;

  if (value.kind !== "call") return true;
  if (!isSemanticTarget(value.targetRef) || !isSourceRange(value.sourceRange)) return false;
  if (value.targetRef.kind === "unresolved") return value.confidence === "inferred" && value.targetFile === undefined;
  if (value.targetRef.kind === "file") return value.targetFile === value.targetRef.filePath;
  return value.targetFile === undefined;
}

function isSemanticTarget(value: unknown): value is NonNullable<SemanticRelation["targetRef"]> {
  if (!isRecord(value)) return false;
  if (value.kind === "file") {
    return typeof value.filePath === "string" &&
      (value.symbolId === undefined || typeof value.symbolId === "string") &&
      (value.declarationRange === undefined || isSourceRange(value.declarationRange));
  }
  if (value.kind === "resource") return typeof value.resourceId === "string";
  if (value.kind === "external") return typeof value.moduleName === "string" && typeof value.standardLibrary === "boolean";
  if (value.kind === "unresolved") return typeof value.reason === "string" && Array.isArray(value.candidates) && value.candidates.every((candidate) => typeof candidate === "string");
  return false;
}

function isSourceRange(value: unknown): value is SourceRange {
  return isRecord(value) && isSourcePosition(value.start) && isSourcePosition(value.end);
}

function isSourcePosition(value: unknown): boolean {
  return isRecord(value) && typeof value.line === "number" && Number.isInteger(value.line) && value.line > 0 &&
    typeof value.column === "number" && Number.isInteger(value.column) && value.column > 0;
}

function isOneOf(value: unknown, options: readonly string[]): boolean {
  return typeof value === "string" && options.includes(value);
}

function isSemanticFile(value: unknown): value is SemanticFile {
  return isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.size === "number" &&
    typeof value.modifiedAt === "string" &&
    typeof value.contentHash === "string" &&
    typeof value.cacheKey === "string" &&
    typeof value.analyzerId === "string" &&
    Array.isArray(value.httpEndpoints) &&
    Array.isArray(value.renderTargets) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isSemanticDiagnostic);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

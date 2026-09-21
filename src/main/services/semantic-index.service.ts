import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
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
  ProjectStructureFacts
} from "../../types";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { readJsonArtifact, writeJsonAtomic } from "../storage/artifact-store";
import { flattenProjectFilePaths, resolveProjectImport } from "./import-parser.service";
import { analyzeTypeScriptProject } from "./typescript-semantic.service";
import { analyzeSourceFile } from "./language-analyzer.service";
import { buildCrossStackHttpRelations } from "./cross-stack-relation.service";

const GENERATOR_VERSION = "4.0.0";
const INDEX_VERSION = 4;
const DEFAULT_PARSE_CONCURRENCY = 8;
const MAX_FILE_BYTES = 220_000;
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".py", ".go", ".java", ".rs", ".php", ".cs"
]);

export type BuildSemanticIndexOptions = {
  concurrency?: number;
  onProgress?: (progress: AnalysisProgressUpdate) => void;
};

export async function buildSemanticIndex(
  project: CodeflowProject,
  options?: BuildSemanticIndexOptions
): Promise<{ index: SemanticIndex; delta: ScanDelta }> {
  const projectPaths = flattenProjectFilePaths(project.files).sort();
  const paths = projectPaths
    .filter((path) => CODE_EXTENSIONS.has(extname(path).toLowerCase()))
    .sort();
  const previousManifest = await readManifest(project.rootPath);
  const previousIndex = await readSemanticIndex(project.rootPath);
  const configurationFingerprint = await createConfigurationFingerprint(project.rootPath, projectPaths);
  const previousByPath = new Map(previousManifest?.files.map((file) => [file.path, file]) ?? []);
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
      const file = await buildSemanticFile(project, path, previousByPath.get(path));
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
  const configurationChanged = previousManifest?.configurationFingerprint !== configurationFingerprint;
  const canReuseLinkedIndex = previousIndex !== undefined &&
    previousIndex.generatorVersion === GENERATOR_VERSION &&
    !configurationChanged &&
    delta.added.length === 0 &&
    delta.modified.length === 0 &&
    delta.deleted.length === 0;
  const analysisScopes = semanticAnalysisScopes(projectPaths, paths);
  const typeScriptResult = canReuseLinkedIndex
    ? { relations: [], symbolsByFile: new Map<string, import("../../types").StructureSymbol[]>() }
    : analyzeProjectTypeScript(project, files, analysisScopes);
  const enrichedFiles = canReuseLinkedIndex
    ? files
    : files.map((file) => enrichTypeScriptSymbols(file, typeScriptResult.symbolsByFile.get(file.path)));
  const httpEndpoints = enrichedFiles.flatMap((file) => file.httpEndpoints);
  options?.onProgress?.({
    stage: "linking",
    completed: paths.length,
    total: paths.length,
    failed,
    message: "Linking symbols and cross-stack relations."
  });
  const relations = canReuseLinkedIndex
    ? previousIndex.relations
    : dedupeRelations([
      ...buildSemanticRelations(enrichedFiles, projectFileSet),
      ...typeScriptResult.relations,
      ...buildCrossStackHttpRelations(httpEndpoints)
    ]);
  const generatedAt = new Date().toISOString();
  const index: SemanticIndex = {
    version: INDEX_VERSION,
    generatorVersion: GENERATOR_VERSION,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt,
    scanFingerprint: project.scanFingerprint ?? "",
    files: enrichedFiles,
    symbols: enrichedFiles.flatMap((file) => file.insight?.symbols ?? []),
    relations,
    httpEndpoints,
    diagnostics: files.flatMap((file) => file.diagnostics)
  };
  const manifest: SemanticIndexManifest = {
    version: INDEX_VERSION,
    generatorVersion: GENERATOR_VERSION,
    projectName: project.projectName,
    rootPath: project.rootPath,
    generatedAt,
    scanFingerprint: project.scanFingerprint ?? "",
    configurationFingerprint,
    files: enrichedFiles.map(toManifestEntry)
  };

  options?.onProgress?.({
    stage: "persisting",
    completed: paths.length,
    total: paths.length,
    failed,
    message: "Persisting semantic index."
  });
  const cacheWritePaths = configurationChanged
    ? new Set(paths)
    : new Set([...delta.added, ...delta.modified]);
  await persistSemanticIndex(
    project.rootPath,
    index,
    manifest,
    cacheWritePaths,
    delta.deleted,
    previousByPath
  );
  project.scanDelta = delta;
  return { index, delta };
}

export type SemanticAnalysisScope = {
  configurationRoot: string;
  paths: string[];
};

export function semanticAnalysisScopes(projectPaths: string[], codePaths: string[]): SemanticAnalysisScope[] {
  const configRoots = projectPaths
    .filter((path) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(path))
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
  scopes: SemanticAnalysisScope[]
): import("./typescript-semantic.service").TypeScriptSemanticResult {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const relations: SemanticRelation[] = [];
  const symbolsByFile = new Map<string, import("../../types").StructureSymbol[]>();
  for (const scope of scopes) {
    const scopeFiles = scope.paths.flatMap((path) => filesByPath.get(path) ?? []);
    const result = analyzeTypeScriptProject(
      project.rootPath,
      join(project.rootPath, scope.configurationRoot),
      scopeFiles.map((file) => ({ ...file, path: relativeScopePath(file.path, scope.configurationRoot) }))
    );
    relations.push(...result.relations);
    result.symbolsByFile.forEach((symbols, path) => symbolsByFile.set(path, symbols));
  }
  return { relations: dedupeRelations(relations), symbolsByFile };
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

function enrichTypeScriptSymbols(file: SemanticFile, symbols: import("../../types").StructureSymbol[] | undefined): SemanticFile {
  if (!file.insight || !symbols || symbols.length === 0) return file;
  return {
    ...file,
    analyzerId: "typescript-program",
    analysisDepth: "semantic",
    insight: {
      ...file.insight,
      symbols
    }
  };
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
    relations: index.relations
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
  previous: SemanticIndexManifestEntry | undefined
): Promise<SemanticFile | undefined> {
  const absolutePath = join(project.rootPath, ...path.split("/"));
  const info = await stat(absolutePath);
  const modifiedAt = info.mtime.toISOString();
  if (previous && previous.size === info.size && previous.modifiedAt === modifiedAt) {
    const cached = await readCachedFile(project.rootPath, previous.cacheKey);
    if (cached) return cached;
  }
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
    const content = await readFile(absolutePath, "utf8");
    const contentHash = createHash("sha256").update(content).digest("hex");
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
      status: "parsed",
      diagnostics: [],
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
        message: error instanceof Error ? error.message : String(error),
        filePath: path
      }]
    };
  }
}

function buildSemanticRelations(files: SemanticFile[], projectFiles: Set<string>): SemanticRelation[] {
  const relations: SemanticRelation[] = [];
  for (const file of files) {
    const insight = file.insight;
    if (!insight) continue;
    for (const specifier of insight.imports) {
      const targetFile = resolveProjectImport(file.path, specifier, projectFiles);
      relations.push({
        id: relationId("import", file.path, targetFile ?? specifier),
        kind: "import",
        source: file.path,
        target: targetFile ?? specifier,
        sourceFile: file.path,
        targetFile,
        detail: targetFile ? `${file.path} imports ${targetFile}` : `${file.path} imports external module ${specifier}`,
        confidence: targetFile ? "confirmed" : "inferred"
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

async function persistSemanticIndex(
  projectPath: string,
  index: SemanticIndex,
  manifest: SemanticIndexManifest,
  cacheWritePaths: Set<string>,
  deletedPaths: string[],
  previousByPath: Map<string, SemanticIndexManifestEntry>
): Promise<void> {
  const root = indexRoot(projectPath);
  const filesRoot = join(root, "files");
  await mkdir(filesRoot, { recursive: true });
  await Promise.all(index.files
    .filter((file) => cacheWritePaths.has(file.path))
    .map((file) => writeJsonAtomic(join(filesRoot, `${file.cacheKey}.json`), file)));
  await Promise.all(deletedPaths.map(async (path) => {
    const previous = previousByPath.get(path);
    if (previous) await rm(join(filesRoot, `${previous.cacheKey}.json`), { force: true });
  }));
  await Promise.all([
    writeJsonAtomic(join(root, "manifest.json"), manifest),
    writeJsonAtomic(join(root, "semantic-index.json"), index)
  ]);
}

async function readManifest(projectPath: string): Promise<SemanticIndexManifest | undefined> {
  const value = await readJsonArtifact(join(indexRoot(projectPath), "manifest.json"));
  return isManifest(value) ? value : undefined;
}

async function readCachedFile(projectPath: string, cacheKey: string): Promise<SemanticFile | undefined> {
  const value = await readJsonArtifact(join(indexRoot(projectPath), "files", `${cacheKey}.json`));
  return isSemanticFile(value) ? value : undefined;
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

async function createConfigurationFingerprint(projectPath: string, projectPaths: string[]): Promise<string> {
  const hash = createHash("sha256");
  const configurationPaths = projectPaths.filter((path) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(path) || /(^|\/)package\.json$/.test(path));
  for (const path of configurationPaths) {
    try {
      hash.update(path);
      hash.update(await readFile(join(projectPath, ...path.split("/"))));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return hash.digest("hex");
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
  return typeof value.projectName === "string" &&
    typeof value.rootPath === "string" &&
    typeof value.scanFingerprint === "string" &&
    (value.configurationFingerprint === undefined || typeof value.configurationFingerprint === "string") &&
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
    value.generatorVersion === GENERATOR_VERSION &&
    typeof value.projectName === "string" &&
    typeof value.rootPath === "string" &&
    Array.isArray(value.files) &&
    value.files.every(isSemanticFile) &&
    Array.isArray(value.relations) &&
    Array.isArray(value.httpEndpoints) &&
    Array.isArray(value.symbols) &&
    Array.isArray(value.diagnostics);
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
    Array.isArray(value.diagnostics);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

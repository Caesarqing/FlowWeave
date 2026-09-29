import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { join } from "node:path";
import { parse } from "@vue/compiler-sfc";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";
import type {
  AnalysisDepth,
  FileInsight,
  ProjectFileNode,
  SemanticHttpEndpoint,
  StructureSymbol,
  SemanticDiagnostic,
  SourceRange
} from "../../types";
import { extractLightweightInsight, extractTypeScriptInsight } from "./structure-extractor.service";

export type LanguageAnalysisResult = {
  analyzerId: string;
  analysisDepth: AnalysisDepth;
  insight: FileInsight;
  httpEndpoints: SemanticHttpEndpoint[];
  renderTargets: string[];
  diagnostics?: SemanticDiagnostic[];
};

export type LanguageAnalyzer = {
  id: string;
  supports(filePath: string): boolean;
  analyze(filePath: string, content: string, projectFiles: ProjectFileNode[]): Promise<LanguageAnalysisResult> | LanguageAnalysisResult;
};

const analyzers: LanguageAnalyzer[] = [
  createVueAnalyzer(),
  createTypeScriptAnalyzer(),
  createPythonAnalyzer(),
  createJavaAnalyzer(),
  createGoAnalyzer(),
  createLightweightAnalyzer()
];

export async function analyzeSourceFile(
  filePath: string,
  content: string,
  projectFiles: ProjectFileNode[]
): Promise<LanguageAnalysisResult> {
  const analyzer = analyzers.find((candidate) => candidate.supports(filePath));
  if (!analyzer) throw new Error(`No language analyzer registered for: ${filePath}`);
  return analyzer.analyze(filePath, content, projectFiles);
}

function createTypeScriptAnalyzer(): LanguageAnalyzer {
  return {
    id: "typescript-ast",
    supports: (filePath) => /\.([cm]?tsx?|[cm]?jsx?)$/.test(filePath),
    analyze: (filePath, content) => ({
      analyzerId: "typescript-ast",
      analysisDepth: "syntax",
      insight: extractTypeScriptInsight(filePath, content),
      httpEndpoints: extractHttpEndpoints(filePath, content),
      renderTargets: extractJsxRenderTargets(content)
    })
  };
}

function createVueAnalyzer(): LanguageAnalyzer {
  return {
    id: "vue-compiler-sfc",
    supports: (filePath) => filePath.endsWith(".vue"),
    analyze: (filePath, content) => {
      const parsed = parse(content, { filename: filePath, sourceMap: false });
      if (parsed.errors.length > 0) {
        throw new Error(`Vue SFC parse failed for ${filePath}: ${parsed.errors.map(formatVueError).join("; ")}`);
      }
      const script = [parsed.descriptor.script?.content, parsed.descriptor.scriptSetup?.content]
        .filter((value): value is string => Boolean(value))
        .join("\n");
      const scriptInsight = extractTypeScriptInsight(filePath, script, "Vue");
      const template = parsed.descriptor.template?.content ?? "";
      return {
        analyzerId: "vue-compiler-sfc",
        analysisDepth: "semantic",
        insight: scriptInsight,
        httpEndpoints: extractHttpEndpoints(filePath, script),
        renderTargets: extractVueRenderTargets(template)
      };
    }
  };
}

function formatVueError(error: string | SyntaxError): string {
  return typeof error === "string" ? error : error.message;
}

function createPythonAnalyzer(): LanguageAnalyzer {
  return createTreeSitterAnalyzer("python", ".py", "Python");
}

function createJavaAnalyzer(): LanguageAnalyzer {
  return createTreeSitterAnalyzer("java", ".java", "Java");
}

function createGoAnalyzer(): LanguageAnalyzer {
  return createTreeSitterAnalyzer("go", ".go", "Go");
}

export type TreeSitterLanguageId = "python" | "java" | "go";

function createTreeSitterAnalyzer(
  languageId: TreeSitterLanguageId,
  extension: string,
  languageLabel: string
): LanguageAnalyzer {
  return {
    id: `${languageId}-tree-sitter-wasm`,
    supports: (filePath) => filePath.endsWith(extension),
    analyze: async (filePath, content) => withTreeSitterTree(languageId, filePath, content, (root) => ({
      analyzerId: `${languageId}-tree-sitter-wasm`,
      analysisDepth: "syntax",
      insight: {
        path: filePath,
        language: languageLabel,
        imports: root.descendantsOfType(languageId === "python" ? ["import_statement", "import_from_statement"] : languageId === "java" ? ["import_declaration"] : ["import_spec"]).map((node) => node.text),
        exports: [],
        symbols: collectSyntaxTreeSymbols(languageId, filePath, root),
        calls: root.descendantsOfType(languageId === "python" ? ["call"] : languageId === "java" ? ["method_invocation", "object_creation_expression"] : ["call_expression"]).map((node) => node.childForFieldName("function")?.text ?? node.childForFieldName("name")?.text ?? node.childForFieldName("type")?.text ?? node.text),
        externalCalls: []
      },
      diagnostics: treeSitterSyntaxDiagnostics(root, filePath, content),
      httpEndpoints: [],
      renderTargets: []
    }))
  };
}

export class TreeSitterInitializationError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = "TreeSitterInitializationError";
  }
}

export function syntaxNodeRange(node: SyntaxNode, content: string): SourceRange {
  const position = (index: number) => {
    const before = content.slice(0, index);
    return { line: before.split("\n").length, column: index - before.lastIndexOf("\n") };
  };
  return { start: position(node.startIndex), end: position(node.endIndex) };
}

export function treeSitterSyntaxDiagnostics(root: SyntaxNode, filePath: string, content: string): SemanticDiagnostic[] {
  if (!root.hasError) return [];
  function firstError(node: SyntaxNode): SyntaxNode | undefined {
    if (node.type === "ERROR" || node.isMissing) return node;
    for (const child of node.children) {
      const error = firstError(child);
      if (error) return error;
    }
    return undefined;
  }
  return [{ code: "syntax-error", severity: "error", filePath, range: syntaxNodeRange(firstError(root) ?? root, content), message: `Tree-sitter found syntax errors in ${filePath}` }];
}

let parserInitialization: Promise<void> | undefined;
const treeSitterLanguages = new Map<TreeSitterLanguageId, Promise<Language>>();

export async function withTreeSitterTree<T>(
  languageId: TreeSitterLanguageId,
  filePath: string,
  content: string,
  analyze: (root: SyntaxNode) => T
): Promise<T> {
  await initializeTreeSitter();
  const language = await loadTreeSitterLanguage(languageId);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(content);
  if (!tree) {
    parser.delete();
    throw new Error(`Tree-sitter returned no syntax tree for ${filePath}`);
  }
  try {
    return analyze(tree.rootNode);
  } finally {
    tree.delete();
    parser.delete();
  }
}

function initializeTreeSitter(): Promise<void> {
  parserInitialization ??= Parser.init({
    locateFile: () => resolveParserAsset("web-tree-sitter.wasm")
  }).catch((cause: unknown) => { throw new TreeSitterInitializationError("Tree-sitter runtime initialization failed", { cause }); });
  return parserInitialization;
}

function loadTreeSitterLanguage(languageId: TreeSitterLanguageId): Promise<Language> {
  const existing = treeSitterLanguages.get(languageId);
  if (existing) return existing;
  const language = Language.load(resolveParserAsset(`tree-sitter-${languageId}.wasm`)).catch((cause: unknown) => { throw new TreeSitterInitializationError(`Tree-sitter ${languageId} grammar loading failed`, { cause }); });
  treeSitterLanguages.set(languageId, language);
  return language;
}

function resolveParserAsset(fileName: string): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packagedPath = resourcesPath ? join(resourcesPath, "parsers", fileName) : "";
  if (packagedPath && existsSync(packagedPath)) return packagedPath;
  const packageName = fileName === "web-tree-sitter.wasm"
    ? "web-tree-sitter"
    : fileName.replace(".wasm", "");
  const developmentPath = join(process.cwd(), "node_modules", packageName, fileName);
  if (!existsSync(developmentPath)) {
    throw new TreeSitterInitializationError(`Tree-sitter WASM asset not found: ${developmentPath}`, {});
  }
  return developmentPath;
}

function collectSyntaxTreeSymbols(
  languageId: TreeSitterLanguageId,
  filePath: string,
  root: SyntaxNode
): StructureSymbol[] {
  const symbols: StructureSymbol[] = [];
  const visit = (node: SyntaxNode) => {
    const kind = syntaxSymbolKind(languageId, node.type);
    const name = kind ? node.childForFieldName("name") : null;
    if (kind && name) {
      symbols.push({
        name: name.text,
        kind,
        filePath,
        line: node.startPosition.row + 1,
        signature: syntaxSignature(node.text)
      });
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return symbols;
}

function syntaxSymbolKind(
  languageId: TreeSitterLanguageId,
  nodeType: string
): StructureSymbol["kind"] | undefined {
  if (languageId === "python") {
    if (nodeType === "class_definition") return "class";
    if (nodeType === "function_definition") return "function";
  }
  if (languageId === "java") {
    if (["class_declaration", "interface_declaration", "record_declaration", "enum_declaration"].includes(nodeType)) return "class";
    if (["method_declaration", "constructor_declaration"].includes(nodeType)) return "method";
  }
  if (languageId === "go") {
    if (nodeType === "type_spec") return "class";
    if (nodeType === "function_declaration") return "function";
    if (nodeType === "method_declaration") return "method";
  }
  return undefined;
}

function syntaxSignature(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.replace(/\s*\{\s*$/, "").replace(/:\s*$/, "").trim() ?? "";
}

function createLightweightAnalyzer(): LanguageAnalyzer {
  return {
    id: "lightweight-language",
    supports: () => true,
    analyze: (filePath, content, projectFiles) => ({
      analyzerId: "lightweight-language",
      analysisDepth: "lightweight",
      insight: extractLightweightInsight(filePath, content, languageForPath(filePath), projectFiles),
      httpEndpoints: extractHttpEndpoints(filePath, content),
      renderTargets: []
    })
  };
}


function extractHttpEndpoints(filePath: string, content: string): SemanticHttpEndpoint[] {
  const endpoints: SemanticHttpEndpoint[] = [];
  collectEndpointMatches(endpoints, filePath, content, /\b(fetch)\s*\(\s*([`"'])([^`"']+)\2/g, "request", "GET", 3);
  collectMethodRequestMatches(endpoints, filePath, content, /\b(?:axios|http|client)\.(get|post|put|patch|delete|options|head)\s*\(\s*([`"'])([^`"']+)\2/gi);
  collectRouteMatches(endpoints, filePath, content, /\b(?:app|router)\.(get|post|put|patch|delete|options|head)\s*\(\s*["']([^"']+)["']/gi);
  collectDecoratorRoutes(endpoints, filePath, content, /@\w+\.(get|post|put|patch|delete|options|head)\s*\(\s*["']([^"']+)["']/gi);
  collectSpringRoutes(endpoints, filePath, content);
  collectGoRoutes(endpoints, filePath, content);
  return dedupeEndpoints(endpoints);
}

function collectEndpointMatches(
  endpoints: SemanticHttpEndpoint[],
  filePath: string,
  content: string,
  pattern: RegExp,
  kind: SemanticHttpEndpoint["kind"],
  method: SemanticHttpEndpoint["method"],
  pathGroup: number
): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    if (match[pathGroup]) endpoints.push(endpoint(kind, filePath, method, match[pathGroup], match[1]));
  }
}

function collectMethodRequestMatches(
  endpoints: SemanticHttpEndpoint[],
  filePath: string,
  content: string,
  pattern: RegExp
): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    if (match[1] && match[3]) endpoints.push(endpoint("request", filePath, httpMethod(match[1]), match[3], match[1]));
  }
}

function collectRouteMatches(
  endpoints: SemanticHttpEndpoint[],
  filePath: string,
  content: string,
  pattern: RegExp
): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    if (match[1] && match[2]) endpoints.push(endpoint("route", filePath, httpMethod(match[1]), match[2], match[1]));
  }
}

function collectDecoratorRoutes(
  endpoints: SemanticHttpEndpoint[],
  filePath: string,
  content: string,
  pattern: RegExp
): void {
  collectRouteMatches(endpoints, filePath, content, pattern);
}

function collectSpringRoutes(endpoints: SemanticHttpEndpoint[], filePath: string, content: string): void {
  const pattern = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    if (match[1] && match[2]) {
      const method = match[1].toLowerCase() === "request" ? "UNKNOWN" : httpMethod(match[1]);
      endpoints.push(endpoint("route", filePath, method, match[2], `${match[1]}Mapping`));
    }
  }
}

function collectGoRoutes(endpoints: SemanticHttpEndpoint[], filePath: string, content: string): void {
  const pattern = /\b(?:HandleFunc|Handle)\s*\(\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    if (match[1]) endpoints.push(endpoint("route", filePath, "UNKNOWN", match[1], "HandleFunc"));
  }
}

function endpoint(
  kind: SemanticHttpEndpoint["kind"],
  filePath: string,
  method: SemanticHttpEndpoint["method"],
  path: string,
  symbol: string
): SemanticHttpEndpoint {
  return {
    id: createHash("sha256").update(`${kind}\0${filePath}\0${method}\0${path}`).digest("hex").slice(0, 24),
    kind,
    filePath,
    method,
    path,
    normalizedPath: normalizeHttpPath(path),
    symbol,
    confidence: path.includes("${") ? "inferred" : "confirmed"
  };
}

function normalizeHttpPath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  return `/${withoutQuery}`
    .replace(/^\/+/, "/")
    .replace(/\$\{[^}]+\}|:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}/g, ":param")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
}

function httpMethod(value: string): SemanticHttpEndpoint["method"] {
  const method = value.toUpperCase();
  return method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" ||
    method === "DELETE" || method === "OPTIONS" || method === "HEAD" ? method : "UNKNOWN";
}

function extractJsxRenderTargets(content: string): string[] {
  return [...content.matchAll(/<([A-Z][A-Za-z0-9_.]*)\b/g)].map((match) => match[1]).filter(Boolean);
}

function extractVueRenderTargets(template: string): string[] {
  return [...template.matchAll(/<([A-Z][A-Za-z0-9]*|[a-z]+-[a-z0-9-]+)\b/g)].map((match) => match[1]).filter(Boolean);
}

function dedupeEndpoints(endpoints: SemanticHttpEndpoint[]): SemanticHttpEndpoint[] {
  const seen = new Set<string>();
  return endpoints.filter((item) => {
    const key = `${item.kind}:${item.method}:${item.normalizedPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function languageForPath(filePath: string): string | undefined {
  const labels: Record<string, string> = {
    ".rs": "Rust",
    ".php": "PHP",
    ".cs": "C#"
  };
  return labels[extname(filePath).toLowerCase()];
}

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
  StructureSymbol
} from "../../types";
import { extractLightweightInsight, extractTypeScriptInsight } from "./structure-extractor.service";

export type LanguageAnalysisResult = {
  analyzerId: string;
  analysisDepth: AnalysisDepth;
  insight: FileInsight;
  httpEndpoints: SemanticHttpEndpoint[];
  renderTargets: string[];
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

export function listLanguageAnalyzers(): Array<{ id: string }> {
  return analyzers.map((analyzer) => ({ id: analyzer.id }));
}

function createTypeScriptAnalyzer(): LanguageAnalyzer {
  return {
    id: "typescript-ast",
    supports: (filePath) => /\.(tsx?|jsx?|mjs|cjs)$/.test(filePath),
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

type TreeSitterLanguageId = "python" | "java" | "go";

function createTreeSitterAnalyzer(
  languageId: TreeSitterLanguageId,
  extension: string,
  languageLabel: string
): LanguageAnalyzer {
  return {
    id: `${languageId}-tree-sitter-wasm`,
    supports: (filePath) => filePath.endsWith(extension),
    analyze: async (filePath, content, projectFiles) => ({
      analyzerId: `${languageId}-tree-sitter-wasm`,
      analysisDepth: "semantic",
      insight: enhanceSymbols(
        extractLightweightInsight(filePath, content, languageLabel, projectFiles),
        await collectTreeSitterSymbols(languageId, filePath, content)
      ),
      httpEndpoints: extractHttpEndpoints(filePath, content),
      renderTargets: []
    })
  };
}

let parserInitialization: Promise<void> | undefined;
const treeSitterLanguages = new Map<TreeSitterLanguageId, Promise<Language>>();

async function collectTreeSitterSymbols(
  languageId: TreeSitterLanguageId,
  filePath: string,
  content: string
): Promise<StructureSymbol[]> {
  await initializeTreeSitter();
  const parser = new Parser();
  const language = await loadTreeSitterLanguage(languageId);
  parser.setLanguage(language);
  const tree = parser.parse(content);
  if (!tree) {
    parser.delete();
    throw new Error(`Tree-sitter returned no syntax tree for ${filePath}`);
  }
  try {
    if (tree.rootNode.hasError) {
      throw new Error(`Tree-sitter found syntax errors in ${filePath}`);
    }
    return collectSyntaxTreeSymbols(languageId, filePath, tree.rootNode);
  } finally {
    tree.delete();
    parser.delete();
  }
}

function initializeTreeSitter(): Promise<void> {
  parserInitialization ??= Parser.init({
    locateFile: () => resolveParserAsset("web-tree-sitter.wasm")
  });
  return parserInitialization;
}

function loadTreeSitterLanguage(languageId: TreeSitterLanguageId): Promise<Language> {
  const existing = treeSitterLanguages.get(languageId);
  if (existing) return existing;
  const language = Language.load(resolveParserAsset(`tree-sitter-${languageId}.wasm`));
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
    throw new Error(`Tree-sitter WASM asset not found: ${fileName}`);
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

function collectSymbols(
  filePath: string,
  content: string,
  definitions: Array<{ kind: StructureSymbol["kind"]; pattern: RegExp }>
): StructureSymbol[] {
  const symbols: StructureSymbol[] = [];
  for (const definition of definitions) {
    definition.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = definition.pattern.exec(content))) {
      const name = match[1];
      if (!name) continue;
      symbols.push({
        name,
        kind: definition.kind,
        filePath,
        line: content.slice(0, match.index).split("\n").length,
        signature: match[2] !== undefined
          ? `${name}(${match[2].trim()})${match[3] ? ` -> ${match[3].trim()}` : ""}`
          : undefined
      });
    }
  }
  return symbols;
}

function enhanceSymbols(insight: FileInsight, symbols: StructureSymbol[]): FileInsight {
  const seen = new Set<string>();
  return {
    ...insight,
    symbols: [...symbols, ...insight.symbols].filter((symbol) => {
      const key = `${symbol.kind}:${symbol.name}:${symbol.line ?? 0}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
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

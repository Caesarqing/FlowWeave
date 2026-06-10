import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import type * as TypeScript from "typescript";
import type {
  CodeflowProject,
  ExternalCallInsight,
  FileInsight,
  ProjectStructureFacts,
  ProjectFileNode,
  StructureSymbol,
  StructureSymbolKind
} from "../../types";
import { flattenProjectFilePaths } from "./import-parser.service";

const MAX_INSIGHT_FILES = 800;
const MAX_FILE_BYTES = 220_000;
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java", ".rs", ".php", ".cs"]);
const require = createRequire(import.meta.url);
type TypeScriptApi = typeof TypeScript;

export async function buildProjectStructureFacts(project: CodeflowProject): Promise<ProjectStructureFacts> {
  const paths = flattenProjectFilePaths(project.files)
    .filter((path) => CODE_EXTENSIONS.has(extname(path).toLowerCase()))
    .sort((left, right) => representativePathScore(right) - representativePathScore(left) || left.localeCompare(right))
    .slice(0, MAX_INSIGHT_FILES);

  const files = await Promise.all(paths.map((path) => readFileInsight(project.rootPath, project.files, path)));

  return {
    projectName: project.projectName,
    rootPath: project.rootPath,
    languages: project.summary.languages,
    files: files.filter((file): file is FileInsight => Boolean(file))
  };
}

async function readFileInsight(rootPath: string, projectFiles: ProjectFileNode[], filePath: string): Promise<FileInsight | undefined> {
  const absolutePath = join(rootPath, ...filePath.split("/"));
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(rootPath), realpath(absolutePath).catch(() => undefined)]);
  if (!canonicalFile) return undefined;
  const pathFromRoot = relative(canonicalRoot, canonicalFile);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) return undefined;
  const content = await readFile(absolutePath, "utf8").catch(() => "");
  if (!content || Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    return undefined;
  }

  const language = detectLanguage(filePath);
  if (isTypeScriptLike(filePath)) {
    return extractTypeScriptInsight(filePath, content, language);
  }

  return extractLightweightInsight(filePath, content, language, projectFiles);
}

export function selectRepresentativeStructureFacts(facts: ProjectStructureFacts, maxFiles: number): FileInsight[] {
  return [...facts.files]
    .sort((left, right) => representativeScore(right) - representativeScore(left) || left.path.localeCompare(right.path))
    .slice(0, maxFiles);
}

function representativeScore(file: FileInsight) {
  const path = file.path.toLowerCase();
  let score = file.symbols.length * 3 + file.calls.length * 2 + file.externalCalls.length * 5 + file.imports.length;
  if (/(^|\/)(main|index|app|server|bootstrap)\.[^.]+$/.test(path)) score += 40;
  if (/(ipc|controller|service|worker|gateway|adapter|repository|store|dispatcher|scheduler)/.test(path)) score += 25;
  if (/(test|spec|fixture|example|generated)/.test(path)) score -= 20;
  return score;
}

function representativePathScore(filePath: string) {
  const path = filePath.toLowerCase();
  let score = 0;
  if (/(^|\/)(main|index|app|server|bootstrap)\.[^.]+$/.test(path)) score += 40;
  if (/(ipc|controller|service|worker|gateway|adapter|repository|store|dispatcher|scheduler)/.test(path)) score += 25;
  if (/(test|spec|fixture|example|generated)/.test(path)) score -= 20;
  return score;
}

export function extractTypeScriptInsight(filePath: string, content: string, language = detectLanguage(filePath)): FileInsight {
  const loadedTypeScript = loadTypeScript();
  if (!loadedTypeScript) {
    return extractLightweightInsight(filePath, content, language);
  }
  const ts = loadedTypeScript;
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = new Set<string>();
  const exports = new Set<string>();
  const symbols: StructureSymbol[] = [];
  const calls = new Set<string>();
  const externalCalls: ExternalCallInsight[] = [];

  function visit(node: TypeScript.Node) {
    collectImportsAndExports(ts, node, imports, exports);
    collectSymbols(ts, filePath, sourceFile, node, symbols, exports);

    if (ts.isCallExpression(node)) {
      const callName = callExpressionName(ts, node.expression);
      if (callName) {
        calls.add(callName);
        const external = externalCallFromExpression(ts, filePath, callName, node);
        if (external) externalCalls.push(external);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    path: filePath,
    language,
    imports: [...imports],
    exports: [...exports],
    symbols: dedupeSymbols(symbols),
    calls: [...calls].slice(0, 80),
    externalCalls: dedupeExternalCalls(externalCalls)
  };
}

function loadTypeScript(): TypeScriptApi | undefined {
  try {
    return require("typescript") as TypeScriptApi;
  } catch {
    return undefined;
  }
}

export function extractLightweightInsight(
  filePath: string,
  content: string,
  language = detectLanguage(filePath),
  _projectFiles: ProjectFileNode[] = []
): FileInsight {
  const imports = new Set<string>();
  const symbols: StructureSymbol[] = [];
  const externalCalls: ExternalCallInsight[] = [];

  const patterns = lightweightPatterns(filePath);
  for (const pattern of patterns.imports) {
    collectMatches(content, pattern, imports);
  }

  for (const pattern of patterns.functions) {
    collectSymbolMatches(filePath, content, pattern, "function", symbols);
  }

  for (const pattern of patterns.classes) {
    collectSymbolMatches(filePath, content, pattern, "class", symbols);
  }

  collectLightweightExternalCalls(filePath, content, externalCalls);

  return {
    path: filePath,
    language,
    imports: [...imports].slice(0, 80),
    exports: [],
    symbols: dedupeSymbols(symbols),
    calls: [],
    externalCalls: dedupeExternalCalls(externalCalls)
  };
}

function collectImportsAndExports(ts: TypeScriptApi, node: TypeScript.Node, imports: Set<string>, exports: Set<string>) {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    imports.add(node.moduleSpecifier.text);
  }

  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    imports.add(node.moduleSpecifier.text);
  }

  if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
    const expression = node.expression.getText();
    if (expression === "require" || expression === "import") {
      imports.add(node.arguments[0].text);
    }
  }

  if (hasExportModifier(ts, node)) {
    const name = declarationName(ts, node);
    if (name) exports.add(name);
  }

  if (ts.isVariableStatement(node) && hasExportModifier(ts, node)) {
    for (const declaration of node.declarationList.declarations) {
      const name = declarationName(ts, declaration);
      if (name) exports.add(name);
    }
  }

  if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
    for (const element of node.exportClause.elements) {
      exports.add(element.name.text);
    }
  }
}

function collectSymbols(ts: TypeScriptApi, filePath: string, sourceFile: TypeScript.SourceFile, node: TypeScript.Node, symbols: StructureSymbol[], exports: Set<string>) {
  const kind = symbolKind(ts, node);
  if (!kind) return;

  const name = declarationName(ts, node);
  if (!name) return;

  const exported = hasExportModifier(ts, node) || hasExportedParent(ts, node) || exports.has(name);
  symbols.push({
    name,
    kind,
    filePath,
    exported,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  });
}

function symbolKind(ts: TypeScriptApi, node: TypeScript.Node): StructureSymbolKind | undefined {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isVariableDeclaration(node) && initializerLooksCallable(ts, node.initializer)) return "function";
  return undefined;
}

function declarationName(ts: TypeScriptApi, node: TypeScript.Node) {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) {
    if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  }
  return undefined;
}

function hasExportModifier(ts: TypeScriptApi, node: TypeScript.Node) {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function hasExportedParent(ts: TypeScriptApi, node: TypeScript.Node) {
  return Boolean(node.parent && hasExportModifier(ts, node.parent));
}

function initializerLooksCallable(ts: TypeScriptApi, initializer: TypeScript.Expression | undefined) {
  return Boolean(initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)));
}

function callExpressionName(ts: TypeScriptApi, expression: TypeScript.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.getText();
  return undefined;
}

function externalCallFromExpression(ts: TypeScriptApi, filePath: string, callName: string, node: TypeScript.CallExpression): ExternalCallInsight | undefined {
  const firstArg = node.arguments[0];
  const target = firstArg && ts.isStringLiteralLike(firstArg) ? firstArg.text : callName;
  if (/^(fetch|axios(\.|$)|request|got\.|http\.|https\.)/.test(callName) || /^https?:\/\//.test(target)) {
    return { kind: "http", target, filePath, symbol: callName };
  }
  if (/(prisma|sequelize|mongoose|knex|repository|db|database)\./i.test(callName)) {
    return { kind: "database", target: callName, filePath, symbol: callName };
  }
  if (/^(fs\.|readFile|writeFile)/.test(callName)) {
    return { kind: "filesystem", target: callName, filePath, symbol: callName };
  }
  if (/^(spawn|exec|execFile|fork)$/.test(callName)) {
    return { kind: "process", target: callName, filePath, symbol: callName };
  }
  if (/(publish|subscribe|enqueue|queue|emit)\b/i.test(callName)) {
    return { kind: "queue", target: callName, filePath, symbol: callName };
  }
  return undefined;
}

function lightweightPatterns(filePath: string) {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".py") {
    return {
      imports: [/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm],
      functions: [/^\s*def\s+([A-Za-z_]\w*)\s*\(/gm],
      classes: [/^\s*class\s+([A-Za-z_]\w*)\s*[:(]/gm]
    };
  }
  if (extension === ".go") {
    return {
      imports: [/\bimport\s+(?:"([^"]+)"|\(([\s\S]*?)\))/gm],
      functions: [/\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/gm],
      classes: [/\btype\s+([A-Za-z_]\w*)\s+struct\b/gm]
    };
  }
  return {
    imports: [/\b(?:import|using|use)\s+["']?([A-Za-z0-9_./:@-]+)/gm],
    functions: [/\b(?:function|fn|def|public\s+\w+|private\s+\w+|protected\s+\w+)\s+([A-Za-z_]\w*)\s*\(/gm],
    classes: [/\b(?:class|interface|trait|struct)\s+([A-Za-z_]\w*)\b/gm]
  };
}

function collectMatches(content: string, pattern: RegExp, values: Set<string>) {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    for (const group of match.slice(1)) {
      if (!group) continue;
      if (group.includes("\n")) {
        for (const item of group.matchAll(/"([^"]+)"/g)) {
          if (item[1]) values.add(item[1]);
        }
      } else {
        values.add(group);
      }
    }
  }
}

function collectSymbolMatches(filePath: string, content: string, pattern: RegExp, kind: StructureSymbolKind, symbols: StructureSymbol[]) {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    if (!match[1]) continue;
    symbols.push({
      name: match[1],
      kind,
      filePath,
      line: lineNumberAt(content, match.index)
    });
  }
}

function collectLightweightExternalCalls(filePath: string, content: string, externalCalls: ExternalCallInsight[]) {
  const checks: Array<[RegExp, ExternalCallInsight["kind"]]> = [
    [/\b(fetch|axios|requests\.|http\.|https\.|curl_exec)\b/g, "http"],
    [/\b(sql|query|execute|prisma|sequelize|mongoose|database|repository)\b/gi, "database"],
    [/\b(readFile|writeFile|open\(|File\(|fs\.)\b/g, "filesystem"],
    [/\b(publish|subscribe|enqueue|queue|emit)\b/gi, "queue"]
  ];
  for (const [pattern, kind] of checks) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      externalCalls.push({ kind, target: match[1] ?? match[0], filePath });
    }
  }
}

function dedupeSymbols(symbols: StructureSymbol[]) {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.filePath}:${symbol.kind}:${symbol.name}:${symbol.line ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 120);
}

function dedupeExternalCalls(calls: ExternalCallInsight[]) {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.filePath}:${call.kind}:${call.target}:${call.symbol ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 80);
}

function lineNumberAt(content: string, index: number) {
  return content.slice(0, index).split("\n").length;
}

function isTypeScriptLike(filePath: string) {
  return /\.(tsx?|jsx?|mjs|cjs)$/.test(filePath);
}

function detectLanguage(filePath: string) {
  const extension = extname(filePath).toLowerCase();
  const labels: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript React",
    ".js": "JavaScript",
    ".jsx": "JavaScript React",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".py": "Python",
    ".go": "Go",
    ".java": "Java",
    ".rs": "Rust",
    ".php": "PHP",
    ".cs": "C#"
  };
  return labels[extension];
}

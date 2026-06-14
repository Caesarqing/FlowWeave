import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import type * as TypeScript from "typescript";
import type { SemanticFile, SemanticRelation, StructureSymbol } from "../../types";

const require = createRequire(import.meta.url);
type TypeScriptApi = typeof TypeScript;

export type TypeScriptSemanticResult = {
  relations: SemanticRelation[];
  symbolsByFile: Map<string, StructureSymbol[]>;
};

export function analyzeTypeScriptProject(rootPath: string, files: SemanticFile[]): TypeScriptSemanticResult {
  const loadedTypeScript = loadTypeScript();
  const sourcePaths = files.filter((file) => isTypeScriptFile(file.path)).map((file) => `${rootPath}/${file.path}`);
  if (!loadedTypeScript || sourcePaths.length === 0) return { relations: [], symbolsByFile: new Map() };
  const ts = loadedTypeScript;
  const options = compilerOptions(ts, rootPath, sourcePaths);
  const program = ts.createProgram({ rootNames: sourcePaths, options });
  const checker = program.getTypeChecker();
  const relations: SemanticRelation[] = [];
  const symbolsByFile = new Map<string, StructureSymbol[]>();

  for (const sourceFile of program.getSourceFiles()) {
    const sourcePath = projectPath(rootPath, sourceFile.fileName);
    if (!sourcePath) continue;
    const currentPath = sourcePath;
    const symbols: StructureSymbol[] = [];
    function visit(node: TypeScript.Node): void {
      const symbol = typedSymbol(ts, checker, sourceFile, currentPath, node);
      if (symbol) symbols.push(symbol);
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        addModuleRelation(ts, relations, options, rootPath, sourceFile.fileName, currentPath, node.moduleSpecifier.text);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        addModuleRelation(ts, relations, options, rootPath, sourceFile.fileName, currentPath, node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node)) {
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          addModuleRelation(ts, relations, options, rootPath, sourceFile.fileName, currentPath, node.arguments[0].text);
          ts.forEachChild(node, visit);
          return;
        }
        const targetPath = declarationProjectPath(rootPath, checker, checker.getSymbolAtLocation(node.expression));
        if (targetPath && targetPath !== currentPath) {
          relations.push(relation("call", currentPath, targetPath, currentPath, targetPath, node.expression.getText(sourceFile)));
        }
      }
      if (ts.isHeritageClause(node)) {
        for (const type of node.types) {
          const targetPath = declarationProjectPath(rootPath, checker, checker.getSymbolAtLocation(type.expression));
          if (targetPath) {
            relations.push(relation("inherit", currentPath, targetPath, currentPath, targetPath, type.expression.getText(sourceFile)));
          }
        }
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const targetPath = declarationProjectPath(rootPath, checker, checker.getSymbolAtLocation(node.tagName));
        if (targetPath && targetPath !== currentPath) {
          relations.push(relation("render", currentPath, targetPath, currentPath, targetPath, node.tagName.getText(sourceFile)));
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    symbolsByFile.set(currentPath, dedupeSymbols(symbols));
  }
  return { relations: dedupeRelations(relations), symbolsByFile };
}

function compilerOptions(ts: TypeScriptApi, rootPath: string, sourcePaths: string[]): TypeScript.CompilerOptions {
  const workspacePaths = workspaceCompilerPaths(rootPath);
  const configPath = ts.findConfigFile(rootPath, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    return {
      allowJs: true,
      baseUrl: rootPath,
      checkJs: false,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      paths: workspacePaths,
      target: ts.ScriptTarget.ES2022
    };
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) return compilerOptionsWithoutConfig(ts);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, rootPath, undefined, configPath);
  return {
    ...parsed.options,
    allowJs: true,
    baseUrl: parsed.options.baseUrl ?? rootPath,
    noEmit: true,
    paths: { ...workspacePaths, ...parsed.options.paths },
    rootDir: parsed.options.rootDir ?? rootPath
  };
}

function compilerOptionsWithoutConfig(ts: TypeScriptApi): TypeScript.CompilerOptions {
  return {
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    target: ts.ScriptTarget.ES2022
  };
}

function addModuleRelation(
  ts: TypeScriptApi,
  relations: SemanticRelation[],
  options: TypeScript.CompilerOptions,
  rootPath: string,
  sourceFileName: string,
  sourcePath: string,
  specifier: string
): void {
  const resolved = ts.resolveModuleName(specifier, sourceFileName, options, ts.sys).resolvedModule;
  const targetPath = resolved ? projectPath(rootPath, resolved.resolvedFileName) : undefined;
  if (targetPath) relations.push(relation("import", sourcePath, targetPath, sourcePath, targetPath, specifier));
}

function workspaceCompilerPaths(rootPath: string): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const parent of ["packages", "apps"]) {
    const parentPath = join(rootPath, parent);
    for (const entry of safeDirectories(parentPath)) {
      const packageRoot = join(parentPath, entry);
      const manifest = readPackageManifest(join(packageRoot, "package.json"));
      if (!manifest?.name) continue;
      const relativeRoot = relative(rootPath, packageRoot).split(sep).join("/");
      paths[manifest.name] = [workspaceEntry(relativeRoot, manifest)];
      paths[`${manifest.name}/*`] = [`${relativeRoot}/src/*`];
    }
  }
  return paths;
}

function safeDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readPackageManifest(path: string): { name?: string; types?: string; main?: string; exports?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { name?: string; types?: string; main?: string; exports?: unknown };
  } catch {
    return undefined;
  }
}

function workspaceEntry(
  relativeRoot: string,
  manifest: { types?: string; main?: string; exports?: unknown }
): string {
  const exported = manifest.exports;
  if (typeof exported === "string") return `${relativeRoot}/${stripRelativePrefix(exported)}`;
  if (exported && typeof exported === "object" && "." in exported) {
    const rootExport = (exported as Record<string, unknown>)["."];
    if (typeof rootExport === "string") return `${relativeRoot}/${stripRelativePrefix(rootExport)}`;
    if (rootExport && typeof rootExport === "object") {
      const conditions = rootExport as Record<string, unknown>;
      for (const condition of ["types", "import", "default"]) {
        if (typeof conditions[condition] === "string") {
          return `${relativeRoot}/${stripRelativePrefix(conditions[condition] as string)}`;
        }
      }
    }
  }
  return `${relativeRoot}/${stripRelativePrefix(manifest.types ?? manifest.main ?? "src/index.ts")}`;
}

function stripRelativePrefix(path: string): string {
  return path.replace(/^\.\//, "");
}

function typedSymbol(
  ts: TypeScriptApi,
  checker: TypeScript.TypeChecker,
  sourceFile: TypeScript.SourceFile,
  filePath: string,
  node: TypeScript.Node
): StructureSymbol | undefined {
  if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node) && !ts.isClassDeclaration(node) &&
      !(ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))) {
    return undefined;
  }
  const nameNode = node.name;
  if (!nameNode || !ts.isIdentifier(nameNode)) return undefined;
  const kind = ts.isClassDeclaration(node) ? "class" : ts.isMethodDeclaration(node) ? "method" : "function";
  const signature = ts.isClassDeclaration(node)
    ? checker.typeToString(checker.getTypeAtLocation(node))
    : signatureForDeclaration(ts, checker, node);
  return {
    name: nameNode.text,
    kind,
    filePath,
    exported: ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)),
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    signature
  };
}

function signatureForDeclaration(
  ts: TypeScriptApi,
  checker: TypeScript.TypeChecker,
  node: TypeScript.FunctionDeclaration | TypeScript.MethodDeclaration | TypeScript.VariableDeclaration
): string | undefined {
  const callable = ts.isVariableDeclaration(node) ? node.initializer : node;
  if (!callable || (!ts.isFunctionLike(callable) && !ts.isFunctionDeclaration(callable))) return undefined;
  const signature = checker.getSignatureFromDeclaration(callable as TypeScript.SignatureDeclaration);
  return signature ? checker.signatureToString(signature) : undefined;
}

function declarationProjectPath(
  rootPath: string,
  checker: TypeScript.TypeChecker,
  symbol: TypeScript.Symbol | undefined
): string | undefined {
  const resolvedSymbol = resolveAliasSymbol(checker, symbol);
  const declaration = resolvedSymbol?.valueDeclaration ?? resolvedSymbol?.declarations?.[0];
  return declaration ? projectPath(rootPath, declaration.getSourceFile().fileName) : undefined;
}

function resolveAliasSymbol(
  checker: TypeScript.TypeChecker,
  symbol: TypeScript.Symbol | undefined
): TypeScript.Symbol | undefined {
  if (!symbol) return undefined;
  const ts = loadTypeScript();
  if (!ts || !(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  return checker.getAliasedSymbol(symbol);
}

function projectPath(rootPath: string, absolutePath: string): string | undefined {
  const fromRoot = relative(rootPath, absolutePath);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot) || fromRoot.includes("node_modules")) {
    return undefined;
  }
  return fromRoot.split(sep).join("/");
}

function relation(
  kind: SemanticRelation["kind"],
  source: string,
  target: string,
  sourceFile: string,
  targetFile: string,
  symbol: string
): SemanticRelation {
  return {
    id: createHash("sha256").update(`${kind}\0${source}\0${target}\0${symbol}`).digest("hex").slice(0, 24),
    kind,
    source,
    target,
    sourceFile,
    targetFile,
    symbol,
    detail: `${sourceFile} ${kind}s ${symbol} from ${targetFile}`,
    confidence: "confirmed"
  };
}

function dedupeRelations(relations: SemanticRelation[]): SemanticRelation[] {
  const seen = new Set<string>();
  return relations.filter((item) => {
    const key = `${item.kind}:${item.source}:${item.target}:${item.symbol ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeSymbols(symbols: StructureSymbol[]): StructureSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.kind}:${symbol.name}:${symbol.line ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isTypeScriptFile(path: string): boolean {
  return /\.(tsx?|jsx?|mjs|cjs)$/.test(path);
}

function loadTypeScript(): TypeScriptApi | undefined {
  try {
    return require("typescript") as TypeScriptApi;
  } catch {
    return undefined;
  }
}

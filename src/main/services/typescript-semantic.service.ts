import type { SourceSnapshot } from "./source-snapshot.service";
import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type * as TypeScript from "typescript";
import type { PackageExport, ProjectAnalysisContext, SemanticDiagnostic, SemanticFile, SemanticImportUsage, SemanticOperationFact, SemanticRelation, SemanticTarget, SourceRange, StructureSymbol, WorkspacePackage } from "../../types";
import { sourceOperation } from "./typescript-source-operations";
import { isTypeScriptProjectConfiguration, isUnknownCompilerOption } from "./project-analysis-context.service";

const require = createRequire(import.meta.url);
type TypeScriptApi = typeof TypeScript;

type ModuleResolution = {
  candidates?: string[];
  resolvedModule: TypeScript.ResolvedModuleFull | undefined;
  reason: string | undefined;
  package: WorkspacePackage | undefined;
};

type Configuration = {
  options: TypeScript.CompilerOptions;
  projectReferences: readonly TypeScript.ProjectReference[] | undefined;
  fileNames: string[];
};

export type TypeScriptSemanticResult = {
  relations: SemanticRelation[];
  symbolsByFile: Map<string, StructureSymbol[]>;
  diagnostics: SemanticDiagnostic[];
  operations: SemanticOperationFact[];
};

export class TypeScriptRuntimeAssetError extends Error {
  constructor(libraryPath: string) {
    super(`TypeScript runtime declaration library is missing: ${libraryPath}. Restore the bundled TypeScript lib/*.d.ts assets before scanning.`);
    this.name = "TypeScriptRuntimeAssetError";
  }
}

export function analyzeTypeScriptProject(
  workspaceRoot: string,
  configurationRoot: string,
  files: SemanticFile[],
  context: ProjectAnalysisContext,
  snapshot?: SourceSnapshot
): TypeScriptSemanticResult {
  const sourcePaths = files.filter((file) => isTypeScriptFile(file.path)).map((file) => resolve(configurationRoot, file.path));
  if (sourcePaths.length === 0) return { relations: [], symbolsByFile: new Map(), diagnostics: [], operations: [] };
  const runtime = require("typescript") as TypeScriptApi;
  const ts: TypeScriptApi = snapshot ? { ...runtime, sys: snapshot.system,
    createCompilerHost: (options, setParentNodes) => {
      const host = runtime.createCompilerHost(options, setParentNodes);
      return { ...host, readFile: snapshot.read, fileExists: snapshot.system.fileExists,
        directoryExists: snapshot.system.directoryExists, getDirectories: snapshot.system.getDirectories, realpath: snapshot.system.realpath,
        getSourceFile: (path, languageVersion) => {
          const content = snapshot.read(path);
          return content === undefined ? undefined : runtime.createSourceFile(path, content, languageVersion, true);
        }
      };
    }
  } : runtime;
  const configuration = compilerConfiguration(ts, workspaceRoot, configurationRoot, context);
  const referenced = referencedConfigurations(ts, configuration.projectReferences, new Set());
  const assigned = new Set(referenced.flatMap((item) => item.fileNames.map((path) => resolve(path))));
  const groups = [...referenced.map((item) => ({ configuration: item, paths: sourcePaths.filter((path) => item.fileNames.some((file) => resolve(file) === path)) })), { configuration, paths: sourcePaths.filter((path) => !assigned.has(path)) }].filter((item) => item.paths.length);
  const results = groups.map((group) => analyzeTypeScriptSources(ts, workspaceRoot, configurationRoot, group.paths, context, group.configuration, snapshot));
  const symbolsByFile = new Map<string, StructureSymbol[]>();
  for (const result of results) for (const [path, symbols] of result.symbolsByFile) symbolsByFile.set(path, [...new Map([...(symbolsByFile.get(path) ?? []), ...symbols].map((symbol) => [symbol.id, symbol])).values()]);
  return { relations: [...new Map(results.flatMap((result) => result.relations).map((item) => [item.id, item])).values()], symbolsByFile, diagnostics: [...new Map(results.flatMap((result) => result.diagnostics).map((item) => [JSON.stringify(item), item])).values()], operations: [...new Map(results.flatMap((result) => result.operations).map((item) => [JSON.stringify(item), item])).values()] };
}

function analyzeTypeScriptSources(ts: TypeScriptApi, workspaceRoot: string, configurationRoot: string, sourcePaths: string[], context: ProjectAnalysisContext, configuration: Configuration, snapshot?: SourceSnapshot): TypeScriptSemanticResult {
  const options = configuration.options;
  const scannedPaths = new Set(context.scopes.flatMap((scope) => scope.paths));
  sourcePaths.forEach((path) => { const scoped = projectPath(workspaceRoot, path); if (scoped) scannedPaths.add(scoped); });
  const sourceSet = new Set(sourcePaths);
  const host = ts.createCompilerHost(options);
  const libraryPath = host.getDefaultLibFileName(options);
  if (!options.noLib && !host.fileExists(libraryPath)) throw new TypeScriptRuntimeAssetError(libraryPath);
  host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, compilerOptions, sourceFile) => literals.map((literal) => {
    const resolvedModule = resolveModule(ts, workspaceRoot, context, literal.text, containingFile, compilerOptions,
      ts.getModeForUsageLocation(sourceFile, literal, compilerOptions), redirectedReference).resolvedModule;
    if (!resolvedModule) return { resolvedModule: undefined };
    if (!scannedPaths.has(projectPath(workspaceRoot, resolvedModule.resolvedFileName) ?? "")) {
      snapshot?.trackFile(resolvedModule.resolvedFileName);
      return { resolvedModule: undefined };
    }
    return { resolvedModule };
  });
  const requireRoots = sourcePaths.flatMap((path) => commonJsRoots(ts, workspaceRoot, context, path, options));
  const program = ts.createProgram({ rootNames: [...new Set([...sourcePaths, ...requireRoots])], options, host, projectReferences: configuration.projectReferences });
  const checker = program.getTypeChecker();
  const relations: SemanticRelation[] = [];
  const diagnostics: SemanticDiagnostic[] = [];
  const operations: SemanticOperationFact[] = [];
  const symbolsByFile = new Map<string, StructureSymbol[]>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceSet.has(resolve(sourceFile.fileName))) continue;
    const resolvedCurrentPath = projectPath(workspaceRoot, sourceFile.fileName);
    if (!resolvedCurrentPath) continue;
    const currentPath: string = resolvedCurrentPath;
    const scopeId = context.scopes.find((scope) => scope.language === "typescript" && scope.paths.includes(currentPath))?.id ?? `typescript:${projectPath(workspaceRoot, configurationRoot) ?? ""}`;
    const symbols: StructureSymbol[] = [];
    const importTargets = new Map<string, SemanticTarget>();
    function moduleRelation(node: TypeScript.StringLiteralLike, usage: SemanticImportUsage, mode: TypeScript.ResolutionMode): void {
      const resolution = resolveModule(ts, workspaceRoot, context, node.text, sourceFile.fileName, options, mode, undefined);
      const path = resolution.resolvedModule ? projectPath(workspaceRoot, resolution.resolvedModule.resolvedFileName) : undefined;
      let targetRef: SemanticTarget;
      if (path && scannedPaths.has(path)) {
        targetRef = { kind: "file", filePath: path };
      } else if (resolution.reason || node.text.startsWith(".") || resolution.package || (path && !scannedPaths.has(path))) {
        targetRef = { kind: "unresolved", reason: resolution.reason ?? `Module ${node.text} has no scanned implementation`, candidates: resolution.candidates ?? [] };
      } else {
        targetRef = { kind: "external", moduleName: node.text, standardLibrary: isStandardModule(node.text) };
      }
      importTargets.set(node.text, targetRef);
      const item = relation("import", currentPath, targetRef, node.text, rangeOf(sourceFile, node), scopeId, usage);
      relations.push(item);
      if (targetRef.kind === "unresolved") diagnostics.push({ code: "unresolved-import", severity: "warning", stage: "binding", message: targetRef.reason, filePath: currentPath, range: item.sourceRange, relationId: item.id, candidates: targetRef.candidates });
    }
    function addReference(kind: "call" | "inherit" | "render", node: TypeScript.Node, expression: TypeScript.Node, usage: SemanticImportUsage | undefined): void {
      const typeOnlyRuntimeReference = referenceIsTypeOnly(ts, checker, expression) && (kind !== "inherit" || ts.isHeritageClause(node.parent) && ts.isClassLike(node.parent.parent));
      const operation = kind === "call" ? sourceOperation(ts, checker, sourceFile, currentPath, scopeId, node as TypeScript.CallExpression | TypeScript.TaggedTemplateExpression, workspaceRoot, context) : undefined;
      if (operation) {
        operations.push(...operation.operations);
        diagnostics.push(...operation.diagnostics);
        return;
      }
      const symbol = resolvedSymbol(ts, checker, checker.getSymbolAtLocation(expression));
      const signature = ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node) ? checker.getResolvedSignature(node) : undefined;
      const commonJsDeclaration = commonJsTarget(ts, checker, program, workspaceRoot, context, options, expression);
      const declaration = implementationDeclaration(ts, symbol, commonJsDeclaration ?? signature?.declaration ?? symbol?.valueDeclaration ?? symbol?.declarations?.[0]);
      const declarationPath = declaration ? projectPath(workspaceRoot, declaration.getSourceFile().fileName) : undefined;
      const callable = kind !== "call" || declaration && isCallableImplementation(ts, declaration);
      if (!typeOnlyRuntimeReference && declaration && callable && declarationPath && scannedPaths.has(declarationPath) && !declaration.getSourceFile().isDeclarationFile) {
        const targetRef: SemanticTarget = { kind: "file", filePath: declarationPath, symbolId: declarationId(declarationPath, declaration), declarationRange: rangeOf(declaration.getSourceFile(), declaration) };
        relations.push(relation(kind, currentPath, targetRef, expression.getText(sourceFile), rangeOf(sourceFile, node), scopeId, usage));
        return;
      }
      // Declaration libraries provide type information, never implementation call edges.
      const base = referenceModule(ts, checker, expression);
      const importedTarget = base ? importTargets.get(base) : undefined;
      if (!typeOnlyRuntimeReference && (declaration?.getSourceFile().isDeclarationFile && !declarationPath || importedTarget?.kind === "external")) {
        const moduleName = base ?? declaration?.getSourceFile().fileName.match(/node_modules\/(?:@types\/)?((?:@[^/]+\/)?[^/]+)/)?.[1] ?? "global";
        relations.push(relation(kind, currentPath, { kind: "external", moduleName, standardLibrary: moduleName === "global" || isStandardModule(moduleName) }, expression.getText(sourceFile), rangeOf(sourceFile, node), scopeId, usage));
        return;
      }
      const declarationOnly = Boolean(declaration?.getSourceFile().isDeclarationFile);
      const reason = typeOnlyRuntimeReference ? `${kind} ${expression.getText(sourceFile)} uses a type-only import, which has no runtime binding` : declarationOnly ? `${kind} ${expression.getText(sourceFile)} resolves only to a declaration in ${declarationPath}; no implementation is available` : `Cannot bind ${kind} ${expression.getText(sourceFile)} to a scanned implementation`;
      const unresolved = relation(kind, currentPath, { kind: "unresolved", reason, candidates: [] }, expression.getText(sourceFile), rangeOf(sourceFile, node), scopeId, usage);
      relations.push(unresolved);
      diagnostics.push({ code: declarationOnly ? "declaration-only-call" : `unresolved-${kind}`, severity: "warning", stage: "binding", message: reason, filePath: currentPath, range: unresolved.sourceRange, relationId: unresolved.id, candidates: [] });
    }
    function visit(node: TypeScript.Node): void {
      const symbol = typedSymbol(ts, checker, sourceFile, currentPath, scopeId, node);
      if (symbol) symbols.push(symbol);
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        moduleRelation(node.moduleSpecifier, importUsage(ts, node), ts.getModeForUsageLocation(sourceFile, node.moduleSpecifier, options));
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
        moduleRelation(node.moduleReference.expression, node.isTypeOnly ? "type" : "value", ts.ModuleKind.CommonJS);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        moduleRelation(node.moduleSpecifier, node.isTypeOnly ? "type" : "value", ts.getModeForUsageLocation(sourceFile, node.moduleSpecifier, options));
      }
      if (ts.isCallExpression(node)) {
        const deferredImport = ts.isMetaProperty(node.expression) &&
          node.expression.keywordToken === ts.SyntaxKind.ImportKeyword && node.expression.name.text === "defer";
        const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword || deferredImport;
        const commonJs = ts.isIdentifier(node.expression) && node.expression.text === "require" && !hasLocalDeclaration(checker, node.expression);
        if (dynamicImport || commonJs) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteralLike(argument)) moduleRelation(argument, "value", commonJs ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext);
          else {
            const reason = `Cannot resolve nonliteral ${dynamicImport ? "import" : "require"} target`;
            const unresolved = relation("import", currentPath, { kind: "unresolved", reason, candidates: [] }, argument?.getText(sourceFile) ?? "missing module target", rangeOf(sourceFile, node), scopeId, "value");
            relations.push(unresolved);
            diagnostics.push({ code: "dynamic-import", severity: "warning", stage: "binding", message: reason, filePath: currentPath, range: unresolved.sourceRange, relationId: unresolved.id, candidates: [] });
          }
        } else addReference("call", node, node.expression, "value");
      }
      if (ts.isTaggedTemplateExpression(node)) addReference("call", node, node.tag, "value");
      if (ts.isHeritageClause(node)) for (const type of node.types) addReference("inherit", type, type.expression, "inherit");
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && !(ts.isIdentifier(node.tagName) && /^[a-z]/.test(node.tagName.text))) addReference("render", node, node.tagName, "value");
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    for (const diagnostic of program.getSyntacticDiagnostics(sourceFile)) diagnostics.push({ code: `typescript-${diagnostic.code}`, severity: "error", stage: "parsing", message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"), filePath: currentPath, range: diagnostic.start === undefined ? undefined : rangeOfPositions(sourceFile, diagnostic.start, diagnostic.start + (diagnostic.length ?? 0)) });
    symbolsByFile.set(currentPath, symbols);
  }
  return { relations, symbolsByFile, diagnostics, operations };
}

function compilerConfiguration(ts: TypeScriptApi, workspaceRoot: string, configurationRoot: string, context: ProjectAnalysisContext): Configuration {
  const rootPath = projectPath(workspaceRoot, configurationRoot) ?? "";
  const scope = context.scopes.find((item) => item.language === "typescript" && (item.rootPath === rootPath || item.rootPath === "." && rootPath === ""));
  const listedConfigs = scope?.configurationPaths.filter((path) => isTypeScriptProjectConfiguration(path) &&
    posix.dirname(path) === (rootPath || ".")) ?? [];
  const listedConfig = listedConfigs.find((path) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(path)) ?? listedConfigs[0];
  const configPath = listedConfig ? join(workspaceRoot, listedConfig) : ["tsconfig.json", "jsconfig.json"].map((fileName) => join(configurationRoot, fileName))
    .find((path) => isTypeScriptProjectConfiguration(projectPath(workspaceRoot, path) ?? "") && ts.sys.fileExists(path));
  if (!configPath) return { options: { allowJs: true, checkJs: false, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs, target: ts.ScriptTarget.ES2022, noEmit: true }, projectReferences: undefined, fileNames: [] };
  return readCompilerConfiguration(ts, configPath);
}

function readCompilerConfiguration(ts: TypeScriptApi, configPath: string): Configuration {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new SyntaxError(`TypeScript configuration ${configPath}: ${ts.flattenDiagnosticMessageText(config.error.messageText, "\n")}`);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configPath, ".."), undefined, configPath);
  // The scanner supplies root files explicitly; a valid configuration need not include them.
  const errors = parsed.errors.filter((error) => error.code !== 18003 && !isUnknownCompilerOption(error));
  if (errors.length) throw new SyntaxError(`TypeScript configuration ${configPath}: ${errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; ")}`);
  return { options: { ...parsed.options, allowJs: true, noEmit: true }, projectReferences: parsed.projectReferences, fileNames: parsed.fileNames };
}

function referencedConfigurations(ts: TypeScriptApi, references: readonly TypeScript.ProjectReference[] | undefined, ancestors: Set<string>): Configuration[] {
  return (references ?? []).flatMap((reference) => {
    const path = ts.resolveProjectReferencePath(reference);
    if (ancestors.has(path)) throw new SyntaxError(`TypeScript configuration reference cycle at ${path}`);
    const configuration = readCompilerConfiguration(ts, path);
    return [configuration, ...referencedConfigurations(ts, configuration.projectReferences, new Set([...ancestors, path]))];
  });
}

function resolveModule(ts: TypeScriptApi, workspaceRoot: string, context: ProjectAnalysisContext, specifier: string, containingFile: string, options: TypeScript.CompilerOptions, mode: TypeScript.ResolutionMode, redirectedReference: TypeScript.ResolvedProjectReference | undefined): ModuleResolution {
  if (isStandardModule(specifier)) return { resolvedModule: ts.resolveModuleName(specifier, containingFile, options, ts.sys, undefined, redirectedReference, mode).resolvedModule, reason: undefined, package: undefined };
  const sourcePath = projectPath(workspaceRoot, containingFile) ?? "";
  const packages = context.packages.filter((item) => (specifier === item.name || specifier.startsWith(`${item.name}/`)) && (!item.workspaceRoot || withinRoot(sourcePath, item.workspaceRoot)));
  const orderedPackages = [...packages].sort((left, right) => Number(withinRoot(sourcePath, right.rootPath)) - Number(withinRoot(sourcePath, left.rootPath)) || (right.workspaceRoot?.length ?? 0) - (left.workspaceRoot?.length ?? 0));
  const packageInfo = orderedPackages[0];
  if (!packageInfo) {
    const resolvedModule = ts.resolveModuleName(specifier, containingFile, options, ts.sys, undefined, redirectedReference, mode).resolvedModule;
    const alias = Object.keys(options.paths ?? {}).find((pattern) => {
      const [prefix, suffix] = pattern.split("*");
      return suffix === undefined ? pattern === specifier : specifier.startsWith(prefix) && specifier.endsWith(suffix);
    });
    return { resolvedModule, reason: !resolvedModule && alias ? `Configured TypeScript alias ${specifier} (${alias}) has no resolvable target` : undefined, package: undefined };
  }
  const equallyVisible = orderedPackages.filter((item) => withinRoot(sourcePath, item.rootPath) === withinRoot(sourcePath, packageInfo.rootPath) && (item.workspaceRoot?.length ?? 0) === (packageInfo.workspaceRoot?.length ?? 0));
  if (equallyVisible.length > 1) return { resolvedModule: undefined, reason: `Package ${packageInfo.name} is ambiguous between ${equallyVisible.map((item) => item.rootPath).join(", ")}`, package: packageInfo };
  const subpath = specifier === packageInfo.name ? "." : `.${specifier.slice(packageInfo.name.length)}`;
  const conditions = new Set(["types", mode === ts.ModuleKind.CommonJS ? "require" : "import", ...(options.moduleResolution === ts.ModuleResolutionKind.Bundler ? [] : ["node"]), "default", ...(options.customConditions ?? [])]);
  const exportPath = packageInfo.exports === undefined ? subpath === "." ? packageInfo.types ?? packageInfo.main : undefined : packageExport(packageInfo.exports, subpath, conditions);
  if (!exportPath) return { resolvedModule: undefined, reason: `Package ${packageInfo.name} does not export ${subpath} for ${mode === ts.ModuleKind.CommonJS ? "require" : "import"}`, package: packageInfo };
  if (packageInfo.exports !== undefined && !exportPath.startsWith("./")) return { resolvedModule: undefined, reason: `Package ${packageInfo.name} export ${exportPath} must begin with ./`, package: packageInfo };
  const requestedPath = resolve(workspaceRoot, packageInfo.rootPath, exportPath);
  const packageRoot = resolve(workspaceRoot, packageInfo.rootPath);
  if (!withinAbsoluteRoot(requestedPath, packageRoot)) return { resolvedModule: undefined, reason: `Package ${packageInfo.name} export ${exportPath} escapes its root`, package: packageInfo };
  const existing = ts.sys.fileExists(requestedPath) ? requestedPath : undefined;
  const candidates = existing ? [existing] : sourceExport(ts, workspaceRoot, packageInfo, requestedPath, context);
  if (candidates.length > 1) return { resolvedModule: undefined, reason: `Package ${packageInfo.name} export ${exportPath} has ambiguous configured source mappings`, candidates: candidates.map((path) => projectPath(workspaceRoot, path)!).sort(), package: packageInfo };
  const mapped = candidates[0];
  if (!mapped) return { resolvedModule: undefined, reason: `Package ${packageInfo.name} export ${exportPath} is missing and has no configured source mapping`, package: packageInfo };
  return { resolvedModule: { resolvedFileName: mapped, extension: sourceExtension(ts, mapped), isExternalLibraryImport: false }, reason: undefined, package: packageInfo };
}

function packageExport(exports: PackageExport, subpath: string, conditions: Set<string>): string | undefined {
  if (exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith("."))) {
    if (Object.prototype.hasOwnProperty.call(exports, subpath)) return conditionalExport(exports[subpath], conditions);
    const patterns = Object.keys(exports).filter((key) => key.includes("*")).sort((left, right) => right.indexOf("*") - left.indexOf("*") || right.length - left.length);
    for (const pattern of patterns) {
      const [prefix, suffix] = pattern.split("*");
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      const target = conditionalExport(exports[pattern], conditions);
      return target?.replaceAll("*", subpath.slice(prefix.length, subpath.length - suffix.length));
    }
    return undefined;
  }
  return subpath === "." ? conditionalExport(exports, conditions) : undefined;
}

function conditionalExport(value: PackageExport, conditions: Set<string>): string | undefined {
  if (typeof value === "string") return value;
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => conditionalExport(item, conditions)).find((item) => item !== undefined);
  for (const [condition, target] of Object.entries(value)) if (conditions.has(condition)) return conditionalExport(target, conditions);
  return undefined;
}

function sourceExport(ts: TypeScriptApi, workspaceRoot: string, packageInfo: WorkspacePackage, requestedPath: string, context: ProjectAnalysisContext): string[] {
  const configurationPath = packageInfo.configurationPath ? resolve(workspaceRoot, packageInfo.configurationPath) : resolve(workspaceRoot, packageInfo.rootPath, "tsconfig.json");
  if (!ts.sys.fileExists(configurationPath)) return [];
  const config = ts.readConfigFile(configurationPath, ts.sys.readFile);
  if (config.error) throw new SyntaxError(`TypeScript configuration ${configurationPath}: ${ts.flattenDiagnosticMessageText(config.error.messageText, "\n")}`);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configurationPath, ".."), undefined, configurationPath);
  const errors = parsed.errors.filter((error) => error.code !== 18003 && !isUnknownCompilerOption(error));
  if (errors.length) throw new SyntaxError(`TypeScript configuration ${configurationPath}: ${errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; ")}`);
  const { rootDir, outDir, jsx, declaration, composite, emitDeclarationOnly, declarationDir } = parsed.options;
  if (!rootDir || !outDir) return [];
  const scanned = new Set(context.scopes.flatMap((scope) => scope.paths));
  return parsed.fileNames.filter((path) => {
    if (/\.d\.[cm]?ts$/.test(path) || !ts.sys.fileExists(path) || !scanned.has(projectPath(workspaceRoot, path) ?? "") || !withinAbsoluteRoot(path, rootDir)) return false;
    const extension = path.match(/\.[^.]+$/)?.[0];
    if (!extension || !/^\.(?:[cm]?[jt]s|[jt]sx)$/.test(extension)) return false;
    const stem = relative(rootDir, path).slice(0, -extension.length);
    const outputExtension = extension === ".mts" || extension === ".mjs" ? ".mjs" : extension === ".cts" || extension === ".cjs" ? ".cjs" : (extension === ".tsx" || extension === ".jsx") && jsx === ts.JsxEmit.Preserve ? ".jsx" : ".js";
    const declarationExtension = outputExtension === ".mjs" ? ".d.mts" : outputExtension === ".cjs" ? ".d.cts" : ".d.ts";
    return !emitDeclarationOnly && resolve(outDir, stem + outputExtension) === requestedPath || Boolean(declaration || composite) && resolve(declarationDir ?? outDir, stem + declarationExtension) === requestedPath;
  }).sort();
}

function sourceExtension(ts: TypeScriptApi, path: string): TypeScript.Extension {
  if (path.endsWith(".d.ts")) return ts.Extension.Dts;
  if (path.endsWith(".d.mts")) return ts.Extension.Dmts;
  if (path.endsWith(".d.cts")) return ts.Extension.Dcts;
  if (path.endsWith(".tsx")) return ts.Extension.Tsx;
  if (path.endsWith(".jsx")) return ts.Extension.Jsx;
  if (path.endsWith(".mts")) return ts.Extension.Mts;
  if (path.endsWith(".cts")) return ts.Extension.Cts;
  if (path.endsWith(".mjs")) return ts.Extension.Mjs;
  if (path.endsWith(".cjs")) return ts.Extension.Cjs;
  return path.endsWith(".ts") ? ts.Extension.Ts : ts.Extension.Js;
}

function withinAbsoluteRoot(path: string, root: string): boolean {
  const local = relative(root, path);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function withinRoot(path: string, root: string): boolean {
  return !root || root === "." || path === root || path.startsWith(`${root}/`);
}

function isStandardModule(name: string): boolean {
  return name.startsWith("node:") || builtinModules.includes(name);
}

function importUsage(ts: TypeScriptApi, node: TypeScript.ImportDeclaration): SemanticImportUsage {
  if (!node.importClause) return "side-effect";
  if (node.importClause.isTypeOnly) return "type";
  const bindings = node.importClause.namedBindings;
  return bindings && ts.isNamedImports(bindings) && bindings.elements.every((item) => item.isTypeOnly) && !node.importClause.name ? "type" : "value";
}

function hasLocalDeclaration(checker: TypeScript.TypeChecker, node: TypeScript.Node): boolean {
  return Boolean(checker.getSymbolAtLocation(node)?.declarations?.some((declaration) => !declaration.getSourceFile().isDeclarationFile));
}

function referenceModule(ts: TypeScriptApi, checker: TypeScript.TypeChecker, node: TypeScript.Node): string | undefined {
  let base = node;
  while (ts.isPropertyAccessExpression(base)) base = base.expression;
  const declaration = checker.getSymbolAtLocation(base)?.declarations?.[0];
  if (!declaration) return undefined;
  let ancestor: TypeScript.Node | undefined = declaration;
  while (ancestor && !ts.isImportDeclaration(ancestor)) ancestor = ancestor.parent;
  return ancestor && ts.isImportDeclaration(ancestor) && ts.isStringLiteralLike(ancestor.moduleSpecifier) ? ancestor.moduleSpecifier.text : undefined;
}

function referenceIsTypeOnly(ts: TypeScriptApi, checker: TypeScript.TypeChecker, node: TypeScript.Node): boolean {
  let base = node;
  while (ts.isPropertyAccessExpression(base)) base = base.expression;
  const declaration = checker.getSymbolAtLocation(base)?.declarations?.[0];
  if (!declaration) return false;
  if (ts.isImportSpecifier(declaration) && declaration.isTypeOnly) return true;
  let ancestor: TypeScript.Node | undefined = declaration;
  while (ancestor && !ts.isImportDeclaration(ancestor)) ancestor = ancestor.parent;
  return Boolean(ancestor && ts.isImportDeclaration(ancestor) && ancestor.importClause?.isTypeOnly);
}

function resolvedSymbol(ts: TypeScriptApi, checker: TypeScript.TypeChecker, symbol: TypeScript.Symbol | undefined): TypeScript.Symbol | undefined {
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function implementationDeclaration(ts: TypeScriptApi, symbol: TypeScript.Symbol | undefined, declaration: TypeScript.Declaration | undefined): TypeScript.Declaration | undefined {
  const implementation = symbol?.declarations?.find((node) => (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body);
  if (implementation) return implementation;
  if (declaration && (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) && ts.isVariableDeclaration(declaration.parent)) return declaration.parent;
  return declaration;
}

function isCallableImplementation(ts: TypeScriptApi, node: TypeScript.Declaration): boolean {
  if (ts.isVariableDeclaration(node)) return Boolean(node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)));
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return Boolean(node.body);
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function commonJsRoots(ts: TypeScriptApi, workspaceRoot: string, context: ProjectAnalysisContext, path: string, options: TypeScript.CompilerOptions): string[] {
  const content = ts.sys.readFile(path);
  if (content === undefined) throw new Error(`Cannot read scanned TypeScript source ${path}`);
  const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const paths: string[] = [];
  const scanned = new Set(context.scopes.flatMap((scope) => scope.paths));
  function visit(node: TypeScript.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const target = resolveModule(ts, workspaceRoot, context, node.arguments[0].text, path, options, ts.ModuleKind.CommonJS, undefined).resolvedModule;
      if (target && scanned.has(projectPath(workspaceRoot, target.resolvedFileName) ?? "")) paths.push(target.resolvedFileName);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return paths;
}

function commonJsTarget(ts: TypeScriptApi, checker: TypeScript.TypeChecker, program: TypeScript.Program, workspaceRoot: string, context: ProjectAnalysisContext, options: TypeScript.CompilerOptions, expression: TypeScript.Node): TypeScript.Declaration | undefined {
  const base = ts.isPropertyAccessExpression(expression) ? expression.expression : expression;
  const declaration = checker.getSymbolAtLocation(base)?.valueDeclaration;
  const variable = declaration && ts.isBindingElement(declaration) ? declaration.parent.parent : declaration;
  if (!variable || !ts.isVariableDeclaration(variable) || !variable.initializer || !ts.isCallExpression(variable.initializer)) return undefined;
  const initializer = variable.initializer;
  if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== "require" || hasLocalDeclaration(checker, initializer.expression)) return undefined;
  const specifier = initializer.arguments[0];
  if (!specifier || !ts.isStringLiteralLike(specifier)) return undefined;
  const resolved = resolveModule(ts, workspaceRoot, context, specifier.text, initializer.getSourceFile().fileName, options, ts.ModuleKind.CommonJS, undefined).resolvedModule;
  const source = resolved ? program.getSourceFile(resolved.resolvedFileName) : undefined;
  const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
  if (!moduleSymbol || !source) return undefined;
  const bindingName = declaration && ts.isBindingElement(declaration) ? declaration.propertyName ?? declaration.name : undefined;
  const exportName = ts.isPropertyAccessExpression(expression) ? expression.name.text : bindingName && ts.isIdentifier(bindingName) ? bindingName.text : "export=";
  const exported = resolvedSymbol(ts, checker, checker.getExportsOfModule(moduleSymbol).find((item) => item.name === exportName));
  if (!exported) return undefined;
  return checker.getTypeOfSymbolAtLocation(exported, source).getCallSignatures()[0]?.declaration ?? exported.valueDeclaration ?? exported.declarations?.[0];
}

function projectPath(rootPath: string, absolutePath: string): string | undefined {
  const fromRoot = relative(rootPath, absolutePath);
  if (!fromRoot || !withinAbsoluteRoot(absolutePath, rootPath) || fromRoot.split(sep).includes("node_modules")) return undefined;
  return fromRoot.split(sep).join("/");
}

function rangeOf(sourceFile: TypeScript.SourceFile, node: TypeScript.Node): SourceRange {
  return rangeOfPositions(sourceFile, node.getStart(sourceFile), node.getEnd());
}

function rangeOfPositions(sourceFile: TypeScript.SourceFile, start: number, end: number): SourceRange {
  const from = sourceFile.getLineAndCharacterOfPosition(start);
  const to = sourceFile.getLineAndCharacterOfPosition(end);
  return { start: { line: from.line + 1, column: from.character + 1 }, end: { line: to.line + 1, column: to.character + 1 } };
}

function declarationId(filePath: string, node: TypeScript.Node): string {
  const range = rangeOf(node.getSourceFile(), node);
  return createHash("sha256").update(`${filePath}\0${range.start.line}:${range.start.column}\0${range.end.line}:${range.end.column}`).digest("hex").slice(0, 24);
}

function relation(kind: SemanticRelation["kind"], sourceFile: string, targetRef: SemanticTarget, symbol: string, sourceRange: SourceRange, scopeId: string, usage: SemanticImportUsage | undefined): SemanticRelation {
  const target = targetRef.kind === "file" ? targetRef.filePath : targetRef.kind === "external" ? `external:${targetRef.moduleName}` : targetRef.kind === "resource" ? targetRef.resourceId : symbol;
  return { id: createHash("sha256").update(`${kind}\0${sourceFile}\0${sourceRange.start.line}:${sourceRange.start.column}\0${sourceRange.end.line}:${sourceRange.end.column}\0${target}\0${symbol}`).digest("hex").slice(0, 24), kind, source: sourceFile, target, sourceFile, targetFile: targetRef.kind === "file" ? targetRef.filePath : undefined, symbol, detail: `${sourceFile} ${kind}s ${symbol} from ${target}`, confidence: targetRef.kind === "unresolved" ? "inferred" : "confirmed", sourceRange, targetRef, scopeId, bindingBasis: "typescript-checker", importUsage: usage };
}

function typedSymbol(ts: TypeScriptApi, checker: TypeScript.TypeChecker, sourceFile: TypeScript.SourceFile, filePath: string, scopeId: string, node: TypeScript.Node): StructureSymbol | undefined {
  if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node) && !ts.isClassDeclaration(node) && !(ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))) return undefined;
  const nameNode = node.name;
  if (!nameNode || !ts.isIdentifier(nameNode)) return undefined;
  const signatureNode = ts.isVariableDeclaration(node) ? node.initializer : node;
  const signature = signatureNode && ts.isFunctionLike(signatureNode) ? checker.getSignatureFromDeclaration(signatureNode as TypeScript.SignatureDeclaration) : undefined;
  const owner = ts.isMethodDeclaration(node) && ts.isClassLike(node.parent) && node.parent.name ? `${node.parent.name.text}.` : "";
  return { id: declarationId(filePath, node), qualifiedName: `${filePath}:${owner}${nameNode.text}`, scopeId, range: rangeOf(sourceFile, node), name: nameNode.text, kind: ts.isClassDeclaration(node) ? "class" : ts.isMethodDeclaration(node) ? "method" : "function", filePath, exported: ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)), line: rangeOf(sourceFile, node).start.line, signature: ts.isClassDeclaration(node) ? checker.typeToString(checker.getTypeAtLocation(node)) : signature ? checker.signatureToString(signature) : undefined };
}

function isTypeScriptFile(path: string): boolean {
  return /\.(tsx?|jsx?|[cm]?[jt]s)$/.test(path);
}

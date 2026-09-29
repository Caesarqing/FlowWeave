import { createHash } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import { relative } from "node:path";
import type * as TypeScript from "typescript";
import type { ProjectAnalysisContext, SemanticDiagnostic, SemanticHttpMethod, SemanticOperationFact } from "../../types";

type ApiBinding = {
  moduleName: string;
  apiName: string;
  receiverId: string | undefined;
  issue?: string;
  options?: TypeScript.Expression;
  prepared?: { sql: string | undefined; scope: TypeScript.Node };
};
type BindingContext = { root: string; project: ProjectAnalysisContext };
type TypeScriptApi = typeof TypeScript;

export function sourceOperation(ts: TypeScriptApi, checker: TypeScript.TypeChecker, sourceFile: TypeScript.SourceFile, filePath: string, scopeId: string, call: TypeScript.CallExpression | TypeScript.TaggedTemplateExpression, workspaceRoot: string, project: ProjectAnalysisContext): { operations: SemanticOperationFact[]; diagnostics: SemanticDiagnostic[] } | undefined {
  const context = { root: workspaceRoot, project };
  const expression = ts.isCallExpression(call) ? call.expression : call.tag;
  const binding = apiBinding(ts, checker, expression, new Set(), context);
  if (!binding) return undefined;
  const moduleName = binding.moduleName.replace(/^node:/, "");
  const api = binding.apiName.split(".").at(-1) ?? binding.apiName;
  const args = ts.isCallExpression(call) ? call.arguments : ts.isNoSubstitutionTemplateLiteral(call.template) ? [call.template] : [];
  const target = literalValue(ts, checker, args[0], new Set()) ?? objectString(ts, checker, args[0], "url");
  const start = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(call.getEnd());
  const base = { filePath, scopeId, moduleName: binding.moduleName, apiName: api, receiverId: binding.receiverId, unresolvedReason: binding.issue, range: { start: { line: start.line + 1, column: start.character + 1 }, end: { line: end.line + 1, column: end.character + 1 } }, confidence: "confirmed" as const };
  function result(operations: SemanticOperationFact[]): { operations: SemanticOperationFact[]; diagnostics: SemanticDiagnostic[] } {
    return { operations, diagnostics: operations.flatMap((fact) => fact.unresolvedReason || !fact.target ? [{ code: "unresolved-operation-target", severity: "warning" as const, filePath, range: fact.range, message: fact.unresolvedReason ?? `Cannot statically resolve ${fact.moduleName}.${fact.apiName} target` }] : []) };
  }
  if ((moduleName === "fs" || moduleName === "fs/promises") && /^(?:promises\.)?(readFile|readFileSync|readdir|readdirSync|stat|statSync|lstat|lstatSync|access|accessSync|open|openSync|createReadStream|writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|unlink|unlinkSync|rm|rmSync|rename|renameSync|copyFile|copyFileSync|createWriteStream)$/.test(binding.apiName)) {
    if (/^(copyFile|rename)(Sync)?$/.test(api)) return result([
      { ...base, kind: "filesystem", operation: api.startsWith("copy") ? "read" : "write", target, role: "source" },
      { ...base, kind: "filesystem", operation: "write", target: literalValue(ts, checker, args[1], new Set()), role: "target" }
    ]);
    if (/^open(Sync)?$/.test(api)) {
      const modes = openOperations(ts, checker, args[1], context);
      return result(modes ? modes.map((operation) => ({ ...base, kind: "filesystem", operation, target })) : [{ ...base, kind: "filesystem", operation: "invoke", target, unresolvedReason: "Filesystem open flags are missing, dynamic, or unsupported; read/write direction is not proven" }]);
    }
    return result([{ ...base, kind: "filesystem", operation: /^(write|append|mkdir|unlink|rm|createWrite)/.test(api) ? "write" : "read", target }]);
  }
  if (moduleName === "child_process" && /^(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)$/.test(binding.apiName)) return result([{ ...base, kind: "process", operation: "invoke", target }]);
  if ((moduleName === "events" && /^EventEmitter\./.test(binding.apiName) || moduleName === "electron" && /^(?:ipcMain|ipcRenderer|BrowserWindow\.webContents)\./.test(binding.apiName)) && /^(emit|send|sendSync|invoke|on|once|addListener|handle|handleOnce)$/.test(api)) {
    return result([{ ...base, receiverId: binding.receiverId ?? (moduleName === "electron" ? `${scopeId}:${binding.apiName.split(".").slice(0, -1).join(".")}` : undefined), kind: "event", operation: /^(on|once|addListener|handle|handleOnce)$/.test(api) ? "subscribe" : "publish", target }]);
  }
  if (moduleName === "global" && binding.apiName === "fetch" || moduleName === "node-fetch" && /^(default|\*)$/.test(binding.apiName) || moduleName === "undici" && binding.apiName === "fetch" || moduleName === "axios" && /^(?:client\.)?(default|\*|client|request|get|post|put|patch|delete|options|head)$/.test(binding.apiName) || (moduleName === "http" || moduleName === "https") && /^(request|get)$/.test(binding.apiName)) {
    const method = ts.isCallExpression(call) ? requestMethod(ts, checker, call, moduleName, api, binding.options) : "UNKNOWN";
    const http = httpTarget(ts, checker, args, moduleName, api, target, binding.options);
    return result([{ ...base, kind: "http", operation: method === "GET" || method === "HEAD" ? "read" : method === "UNKNOWN" ? "invoke" : "write", ...http, method }]);
  }
  if (moduleName === "@prisma/client" && /\bPrismaClient\.[^.]+\./.test(binding.apiName)) {
    const table = binding.apiName.split(".").at(-2);
    if (/^(findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|count|aggregate|groupBy|create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(api)) return result([{ ...base, kind: "database", operation: /^(find|count|aggregate|groupBy)/.test(api) ? "read" : "write", target: table }]);
  }
  if (/^(better-sqlite3|sqlite3)$/.test(moduleName) && /^(?:Database|default|\*|Statement)\.(exec|run|all|get|prepare)$/.test(binding.apiName)) {
    if (api === "prepare") return result([]);
    const sql = binding.prepared ? binding.prepared.sql : target;
    const crossFunction = binding.prepared && binding.prepared.scope !== executionScope(ts, call);
    return result([{ ...base, kind: "database", operation: sqlOperation(sql), target: sql, unresolvedReason: crossFunction ? "Prepared statement crosses a function boundary; execution binding is not proven" : binding.issue }]);
  }
  if (moduleName === "pg" && /^(?:Pool|Client)\.query$/.test(binding.apiName) || /^(mysql|mysql2|mysql2\/promise)$/.test(moduleName) && /^(?:createConnection|createPool)\.(query|execute)$/.test(binding.apiName) || moduleName === "postgres" && /^sql(?:\.unsafe)?$/.test(binding.apiName) || moduleName === "@vercel/postgres" && /^(sql|sql\.query)$/.test(binding.apiName)) return result([{ ...base, kind: "database", operation: sqlOperation(target), target }]);
  return undefined;
}

function sqlOperation(sql: string | undefined): SemanticOperationFact["operation"] {
  return sql && /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) ? "read" : sql && /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i.test(sql) ? "write" : "invoke";
}

function apiBinding(ts: TypeScriptApi, checker: TypeScript.TypeChecker, expression: TypeScript.Expression, visited: Set<TypeScript.Node>, context: BindingContext): ApiBinding | undefined {
  if (visited.has(expression)) return undefined;
  const nextVisited = new Set([...visited, expression]);
  if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return apiBinding(ts, checker, expression.expression, nextVisited, context);
  if (ts.isPropertyAccessExpression(expression)) {
    const propertyDeclaration = checker.getSymbolAtLocation(expression.name)?.valueDeclaration;
    if (propertyDeclaration && !propertyDeclaration.getSourceFile().isDeclarationFile && ts.isVariableDeclaration(propertyDeclaration) && ts.isIdentifier(propertyDeclaration.name)) return apiBinding(ts, checker, propertyDeclaration.name, nextVisited, context);
    const base = apiBinding(ts, checker, expression.expression, nextVisited, context);
    if (base) return { ...base, apiName: base.apiName === "*" || base.apiName === "default" ? expression.name.text : `${base.apiName}.${expression.name.text}` };
  }
  if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
    if (ts.isCallExpression(expression) && (expression.expression.kind === ts.SyntaxKind.ImportKeyword || isGlobalRequire(ts, checker, expression.expression))) {
      const module = expression.arguments[0];
      return module && ts.isStringLiteralLike(module) ? { moduleName: module.text, apiName: "*", receiverId: undefined } : undefined;
    }
    const factory = apiBinding(ts, checker, expression.expression, nextVisited, context);
    if (factory && ts.isNewExpression(expression)) {
      const identity = declarationIdentity(ts, expression, context);
      return { ...factory, ...identity, apiName: factory.moduleName.replace(/^node:/, "") === "events" && /^(default|\*)$/.test(factory.apiName) ? "EventEmitter" : factory.moduleName === "better-sqlite3" && /^(default|\*)$/.test(factory.apiName) ? "Database" : factory.apiName };
    }
    if (factory && /^(sqlite3|better-sqlite3)$/.test(factory.moduleName) && /^(Database|default|\*)\.prepare$/.test(factory.apiName)) return { ...factory, apiName: "Statement", prepared: { sql: literalValue(ts, checker, expression.arguments?.[0], new Set()), scope: executionScope(ts, expression) } };
    if (factory && factory.moduleName === "sqlite3" && factory.apiName === "verbose") return { ...factory, apiName: "*" };
    if (factory && factory.moduleName === "better-sqlite3" && /^(default|\*)$/.test(factory.apiName)) return { ...factory, ...declarationIdentity(ts, expression, context), apiName: "Database" };
    if (factory && factory.moduleName === "sqlite3" && /^Database\.(run|all|get|exec|each)$/.test(factory.apiName)) return { ...factory, apiName: "Database" };
    if (factory && /^(sqlite3|better-sqlite3)$/.test(factory.moduleName) && /^Statement\.(bind|reset)$/.test(factory.apiName) || factory && factory.moduleName === "sqlite3" && /^Statement\.(run|all|get)$/.test(factory.apiName)) return { ...factory, apiName: "Statement" };
    if (factory && factory.moduleName === "axios" && factory.apiName === "create") return { ...factory, apiName: "client", options: expression.arguments?.[0] };
    if (factory && factory.moduleName === "postgres" && /^(default|\*)$/.test(factory.apiName)) return { ...factory, ...declarationIdentity(ts, expression, context), apiName: "sql" };
    if (factory && /^(mysql2?(\/promise)?|knex)$/.test(factory.moduleName)) return { ...factory, ...declarationIdentity(ts, expression, context) };
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return undefined;
  if (ts.isIdentifier(expression) && expression.text === "fetch" && declaration.getSourceFile().isDeclarationFile && /(?:\blib\.dom|@types\/node\/web-globals\/fetch)\.d\.ts$/.test(declaration.getSourceFile().fileName)) return { moduleName: "global", apiName: "fetch", receiverId: undefined };
  if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
    const importDeclaration = ancestorImport(ts, declaration);
    if (!importDeclaration || !ts.isStringLiteralLike(importDeclaration.moduleSpecifier)) return undefined;
    if (importDeclaration.importClause?.isTypeOnly || ts.isImportSpecifier(declaration) && declaration.isTypeOnly) return undefined;
    const imported = checker.getImmediateAliasedSymbol(symbol!);
    const importedDeclaration = imported?.valueDeclaration ?? imported?.declarations?.[0];
    if (importedDeclaration && !importedDeclaration.getSourceFile().isDeclarationFile && (ts.isVariableDeclaration(importedDeclaration) || ts.isImportSpecifier(importedDeclaration) || ts.isExportSpecifier(importedDeclaration)) && ts.isIdentifier(importedDeclaration.name)) {
      const linked = apiBinding(ts, checker, importedDeclaration.name, nextVisited, context);
      if (linked) return linked;
    }
    if (importedDeclaration && !importedDeclaration.getSourceFile().isDeclarationFile) return undefined;
    const apiName = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : ts.isNamespaceImport(declaration) ? "*" : "default";
    return { moduleName: importDeclaration.moduleSpecifier.text, apiName, receiverId: undefined };
  }
  if (ts.isExportSpecifier(declaration)) {
    const immediate = symbol ? checker.getImmediateAliasedSymbol(symbol) : undefined;
    const target = immediate?.valueDeclaration ?? immediate?.declarations?.[0];
    if (target && !target.getSourceFile().isDeclarationFile && (ts.isVariableDeclaration(target) || ts.isImportSpecifier(target) || ts.isExportSpecifier(target)) && ts.isIdentifier(target.name)) {
      const linked = apiBinding(ts, checker, target.name, nextVisited, context);
      if (linked) return linked;
    }
    const exported = declaration.parent.parent;
    if (ts.isExportDeclaration(exported) && exported.moduleSpecifier && ts.isStringLiteralLike(exported.moduleSpecifier)) return { moduleName: exported.moduleSpecifier.text, apiName: (declaration.propertyName ?? declaration.name).text, receiverId: undefined };
    return undefined;
  }
  if (ts.isImportEqualsDeclaration(declaration) && ts.isExternalModuleReference(declaration.moduleReference) && declaration.moduleReference.expression && ts.isStringLiteralLike(declaration.moduleReference.expression)) return { moduleName: declaration.moduleReference.expression.text, apiName: "*", receiverId: undefined };
  if ((ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer) {
    if (ts.isVariableDeclaration(declaration) && !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
    const binding = apiBinding(ts, checker, declaration.initializer, nextVisited, context);
    return binding;
  }
  if (ts.isBindingElement(declaration)) {
    const parent = declaration.parent.parent;
    if (!ts.isVariableDeclaration(parent) || !parent.initializer || !(parent.parent.flags & ts.NodeFlags.Const)) return undefined;
    const binding = apiBinding(ts, checker, parent.initializer, nextVisited, context);
    const property = declaration.propertyName ?? declaration.name;
    return binding && ts.isIdentifier(property) ? { ...binding, apiName: property.text, receiverId: binding.receiverId } : undefined;
  }
  return undefined;
}

function ancestorImport(ts: TypeScriptApi, node: TypeScript.Node): TypeScript.ImportDeclaration | undefined {
  let current: TypeScript.Node | undefined = node;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  return current && ts.isImportDeclaration(current) ? current : undefined;
}

function isGlobalRequire(ts: TypeScriptApi, checker: TypeScript.TypeChecker, expression: TypeScript.Expression): boolean {
  return ts.isIdentifier(expression) && expression.text === "require" && !checker.getSymbolAtLocation(expression)?.declarations?.some((node) => !node.getSourceFile().isDeclarationFile);
}

function executionScope(ts: TypeScriptApi, node: TypeScript.Node): TypeScript.Node {
  let current = node.parent;
  while (current.parent && !ts.isFunctionLike(current)) current = current.parent;
  return current;
}

function declarationIdentity(ts: TypeScriptApi, node: TypeScript.Node, context: BindingContext): { receiverId: string | undefined; issue?: string } {
  let declaration = node.parent;
  while (ts.isParenthesizedExpression(declaration) || ts.isAwaitExpression(declaration)) declaration = declaration.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return { receiverId: undefined, issue: "Instance has no unique variable declaration anchor" };
  const source = node.getSourceFile();
  function anchor(item: TypeScript.VariableDeclaration): string {
    const names = [item.name.getText(source)];
    let parent: TypeScript.Node = item.parent;
    while (parent !== source) {
      if (ts.isFunctionLike(parent) || ts.isClassLike(parent)) {
        const name = parent.name?.getText(source) ?? (ts.isVariableDeclaration(parent.parent) ? parent.parent.name.getText(source) : "<anonymous>");
        names.unshift(name);
      }
      parent = parent.parent;
    }
    return names.join("/");
  }
  const key = anchor(declaration);
  let matches = 0;
  function count(item: TypeScript.Node): void {
    if (ts.isVariableDeclaration(item) && anchor(item) === key) matches++;
    ts.forEachChild(item, count);
  }
  count(source);
  if (matches !== 1) return { receiverId: undefined, issue: `Instance declaration anchor ${key} is ambiguous` };
  const path = relative(context.root, source.fileName).replaceAll("\\", "/");
  const scopeId = context.project.scopes.find((scope) => scope.language === "typescript" && scope.paths.includes(path))?.id;
  if (!scopeId) return { receiverId: undefined, issue: "Instance declaration is outside a scanned TypeScript scope" };
  return { receiverId: createHash("sha256").update(`${scopeId}\0${path}\0${key}`).digest("hex").slice(0, 24) };
}

function literalValue(ts: TypeScriptApi, checker: TypeScript.TypeChecker, expression: TypeScript.Expression | undefined, visited: Set<TypeScript.Node>): string | undefined {
  if (!expression || visited.has(expression)) return undefined;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isIdentifier(expression)) {
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const) return literalValue(ts, checker, declaration.initializer, new Set([...visited, expression]));
  }
  return undefined;
}

function requestMethod(ts: TypeScriptApi, checker: TypeScript.TypeChecker, call: TypeScript.CallExpression, moduleName: string, apiName: string, defaults: TypeScript.Expression | undefined): SemanticHttpMethod {
  const upper = apiName.toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(upper)) return upper as SemanticHttpMethod;
  const configuration = moduleName === "axios" ? httpConfiguration(ts, checker, call.arguments, apiName) : (moduleName === "http" || moduleName === "https") && call.arguments[0] && ts.isObjectLiteralExpression(call.arguments[0]) ? call.arguments[0] : call.arguments[1];
  if (configuration && (ts.isArrowFunction(configuration) || ts.isFunctionExpression(configuration))) return "GET";
  const local = staticOption(ts, checker, configuration, "method");
  const option = local.kind === "absent" && moduleName === "axios" ? staticOption(ts, checker, defaults, "method") : local;
  if (option.kind === "absent") return "GET";
  const method = option.kind === "value" ? literalValue(ts, checker, option.expression, new Set())?.toUpperCase() : undefined;
  return method && ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method) ? method as SemanticHttpMethod : "UNKNOWN";
}

function objectString(ts: TypeScriptApi, checker: TypeScript.TypeChecker, expression: TypeScript.Expression | undefined, key: string): string | undefined {
  const property = staticOption(ts, checker, expression, key);
  return property.kind === "value" ? literalValue(ts, checker, property.expression, new Set()) : undefined;
}

function objectLiteral(ts: TypeScriptApi, checker: TypeScript.TypeChecker, expression: TypeScript.Expression | undefined, visited: Set<TypeScript.Node>): TypeScript.ObjectLiteralExpression | undefined {
  if (!expression || visited.has(expression)) return undefined;
  if (ts.isObjectLiteralExpression(expression)) return expression;
  const declaration = ts.isIdentifier(expression) ? checker.getSymbolAtLocation(expression)?.valueDeclaration : undefined;
  return declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const ? objectLiteral(ts, checker, declaration.initializer, new Set([...visited, expression])) : undefined;
}

function openOperations(ts: TypeScriptApi, checker: TypeScript.TypeChecker, expression: TypeScript.Expression | undefined, context: BindingContext): ("read" | "write")[] | undefined {
  const mode = literalValue(ts, checker, expression, new Set());
  if (mode !== undefined) {
    if (/^(r|rs|sr)$/.test(mode)) return ["read"];
    if (/^(r|rs|sr|w|wx|xw|a|ax|xa|as|sa)\+$/.test(mode)) return ["read", "write"];
    return /^(w|wx|xw|a|ax|xa|as|sa)$/.test(mode) ? ["write"] : undefined;
  }
  const bits = openAccessBits(ts, checker, expression, new Set(), context);
  if (bits === undefined) return undefined;
  const access = bits & 3;
  if ((bits & 4) !== 0) return access === 2 ? ["read", "write"] : ["write"];
  if ((bits & 8) !== 0) return access === 1 ? ["write"] : ["read", "write"];
  return access === 0 ? ["read"] : access === 1 ? ["write"] : access === 2 ? ["read", "write"] : undefined;
}

function openAccessBits(ts: TypeScriptApi, checker: TypeScript.TypeChecker, expression: TypeScript.Expression | undefined, visited: Set<TypeScript.Node>, context: BindingContext): number | undefined {
  if (!expression || visited.has(expression)) return undefined;
  const next = new Set([...visited, expression]);
  if (ts.isNumericLiteral(expression)) {
    const value = Number(expression.text);
    return Number.isSafeInteger(value) && value >= 0
      ? (value & 3) | (value & fileSystemConstants.O_TRUNC ? 4 : 0) | (value & fileSystemConstants.O_CREAT ? 8 : 0)
      : undefined;
  }
  if (ts.isParenthesizedExpression(expression)) return openAccessBits(ts, checker, expression.expression, next, context);
  if (ts.isIdentifier(expression)) {
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const) return openAccessBits(ts, checker, declaration.initializer, next, context);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.BarToken) {
    const left = openAccessBits(ts, checker, expression.left, next, context);
    const right = openAccessBits(ts, checker, expression.right, next, context);
    return left === undefined || right === undefined ? undefined : left | right;
  }
  const binding = apiBinding(ts, checker, expression, new Set(), context);
  if (binding && /^(?:node:)?fs(?:\/promises)?$/.test(binding.moduleName)) {
    const name = binding.apiName.replace(/^constants\./, "");
    if (name === "O_RDONLY") return 0;
    if (name === "O_WRONLY") return 1;
    if (name === "O_RDWR") return 2;
    if (name === "O_TRUNC") return 4;
    if (name === "O_CREAT") return 8;
    if (/^(O_APPEND|O_EXCL|O_SYNC|O_DSYNC|O_DIRECT|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY)$/.test(name)) return 0;
  }
  return undefined;
}

type StaticOption = { kind: "absent" } | { kind: "dynamic" } | { kind: "value"; expression: TypeScript.Expression };

function staticOption(ts: TypeScriptApi, checker: TypeScript.TypeChecker, expression: TypeScript.Expression | undefined, key: string): StaticOption {
  if (!expression) return { kind: "absent" };
  const object = objectLiteral(ts, checker, expression, new Set());
  if (!object || object.properties.some((item) => ts.isSpreadAssignment(item) || item.name && ts.isComputedPropertyName(item.name))) return { kind: "dynamic" };
  const property = [...object.properties].reverse().find((item) => item.name?.getText().replace(/["']/g, "") === key);
  if (!property) return { kind: "absent" };
  return ts.isPropertyAssignment(property) ? { kind: "value", expression: property.initializer } : ts.isShorthandPropertyAssignment(property) ? { kind: "value", expression: property.name } : { kind: "dynamic" };
}

function httpConfiguration(ts: TypeScriptApi, checker: TypeScript.TypeChecker, call: readonly TypeScript.Expression[], api: string): TypeScript.Expression | undefined {
  if (/^(post|put|patch)$/.test(api)) return call[2];
  if (/^(default|\*|request|client)$/.test(api) && call[0] && literalValue(ts, checker, call[0], new Set()) === undefined) return call[0];
  return call[1];
}

function booleanValue(ts: TypeScriptApi, checker: TypeScript.TypeChecker, expression: TypeScript.Expression, visited: Set<TypeScript.Node>): boolean | undefined {
  if (visited.has(expression)) return undefined;
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  const declaration = ts.isIdentifier(expression) ? checker.getSymbolAtLocation(expression)?.valueDeclaration : undefined;
  return declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const && declaration.initializer ? booleanValue(ts, checker, declaration.initializer, new Set([...visited, expression])) : undefined;
}

function httpTarget(ts: TypeScriptApi, checker: TypeScript.TypeChecker, args: readonly TypeScript.Expression[], moduleName: string, api: string, literal: string | undefined, defaults: TypeScript.Expression | undefined): { target: string | undefined; origin?: string; unresolvedReason?: string } {
  let target = literal;
  if (moduleName === "axios") {
    const config = httpConfiguration(ts, checker, args, api);
    function option(key: string): StaticOption {
      const local = staticOption(ts, checker, config, key);
      return local.kind === "absent" ? staticOption(ts, checker, defaults, key) : local;
    }
    const base = option("baseURL");
    const absolute = option("allowAbsoluteUrls");
    const url = staticOption(ts, checker, config, "url");
    if (base.kind === "dynamic" || absolute.kind === "dynamic" || url.kind === "dynamic") return { target, unresolvedReason: "Dynamic Axios options may override URL resolution" };
    if (!target && url.kind === "value") target = literalValue(ts, checker, url.expression, new Set());
    const baseURL = base.kind === "value" ? literalValue(ts, checker, base.expression, new Set()) : undefined;
    const allowAbsolute = absolute.kind === "value" ? booleanValue(ts, checker, absolute.expression, new Set()) : true;
    if (base.kind === "value" && baseURL === undefined || allowAbsolute === undefined) return { target, unresolvedReason: "Dynamic Axios baseURL or allowAbsoluteUrls prevents URL resolution" };
    const isAbsolute = target !== undefined && /^([a-z][a-z\d+\-.]*:)?\/\//i.test(target);
    if (target !== undefined && baseURL && (!isAbsolute || allowAbsolute === false)) target = `${baseURL.replace(/\/+$/, "")}/${target.replace(/^\/+/, "")}`;
  }
  if (!target) return { target };
  if (target.startsWith("//")) return { target, unresolvedReason: "Protocol-relative HTTP URL requires an unknown runtime protocol; baseURL does not supply it" };
  if (!/^https?:\/\//i.test(target)) return { target, unresolvedReason: "Relative or unsupported HTTP URL requires an unknown runtime origin" };
  try {
    const url = new URL(target);
    return { target: url.href, origin: url.origin };
  } catch (error) {
    if (error instanceof TypeError) return { target, unresolvedReason: "HTTP URL is not a valid absolute URL" };
    throw error;
  }
}

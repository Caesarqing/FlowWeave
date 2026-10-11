import type { SourceSnapshot } from "./source-snapshot.service";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { AnalysisScope, ProjectAnalysisContext, SemanticDiagnostic, SemanticFile, SemanticOperationFact, SemanticRelation, SemanticTarget, SourceRange, StructureSymbol } from "../../types";
import { syntaxNodeRange, treeSitterSyntaxDiagnostics, withTreeSitterTree, type TreeSitterLanguageId } from "./language-analyzer.service";

type Expression =
  | { kind: "name"; name: string }
  | { kind: "member"; object: Expression; name: string }
  | { kind: "call"; callee: Expression; arguments: Expression[] }
  | { kind: "literal"; value: string }
  | { kind: "number"; value: string }
  | { kind: "keyword"; name: string; value: Expression }
  | { kind: "unknown"; text: string };
type Declaration = { symbol: StructureSymbol; name: string; owner?: string; lexicalScope: number; arity?: number; static: boolean; final: boolean; interface: boolean; bases: Expression[] };
type Import = { module: string; name?: string; local: string; range: SourceRange; lexicalScope: number; index: number; static: boolean; boundModule?: string; implicit?: boolean };
type PythonControlRegion = { control: number; arm: string; kind: "branch" | "loop" };
type Local = { name: string; value?: Expression; type?: Expression; lexicalScope: number; index: number; parameter: boolean; controlPath?: PythonControlRegion[] };
type Field = { owner: string; name: string; value?: Expression; type?: Expression; lexicalScope: number; index: number };
type Call = { expression: Expression; arguments: Expression[]; name: string; range: SourceRange; lexicalScope: number; index: number; kind: "call" | "inherit"; constructorCall?: boolean; controlPath?: PythonControlRegion[] };
type LexicalScope = { id: number; parent?: number; owner?: string; qualifiedName?: string };
type FileFacts = { path: string; scope: AnalysisScope; language: TreeSitterLanguageId; module: string; packageName?: string; declarations: Declaration[]; imports: Import[]; locals: Local[]; fields: Field[]; calls: Call[]; lexicalScopes: LexicalScope[]; diagnostics: SemanticDiagnostic[] };
type VisibleFacts = { files: FileFacts[]; declarationsByName: Map<string, Declaration[]>; declarationsByQualifiedName: Map<string | undefined, Declaration[]> };
type BindingFacts = { fileByPath: Map<string, FileFacts>; scopes: Map<string, VisibleFacts> };
type Identity =
  | { kind: "declaration"; declarations: Declaration[]; receiver: boolean; receiverProof?: "construction" | "declared-type"; target?: string; receiverId?: string }
  | { kind: "module"; files: FileFacts[]; module: string }
  | { kind: "external"; module: string; members: string[]; target?: string; receiverId?: string; origin?: string; method?: SemanticOperationFact["method"] }
  | { kind: "unresolved"; reason: string; candidates: string[] };
export type TreeSitterProjectResult = { relations: SemanticRelation[]; symbolsByFile: Map<string, StructureSymbol[]>; diagnostics: SemanticDiagnostic[]; operations: SemanticOperationFact[] };

/** Bind declarations and imported APIs from source, without running project code or language toolchains. */
export async function analyzeTreeSitterProject(rootPath: string, files: SemanticFile[], context: ProjectAnalysisContext, snapshot?: SourceSnapshot): Promise<TreeSitterProjectResult> {
  const facts: FileFacts[] = [];
  for (const file of files) {
    const language = languageForFile(file.path);
    if (!language) continue;
    const scope = context.scopes.filter((candidate) => candidate.language === language && candidate.paths.includes(file.path)).sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
    if (!scope) throw new Error(`No ${language} analysis scope owns ${file.path}`);
    const content = snapshot ? snapshot.read(join(rootPath, file.path)) : await readFile(join(rootPath, file.path), "utf8");
    if (content === undefined) throw new Error(`Missing source snapshot: ${file.path}`);
    facts.push(await withTreeSitterTree(language, file.path, content, (root) => collectFileFacts(file.path, scope, language, content, root)));
  }
  const bindingFacts = createBindingFacts(facts);
  const relations: SemanticRelation[] = [];
  const operations: SemanticOperationFact[] = [];
  const diagnostics = facts.flatMap((file) => file.diagnostics);
  for (const file of facts) {
    for (const imported of file.imports) {
      const identity = resolveImport(file, imported.boundModule ? { ...imported, boundModule: undefined } : imported, bindingFacts, new Set());
      const call: Call = { expression: { kind: "name", name: imported.local }, arguments: [], name: imported.module + (imported.name ? `.${imported.name}` : ""), range: imported.range, lexicalScope: imported.lexicalScope, index: imported.index, kind: "call" };
      const identities: Identity[] = identity.kind === "module" && file.language !== "python" ? identity.files.map((candidate) => ({ ...identity, files: [candidate] })) : [identity];
      for (const target of identities) {
        const relation = makeRelation(file, call, "import", target, "scoped-import");
        relations.push(relation);
        if (relation.targetRef?.kind === "unresolved") diagnostics.push({ ...bindingDiagnostic(file, call, unresolved(relation.targetRef.reason, relation.targetRef.candidates), "unresolved-import"), relationId: relation.id });
      }
    }
    for (const call of file.calls) {
      const identity = resolveExpression(file, call.expression, call.lexicalScope, call.index, bindingFacts, new Set());
      const selectedCallable = call.constructorCall ? selectJavaConstructor(file, identity, call.arguments.length, bindingFacts) : selectCallable(identity, call.arguments.length);
      const missingJavaClasspath = unresolvedJavaExternalCall(file, call, selectedCallable);
      const callable = missingJavaClasspath ?? selectedCallable;
      const virtual = isJavaVirtualCall(file, call, callable);
      const bindingBasis = missingJavaClasspath ? "classpath-unavailable" : virtual ? "declared-virtual-member" : callable.kind === "declaration" ? "source-declaration" : "source-import";
      const boundRelation = makeRelation(file, call, call.kind, callable, bindingBasis);
      const relation: SemanticRelation = virtual ? { ...boundRelation, confidence: "inferred" } : boundRelation;
      const operation = operationFromIdentity(file, call, callable, bindingFacts);
      if (callable.kind === "external" && callable.module === "net/http" && ["Handle", "HandleFunc"].includes(callable.members.at(-1) ?? "")) diagnostics.push({ code: "unsupported-http-route", severity: "warning", filePath: file.path, range: call.range, relationId: relation.id, message: `${call.name} registers a route; it is not an outbound HTTP request` });
      if (!operation) {
        relations.push(relation);
        if (virtual) diagnostics.push({ code: "java-virtual-dispatch", severity: "warning", filePath: file.path, range: call.range, relationId: relation.id, message: `${call.name} binds its declared member; runtime overriding implementation is not proven` });
        if (callable.kind === "unresolved") diagnostics.push({ ...bindingDiagnostic(file, call, callable, callable.candidates.length > 1 ? "ambiguous-call" : "unresolved-call"), relationId: relation.id });
      }
      if (operation) {
        operations.push(operation);
        if (!operation.target) diagnostics.push({ code: "unknown-operation-target", severity: "warning", filePath: file.path, range: call.range, message: `${operation.moduleName}.${operation.apiName} has no source literal target` });
      }
    }
  }
  return { relations, symbolsByFile: new Map(facts.map((file) => [file.path, file.declarations.map((declaration) => declaration.symbol)])), diagnostics, operations };
}

function languageForFile(path: string): TreeSitterLanguageId | undefined {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".java")) return "java";
  if (path.endsWith(".go")) return "go";
  return undefined;
}
function normalizedPath(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//, ""); }
function sourcePath(scope: AnalysisScope, path: string): string {
  const roots = [...scope.sourceRoots].sort((a, b) => b.length - a.length);
  const root = roots.find((candidate) => path === normalizedPath(candidate) || path.startsWith(`${normalizedPath(candidate)}/`)) ?? normalizedPath(scope.rootPath);
  return normalizedPath(relative(root || ".", path));
}
function moduleName(path: string, scope: AnalysisScope, language: TreeSitterLanguageId, root: SyntaxNode): string {
  if (language === "python") return sourcePath(scope, path).replace(/\.py$/, "").replace(/(?:^|\/)__init__$/, "").replaceAll("/", ".");
  if (language === "java") return root.namedChildren.find((node) => node.type === "package_declaration")?.namedChildren[0]?.text ?? "";
  const suffix = normalizedPath(relative(scope.rootPath || ".", dirname(path)));
  return `${scope.packageName ?? scope.id}${suffix && suffix !== "." ? `/${suffix}` : ""}`;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function expression(node: SyntaxNode | null): Expression {
  if (!node) return { kind: "unknown", text: "" };
  if (["integer", "int_literal", "decimal_integer_literal"].includes(node.type)) return { kind: "number", value: node.text };
  if (node.type === "keyword_argument") return { kind: "keyword", name: node.childForFieldName("name")?.text ?? "", value: expression(node.childForFieldName("value")) };
  if (["identifier", "type_identifier", "package_identifier", "field_identifier", "this", "super"].includes(node.type)) return { kind: "name", name: node.text };
  if (["dotted_name", "scoped_identifier", "scoped_type_identifier"].includes(node.type)) return node.namedChildren.reduce<Expression | undefined>((value, child) => value ? { kind: "member", object: value, name: child.text } : expression(child), undefined) ?? { kind: "unknown", text: node.text };
  if (node.type === "qualified_type") return { kind: "member", object: expression(node.childForFieldName("package")), name: node.childForFieldName("name")?.text ?? "" };
  if (node.type === "attribute") return { kind: "member", object: expression(node.childForFieldName("object")), name: node.childForFieldName("attribute")?.text ?? "" };
  if (node.type === "selector_expression" || node.type === "field_access") return { kind: "member", object: expression(node.childForFieldName("operand") ?? node.childForFieldName("object")), name: node.childForFieldName("field")?.text ?? "" };
  if (["call", "call_expression", "method_invocation", "object_creation_expression"].includes(node.type)) {
    let callee = expression(node.childForFieldName("function") ?? node.childForFieldName("type") ?? node.childForFieldName("name"));
    const object = node.type === "method_invocation" ? node.childForFieldName("object") : null;
    if (object) callee = { kind: "member", object: expression(object), name: node.childForFieldName("name")?.text ?? "" };
    return { kind: "call", callee, arguments: (node.childForFieldName("arguments")?.namedChildren ?? []).map(expression) };
  }
  if (["string", "string_literal", "interpreted_string_literal", "raw_string_literal"].includes(node.type) && !node.descendantsOfType(["interpolation", "escape_interpolation"]).length) {
    const content = node.namedChildren.filter((child) => ["string_content", "string_fragment", "interpreted_string_literal_content", "raw_string_literal_content"].includes(child.type)).map((child) => child.text).join("");
    return { kind: "literal", value: content || node.text.slice(1, -1) };
  }
  if (node.type === "generic_type") return expression(node.namedChildren[0] ?? null);
  if (["pointer_type", "parenthesized_expression", "unary_expression"].includes(node.type)) return expression(node.namedChildren[node.namedChildren.length - 1] ?? null);
  if (node.type === "composite_literal") return { kind: "call", callee: expression(node.childForFieldName("type")), arguments: [] };
  if (["list", "array_initializer", "literal_value", "expression_list"].includes(node.type)) return expression(node.namedChildren[0] ?? null);
  return { kind: "unknown", text: node.text };
}
function expressionName(value: Expression): string {
  if (value.kind === "name") return value.name;
  if (value.kind === "member") return `${expressionName(value.object)}.${value.name}`;
  if (value.kind === "call") return `${expressionName(value.callee)}()`;
  if (value.kind === "literal" || value.kind === "number") return value.value;
  if (value.kind === "keyword") return `${value.name}=${expressionName(value.value)}`;
  return value.text;
}
function inheritedTypes(language: TreeSitterLanguageId, node: SyntaxNode): SyntaxNode[] {
  if (language === "python") return node.childForFieldName("superclasses")?.namedChildren ?? [];
  if (language === "java") {
    const interfaces = node.childForFieldName("interfaces") ?? node.namedChildren.find((child) => child.type === "extends_interfaces");
    return [...(node.childForFieldName("superclass")?.namedChildren ?? []), ...(interfaces?.namedChildren.find((child) => child.type === "type_list")?.namedChildren ?? [])];
  }
  const type = node.childForFieldName("type");
  return type?.type === "struct_type" ? type.descendantsOfType("field_declaration").filter((field) => !field.childForFieldName("name")).map((field) => field.childForFieldName("type")).filter((field): field is SyntaxNode => Boolean(field)) : [];
}

function collectFileFacts(path: string, scope: AnalysisScope, language: TreeSitterLanguageId, content: string, root: SyntaxNode): FileFacts {
  const file: FileFacts = { path, scope, language, module: moduleName(path, scope, language, root), packageName: language === "go" ? root.namedChildren.find((node) => node.type === "package_clause")?.namedChildren[0]?.text : undefined, declarations: [], imports: [], locals: [], fields: [], calls: [], lexicalScopes: [{ id: -1 }], diagnostics: [] };
  file.diagnostics.push(...treeSitterSyntaxDiagnostics(root, path, content));
  const buildConstraint = language === "go" ? root.descendantsOfType("comment").find((node) => node.text.startsWith("//go:build") || node.text.startsWith("// +build")) : undefined;
  if (buildConstraint) file.diagnostics.push({ code: "go-build-constraints", severity: "warning", filePath: path, range: syntaxNodeRange(buildConstraint, content), message: `Build constraints in ${path} were not evaluated; declarations are source candidates only` });
  function visit(node: SyntaxNode, lexicalScope: number, owner: string | undefined, controlPath: PythonControlRegion[]): void {
    if (node.type === "ERROR" || node.isMissing) return;
    const imported = collectImports(file.language, file.path, node, lexicalScope, content);
    file.imports.push(...imported.imports);
    file.diagnostics.push(...imported.diagnostics);
    const classNode = language === "python" ? node.type === "class_definition" : language === "java" ? ["class_declaration", "interface_declaration", "record_declaration", "enum_declaration"].includes(node.type) : node.type === "type_spec";
    const functionNode = ["function_definition", "function_declaration", "method_declaration", "constructor_declaration", "method_elem"].includes(node.type);
    let nextOwner = owner;
    let nextScope = lexicalScope;
    if (classNode || functionNode) {
      const name = node.childForFieldName("name");
      if (name) {
        const receiver = language === "go" && node.type === "method_declaration" ? node.childForFieldName("receiver")?.descendantsOfType("type_identifier")[0]?.text : undefined;
        const lexicalPrefix = file.lexicalScopes.find((candidate) => candidate.id === lexicalScope)?.qualifiedName;
        const declarationOwner = receiver ? `${file.module}.${receiver}` : language === "python" && functionNode && lexicalPrefix !== owner ? undefined : owner;
        const prefix = receiver ? declarationOwner : lexicalPrefix ?? declarationOwner ?? file.module;
        const qualifiedName = `${prefix}${prefix ? "." : ""}${name.text}`;
        const symbol: StructureSymbol = { id: hash(`${scope.id}:${path}:${qualifiedName}:${node.startIndex}`), qualifiedName, scopeId: scope.id, range: syntaxNodeRange(node, content), name: name.text, kind: classNode ? "class" : declarationOwner ? "method" : "function", filePath: path, line: node.startPosition.row + 1, signature: node.text.split("\n")[0]?.trim() };
        const modifiers = node.namedChildren.find((child) => child.type === "modifiers")?.children.map((child) => child.text) ?? [];
        file.declarations.push({ symbol, name: name.text, owner: declarationOwner, lexicalScope, arity: functionNode ? node.childForFieldName("parameters")?.namedChildren.length : undefined, static: modifiers.includes("static"), final: modifiers.includes("final") || modifiers.includes("private") || functionNode && file.declarations.some((declaration) => declaration.symbol.qualifiedName === declarationOwner && declaration.final), interface: node.type === "interface_declaration" || node.childForFieldName("type")?.type === "interface_type", bases: inheritedTypes(language, node).map(expression) });
        nextOwner = classNode ? qualifiedName : owner;
        nextScope = node.startIndex;
        file.lexicalScopes.push({ id: nextScope, parent: lexicalScope, owner: nextOwner, qualifiedName });
        if (language === "python" && functionNode && declarationOwner) file.locals.push({ name: "self", type: { kind: "name", name: declarationOwner.split(".").at(-1) ?? "" }, lexicalScope: nextScope, index: node.startIndex, parameter: true });
        const bases = inheritedTypes(language, node);
        for (const base of bases) file.calls.push({ expression: expression(base), arguments: [], name: base.text, range: syntaxNodeRange(base, content), lexicalScope, index: base.startIndex, kind: "inherit" });
      }
    } else if (["lambda", "lambda_expression", "func_literal", "list_comprehension", "set_comprehension", "dictionary_comprehension", "generator_expression"].includes(node.type) || language !== "python" && ["block", "for_statement", "enhanced_for_statement", "if_statement"].includes(node.type)) {
      nextScope = node.startIndex;
      file.lexicalScopes.push({ id: nextScope, parent: lexicalScope, owner, qualifiedName: file.lexicalScopes.find((candidate) => candidate.id === lexicalScope)?.qualifiedName });
    }
    const localPath = language === "python" && node.type === "for_statement" ? [...controlPath, { control: node.startIndex, arm: "iteration", kind: "loop" as const }] : controlPath;
    file.locals.push(...collectLocals(language, node, nextScope).map((local) => language === "python" ? { ...local, controlPath: localPath } : local));
    file.fields.push(...collectFields(language, node, nextOwner, nextScope));
    const isCall = language === "python" ? node.type === "call" : language === "java" ? ["method_invocation", "object_creation_expression"].includes(node.type) : node.type === "call_expression";
    if (isCall) {
      const value = expression(node);
      if (value.kind === "call") file.calls.push({ expression: value.callee, arguments: value.arguments, name: expressionName(value.callee), range: syntaxNodeRange(node, content), lexicalScope: nextScope, index: node.startIndex, kind: "call", constructorCall: node.type === "object_creation_expression", controlPath });
    }
    for (const child of node.namedChildren) visit(child, nextScope, nextOwner, pythonControlPath(node, child, controlPath));
  }
  visit(root, -1, undefined, []);
  return file;
}

function pythonControlPath(parent: SyntaxNode, child: SyntaxNode, path: PythonControlRegion[]): PythonControlRegion[] {
  if (parent.type === "if_statement") {
    const arms = parent.namedChildren.filter((candidate) => candidate.type === "block" || candidate.type === "elif_clause" || candidate.type === "else_clause");
    const armIndex = arms.findIndex((candidate) => candidate.id === child.id);
    if (armIndex >= 0) {
      const arm = child.type === "block" ? "if" : `${child.type}:${armIndex}`;
      return [...path, { control: parent.startIndex, arm, kind: "branch" }];
    }
  }
  if (["for_statement", "while_statement"].includes(parent.type)) {
    if (child.type === "block") return [...path, { control: parent.startIndex, arm: "iteration", kind: "loop" }];
    if (child.type === "else_clause") return [...path, { control: parent.startIndex, arm: "else", kind: "loop" }];
  }
  if (parent.type === "try_statement") {
    if (child.type === "block") return [...path, { control: parent.startIndex, arm: "try", kind: "branch" }];
    if (child.type === "except_clause" || child.type === "else_clause") return [...path, { control: parent.startIndex, arm: `${child.type}:${child.startIndex}`, kind: "branch" }];
  }
  if (child.type === "case_clause") {
    let ancestor = parent.parent;
    while (ancestor && ancestor.type !== "match_statement") ancestor = ancestor.parent;
    if (ancestor) return [...path, { control: ancestor.startIndex, arm: `case:${child.startIndex}`, kind: "branch" }];
  }
  return path;
}
function collectImports(language: TreeSitterLanguageId, path: string, node: SyntaxNode, lexicalScope: number, content: string): { imports: Import[]; diagnostics: SemanticDiagnostic[] } {
  const imports: Import[] = [];
  const diagnostics: SemanticDiagnostic[] = [];
  if (language === "python" && ["import_statement", "import_from_statement"].includes(node.type)) {
    const module = node.childForFieldName("module_name");
    for (const name of node.namedChildren.filter((child) => child.id !== module?.id)) {
      if (!["dotted_name", "aliased_import", "wildcard_import"].includes(name.type)) continue;
      const imported = name.childForFieldName("name")?.text ?? name.text;
      const alias = name.childForFieldName("alias")?.text;
      imports.push({ module: module?.text ?? imported, name: module ? imported : undefined, local: alias ?? (module ? imported : imported.split(".")[0] ?? imported), range: syntaxNodeRange(node, content), lexicalScope, index: node.startIndex, static: false, boundModule: !module && !alias && imported.includes(".") ? imported.split(".")[0] : undefined });
      if (imported === "*") diagnostics.push({ code: "wildcard-import", severity: "warning", filePath: path, range: syntaxNodeRange(node, content), message: "Python wildcard exports cannot be proven without executing the module" });
    }
  }
  if (language === "java" && node.type === "import_declaration") {
    const imported = node.namedChildren.find((child) => child.type !== "asterisk")?.text ?? "";
    const wildcard = node.namedChildren.some((child) => child.type === "asterisk");
    const isStatic = node.children.some((child) => child.type === "static");
    const parts = imported.split(".");
    imports.push({ module: isStatic && !wildcard ? parts.slice(0, -1).join(".") : imported, name: isStatic && !wildcard ? parts.at(-1) : wildcard ? "*" : undefined, local: wildcard ? "*" : parts.at(-1) ?? imported, range: syntaxNodeRange(node, content), lexicalScope, index: node.startIndex, static: isStatic });
  }
  if (language === "go" && node.type === "import_spec") {
    const imported = expression(node.childForFieldName("path"));
    if (imported.kind !== "literal") return { imports, diagnostics };
    const alias = node.childForFieldName("name")?.text;
    imports.push({ module: imported.value, local: alias ?? posix.basename(imported.value), implicit: !alias, range: syntaxNodeRange(node, content), lexicalScope, index: node.startIndex, static: false });
    if (alias === ".") diagnostics.push({ code: "go-dot-import", severity: "warning", filePath: path, range: syntaxNodeRange(node, content), message: "Go dot imports require explicit package export binding and are not treated as global names" });
  }
  return { imports, diagnostics };
}
function collectLocals(language: TreeSitterLanguageId, node: SyntaxNode, lexicalScope: number): Local[] {
  const locals: Local[] = [];
  const add = (name: SyntaxNode | null, value: SyntaxNode | null, type: SyntaxNode | null, parameter: boolean) => {
    if (!name || !["identifier", "field_identifier"].includes(name.type)) return;
    locals.push({ name: name.text, value: value ? expression(value) : undefined, type: type ? expression(type) : undefined, lexicalScope, index: node.startIndex, parameter });
  };
  if (language === "python") {
    if (node.type === "assignment" || node.type === "named_expression") add(node.childForFieldName("left") ?? node.childForFieldName("name"), node.childForFieldName("right") ?? node.childForFieldName("value"), null, false);
    if (node.type === "parameters" || node.type === "lambda_parameters") for (const param of node.namedChildren) {
      const name = param.type === "identifier" ? param : param.childForFieldName("name") ?? param.namedChildren.find((child) => child.type === "identifier") ?? null;
      if (name?.text !== "self") add(name, null, null, true);
    }
    if (node.type === "for_statement" || node.type === "for_in_clause") add(node.childForFieldName("left"), null, null, false);
    if (node.type === "as_pattern") add(node.childForFieldName("alias")?.namedChildren[0] ?? node.childForFieldName("alias"), null, null, false);
  }
  if (language === "java") {
    if (node.type === "formal_parameter" || node.type === "spread_parameter" || node.type === "catch_formal_parameter") add(node.childForFieldName("name"), null, node.childForFieldName("type"), true);
    if (node.type === "variable_declarator") add(node.childForFieldName("name"), node.childForFieldName("value"), node.parent?.childForFieldName("type") ?? null, false);
    if (node.type === "assignment_expression") add(node.childForFieldName("left"), node.childForFieldName("right"), null, false);
    if (node.type === "inferred_parameters") for (const name of node.namedChildren) add(name, null, null, true);
    if (node.type === "lambda_expression" && node.childForFieldName("parameters")?.type === "identifier") add(node.childForFieldName("parameters"), null, null, true);
    if (node.type === "enhanced_for_statement") add(node.childForFieldName("name"), null, node.childForFieldName("type"), false);
  }
  if (language === "go") {
    if (node.type === "parameter_declaration" || node.type === "variadic_parameter_declaration") {
      for (const name of node.childrenForFieldName("name")) add(name, null, node.childForFieldName("type"), true);
    }
    if (node.type === "short_var_declaration" || node.type === "assignment_statement") {
      const names = node.childForFieldName("left")?.namedChildren ?? [];
      const values = node.childForFieldName("right")?.namedChildren ?? [];
      for (const [index, name] of names.entries()) add(name, values[index] ?? null, null, false);
    }
    if (node.type === "var_spec") for (const name of node.childrenForFieldName("name")) add(name, node.childForFieldName("value")?.namedChildren[0] ?? null, node.childForFieldName("type"), false);
  }
  return locals;
}
function collectFields(language: TreeSitterLanguageId, node: SyntaxNode, owner: string | undefined, lexicalScope: number): Field[] {
  if (!owner) return [];
  if (language === "python" && node.type === "assignment") {
    const left = node.childForFieldName("left");
    const receiver = left?.childForFieldName("object")?.text;
    const name = left?.childForFieldName("attribute");
    const value = node.childForFieldName("right");
    return left?.type === "attribute" && ["self", "cls"].includes(receiver ?? "") && name && value ? [{ owner, name: name.text, value: expression(value), lexicalScope, index: node.startIndex }] : [];
  }
  if (language === "java" && node.type === "field_declaration") return node.namedChildren.filter((child) => child.type === "variable_declarator").map((child) => ({ owner, name: child.childForFieldName("name")?.text ?? "", value: child.childForFieldName("value") ? expression(child.childForFieldName("value")) : undefined, type: expression(node.childForFieldName("type")), lexicalScope, index: child.startIndex }));
  if (language === "go" && node.type === "field_declaration") return node.childrenForFieldName("name").map((name) => ({ owner, name: name.text, type: expression(node.childForFieldName("type")), lexicalScope, index: node.startIndex }));
  return [];
}

function unresolved(reason: string, candidates: string[]): Extract<Identity, { kind: "unresolved" }> { return { kind: "unresolved", reason, candidates }; }
function declarationIdentity(declarations: Declaration[], receiver: boolean): Identity {
  return declarations.length ? { kind: "declaration", declarations, receiver } : unresolved("No declaration in the source scope", []);
}
function createBindingFacts(files: FileFacts[]): BindingFacts {
  const scopes = new Map<string, VisibleFacts>();
  for (const file of files) {
    const key = `${file.language}:${file.scope.id}`;
    if (scopes.has(key)) continue;
    const visible = files.filter((candidate) => candidate.language === file.language && (candidate.scope.id === file.scope.id || file.scope.dependencies?.some((dependency) => dependency === candidate.scope.packageName || dependency.split("=>")[1] === candidate.scope.rootPath)));
    const declarationsByName = new Map<string, Declaration[]>();
    const declarationsByQualifiedName = new Map<string | undefined, Declaration[]>();
    for (const candidate of visible) {
      for (const declaration of candidate.declarations) {
        const named = declarationsByName.get(declaration.name);
        if (named) named.push(declaration);
        else declarationsByName.set(declaration.name, [declaration]);
        const qualified = declarationsByQualifiedName.get(declaration.symbol.qualifiedName);
        if (qualified) qualified.push(declaration);
        else declarationsByQualifiedName.set(declaration.symbol.qualifiedName, [declaration]);
      }
    }
    scopes.set(key, { files: visible, declarationsByName, declarationsByQualifiedName });
  }
  return { fileByPath: new Map(files.map((file) => [file.path, file])), scopes };
}
function visibleFacts(file: FileFacts, facts: BindingFacts): VisibleFacts {
  const visible = facts.scopes.get(`${file.language}:${file.scope.id}`);
  if (!visible) throw new Error(`Missing declaration index for ${file.language} scope ${file.scope.id}`);
  return visible;
}
function visibleFiles(file: FileFacts, facts: BindingFacts): FileFacts[] {
  return visibleFacts(file, facts).files;
}
function declarationsNamed(file: FileFacts, name: string, facts: BindingFacts): Declaration[] {
  return visibleFacts(file, facts).declarationsByName.get(name) ?? [];
}
function declarationsQualified(file: FileFacts, name: string, facts: BindingFacts): Declaration[] {
  return visibleFacts(file, facts).declarationsByQualifiedName.get(name) ?? [];
}
function sameModuleDeclarations(file: FileFacts, name: string, facts: BindingFacts): Declaration[] {
  return declarationsNamed(file, name, facts).filter((declaration) => {
    const candidate = facts.fileByPath.get(declaration.symbol.filePath);
    return candidate?.module === file.module && (file.language !== "go" || candidate.packageName === file.packageName);
  });
}
function canonicalImport(file: FileFacts, module: string): string {
  if (file.language !== "python" || !module.startsWith(".")) return module;
  const dots = module.match(/^\.+/)?.[0].length ?? 0;
  const parts = (file.path.endsWith("/__init__.py") ? file.module : file.module.split(".").slice(0, -1).join(".")).split(".");
  return [...parts.slice(0, Math.max(0, parts.length - dots + 1)), module.slice(dots)].filter(Boolean).join(".");
}
function importFiles(file: FileFacts, module: string, facts: BindingFacts): FileFacts[] {
  const visible = visibleFiles(file, facts);
  if (file.language !== "go") return visible.filter((candidate) => candidate.module === module);
  const replacement = file.scope.dependencies?.map((dependency) => dependency.split("=>")).find(([prefix, root]) => root && (module === prefix || module.startsWith(`${prefix}/`)));
  if (replacement) {
    const [prefix, root] = replacement;
    const desired = normalizedPath(join(root ?? "", module.slice((prefix ?? "").length)));
    return visible.filter((candidate) => normalizedPath(dirname(candidate.path)) === desired && !candidate.path.endsWith("_test.go"));
  }
  return visible.filter((candidate) => candidate.module === module && !candidate.path.endsWith("_test.go"));
}
function resolveImport(file: FileFacts, imported: Import, facts: BindingFacts, visited: Set<string>): Identity {
  const module = canonicalImport(file, imported.module);
  if (imported.name === "*" && file.language !== "java") return unresolved("Wildcard import cannot establish a unique local binding", []);
  if (file.language === "java") {
    const classes = declarationsQualified(file, module, facts).filter((declaration) => declaration.symbol.kind === "class");
    if (classes.length) {
      const base = declarationIdentity(classes, false);
      return imported.name && imported.name !== "*" ? resolveMember(file, base, imported.name, facts, visited) : base;
    }
  }
  const candidates = importFiles(file, module, facts);
  if (candidates.length) {
    if (file.language === "go" && new Set(candidates.map((candidate) => candidate.packageName)).size > 1) return unresolved(`Go package ${module} has conflicting package declarations`, candidates.map((candidate) => candidate.path));
    const identity: Identity = imported.boundModule ? { kind: "module", files: importFiles(file, imported.boundModule, facts), module: imported.boundModule } : { kind: "module", files: candidates, module };
    return imported.name && imported.name !== "*" ? resolveMember(file, identity, imported.name, facts, visited) : identity;
  }
  if (file.language === "python" && imported.name) {
    const submodules = importFiles(file, `${module}.${imported.name}`, facts);
    if (submodules.length) return { kind: "module", files: submodules, module: `${module}.${imported.name}` };
  }
  if (file.language === "python" && !imported.module.startsWith(".")) {
    const prefix = module.split(".")[0];
    const possibleRoots = visibleFiles(file, facts).filter((candidate) => candidate.module.split(".").slice(1).includes(prefix ?? "\0"));
    if (possibleRoots.length) return unresolved(`Python import ${module} resembles indexed package directories, but no configured source root establishes that absolute module identity`, possibleRoots.map((candidate) => candidate.path));
  }
  const internal = file.language === "python" ? imported.module.startsWith(".") || visibleFiles(file, facts).some((candidate) => candidate.module.split(".")[0] === module.split(".")[0]) : file.language === "java" ? visibleFiles(file, facts).some((candidate) => candidate.module && module.startsWith(`${candidate.module}.`)) : module === file.scope.packageName || module.startsWith(`${file.scope.packageName}/`) || Boolean(file.scope.dependencies?.some((dependency) => module.startsWith(dependency.split("=>")[0] ?? "\0")));
  if (internal) return unresolved(`Internal module ${module} is absent from the indexed scope`, []);
  if (file.language === "python" && (module === "urllib" && imported.name === "request" || module === "http" && imported.name === "client")) return { kind: "external", module: `${module}.${imported.name}`, members: [] };
  return { kind: "external", module, members: imported.name && imported.name !== "*" ? [imported.name] : [] };
}
function resolveExpression(file: FileFacts, value: Expression, lexicalScope: number, index: number, facts: BindingFacts, visited: Set<string>): Identity {
  if (value.kind === "keyword") return resolveExpression(file, value.value, lexicalScope, index, facts, visited);
  if (value.kind === "name") return resolveName(file, value.name, lexicalScope, index, facts, visited);
  if (value.kind === "member") return resolveMember(file, resolveExpression(file, value.object, lexicalScope, index, facts, visited), value.name, facts, visited);
  if (value.kind === "call") {
    const identity = resolveExpression(file, value.callee, lexicalScope, index, facts, visited);
    const target = literalTarget(value.arguments[0]);
    if (identity.kind === "declaration" && identity.declarations.every((declaration) => declaration.symbol.kind === "class")) return { ...identity, receiver: true, receiverProof: "construction", target, receiverId: `${file.path}:${index}:${expressionName(value.callee)}` };
    if (identity.kind === "external") return externalReturnIdentity(identity, value.arguments, file, lexicalScope, index, facts, visited);
    return unresolved("Return type or callable variable is not proven by source binding", []);
  }
  return unresolved(`Expression ${expressionName(value)} is not a source declaration`, []);
}
function resolveName(file: FileFacts, name: string, lexicalScope: number, index: number, facts: BindingFacts, visited: Set<string>): Identity {
  const key = `${file.path}:${lexicalScope}:${name}`;
  if (visited.has(key)) return unresolved(`Cyclic source alias ${name}`, []);
  const nextVisited = new Set([...visited, key]);
  let current: number | undefined = lexicalScope;
  while (current !== undefined) {
    const scope = file.lexicalScopes.find((candidate) => candidate.id === current);
    if (file.language === "python" && current !== lexicalScope && scope?.owner && scope.qualifiedName === scope.owner) { current = scope.parent; continue; }
    if ((name === "this" || name === "super") && scope?.owner) {
      const owners = declarationsQualified(file, scope.owner, facts).filter((declaration) => declaration.symbol.kind === "class");
      if (name === "super") {
        const base = owners[0]?.bases[0];
        return base ? resolveExpression(file, base, owners[0].lexicalScope, index, facts, nextVisited) : unresolved("No explicit superclass source declaration", []);
      }
      return declarationIdentity(owners, true);
    }
    const locals = file.locals.filter((local) => local.lexicalScope === current && local.name === name && (file.language === "python" || local.index <= index));
    if (locals.length) {
      if (file.language === "python") return resolvePythonLocal(file, name, lexicalScope, index, locals, facts, nextVisited);
      const local = locals.filter((candidate) => candidate.parameter || candidate.index <= index).sort((a, b) => b.index - a.index)[0];
      if (!local) return unresolved(`Local ${name} shadows an outer binding before assignment`, []);
      if (local.value?.kind === "call") return resolveExpression(file, local.value, current, local.index, facts, nextVisited);
      if (local.type) {
        const typed = resolveExpression(file, local.type as Expression, current, local.index, facts, nextVisited);
        if (typed.kind === "declaration") return { ...typed, receiver: true, receiverProof: "declared-type", receiverId: `${file.path}:${current}:${name}` };
        if (typed.kind === "external" && typed.module === "builtin") return unresolved(`Go primitive ${expressionName(local.type as Expression)} has no source receiver members`, []);
        if (typed.kind === "external") return { ...typed, receiverId: `${file.path}:${current}:${name}` };
      }
      return unresolved(`Local ${name} has no explicit concrete source receiver`, []);
    }
    const imports = file.imports.filter((imported) => {
      if (imported.lexicalScope !== current) return false;
      const candidates = file.language === "go" && imported.implicit ? importFiles(file, imported.module, facts) : [];
      return candidates.length ? candidates.some((candidate) => candidate.packageName === name) : imported.local === name;
    });
    const declarations = declarationsNamed(file, name, facts).filter((declaration) => declaration.symbol.filePath === file.path && declaration.lexicalScope === current);
    if (imports.length && declarations.length) return unresolved(`Imports and declarations both bind ${name}`, [...imports.map((imported) => imported.module), ...declarations.map((declaration) => declaration.symbol.id ?? declaration.name)]);
    if (imports.length > 1) return unresolved(`Duplicate imports bind ${name}`, imports.map((imported) => imported.module));
    if (imports[0]) return resolveImport(file, imports[0], facts, nextVisited);
    if (declarations.length) {
      const candidates = current === -1 && file.language !== "python" ? sameModuleDeclarations(file, name, facts).filter((declaration) => declaration.lexicalScope === -1) : declarations;
      return declarationIdentity(candidates, false);
    }
    if (scope?.owner && file.language === "java") {
      const members = declarationsNamed(file, name, facts).filter((declaration) => declaration.owner === scope.owner);
      if (members.length) return declarationIdentity(members, true);
    }
    current = scope?.parent;
  }
  if (file.language === "python" && ["open", "print", "len", "str", "int", "float", "bool", "list", "dict", "set", "tuple", "range", "enumerate", "zip", "map", "filter", "sum", "min", "max", "sorted", "reversed", "isinstance", "issubclass", "getattr", "setattr", "hasattr", "super", "type", "object", "bytes", "bytearray", "iter", "next", "abs", "all", "any", "round", "Exception", "ValueError", "RuntimeError"].includes(name)) return { kind: "external", module: "builtins", members: [name] };
  if (file.language === "go" && ["append", "cap", "clear", "close", "complex", "copy", "delete", "imag", "len", "make", "max", "min", "new", "panic", "print", "println", "real", "recover", "string", "int", "int64", "float64", "bool", "byte", "rune"].includes(name)) return { kind: "external", module: "builtin", members: [name] };
  if (file.language === "java" || file.language === "go") {
    const declarations = sameModuleDeclarations(file, name, facts).filter((declaration) => !declaration.owner);
    if (declarations.length) return declarationIdentity(declarations, false);
  }
  if (file.language === "java") {
    const wildcardCandidates = file.imports.filter((imported) => imported.name === "*").map((imported) => resolveMember(file, resolveImport(file, imported, facts, nextVisited), name, facts, nextVisited)).filter((identity) => identity.kind === "declaration");
    if (wildcardCandidates.length === 1) return wildcardCandidates[0];
    if (wildcardCandidates.length > 1) return unresolved(`Multiple wildcard imports bind ${name}`, wildcardCandidates.flatMap((identity) => identity.kind === "declaration" ? identity.declarations.map((declaration) => declaration.symbol.id ?? declaration.name) : []));
  }
  if (file.language === "java" && ["ProcessBuilder", "System", "String", "Object", "Integer", "Long", "Boolean", "Thread", "Exception", "RuntimeException", "Math"].includes(name)) return { kind: "external", module: `java.lang.${name}`, members: [] };
  if (file.language === "java" && name === "java") return { kind: "external", module: "java", members: [] };
  if (file.language === "java") {
    const packageRoots = visibleFiles(file, facts).filter((candidate) => candidate.module === name || candidate.module.startsWith(`${name}.`));
    if (packageRoots.length) return { kind: "module", files: packageRoots, module: name };
  }
  return unresolved(`No lexical declaration or import binds ${name}`, []);
}

function resolvePythonLocal(file: FileFacts, name: string, lexicalScope: number, index: number, locals: Local[], facts: BindingFacts, visited: Set<string>): Identity {
  const prior = locals.filter((local) => local.parameter || local.index <= index);
  if (!prior.length) return unresolved(`Local ${name} shadows an outer binding before assignment`, locals.map((local) => `${file.path}:${local.index}:${name}`));

  const queryPath = file.calls.find((call) => call.index === index)?.controlPath ?? [];
  const compatible = prior.filter((local) => !local.controlPath?.some((region) => queryPath.some((current) => current.control === region.control && current.arm !== region.arm)));
  const byPath = new Map<string, Local>();
  for (const local of compatible) {
    const path = local.controlPath ?? [];
    const key = path.map((region) => `${region.control}:${region.arm}`).join("/");
    const existing = byPath.get(key);
    if (!existing || local.index > existing.index) byPath.set(key, local);
  }
  const isPrefix = (candidate: Local) => {
    const candidatePath = candidate.controlPath ?? [];
    return candidatePath.length <= queryPath.length && candidatePath.every((region, position) => {
      const queryRegion = queryPath[position];
      return queryRegion?.control === region.control && queryRegion.arm === region.arm;
    });
  };
  const representatives = [...byPath.values()];
  const dominating = representatives.filter(isPrefix).sort((left, right) => right.index - left.index)[0];
  // ponytail: joins conservatively retain old values across exhaustive arms; prune only if branch coverage becomes noisy.
  const selected = representatives.filter((local) => local === dominating || local.index > (dominating?.index ?? -1) && !isPrefix(local));
  const identities = selected.map((local) => pythonLocalIdentity(file, name, lexicalScope, local, facts, visited));
  return mergePythonLocalIdentities(file, name, lexicalScope, identities);
}

function pythonLocalIdentity(file: FileFacts, name: string, lexicalScope: number, local: Local, facts: BindingFacts, visited: Set<string>): Identity {
  const localCandidate = `${file.path}:${local.index}:${name}`;
  if (local.value) {
    const identity = resolveExpression(file, local.value, local.lexicalScope, local.index, facts, visited);
    if (identity.kind === "declaration" && identity.receiverProof === "construction") return { ...identity, receiverId: `${file.path}:${lexicalScope}:${name}` };
    if (identity.kind === "external" && identity.receiverId) return { ...identity, receiverId: `${file.path}:${lexicalScope}:${name}` };
    if (identity.kind === "declaration" || identity.kind === "external") return { ...identity, receiverId: `${file.path}:${lexicalScope}:${name}` };
    if (identity.kind === "module") return identity;
    return { ...identity, candidates: identity.candidates.length ? identity.candidates : [localCandidate] };
  }
  if (local.type && name === "self") {
    const identity = resolveExpression(file, local.type, local.lexicalScope, local.index, facts, visited);
    return identity.kind === "declaration" ? { ...identity, receiver: true, receiverProof: "declared-type", receiverId: `${file.path}:${lexicalScope}:${name}` } : identity;
  }
  return unresolved(`Local ${name} has no explicit concrete source receiver`, [localCandidate]);
}

function mergePythonLocalIdentities(file: FileFacts, name: string, lexicalScope: number, identities: Identity[]): Identity {
  if (!identities.length) return unresolved(`Local ${name} has no assignment on a path reaching this call`, []);
  const key = (identity: Identity): string => {
    if (identity.kind === "declaration") return `declaration:${identity.declarations.map((declaration) => declaration.symbol.id).sort().join(",")}`;
    if (identity.kind === "external") return `external:${identity.module}:${identity.members.join(".")}:${identity.target ?? ""}:${identity.origin ?? ""}:${identity.receiverId ?? ""}`;
    if (identity.kind === "module") return `module:${identity.module}:${identity.files.map((candidate) => candidate.path).sort().join(",")}`;
    return `unresolved:${identity.reason}:${[...identity.candidates].sort().join(",")}`;
  };
  const unique = [...new Map(identities.map((identity) => [key(identity), identity])).values()];
  if (unique.length === 1) return unique[0];
  const candidates = [...new Set(unique.flatMap((identity) => {
    if (identity.kind === "declaration") return identity.declarations.map((declaration) => String(declaration.symbol.id ?? declaration.symbol.qualifiedName));
    if (identity.kind === "external") return [`external:${identity.module}${identity.members.length ? `.${identity.members.join(".")}` : ""}`];
    if (identity.kind === "module") return identity.files.map((candidate) => candidate.path);
    return identity.candidates;
  }))];
  return unresolved(`Local ${name} has multiple possible source bindings across control-flow branches`, candidates.length ? candidates : [`${file.path}:${lexicalScope}:${name}`]);
}

function resolveMember(file: FileFacts, identity: Identity, name: string, facts: BindingFacts, visited: Set<string>): Identity {
  if (identity.kind === "unresolved") return identity;
  if (identity.kind === "external") {
    if (file.language === "java" && (identity.module === "java" || !/[A-Z]/.test(identity.module)) && /^[A-Z]/.test(name)) return { ...identity, module: [identity.module, ...identity.members, name].join("."), members: [] };
    return { ...identity, members: [...identity.members, name] };
  }
  if (identity.kind === "module") {
    const declarations = identity.files.flatMap((candidate) => candidate.declarations.filter((declaration) => declaration.lexicalScope === -1 && declaration.name === name));
    if (declarations.length) return declarationIdentity(declarations, false);
    const reexports = identity.files.flatMap((candidate) => candidate.imports.filter((imported) => imported.lexicalScope === -1 && imported.local === name).map((imported) => ({ candidate, imported })));
    if (reexports.length === 1) {
      const exported = reexports[0];
      const key = `${exported.candidate.path}:export:${name}`;
      if (visited.has(key)) return unresolved(`Cyclic reexport ${name}`, []);
      return resolveImport(exported.candidate, exported.imported, facts, new Set([...visited, key]));
    }
    if (reexports.length > 1) return unresolved(`Ambiguous reexport ${name}`, reexports.map((entry) => entry.candidate.path));
    const nestedModule = `${identity.module}.${name}`;
    const nested = file.language === "java" ? visibleFiles(file, facts).filter((candidate) => candidate.module === nestedModule || candidate.module.startsWith(`${nestedModule}.`)) : importFiles(file, nestedModule, facts);
    return nested.length ? { kind: "module", files: nested, module: `${identity.module}.${name}` } : unresolved(`Module ${identity.module} has no source export ${name}`, []);
  }
  if (identity.declarations.some((declaration) => declaration.interface)) return unresolved(`Interface member ${name} has runtime dispatch`, identity.declarations.map((declaration) => declaration.symbol.id ?? declaration.symbol.qualifiedName ?? declaration.name));
  const owners = identity.declarations.map((declaration) => declaration.symbol.qualifiedName);
  const declarations = declarationsNamed(file, name, facts).filter((declaration) => owners.includes(declaration.owner) && (file.language !== "java" || identity.receiver || declaration.static || declaration.symbol.kind === "class"));
  if (declarations.length) return { ...identity, declarations };
  const fields = visibleFiles(file, facts).flatMap((candidate) => candidate.fields.filter((field) => owners.includes(field.owner) && field.name === name).map((field) => ({ field, candidate })));
  if (fields.length > 1) return unresolved(`Multiple source assignments establish field ${name}`, fields.map(({ field, candidate }) => `${candidate.path}:${field.index}`));
  if (fields[0]) {
    const { field, candidate } = fields[0];
    const initializer = field.value ?? field.type;
    if (!initializer) return unresolved(`Field ${name} has no source type or constructor`, []);
    const key = `${candidate.path}:${field.owner}:field:${name}`;
    if (visited.has(key)) return unresolved(`Cyclic source field ${name}`, []);
    const fieldIdentity = resolveExpression(candidate, initializer, field.lexicalScope, field.index, facts, new Set([...visited, key]));
    return fieldIdentity.kind === "declaration" ? { ...fieldIdentity, receiver: true, receiverProof: fieldIdentity.receiverProof ?? "declared-type", receiverId: `${candidate.path}:${field.owner}.${name}` } : fieldIdentity.kind === "external" ? { ...fieldIdentity, receiverId: fieldIdentity.receiverId ?? `${candidate.path}:${field.owner}.${name}` } : fieldIdentity;
  }
  const inherited: Declaration[] = [];
  for (const declaration of identity.declarations) {
    const key = `${declaration.symbol.id}:member:${name}`;
    if (visited.has(key)) continue;
    const ownerFile = facts.fileByPath.get(declaration.symbol.filePath);
    if (!ownerFile) continue;
    for (const base of declaration.bases) {
      const baseIdentity = resolveExpression(ownerFile, base, declaration.lexicalScope, Number.MAX_SAFE_INTEGER, facts, new Set([...visited, key]));
      const member = resolveMember(ownerFile, baseIdentity.kind === "declaration" ? { ...baseIdentity, receiver: identity.receiver } : baseIdentity, name, facts, new Set([...visited, key]));
      if (member.kind === "declaration") inherited.push(...member.declarations);
    }
  }
  return inherited.length ? { ...identity, declarations: inherited } : unresolved(`No source member ${name} belongs to the receiver declaration`, []);
}
function selectCallable(identity: Identity, arity: number): Identity {
  if (identity.kind === "module") return unresolved(`Module ${identity.module} does not identify a callable source declaration`, identity.files.map((file) => file.path));
  if (identity.kind !== "declaration") return identity;
  const declarations = identity.declarations.filter((declaration) => declaration.symbol.kind === "class" || declaration.arity === undefined || declaration.arity === arity || declaration.symbol.filePath.endsWith(".py"));
  if (declarations.length > 1) return unresolved("Multiple source declarations match the call; argument types and runtime dispatch are not proven", declarations.map((declaration) => declaration.symbol.id ?? declaration.symbol.qualifiedName ?? declaration.name));
  return declarations.length ? { ...identity, declarations } : unresolved(`No source overload accepts ${arity} argument(s); declared arities: ${identity.declarations.map((declaration) => declaration.arity).join(", ")}`, []);
}
function isJavaVirtualCall(file: FileFacts, call: Call, identity: Identity): boolean {
  if (file.language !== "java" || call.kind !== "call" || call.constructorCall || identity.kind !== "declaration") return false;
  const declaration = identity.declarations[0];
  return Boolean(declaration && declaration.symbol.kind === "method" && !declaration.static && !declaration.final && identity.receiverProof !== "construction");
}

function selectJavaConstructor(file: FileFacts, identity: Identity, arity: number, facts: BindingFacts): Identity {
  if (identity.kind !== "declaration") return identity;
  if (identity.declarations.length !== 1) return selectCallable(identity, arity);
  const classDeclaration = identity.declarations[0];
  const constructors = declarationsNamed(file, classDeclaration.name, facts).filter((declaration) => declaration.owner === classDeclaration.symbol.qualifiedName);
  return constructors.length ? selectCallable(declarationIdentity(constructors, false), arity) : arity === 0 ? identity : unresolved(`Class ${classDeclaration.name} only has the implicit no-argument constructor`, []);
}

function standardLibrary(module: string, language: TreeSitterLanguageId): boolean {
  if (language === "java") return isJavaPlatformModule(module);
  if (language === "go") return !module.split("/")[0]?.includes(".");
  return ["builtins", "pathlib", "subprocess", "sqlite3", "os", "sys", "json", "typing", "collections", "asyncio", "math", "re", "urllib", "http"].includes(module.split(".")[0] ?? "");
}
function isJavaPlatformModule(module: string): boolean {
  return module.startsWith("java.") || module.startsWith("javax.") || module.startsWith("jdk.");
}
function unresolvedJavaExternalCall(file: FileFacts, call: Call, identity: Identity): Extract<Identity, { kind: "unresolved" }> | undefined {
  if (file.language !== "java" || call.kind !== "call" || identity.kind !== "external" || isJavaPlatformModule(identity.module)) return undefined;
  const candidate = `external:${identity.module}${identity.members.length ? `.${identity.members.join(".")}` : ""}`;
  return unresolved(`Java dependency target ${candidate} is not source-indexed and the dependency classpath was not loaded`, [candidate]);
}
function makeRelation(file: FileFacts, call: Call, kind: SemanticRelation["kind"], identity: Identity, basis: string): SemanticRelation {
  let targetRef: SemanticTarget;
  if (identity.kind === "declaration" && identity.declarations.length === 1) {
    const symbol = identity.declarations[0].symbol;
    targetRef = { kind: "file", filePath: symbol.filePath, symbolId: symbol.id, declarationRange: symbol.range };
  } else if (identity.kind === "module" && identity.files.length === 1) targetRef = { kind: "file", filePath: identity.files[0].path };
  else if (identity.kind === "external") targetRef = { kind: "external", moduleName: identity.module, standardLibrary: standardLibrary(identity.module, file.language) };
  else targetRef = { kind: "unresolved", reason: identity.kind === "unresolved" ? identity.reason : "Multiple source files own the binding", candidates: identity.kind === "unresolved" ? identity.candidates : identity.kind === "module" ? identity.files.map((candidate) => candidate.path) : identity.declarations.map((declaration) => declaration.symbol.id ?? declaration.name) };
  const target = targetRef.kind === "file" ? targetRef.filePath : targetRef.kind === "external" ? `external:${targetRef.moduleName}` : kind === "import" ? call.name : `unresolved:${file.path}:${call.range.start.line}:${call.range.start.column}`;
  return { id: hash(`${file.scope.id}:${file.path}:${kind}:${call.range.start.line}:${call.range.start.column}:${target}:${call.name}`), kind, source: file.path, target, sourceFile: file.path, targetFile: targetRef.kind === "file" ? targetRef.filePath : undefined, targetRef, sourceRange: call.range, scopeId: file.scope.id, bindingBasis: basis, importUsage: kind === "import" ? "value" : undefined, symbol: call.name, detail: `${call.name} in ${file.path}`, confidence: targetRef.kind === "unresolved" ? "inferred" : "confirmed" };
}
function bindingDiagnostic(file: FileFacts, call: Call, identity: Extract<Identity, { kind: "unresolved" }>, code: string): SemanticDiagnostic {
  return { stage: "binding", code, severity: "warning", filePath: file.path, range: call.range, candidates: identity.candidates, message: `${call.name}: ${identity.reason}` };
}
function literalTarget(value: Expression | undefined): string | undefined {
  if (value?.kind === "literal") return value.value;
  if (value?.kind === "keyword") return literalTarget(value.value);
  if (value?.kind === "call") return literalTarget(value.arguments[0]);
  return undefined;
}
function positionalArgument(arguments_: Expression[], index: number): Expression | undefined { return arguments_.filter((argument) => argument.kind !== "keyword")[index]; }
function namedArgument(arguments_: Expression[], name: string): Expression | undefined { return arguments_.find((argument) => argument.kind === "keyword" && argument.name === name); }
function pythonConnectionOrigin(arguments_: Expression[], api: string): string | undefined {
  const host = literalTarget(positionalArgument(arguments_, 0) ?? namedArgument(arguments_, "host"));
  const port = positionalArgument(arguments_, 1) ?? namedArgument(arguments_, "port");
  const value = port?.kind === "keyword" ? port.value : port;
  if (!host || /[\s/]/.test(host) || value && value.kind !== "number") return undefined;
  const portNumber = value?.kind === "number" ? Number(value.value.replaceAll("_", "")) : undefined;
  if (portNumber !== undefined && (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535)) return undefined;
  return `${api === "HTTPSConnection" ? "https" : "http"}://${host}${portNumber !== undefined ? `:${portNumber}` : ""}`;
}
function pythonRequestUrl(origin: string | undefined, path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//.test(path)) return path;
  return origin && path.startsWith("/") ? `${origin}${path}` : undefined;
}

function externalReturnIdentity(identity: Extract<Identity, { kind: "external" }>, arguments_: Expression[], file: FileFacts, lexicalScope: number, index: number, facts: BindingFacts, visited: Set<string>): Identity {
  const api = identity.members.at(-1) ?? identity.module.split(".").at(-1) ?? identity.module;
  const factories: Record<string, string[]> = {
    requests: ["Session", "session"], httpx: ["Client", "AsyncClient"], pathlib: ["Path", "PosixPath", "WindowsPath", "PurePath"],
    "urllib.request": ["Request"], "http.client": ["HTTPConnection", "HTTPSConnection"],
    sqlite3: ["connect", "cursor"], builtins: ["open"], subprocess: ["Popen"],
    "java.lang.ProcessBuilder": ["ProcessBuilder", "command", "directory", "redirectErrorStream"],
    "java.net.http.HttpClient": ["newHttpClient", "newBuilder", "build"],
    "java.net.http.HttpRequest": ["newBuilder", "uri", "GET", "POST", "PUT", "DELETE", "method", "header", "build"],
    "java.net.URI": ["create"], "java.nio.file.Path": ["of"], "java.nio.file.Paths": ["get"],
    "java.sql.DriverManager": ["getConnection", "createStatement", "prepareStatement"],
    "java.sql.Connection": ["createStatement", "prepareStatement"],
    "net/http": ["Client", "NewRequest", "NewRequestWithContext"], "os/exec": ["Command", "CommandContext"],
    "database/sql": ["Open", "OpenDB"], "os": ["Open", "Create"]
  };
  if (!factories[identity.module]?.includes(api)) return unresolved(`Return receiver of ${identity.module}.${api} is not source-proven`, []);
  const targetIndex = identity.module === "database/sql" && api === "Open" || identity.module === "os/exec" && api === "CommandContext" || identity.module === "net/http" && api === "NewRequest" ? 1 : identity.module === "net/http" && api === "NewRequestWithContext" ? 2 : 0;
  const argument = positionalArgument(arguments_, targetIndex) ?? namedArgument(arguments_, "url");
  const argumentIdentity = argument ? resolveExpression(file, argument, lexicalScope, index, facts, visited) : undefined;
  const argumentTarget = literalTarget(argument) ?? (argumentIdentity?.kind === "external" || argumentIdentity?.kind === "declaration" ? argumentIdentity.target : undefined);
  const connectionFactory = identity.module === "sqlite3" && api === "connect" || identity.module === "database/sql" && api === "Open" || identity.module === "java.sql.DriverManager" && api === "getConnection";
  const connectionUrl = identity.module === "http.client" && ["HTTPConnection", "HTTPSConnection"].includes(api) ? pythonConnectionOrigin(arguments_, api) : undefined;
  const target = connectionFactory ? undefined : identity.module === "http.client" ? connectionUrl : argumentTarget ?? identity.target;
  const origin = connectionFactory ? argumentTarget : connectionUrl ?? identity.origin;
  const method = identity.module === "urllib.request" && api === "Request" ? httpMethod(literalTarget(namedArgument(arguments_, "method")) ?? (positionalArgument(arguments_, 1) || namedArgument(arguments_, "data") ? "UNKNOWN" : "GET")) : identity.module === "net/http" && api.startsWith("NewRequest") ? httpMethod(literalTarget(arguments_[api === "NewRequest" ? 0 : 1]) ?? "") : identity.module === "java.net.http.HttpRequest" && ["GET", "POST", "PUT", "DELETE"].includes(api) ? httpMethod(api) : identity.method;
  return { ...identity, target, origin, method, receiverId: identity.receiverId ?? `${file.path}:${index}:${identity.module}.${api}` };
}

function operationFromIdentity(file: FileFacts, call: Call, identity: Identity, facts: BindingFacts): SemanticOperationFact | undefined {
  if (identity.kind !== "external") return undefined;
  const module = identity.module;
  const api = identity.members.at(-1) ?? module.split(".").at(-1) ?? module;
  const known = (modules: string[], apis: string[]) => modules.includes(module) && apis.includes(api);
  let kind: SemanticOperationFact["kind"] | undefined;
  let operation: SemanticOperationFact["operation"] = "invoke";
  let method: SemanticOperationFact["method"] | undefined;
  if (known(["requests", "httpx", "net/http"], ["get", "post", "put", "patch", "delete", "head", "options", "request", "Get", "Post", "PostForm", "Head", "Do"]) || known(["java.net.http.HttpClient"], ["send", "sendAsync"]) || known(["urllib.request"], ["urlopen"]) || known(["http.client"], ["request"])) { kind = "http"; method = httpMethod(api); }
  if (known(["builtins"], ["open"]) || known(["pathlib"], ["read_text", "read_bytes", "write_text", "write_bytes", "open", "unlink", "mkdir"]) || known(["java.nio.file.Files"], ["readString", "readAllBytes", "readAllLines", "newInputStream", "write", "writeString", "newOutputStream", "delete", "deleteIfExists", "createFile", "createDirectory"]) || known(["os"], ["ReadFile", "Open", "WriteFile", "Create", "Remove", "Mkdir", "MkdirAll"])) { kind = "filesystem"; operation = /^(write|Write|Create|create|delete|Remove|unlink|mkdir|Mkdir|newOutput)/.test(api) ? "write" : "read"; }
  if (known(["subprocess"], ["run", "Popen", "call", "check_call", "check_output"]) || known(["os/exec"], ["Run", "Start", "Output", "CombinedOutput"]) || known(["java.lang.ProcessBuilder"], ["start"])) kind = "process";
  if (known(["sqlite3"], ["execute", "executemany", "executescript"]) || known(["database/sql"], ["Query", "QueryContext", "QueryRow", "QueryRowContext", "Exec", "ExecContext", "Ping", "PingContext"]) || known(["java.sql.DriverManager", "java.sql.Connection", "java.sql.Statement", "java.sql.PreparedStatement"], ["execute", "executeQuery", "executeUpdate"])) { kind = "database"; operation = /^(executeUpdate|Exec|executemany|executescript)/.test(api) ? "write" : /^(Query|executeQuery)/.test(api) ? "read" : "invoke"; }
  if (!kind) return undefined;
  const targetArgument = module === "http.client" ? 1 : module === "database/sql" && api.endsWith("Context") ? 1 : 0;
  const argument = positionalArgument(call.arguments, targetArgument) ?? namedArgument(call.arguments, "url");
  const argumentIdentity = argument ? resolveExpression(file, argument, call.lexicalScope, call.index, facts, new Set()) : undefined;
  const argumentTarget = literalTarget(argument) ?? (argumentIdentity?.kind === "external" || argumentIdentity?.kind === "declaration" ? argumentIdentity.target : undefined);
  const target = module === "http.client" ? pythonRequestUrl(identity.origin, argumentTarget) : argumentTarget ?? identity.target;
  if (kind === "database" && target && ["execute", "executemany", "executescript"].includes(api)) { const verb = target.trim().split(/\s+/)[0]?.toUpperCase(); operation = verb === "SELECT" ? "read" : ["INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "REPLACE"].includes(verb ?? "") ? "write" : "invoke"; }
  if (kind === "http" && method === "UNKNOWN" && argumentIdentity?.kind === "external") method = argumentIdentity.method ?? method;
  if (module === "http.client") method = httpMethod(literalTarget(positionalArgument(call.arguments, 0) ?? namedArgument(call.arguments, "method")) ?? "");
  if (module === "urllib.request" && method === "UNKNOWN" && !positionalArgument(call.arguments, 1) && !namedArgument(call.arguments, "data")) method = argumentIdentity?.kind === "external" ? argumentIdentity.method ?? "UNKNOWN" : "GET";
  if (module === "builtins" && api === "open") { const mode = literalTarget(call.arguments[1]); if (mode && /[wax+]/.test(mode)) operation = "write"; }
  return { kind, filePath: file.path, range: call.range, scopeId: file.scope.id, moduleName: module, apiName: api, receiverId: identity.receiverId, target, operation, method, origin: kind === "database" ? identity.origin : target?.match(/^https?:\/\/[^/]+/)?.[0], confidence: target ? "confirmed" : "inferred" };
}
function httpMethod(api: string): SemanticOperationFact["method"] {
  const value = api.toUpperCase();
  return value === "GET" || value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE" || value === "HEAD" || value === "OPTIONS" ? value : "UNKNOWN";
}

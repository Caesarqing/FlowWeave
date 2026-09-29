import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ArchitectureEvidence, SemanticDiagnostic, SemanticOperationFact, SemanticRelation, SemanticResource } from "../../types";

/** Converts API-identity-checked operations into resources or explicit unresolved facts. */
export function buildResourceRelations(operations: SemanticOperationFact[], imports: SemanticRelation[]): { resources: SemanticResource[]; relations: SemanticRelation[]; diagnostics: SemanticDiagnostic[] } {
  const resources = new Map<string, SemanticResource>();
  const relations: SemanticRelation[] = [];
  const diagnostics: SemanticDiagnostic[] = [];
  for (const fact of [...operations].sort((a, b) => operationKey(a).localeCompare(operationKey(b)))) {
    const identity = resourceIdentity(fact);
    const id = fingerprint(`operation:${operationKey(fact)}`);
    const evidence: ArchitectureEvidence = { operation: fact.operation, role: fact.role, relationId: id, filePath: fact.filePath, range: fact.range, line: fact.range.start.line, symbol: fact.apiName, bindingBasis: `API identity: ${fact.moduleName}.${fact.apiName}`, detail: `${fact.operation} via ${fact.moduleName}.${fact.apiName}` };
    if (!identity) {
      const reason = fact.unresolvedReason ?? (fact.kind === "event" && !fact.receiverId ? "Event channel or emitter identity could not be located" : fact.kind === "filesystem" && fact.target ? "Relative filesystem path has no statically proven base" : fact.kind === "database" ? "SQL is dynamic or outside the supported single-table statement grammar" : "Operation target is not a statically identifiable resource");
      relations.push({ id, kind: fact.kind, source: fact.filePath, target: `unresolved:${id}`, sourceFile: fact.filePath, sourceRange: fact.range, scopeId: fact.scopeId, symbol: fact.apiName, operation: fact.operation, role: fact.role, targetRef: { kind: "unresolved", reason, candidates: [] }, bindingBasis: evidence.bindingBasis, detail: reason, confidence: "inferred" });
      diagnostics.push({ code: "resource-target-unresolved", severity: "warning", filePath: fact.filePath, relationId: id, range: fact.range, message: reason });
      continue;
    }
    const resourceId = `resource:${fingerprint(identity.key)}`;
    const previous = resources.get(resourceId);
    resources.set(resourceId, { id: resourceId, kind: identity.kind, scopeId: fact.scopeId, key: identity.key, title: identity.title, detail: identity.detail, evidence: [...(previous?.evidence ?? []), evidence] });
    relations.push({ id, kind: fact.kind, source: fact.filePath, target: resourceId, sourceFile: fact.filePath, sourceRange: fact.range, scopeId: fact.scopeId, symbol: fact.apiName, operation: fact.operation, role: fact.role, targetRef: { kind: "resource", resourceId }, bindingBasis: evidence.bindingBasis, detail: `${fact.operation} ${identity.title}`, confidence: identity.inferred ? "inferred" : fact.confidence });
  }
  for (const relation of imports.filter((item) => item.kind === "import" && item.targetRef?.kind === "external")) {
    if (relation.targetRef?.kind !== "external") continue;
    const moduleName = relation.targetRef.moduleName;
    const key = `package:${relation.scopeId ?? "project"}:${moduleName}`;
    const id = `resource:${fingerprint(key)}`;
    const evidence: ArchitectureEvidence = { relationId: relation.id, filePath: relation.sourceFile, range: relation.sourceRange, line: relation.sourceRange?.start.line, symbol: relation.symbol, detail: `Imports ${moduleName}`, bindingBasis: relation.bindingBasis };
    const previous = resources.get(id);
    resources.set(id, { id, kind: "package", scopeId: relation.scopeId ?? "project", key, title: moduleName, detail: relation.targetRef.standardLibrary ? "Standard library dependency" : "External module dependency; implementation is outside the scanned sources", evidence: [...(previous?.evidence ?? []), evidence] });
    relations.push({ ...relation, target: id, targetRef: { kind: "resource", resourceId: id } });
  }
  return { resources: [...resources.values()].sort((a, b) => a.id.localeCompare(b.id)), relations: relations.sort((a, b) => a.id.localeCompare(b.id)), diagnostics };
}

type ResourceIdentity = { kind: SemanticResource["kind"]; key: string; title: string; detail: string; inferred: boolean };

function resourceIdentity(fact: SemanticOperationFact): ResourceIdentity | undefined {
  if (fact.unresolvedReason || !fact.target || !fact.target.trim()) return undefined;
  if (fact.kind === "http") return httpIdentity(fact);
  if (fact.kind === "event") {
    if (!fact.receiverId) return undefined;
    return { kind: "event", key: `event:${fact.receiverId}:${fact.target}`, title: fact.target, detail: `Event channel ${fact.receiverId}`, inferred: false };
  }
  if (fact.kind === "database") {
    const name = databaseTable(fact.target, fact.moduleName);
    if (!name) return undefined;
    return { kind: "database", key: `database:${fact.receiverId ?? fact.scopeId}:${name}`, title: name, detail: `SQL table in ${fact.receiverId ?? fact.scopeId}`, inferred: fact.receiverId === undefined };
  }
  if (fact.kind === "filesystem") {
    const path = posix.normalize(fact.target.replaceAll("\\", "/"));
    const absolute = path.startsWith("/") || /^[A-Za-z]:\//.test(path);
    if (!absolute) return undefined;
    return { kind: "filesystem", key: `filesystem:absolute:${path}`, title: path, detail: "Literal absolute filesystem path", inferred: false };
  }
  return { kind: "process", key: `process:${fact.scopeId}:${fact.target}`, title: fact.target, detail: "Statically named process invocation; runtime execution is not observed", inferred: false };
}

function databaseTable(target: string, moduleName: string): string | undefined {
  const sql = target.trim().replace(/;$/, "").trim();
  if (moduleName === "@prisma/client") return /^[A-Za-z_$][\w$]*$/.test(sql) ? sql : undefined;
  // ponytail: a single-table grammar; joins, subqueries, comments and multiple statements need a SQL parser.
  const syntax = sql.replace(/'(?:''|[^'])*'/g, "?");
  if (/;|--|\/\*|\b(?:join|union|with|intersect|except|using)\b/i.test(syntax) || (syntax.match(/\bselect\b/gi)?.length ?? 0) > 1) return undefined;
  const identifier = '(?:[A-Za-z_$][\\w$]*|"[^"\\n]+"|`[^`\\n]+`|\\[[^\\]\\n]+\\])';
  const table = `(${identifier}(?:\\.${identifier})*)`;
  const select = syntax.match(new RegExp(`^select\\s+.+?\\s+from\\s+${table}(?=\\s|$)([\\s\\S]*)$`, "i"));
  if (select && /^(?:\s*(?:where|order\s+by|group\s+by|having|limit|offset)\b[\s\S]*|\s*)$/i.test(select[2]) && (syntax.match(/\bfrom\b/gi)?.length ?? 0) === 1) return select[1].replace(/["`\[\]]/g, "");
  const write = syntax.match(new RegExp(`^(?:insert\\s+into\\s+${table}\\s*(?:\\([^)]*\\)\\s*)?(?:values|default\\s+values)\\b|update\\s+${table}\\s+set\\b|delete\\s+from\\s+${table}(?=\\s|$))`, "i"));
  if (!write || /\bselect\b/i.test(syntax) || !/^delete\b/i.test(syntax) && /\bfrom\b/i.test(syntax)) return undefined;
  return (write[1] ?? write[2] ?? write[3]).replace(/["`\[\]]/g, "");
}

function httpIdentity(fact: SemanticOperationFact): ResourceIdentity | undefined {
  const method = fact.method ?? "UNKNOWN";
  const target = fact.target!;
  if (/^https?:\/\//i.test(target)) {
    let url: URL;
    try { url = new URL(target); } catch (error) { if (error instanceof TypeError) return undefined; throw error; }
    const endpoint = `${url.origin}${url.pathname}`;
    return { kind: "api", key: `api:${method}:${url.origin}:${url.pathname}`, title: `${method} ${endpoint}`, detail: "Literal HTTP endpoint; query values and credentials are excluded", inferred: method === "UNKNOWN" };
  }
  if (target.startsWith("//") || !target.startsWith("/")) return undefined;
  const path = target.split(/[?#]/, 1)[0];
  let origin = fact.origin;
  if (origin) {
    try { origin = new URL(origin).origin; } catch (error) { if (error instanceof TypeError) origin = undefined; else throw error; }
  }
  const endpoint = origin ? `${origin}${path}` : path;
  return { kind: "api", key: `api:${method}:${origin ?? `scope:${fact.scopeId}`}:${path}`, title: `${method} ${endpoint}`, detail: origin ? "HTTP endpoint with a statically located origin" : "Relative HTTP endpoint; service origin is not proven", inferred: origin === undefined || method === "UNKNOWN" };
}

function operationKey(fact: SemanticOperationFact): string {
  // Hash the raw literal to retain call-site identity without persisting URL credentials.
  return `${fact.filePath}:${fact.range.start.line}:${fact.range.start.column}:${fact.range.end.line}:${fact.range.end.column}:${fact.kind}:${fact.operation}:${fact.role ?? ""}:${fact.apiName}:${fingerprint(fact.target ?? "")}`;
}
function fingerprint(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }

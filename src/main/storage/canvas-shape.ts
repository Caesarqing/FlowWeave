export function graphNodeShapeIssue(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  for (const field of ["id", "title", "subtitle", "description", "guidanceDraft"] as const) {
    if (typeof value[field] !== "string") return `${path}.${field} must be a string`;
  }
  if (!enumHas(value.kind, ["module", "requirement", "task", "file", "doc", "agent", "diff"])) return `${path}.kind is invalid`;
  if (!enumHas(value.nodeType, ["module", "entrypoint", "api", "service", "data", "external", "worker", "utility", "test"])) return `${path}.nodeType is invalid`;
  if (!enumHas(value.risk, ["low", "medium", "high", "unknown"])) return `${path}.risk is invalid`;
  if (!enumHas(value.status, ["mapped", "needs-review", "draft"])) return `${path}.status is invalid`;
  if (!Array.isArray(value.files) || value.files.some((file) => typeof file !== "string")) return `${path}.files must be an array of strings`;
  if (typeof value.x !== "number" || !Number.isFinite(value.x) || typeof value.y !== "number" || !Number.isFinite(value.y)) return `${path}.x and ${path}.y must be finite numbers`;
  if (value.evidence !== undefined) {
    const issue = evidenceArrayShapeIssue(value.evidence, `${path}.evidence`);
    if (issue) return issue;
  }
  if (value.fileRoles !== undefined && (!Array.isArray(value.fileRoles) || value.fileRoles.some((item) => !isRecord(item) || typeof item.path !== "string" || typeof item.role !== "string"))) return `${path}.fileRoles must contain path and role strings`;
  if (value.symbols !== undefined && (!Array.isArray(value.symbols) || value.symbols.some((item) => !isRecord(item) || typeof item.name !== "string" || typeof item.kind !== "string" || typeof item.filePath !== "string"))) return `${path}.symbols must contain valid symbols`;
  if (value.relationDiagnostics !== undefined && (!Array.isArray(value.relationDiagnostics) || value.relationDiagnostics.some((item) => !isRecord(item) || typeof item.code !== "string" || typeof item.message !== "string" || typeof item.filePath !== "string" || (item.candidates !== undefined && (!Array.isArray(item.candidates) || item.candidates.some((candidate) => typeof candidate !== "string"))) || (item.range !== undefined && !validRange(item.range))))) return `${path}.relationDiagnostics must contain valid diagnostics`;
  return undefined;
}

export function graphEdgeShapeIssue(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  for (const field of ["id", "source", "target"] as const) {
    if (typeof value[field] !== "string" || !value[field]) return `${path}.${field} must be a non-empty string`;
  }
  if (!enumHas(value.relation, ["depends_on", "calls", "reads", "writes", "reads_writes", "http_contract", "process_invocation", "external_api", "publishes_event", "subscribes_event", "tests"])) return `${path}.relation is invalid`;
  if (value.guidanceNote !== undefined && typeof value.guidanceNote !== "string") return `${path}.guidanceNote must be a string`;
  if (value.evidence !== undefined) {
    const issue = evidenceArrayShapeIssue(value.evidence, `${path}.evidence`);
    if (issue) return issue;
  }
  for (const field of ["semanticKinds", "operations", "importUsages", "sourceRelationIds", "aggregatedEdgeIds"] as const) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some((entry) => typeof entry !== "string"))) return `${path}.${field} must be an array of strings`;
  }
  return undefined;
}

function evidenceArrayShapeIssue(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value)) return `${path} must be an array`;
  for (const [index, evidence] of value.entries()) {
    if (!isRecord(evidence) || typeof evidence.detail !== "string") return `${path}[${index}] must include a detail string`;
    for (const field of ["filePath", "symbol", "eventId", "relationId", "bindingBasis"] as const) {
      if (evidence[field] !== undefined && typeof evidence[field] !== "string") return `${path}[${index}].${field} must be a string`;
    }
    if (evidence.line !== undefined && (typeof evidence.line !== "number" || !Number.isFinite(evidence.line))) return `${path}[${index}].line must be a finite number`;
    if (evidence.range !== undefined && !validRange(evidence.range)) return `${path}[${index}].range is invalid`;
    if (evidence.declarationRange !== undefined && !validRange(evidence.declarationRange)) return `${path}[${index}].declarationRange is invalid`;
  }
  return undefined;
}

function validRange(value: unknown): boolean {
  return isRecord(value) && validPosition(value.start) && validPosition(value.end);
}

function validPosition(value: unknown): boolean {
  return isRecord(value) && Number.isInteger(value.line) && Number(value.line) > 0 && Number.isInteger(value.column) && Number(value.column) > 0;
}

function enumHas(value: unknown, options: readonly string[]): boolean {
  return typeof value === "string" && options.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

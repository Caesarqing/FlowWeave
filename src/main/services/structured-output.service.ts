import type { ArchitectureReviewResponse } from "../../types";

export type StructuredJsonResult =
  | { value: unknown; raw: string }
  | { error: "missing-json" | "malformed-json"; raw?: string };

export type ArchitectureReviewParseContext = {
  moduleIds: string[];
  evidence: Array<{ id: string; moduleIds: string[] }>;
};

export class ArchitectureReviewResponseError extends Error {
  readonly code = "ARCHITECTURE_REVIEW_INVALID_RESPONSE";
  readonly moduleIds: string[];

  constructor(message: string, moduleIds: string[]) {
    super(message);
    this.name = "ArchitectureReviewResponseError";
    this.moduleIds = moduleIds;
  }
}

export function extractStructuredJson(output: string, requiredKey?: string | string[]): StructuredJsonResult {
  const candidates = collectJsonCandidates(output);
  if (candidates.length === 0) {
    return looksLikeTruncatedJson(output)
      ? { error: "malformed-json", raw: output.trim() }
      : { error: "missing-json" };
  }

  let parsedAny = false;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      parsedAny = true;
      const unwrapped = unwrapProviderValue(parsed);
      if (requiredKey && !hasObjectKeys(unwrapped, Array.isArray(requiredKey) ? requiredKey : [requiredKey])) continue;
      return { value: unwrapped, raw: candidate };
    } catch {
      continue;
    }
  }
  return { error: parsedAny ? "missing-json" : "malformed-json", raw: candidates[0] };
}

export function parseArchitectureReviewResponse(
  output: string,
  context: ArchitectureReviewParseContext
): ArchitectureReviewResponse {
  const extracted = extractStructuredJson(output, ["modules", "findings"]);
  if (!("value" in extracted)) {
    throw new ArchitectureReviewResponseError(
      extracted.error === "malformed-json" ? "Malformed architecture review JSON." : "Missing architecture review JSON.",
      []
    );
  }

  const value = requireRecord(extracted.value, "Architecture review response must be an object.");
  rejectUnknownKeys(value, ["architectureStyle", "modules", "findings"], "response");
  const validModuleIds = new Set(context.moduleIds);
  const evidenceById = new Map(context.evidence.map((evidence) => [evidence.id, evidence]));
  if (value.architectureStyle !== undefined) requireString(value.architectureStyle, "architectureStyle");
  if (!Array.isArray(value.modules)) throw new ArchitectureReviewResponseError("modules must be an array.", []);
  if (!Array.isArray(value.findings)) throw new ArchitectureReviewResponseError("findings must be an array.", []);

  const seenModuleIds = new Set<string>();
  const modules = value.modules.map((entry, index) => {
    const module = requireRecord(entry, `modules[${index}] must be an object.`);
    rejectUnknownKeys(module, ["moduleId", "title", "role", "description", "assessmentNotes"], `modules[${index}]`);
    const moduleId = requireString(module.moduleId, `modules[${index}].moduleId`);
    if (!validModuleIds.has(moduleId)) {
      throw new ArchitectureReviewResponseError(`Unknown moduleId: ${moduleId}`, []);
    }
    if (seenModuleIds.has(moduleId)) {
      throw new ArchitectureReviewResponseError(`Duplicate moduleId: ${moduleId}`, [moduleId]);
    }
    seenModuleIds.add(moduleId);
    return {
      moduleId,
      title: optionalString(module.title, `modules[${index}].title`),
      role: optionalString(module.role, `modules[${index}].role`),
      description: optionalString(module.description, `modules[${index}].description`),
      assessmentNotes: optionalString(module.assessmentNotes, `modules[${index}].assessmentNotes`)
    };
  });

  const findings = value.findings.map((entry, index) => {
    const finding = requireRecord(entry, `findings[${index}] must be an object.`);
    rejectUnknownKeys(finding, ["code", "severity", "moduleIds", "message", "evidenceIds"], `findings[${index}]`);
    const code = requireString(finding.code, `findings[${index}].code`);
    if (finding.severity !== "warning" && finding.severity !== "error") {
      throw new ArchitectureReviewResponseError(`findings[${index}].severity must be warning or error.`, []);
    }
    const severity: "warning" | "error" = finding.severity;
    const moduleIds = requireStringArray(finding.moduleIds, `findings[${index}].moduleIds`);
    if (moduleIds.length === 0 || moduleIds.some((moduleId) => !validModuleIds.has(moduleId))) {
      throw new ArchitectureReviewResponseError(`findings[${index}] references an unknown or empty moduleIds list.`, moduleIds);
    }
    const message = requireString(finding.message, `findings[${index}].message`);
    const evidenceIds = requireStringArray(finding.evidenceIds, `findings[${index}].evidenceIds`);
    if (evidenceIds.length === 0 || evidenceIds.some((id) => {
      const evidence = evidenceById.get(id);
      return !evidence || !evidence.moduleIds.some((moduleId) => moduleIds.includes(moduleId));
    })) {
      throw new ArchitectureReviewResponseError(`Invalid finding evidence in findings[${index}].`, moduleIds);
    }
    return { code, severity, moduleIds, message, evidenceIds };
  });

  return {
    architectureStyle: optionalString(value.architectureStyle, "architectureStyle"),
    modules,
    findings
  };
}

export function extractProviderOutputText(output: string): string {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const value = unwrapProviderValue(parsed);
    return typeof value === "string" ? value.trim() : trimmed;
  } catch {
    return trimmed;
  }
}

function collectJsonCandidates(output: string): string[] {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of output.matchAll(fenced)) {
    candidates.push(...balancedObjects(match[1]));
  }
  candidates.push(...balancedObjects(output));
  return [...new Set(candidates)];
}

function balancedObjects(value: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function unwrapProviderValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  for (const key of ["structured_output", "result", "response", "content", "output", "message"]) {
    const nested = value[key];
    if (typeof nested === "string") {
      const extracted = extractStructuredJson(nested);
      if ("value" in extracted) return extracted.value;
      return nested;
    }
    if (isRecord(nested)) return unwrapProviderValue(nested);
  }
  return value;
}

function hasObjectKeys(value: unknown, keys: string[]): boolean {
  return isRecord(value) && keys.every((key) => key in value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ArchitectureReviewResponseError(label, []);
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ArchitectureReviewResponseError(`Unsupported architecture review field ${label}.${unknown}.`, []);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ArchitectureReviewResponseError(`${label} must be a non-empty string.`, []);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new ArchitectureReviewResponseError(`${label} must be an array of non-empty strings.`, []);
  }
  return value as string[];
}

function looksLikeTruncatedJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || /```json\s*[\[{]/i.test(trimmed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

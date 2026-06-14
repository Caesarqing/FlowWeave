export type StructuredJsonResult =
  | { value: unknown; raw: string }
  | { error: "missing-json" | "malformed-json"; raw?: string };

export function extractStructuredJson(output: string, requiredKey?: string): StructuredJsonResult {
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
      if (requiredKey && !hasObjectKey(unwrapped, requiredKey)) continue;
      return { value: unwrapped, raw: candidate };
    } catch {
      continue;
    }
  }
  return { error: parsedAny ? "missing-json" : "malformed-json", raw: candidates[0] };
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

function hasObjectKey(value: unknown, key: string): boolean {
  return isRecord(value) && key in value;
}

function looksLikeTruncatedJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || /```json\s*[\[{]/i.test(trimmed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(channel: string, value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[${channel}] Invalid "${name}": expected a non-empty string.`);
  }
  return value;
}

export function requireObject(channel: string, value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[${channel}] Invalid "${name}": expected an object.`);
  }
  return value as Record<string, unknown>;
}

export function requireEnum<T extends string>(
  channel: string,
  value: unknown,
  name: string,
  allowed: readonly T[]
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`[${channel}] Invalid "${name}": expected one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function requireStringArray(channel: string, value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`[${channel}] Invalid "${name}": expected an array of strings.`);
  }
  return value;
}

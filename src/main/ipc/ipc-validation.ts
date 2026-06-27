export function requireString(channel: string, value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[${channel}] Invalid "${name}": expected a non-empty string.`);
  }
  return value;
}

export function optionalTrimmedString(
  channel: string,
  value: unknown,
  name: string
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`[${channel}] Invalid "${name}": expected a string when provided.`);
  }
  return value.trim() || undefined;
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

export function requireSafeId(channel: string, value: unknown, name: string): string {
  const id = requireString(channel, value, name);
  if (id.includes("..") || id.includes("/") || id.includes("\\") || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new Error(`[${channel}] Invalid "${name}": expected a safe identifier.`);
  }
  return id;
}

export function requireBoolean(channel: string, value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`[${channel}] Invalid "${name}": expected a boolean.`);
  }
  return value;
}

export function requireInteger(
  channel: string,
  value: unknown,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`[${channel}] Invalid "${name}": expected an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

export function requireBoundedString(
  channel: string,
  value: unknown,
  name: string,
  maxLength: number
): string {
  const text = requireString(channel, value, name);
  if (text.length > maxLength) {
    throw new Error(`[${channel}] Invalid "${name}": exceeds ${maxLength} characters.`);
  }
  return text;
}

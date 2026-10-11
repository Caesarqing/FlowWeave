import type { CanvasMigrationPendingItem } from "../types";

export function canvasMigrationPendingItemId(item: CanvasMigrationPendingItem): string {
  const serialized = stableJson(item);
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const hashes = seeds.map((seed, index) => hashText(serialized, seed, index % 2 === 0 ? 0x01000193 : 0x27d4eb2d));
  return hashes.map((hash) => hash.toString(16).padStart(8, "0")).join("");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hashText(value: string, seed: number, prime: number): number {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, prime);
  }
  return hash >>> 0;
}

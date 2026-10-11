import { GenerationInputChangedError } from "./generation-errors";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type * as TypeScript from "typescript";

const require = createRequire(import.meta.url);
export type SourceSnapshot = {
  read: (path: string) => string | undefined;
  info: (path: string) => { size: number; modifiedAt: string };
  trackFile: (path: string) => void;
  resetForRebuild: () => void;
  system: TypeScript.System;
  fingerprint: () => string;
  inputState: () => { filePaths: string[]; observations: Array<[string, string]>; trackedFileHashes: Array<[string, string, string]> };
  validate: () => void;
};

/** Freeze source/config/declaration reads and resolution probes; validate all observations before commit. */
export function createSourceSnapshot(paths: string[], priorInputState?: {
  filePaths: string[];
  observations: Array<[string, string]>;
  trackedFileHashes?: Array<[string, string, string]>;
}): SourceSnapshot {
  const ts = require("typescript") as typeof TypeScript;
  const contents = new Map<string, string | undefined>();
  const sourcePaths = new Set(paths.map((path) => resolve(path)));
  const metadata = new Map<string, { size: number; modifiedAt: string }>();
  const observations = new Map<string, { value: string; read: () => string }>();
  const trackedFileHashes = new Map<string, { hash: string; statSignature: string }>();
  const previousTrackedFileHashes = new Map((priorInputState?.trackedFileHashes ?? []).map(([path, hash, statSignature]) => [resolve(path), { hash, statSignature }]));
  function observe<T>(key: string, read: () => T): T {
    const previous = observations.get(key);
    if (previous) return JSON.parse(previous.value) as T;
    const value = read();
    observations.set(key, { value: JSON.stringify(value), read: () => JSON.stringify(read()) });
    return value;
  }
  function read(path: string): string | undefined {
    const key = resolve(path);
    if (contents.has(key)) return contents.get(key);
    if (!sourcePaths.has(key) && /\.d\.(?:ts|mts|cts)$/.test(key)) {
      trackFile(key);
      try { return readFileSync(key, "utf8"); }
      catch (error) { if (!isMissing(error)) throw error; return undefined; }
    }
    let content: string | undefined;
    try { content = readFileSync(key, "utf8"); }
    catch (error) { if (!isMissing(error)) throw error; }
    contents.set(key, content);
    return content;
  }
  function info(path: string): { size: number; modifiedAt: string } {
    const key = resolve(path);
    const previous = metadata.get(key);
    if (previous) return previous;
    const result = statSync(key);
    const value = { size: result.size, modifiedAt: result.mtime.toISOString() };
    metadata.set(key, value);
    return value;
  }
  function trackFile(path: string): void {
    const key = resolve(path);
    if (contents.has(key) || trackedFileHashes.has(key)) return;
    const stat = fileStatSignature(key);
    const previous = previousTrackedFileHashes.get(key);
    trackedFileHashes.set(key, {
      hash: previous?.statSignature === stat ? previous.hash : contentHash(key),
      statSignature: stat
    });
  }
  function resetForRebuild(): void {
    for (const path of contents.keys()) if (!sourcePaths.has(path)) contents.delete(path);
    trackedFileHashes.clear();
    observations.clear();
  }
  for (const path of paths) { info(path); read(path); }
  for (const path of priorInputState?.filePaths ?? []) read(path);
  for (const [path] of priorInputState?.trackedFileHashes ?? []) trackFile(path);
  for (const [key] of priorInputState?.observations ?? []) {
    const readObservation = observationReader(ts, key);
    observations.set(key, { value: JSON.stringify(readObservation()), read: () => JSON.stringify(readObservation()) });
  }
  const system: TypeScript.System = {
    ...ts.sys, readFile: read,
    fileExists: (path) => observe(`file:${resolve(path)}`, () => ts.sys.fileExists(path)),
    directoryExists: (path) => observe(`directory:${resolve(path)}`, () => ts.sys.directoryExists(path)),
    getDirectories: (path) => observe(`directories:${resolve(path)}`, () => ts.sys.getDirectories(path)),
    readDirectory: (path, extensions, exclude, include, depth) => observe(`listing:${JSON.stringify([resolve(path), extensions, exclude, include, depth])}`, () => ts.sys.readDirectory(path, extensions, exclude, include, depth)),
    realpath: (path) => observe(`realpath:${resolve(path)}`, () => ts.sys.realpath ? ts.sys.realpath(path) : resolve(path))
  };
  function fingerprint(): string {
    return createHash("sha256").update(JSON.stringify([...contents.entries()].sort(([a], [b]) => a.localeCompare(b))))
      .update(JSON.stringify([...trackedFileHashes.entries()].map(([path, state]) => [path, state.hash]).sort(([a], [b]) => a.localeCompare(b))))
      .update(JSON.stringify([...observations.entries()].map(([key, item]) => [key, item.value]).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
  }
  function validate(): void {
    for (const [path, content] of contents) {
      let current: string | undefined;
      try { current = readFileSync(path, "utf8"); } catch (error) { if (!isMissing(error)) throw error; }
      if (current !== content) throw new GenerationInputChangedError(`source/config/declaration ${path}`);
    }
    for (const [path, state] of trackedFileHashes) {
      const stat = fileStatSignature(path);
      if (stat === state.statSignature) continue;
      const hash = contentHash(path);
      if (hash !== state.hash || stat !== fileStatSignature(path)) throw new GenerationInputChangedError(`external dependency ${path}`);
      state.statSignature = stat;
    }
    for (const [key, observation] of observations) {
      if (observation.read() !== observation.value) throw new GenerationInputChangedError(`resolution dependency ${key}`);
    }
  }
  function inputState() {
    return {
      filePaths: [...contents.keys()].sort(),
      trackedFileHashes: [...trackedFileHashes.entries()].map(([path, state]) => [path, state.hash, state.statSignature] as [string, string, string]).sort(([left], [right]) => left.localeCompare(right)),
      observations: [...observations.entries()].map(([key, item]) => [key, item.value] as [string, string]).sort(([left], [right]) => left.localeCompare(right))
    };
  }
  return { read, info, trackFile, resetForRebuild, system, fingerprint, inputState, validate };
}
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }

function contentHash(path: string): string {
  let content: Buffer;
  try { content = readFileSync(path); }
  catch (error) { if (isMissing(error)) return "missing"; throw error; }
  return createHash("sha256").update(content).digest("hex");
}

function fileStatSignature(path: string): string {
  try {
    const info = statSync(path, { bigint: true });
    if (info.mtimeNs === undefined || info.ctimeNs === undefined) return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
}

function observationReader(ts: typeof TypeScript, key: string): () => unknown {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const value = key.slice(separator + 1);
  if (kind === "file") return () => ts.sys.fileExists(value);
  if (kind === "directory") return () => ts.sys.directoryExists(value);
  if (kind === "directories") return () => ts.sys.getDirectories(value);
  if (kind === "realpath") return () => ts.sys.realpath ? ts.sys.realpath(value) : resolve(value);
  if (kind === "listing") {
    const [path, extensions, exclude, include, depth] = JSON.parse(value) as [string, string[] | null, string[] | null, string[] | null, number | null];
    return () => ts.sys.readDirectory(path, extensions ?? undefined, exclude ?? undefined, include ?? undefined, depth ?? undefined);
  }
  throw new Error(`Unsupported source snapshot observation: ${key}`);
}

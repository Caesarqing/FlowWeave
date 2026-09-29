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
  system: TypeScript.System;
  fingerprint: () => string;
  inputState: () => { filePaths: string[]; observations: Array<[string, string]> };
  validate: () => void;
};

/** Freeze source/config/declaration reads and resolution probes; validate all observations before commit. */
export function createSourceSnapshot(paths: string[], priorInputState?: { filePaths: string[]; observations: Array<[string, string]> }): SourceSnapshot {
  const ts = require("typescript") as typeof TypeScript;
  const contents = new Map<string, string | undefined>();
  const metadata = new Map<string, { size: number; modifiedAt: string }>();
  const observations = new Map<string, { value: string; read: () => string }>();
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
  for (const path of paths) { info(path); read(path); }
  for (const path of priorInputState?.filePaths ?? []) read(path);
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
      .update(JSON.stringify([...observations.entries()].map(([key, item]) => [key, item.value]).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
  }
  function validate(): void {
    for (const [path, content] of contents) {
      let current: string | undefined;
      try { current = readFileSync(path, "utf8"); } catch (error) { if (!isMissing(error)) throw error; }
      if (current !== content) throw new GenerationInputChangedError(`source/config/declaration ${path}`);
    }
    for (const [key, observation] of observations) {
      if (observation.read() !== observation.value) throw new GenerationInputChangedError(`resolution dependency ${key}`);
    }
  }
  function inputState() {
    return {
      filePaths: [...contents.keys()].sort(),
      observations: [...observations.entries()].map(([key, item]) => [key, item.value] as [string, string]).sort(([left], [right]) => left.localeCompare(right))
    };
  }
  return { read, info, system, fingerprint, inputState, validate };
}
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }

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

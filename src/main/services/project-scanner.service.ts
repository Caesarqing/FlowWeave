import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import type { CodeflowProject, GitSummary, ProjectFileNode, ProjectScanSummary } from "../storage/schemas";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";
import { createStructureFingerprint } from "./project-registry.service";

const execFileAsync = promisify(execFile);

const DEFAULT_IGNORE = [
  "**/.git/**", "**/node_modules/**", "**/dist/**", "**/out/**", "**/build/**",
  "**/release/**", "**/.cache/**", "**/.parcel-cache/**", "**/.pytest_cache/**",
  "**/.ruff_cache/**", "**/.mypy_cache/**", "**/__pycache__/**", "**/.venv/**",
  "**/venv/**", "**/env/**", "**/target/**", "**/vendor/**", "**/Pods/**",
  "**/DerivedData/**", "**/*.app/**", "**/.next/**", `**/${FLOWWEAVE_DIR}/**`,
  "**/coverage/**", "**/.turbo/**", "**/.vercel/**", "**/.runtime/**",
  "**/logs/**", "**/*.log", "**/.DS_Store", "**/.env", "**/.env.*",
  "**/*.{key,pem,p12,pfx,crt,cer}", "**/credentials.{json,yml,yaml}",
  "**/*credentials*.{json,yml,yaml}", "**/*secret*.{json,yml,yaml}"
];

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_SCAN_CONCURRENCY = 32;

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".js": "JavaScript",
  ".jsx": "JavaScript React",
  ".ts": "TypeScript",
  ".tsx": "TypeScript React",
  ".py": "Python",
  ".go": "Go",
  ".java": "Java",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".php": "PHP",
  ".cs": "C#",
  ".json": "JSON",
  ".md": "Markdown",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".sql": "SQL",
  ".prisma": "Prisma",
  ".css": "CSS",
  ".scss": "SCSS",
  ".html": "HTML"
};

export type ScanProjectOptions = {
  concurrency?: number;
  ignore?: string[];
  maxDepth?: number;
  maxEntries?: number;
};

export async function scanProject(rootPath: string, options?: ScanProjectOptions): Promise<CodeflowProject> {
  const ignore = [...DEFAULT_IGNORE, ...(options?.ignore ?? [])];
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const concurrency = normalizeConcurrency(options?.concurrency);
  const entries = await fg("**/*", {
    cwd: rootPath,
    deep: maxDepth,
    dot: true,
    ignore,
    markDirectories: true,
    onlyFiles: false,
    stats: false,
    unique: true,
    followSymbolicLinks: false
  });

  const nonSymlinkEntries = await filterSafeEntries(rootPath, entries, concurrency);
  const filteredEntries = nonSymlinkEntries.filter((entry) => {
    const depth = entry.split("/").filter(Boolean).length - 1;
    return depth <= maxDepth;
  });
  const visibleEntries = filteredEntries.slice(0, maxEntries);

  const metadata = await readEntryMetadata(rootPath, visibleEntries, concurrency);
  const files = buildTree(visibleEntries, metadata);
  const summary = buildSummary(visibleEntries);
  summary.displayedEntries = visibleEntries.length;
  summary.truncated = filteredEntries.length > visibleEntries.length;
  const git = await readGitSummary(rootPath);

  const project: CodeflowProject = {
    version: 2,
    projectName: basename(rootPath),
    rootPath,
    generatedAt: new Date().toISOString(),
    git,
    summary,
    files
  } satisfies CodeflowProject;
  project.scanFingerprint = createStructureFingerprint(
    project.projectName,
    project.summary.languages,
    flattenFiles(project.files)
  );
  return project;
}

async function readEntryMetadata(rootPath: string, entries: string[], concurrency: number) {
  const files = entries.filter((entry) => !entry.endsWith("/"));
  const results = await mapWithConcurrency(files, concurrency, async (entry) => {
    const info = await stat(join(rootPath, ...entry.split("/")));
    return [entry, { size: info.size, modifiedAt: info.mtime.toISOString() }] as const;
  });
  return new Map(results);
}

async function filterSafeEntries(rootPath: string, entries: string[], concurrency: number): Promise<string[]> {
  const canonicalRoot = await realpath(rootPath);
  const results = await mapWithConcurrency(entries, concurrency, async (entry) => {
    const relativeEntry = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const absoluteEntry = join(rootPath, ...relativeEntry.split("/"));
    const info = await lstat(absoluteEntry);
    if (info.isSymbolicLink()) return undefined;
    const canonicalEntry = await realpath(absoluteEntry);
    const fromRoot = relative(canonicalRoot, canonicalEntry);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return undefined;
    return entry;
  });
  return results.filter((entry): entry is string => Boolean(entry));
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SCAN_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1 || value > 128) {
    throw new Error(`Project scan concurrency must be an integer between 1 and 128: ${value}`);
  }
  return value;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function flattenFiles(nodes: ProjectFileNode[]): Array<{ path: string; language?: string; size?: number; modifiedAt?: string }> {
  return nodes.flatMap((node) => [
    ...(node.type === "file" ? [{
      path: node.path,
      language: node.language,
      size: node.size,
      modifiedAt: node.modifiedAt
    }] : []),
    ...flattenFiles(node.children ?? [])
  ]);
}

function buildTree(entries: string[], metadata: Map<string, { size: number; modifiedAt: string }>): ProjectFileNode[] {
  const rootNodes: ProjectFileNode[] = [];
  const nodesByPath = new Map<string, ProjectFileNode>();

  for (const rawEntry of entries.sort()) {
    const normalizedEntry = rawEntry.endsWith("/") ? rawEntry.slice(0, -1) : rawEntry;
    const parts = normalizedEntry.split("/").filter(Boolean);
    const isFolder = rawEntry.endsWith("/");
    const nodePath = parts.join("/");
    const parentPath = parts.slice(0, -1).join("/");
    const node: ProjectFileNode = {
      id: nodePath,
      name: parts.at(-1) ?? nodePath,
      path: nodePath,
      type: isFolder ? "folder" : "file",
      depth: parts.length - 1,
      language: isFolder ? undefined : detectLanguage(nodePath),
      size: isFolder ? undefined : metadata.get(nodePath)?.size,
      modifiedAt: isFolder ? undefined : metadata.get(nodePath)?.modifiedAt,
      children: isFolder ? [] : undefined
    };

    nodesByPath.set(nodePath, node);

    if (!parentPath) {
      rootNodes.push(node);
      continue;
    }

    const parent = nodesByPath.get(parentPath);
    if (parent) {
      parent.children = parent.children ?? [];
      parent.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  return rootNodes;
}

function buildSummary(entries: string[]): ProjectScanSummary {
  const summary: ProjectScanSummary = {
    totalFiles: 0,
    totalFolders: 0,
    languages: {}
  };

  for (const entry of entries) {
    if (entry.endsWith("/")) {
      summary.totalFolders += 1;
      continue;
    }

    summary.totalFiles += 1;
    const language = detectLanguage(entry);
    if (language) {
      summary.languages[language] = (summary.languages[language] ?? 0) + 1;
    }
  }

  return summary;
}

function detectLanguage(filePath: string) {
  return LANGUAGE_BY_EXT[extname(filePath).toLowerCase()];
}

async function readGitSummary(rootPath: string): Promise<GitSummary> {
  try {
    const { stdout: inside } = await execFileAsync("git", ["-C", rootPath, "rev-parse", "--is-inside-work-tree"]);
    if (inside.trim() !== "true") return { isRepo: false };
    const [branch, remote, status] = await Promise.all([
      execFileAsync("git", ["-C", rootPath, "branch", "--show-current"]).catch(() => ({ stdout: "" })),
      execFileAsync("git", ["-C", rootPath, "remote", "get-url", "origin"]).catch(() => ({ stdout: "" })),
      execFileAsync("git", ["-C", rootPath, "status", "--short"]).catch(() => ({ stdout: "" }))
    ]);
    return {
      isRepo: true,
      branch: branch.stdout.trim() || "detached",
      remote: remote.stdout.trim() || undefined,
      status: status.stdout.trim()
    };
  } catch {
    return { isRepo: false };
  }
}

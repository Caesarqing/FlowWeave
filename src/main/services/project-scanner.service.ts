import { execFile } from "node:child_process";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import type { CodeflowProject, GitSummary, ProjectFileNode, ProjectScanSummary } from "../storage/schemas";
import { FLOWWEAVE_DIR } from "../storage/flowweave-paths";

const execFileAsync = promisify(execFile);

const DEFAULT_IGNORE = [
  ".git/**",
  "node_modules/**",
  "dist/**",
  "out/**",
  "build/**",
  "release/**",
  ".cache/**",
  ".parcel-cache/**",
  ".pytest_cache/**",
  ".ruff_cache/**",
  ".mypy_cache/**",
  "__pycache__/**",
  ".venv/**",
  "venv/**",
  "env/**",
  "target/**",
  "vendor/**",
  "Pods/**",
  "DerivedData/**",
  "*.app/**",
  ".next/**",
  `${FLOWWEAVE_DIR}/**`,
  "coverage/**",
  ".turbo/**",
  ".vercel/**",
  ".DS_Store"
];

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ENTRIES = 2500;

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
  ignore?: string[];
  maxDepth?: number;
  maxEntries?: number;
};

export async function scanProject(rootPath: string, options: ScanProjectOptions = {}): Promise<CodeflowProject> {
  const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = await fg("**/*", {
    cwd: rootPath,
    deep: maxDepth,
    dot: true,
    ignore,
    markDirectories: true,
    onlyFiles: false,
    stats: false,
    unique: true
  });

  const filteredEntries = entries.filter((entry) => {
    const depth = entry.split("/").filter(Boolean).length - 1;
    return depth <= maxDepth;
  });
  const visibleEntries = filteredEntries.slice(0, maxEntries);

  const files = buildTree(visibleEntries);
  const summary = buildSummary(visibleEntries);
  summary.displayedEntries = visibleEntries.length;
  summary.truncated = filteredEntries.length > visibleEntries.length;
  const git = await readGitSummary(rootPath);

  return {
    version: 1,
    projectName: basename(rootPath),
    rootPath,
    generatedAt: new Date().toISOString(),
    git,
    summary,
    files
  };
}

function buildTree(entries: string[]): ProjectFileNode[] {
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
    const [{ stdout: branch }, { stdout: remote }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["-C", rootPath, "branch", "--show-current"]),
      execFileAsync("git", ["-C", rootPath, "remote", "get-url", "origin"]),
      execFileAsync("git", ["-C", rootPath, "status", "--short"])
    ]);

    return {
      isRepo: true,
      branch: branch.trim() || "detached",
      remote: remote.trim() || undefined,
      status: status.trim()
    };
  } catch {
    return { isRepo: false };
  }
}

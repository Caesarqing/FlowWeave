import { dirname, posix } from "node:path";
import type { ProjectFileNode } from "../../types";

export type ImportReference = {
  importer: string;
  imported: string;
};

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
];

const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".prisma", ".sql"];

export function parseImportSpecifiers(source: string) {
  const withoutComments = stripComments(source);
  const specifiers: string[] = [];

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(withoutComments))) {
      if (match[1]) specifiers.push(match[1]);
    }
  }

  return specifiers;
}

export function resolveProjectImport(importerPath: string, specifier: string, projectFiles: Set<string>) {
  if (!specifier.startsWith(".")) return undefined;

  const basePath = posix.normalize(posix.join(dirname(importerPath), specifier));
  const candidates = [
    basePath,
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...RESOLVABLE_EXTENSIONS.map((extension) => posix.join(basePath, `index${extension}`))
  ];

  return candidates.find((candidate) => projectFiles.has(candidate));
}

export function collectImportReferences(
  fileContents: Array<{ path: string; content: string }>,
  projectFiles: ProjectFileNode[]
): ImportReference[] {
  const fileSet = new Set(flattenProjectFilePaths(projectFiles));
  const references: ImportReference[] = [];

  for (const file of fileContents) {
    for (const specifier of parseImportSpecifiers(file.content)) {
      const imported = resolveProjectImport(file.path, specifier, fileSet);
      if (imported) {
        references.push({ importer: file.path, imported });
      }
    }
  }

  return references;
}

export function flattenProjectFilePaths(nodes: ProjectFileNode[]) {
  const paths: string[] = [];
  function visit(node: ProjectFileNode) {
    if (node.type === "file") paths.push(node.path);
    node.children?.forEach(visit);
  }
  nodes.forEach(visit);
  return paths;
}

function stripComments(source: string) {
  let output = "";
  let index = 0;
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (mode === "line") {
      if (char === "\n") {
        mode = "code";
        output += char;
      }
      index += 1;
      continue;
    }

    if (mode === "block") {
      if (char === "*" && next === "/") {
        mode = "code";
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (mode === "single" || mode === "double" || mode === "template") {
      output += char;
      const quote = mode === "single" ? "'" : mode === "double" ? '"' : "`";
      if (char === "\\") {
        output += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) mode = "code";
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      mode = "line";
      index += 2;
      continue;
    }

    if (char === "/" && next === "*") {
      mode = "block";
      index += 2;
      continue;
    }

    if (char === "'") mode = "single";
    if (char === '"') mode = "double";
    if (char === "`") mode = "template";
    output += char;
    index += 1;
  }

  return output;
}

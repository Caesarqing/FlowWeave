import { dirname, posix } from "node:path";
import type { ProjectFileNode } from "../../types";

const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".prisma", ".sql"];

export function resolvePythonProjectImport(
  importerPath: string,
  specifier: string,
  projectFiles: Set<string>
): { targetFile: string; confidence: "confirmed" | "inferred" } | undefined {
  const leadingDots = specifier.match(/^\.+/)?.[0].length ?? 0;
  const modulePath = specifier.slice(leadingDots).replaceAll(".", "/");
  if (leadingDots > 0) {
    const parent = dirname(importerPath).split("/");
    if (leadingDots > parent.length) return undefined;
    const base = posix.join(...parent.slice(0, parent.length - leadingDots + 1), modulePath);
    const targetFile = [`${base}.py`, posix.join(base, "__init__.py")].find((path) => projectFiles.has(path));
    return targetFile ? { targetFile, confidence: "confirmed" } : undefined;
  }
  // A unique qualified package path supports a dependency, but runtime sys.path is not proven.
  const candidates = [...projectFiles].filter((path) =>
    [`${modulePath}.py`, `${modulePath}/__init__.py`].some((suffix) => path === suffix || path.endsWith(`/${suffix}`))
  );
  return candidates.length === 1 ? { targetFile: candidates[0], confidence: "inferred" } : undefined;
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

export function flattenProjectFilePaths(nodes: ProjectFileNode[]) {
  const paths: string[] = [];
  function visit(node: ProjectFileNode) {
    if (node.type === "file") paths.push(node.path);
    node.children?.forEach(visit);
  }
  nodes.forEach(visit);
  return paths;
}

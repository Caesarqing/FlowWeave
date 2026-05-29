import type { ProjectFileNode, ProjectFileRow } from "../types";

export function flattenVisibleProjectFiles(
  files: ProjectFileNode[],
  expandedPaths: Set<string>,
  maxVisibleRows: number
): { rows: ProjectFileRow[]; truncated: boolean } {
  const rows: ProjectFileRow[] = [];
  let truncated = false;

  function visit(node: ProjectFileNode) {
    if (rows.length >= maxVisibleRows) {
      truncated = true;
      return;
    }

    const isExpanded = node.type === "folder" && expandedPaths.has(node.path);
    rows.push({
      ...node,
      active: node.path.endsWith("package.json") || node.path.endsWith("AGENTS.md"),
      isExpanded
    });

    if (node.type === "folder" && isExpanded) {
      node.children?.forEach(visit);
    }
  }

  files.forEach(visit);

  if (truncated && rows.length < maxVisibleRows + 1) {
    rows.push({
      id: "__truncated__",
      name: "已截断，继续折叠部分目录以保持流畅",
      path: "__truncated__",
      type: "file",
      depth: 0,
      isTruncatedNotice: true
    });
  }

  return { rows, truncated };
}

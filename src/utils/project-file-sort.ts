import type { ProjectFileNode } from "../types";

const PROJECT_FILE_NODE_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function sortProjectFileNodes(nodes: ProjectFileNode[]): ProjectFileNode[] {
  return nodes
    .map((node) => ({
      ...node,
      children: node.children ? sortProjectFileNodes(node.children) : undefined
    }))
    .sort(compareProjectFileNodes);
}

function compareProjectFileNodes(left: ProjectFileNode, right: ProjectFileNode): number {
  const groupOrder = getProjectFileNodeSortGroup(left) - getProjectFileNodeSortGroup(right);
  if (groupOrder !== 0) return groupOrder;

  if (left.type === "folder" && right.type === "folder" && !isDotEntry(left) && !isDotEntry(right)) {
    const fileCountOrder = countDescendantFiles(right) - countDescendantFiles(left);
    if (fileCountOrder !== 0) return fileCountOrder;

    const totalSizeOrder = totalDescendantSize(right) - totalDescendantSize(left);
    if (totalSizeOrder !== 0) return totalSizeOrder;
  }

  const nameOrder = PROJECT_FILE_NODE_COLLATOR.compare(left.name, right.name);
  if (nameOrder !== 0) return nameOrder;
  return left.path.localeCompare(right.path);
}

function getProjectFileNodeSortGroup(node: ProjectFileNode): number {
  if (isDotEntry(node)) return 0;
  if (node.type === "folder") return 1;
  return 2;
}

function isDotEntry(node: ProjectFileNode): boolean {
  return node.name.startsWith(".");
}

function countDescendantFiles(node: ProjectFileNode): number {
  if (node.type === "file") return 1;
  return (node.children ?? []).reduce((total, child) => total + countDescendantFiles(child), 0);
}

function totalDescendantSize(node: ProjectFileNode): number {
  if (node.type === "file") return node.size ?? 0;
  return (node.children ?? []).reduce((total, child) => total + totalDescendantSize(child), 0);
}

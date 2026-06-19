import type { GraphNode } from "../types";

export type ModuleFileTreeNode = {
  id: string;
  name: string;
  path: string;
  type: "folder" | "file";
  depth: number;
  role?: string;
  children: ModuleFileTreeNode[];
};

export function buildModuleFileTree(files: string[], fileRoles?: GraphNode["fileRoles"]) {
  const root: ModuleFileTreeNode[] = [];
  const folderMap = new Map<string, ModuleFileTreeNode>();
  const roleMap = new Map((fileRoles ?? []).map((item) => [item.path, item.role]));

  for (const filePath of [...new Set(files.map((file) => file.trim()).filter(Boolean))].sort()) {
    const parts = filePath.split("/").filter(Boolean);
    let siblings = root;
    let currentPath = "";

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = index === parts.length - 1;

      if (!isFile) {
        let folder = folderMap.get(currentPath);
        if (!folder) {
          folder = { id: currentPath, name: part, path: currentPath, type: "folder", depth: index, role: roleMap.get(currentPath), children: [] };
          folderMap.set(currentPath, folder);
          siblings.push(folder);
        }
        siblings = folder.children;
        return;
      }

      if (!siblings.some((node) => node.path === currentPath)) {
        siblings.push({
          id: currentPath,
          name: part,
          path: currentPath,
          type: "file",
          depth: index,
          role: roleMap.get(currentPath),
          children: []
        });
      }
    });
  }

  applyAggregatedFolderRoles(root);
  return root;
}

function applyAggregatedFolderRoles(nodes: ModuleFileTreeNode[]) {
  for (const node of nodes) {
    if (node.type !== "folder") continue;
    applyAggregatedFolderRoles(node.children);
    if (!node.role) node.role = aggregateChildRole(node);
  }
}

function aggregateChildRole(node: ModuleFileTreeNode) {
  const childRoles = collectChildRoles(node.children);
  if (childRoles.length === 0) return undefined;
  if (childRoles.length === 1) return childRoles[0];
  const first = childRoles[0].replace(/\.$/, "");
  return `${first}, plus ${childRoles.length - 1} related responsibilities.`;
}

function collectChildRoles(nodes: ModuleFileTreeNode[]) {
  const roles: string[] = [];
  for (const node of nodes) {
    if (node.role) roles.push(node.role);
    roles.push(...collectChildRoles(node.children));
  }
  return [...new Set(roles)].slice(0, 4);
}

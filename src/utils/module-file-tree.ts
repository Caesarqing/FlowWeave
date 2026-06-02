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

export function buildModuleFileTree(files: string[], fileRoles: GraphNode["fileRoles"] = []) {
  const root: ModuleFileTreeNode[] = [];
  const folderMap = new Map<string, ModuleFileTreeNode>();
  const roleMap = new Map(fileRoles.map((item) => [item.path, item.role]));

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
          folder = { id: currentPath, name: part, path: currentPath, type: "folder", depth: index, children: [] };
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

  return root;
}

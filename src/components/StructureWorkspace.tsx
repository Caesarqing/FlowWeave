import { FileCode2 } from "lucide-react";
import { useState } from "react";
import type { ProjectFileNode } from "../types";
import { flattenVisibleProjectFiles } from "../utils/file-utils";

export function StructureWorkspace({
  files,
  expandedPaths,
  onTogglePath,
  projectPath
}: {
  files: ProjectFileNode[];
  expandedPaths: Set<string>;
  onTogglePath: (path: string) => void;
  projectPath: string;
}) {
  const [selectedPath, setSelectedPath] = useState("");
  const [content, setContent] = useState("请选择文件。");
  const { rows } = flattenVisibleProjectFiles(files, expandedPaths, 1200);
  const selectedFile = rows.find((row) => row.path === selectedPath) ?? rows.find((row) => row.type === "file");

  async function selectFile(path: string, type: ProjectFileNode["type"]) {
    if (type === "folder") {
      onTogglePath(path);
      return;
    }
    setSelectedPath(path);
    if (!window.flowweave || !projectPath) {
      setContent("需要 Electron 桌面版读取文件。");
      return;
    }
    try {
      setContent(await window.flowweave.readProjectFile(projectPath, path));
    } catch (error) {
      setContent(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="workspace-page structure-workspace">
      <section className="workspace-column">
        <div className="panel-header"><span>Structure</span></div>
        <div className="tree">
          {rows.map((row) => (
            <button className={`tree-row ${selectedPath === row.path ? "active" : ""}`} key={row.path} onClick={() => void selectFile(row.path, row.type)} style={{ paddingLeft: `${12 + row.depth * 14}px` }} type="button">
              <FileCode2 size={14} />
              <span>{row.name}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="workspace-main">
        <div className="panel-header"><span>File Preview</span></div>
        <pre className="code-preview">{content}</pre>
      </section>
      <section className="workspace-column">
        <div className="panel-header"><span>Details</span></div>
        <div className="module-card">
          <h3>{selectedFile?.name ?? "No file"}</h3>
          <p>{selectedFile?.language ?? "unknown"}</p>
          <p>{selectedFile?.path ?? "尚未选择文件"}</p>
        </div>
      </section>
    </main>
  );
}

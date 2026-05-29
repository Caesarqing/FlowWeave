import { ChevronDown, ChevronRight, FileCode2, Folder, RefreshCw } from "lucide-react";
import type { ProjectFileNode, ProjectFileRow } from "../types";
import { flattenVisibleProjectFiles } from "../utils/file-utils";

export function ProjectExplorer({
  expandedPaths,
  files,
  isDesktopBridgeAvailable,
  isProjectLoading,
  maxVisibleRows,
  onOpenProject,
  onRefreshProject,
  onTogglePath,
  projectPath,
  statusMessage
}: {
  expandedPaths: Set<string>;
  files: ProjectFileNode[];
  isDesktopBridgeAvailable: boolean;
  isProjectLoading: boolean;
  maxVisibleRows: number;
  onOpenProject: () => void;
  onRefreshProject: () => void;
  onTogglePath: (path: string) => void;
  projectPath: string;
  statusMessage: string;
}) {
  const { rows, truncated } = flattenVisibleProjectFiles(files, expandedPaths, maxVisibleRows);

  return (
    <aside className="left-panel">
      <div className="panel-header">
        <span>Project Files</span>
      </div>
      <div className="project-actions">
        <div className={`bridge-state ${isDesktopBridgeAvailable ? "ready" : "browser"}`}>
          {isDesktopBridgeAvailable ? "Desktop bridge ready" : "Browser preview only"}
        </div>
        <div className="project-path" title={projectPath || undefined}>
          {projectPath || "尚未打开本地项目"}
        </div>
        <div className="project-action-row">
          <button className="ghost-button" disabled={isProjectLoading} type="button" onClick={onOpenProject}>
            <Folder size={14} />
            打开项目
          </button>
          <button className="ghost-button" disabled={isProjectLoading || !projectPath} type="button" onClick={onRefreshProject}>
            <RefreshCw size={14} />
            重新扫描
          </button>
        </div>
        <p className="project-status">{isProjectLoading ? "正在读取项目..." : statusMessage}</p>
      </div>
      <div className="tree">
        {rows.map((file: ProjectFileRow) => (
          <button
            className={`tree-row ${file.active ? "active" : ""} ${file.isTruncatedNotice ? "muted" : ""}`}
            disabled={file.isTruncatedNotice}
            key={file.path}
            onClick={() => {
              if (file.type === "folder") onTogglePath(file.path);
            }}
            style={{ paddingLeft: `${12 + file.depth * 14}px` }}
            type="button"
            title={file.path}
          >
            {file.type === "folder" ? (
              <>
                {file.isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Folder size={14} />
              </>
            ) : (
              <>
                <span className="tree-indent-spacer" />
                <FileCode2 size={14} />
              </>
            )}
            <span>{file.name}</span>
          </button>
        ))}
        {truncated ? <p className="tree-truncated">可见文件已截断，折叠部分目录后会恢复完整渲染。</p> : null}
      </div>
    </aside>
  );
}

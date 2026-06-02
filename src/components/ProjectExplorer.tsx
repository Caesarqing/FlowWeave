import { ChevronDown, ChevronRight, FileCode2, Folder, RefreshCw } from "lucide-react";
import type { ProjectFileNode, ProjectFileRow } from "../types";
import { flattenVisibleProjectFiles } from "../utils/file-utils";
import { cn } from "../utils/classnames";
import { useI18n } from "../utils/i18n";

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
  const { t } = useI18n();

  return (
    <aside className="left-panel">
      <div className="panel-header">
        <span>{t("project.files")}</span>
      </div>
      <div className="project-actions">
        <div className={`bridge-state ${isDesktopBridgeAvailable ? "ready" : "browser"}`}>
          {isDesktopBridgeAvailable ? t("project.desktopReady") : t("project.browserOnly")}
        </div>
        <div className="project-path" title={projectPath || undefined}>
          {projectPath || t("project.noProject")}
        </div>
        <div className="project-action-row">
          <button className="ghost-button" disabled={isProjectLoading} type="button" onClick={onOpenProject}>
            <Folder size={14} />
            {t("project.open")}
          </button>
          <button className="ghost-button" disabled={isProjectLoading || !projectPath} type="button" onClick={onRefreshProject}>
            <RefreshCw size={14} />
            {t("project.refresh")}
          </button>
        </div>
        <p className="project-status">{isProjectLoading ? t("project.loading") : statusMessage}</p>
      </div>
      <div className="tree">
        {rows.map((file: ProjectFileRow) => (
          <button
            className={cn("tree-row", file.active && "active", file.isTruncatedNotice && "muted")}
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
        {truncated ? <p className="tree-truncated">{t("project.truncated")}</p> : null}
      </div>
    </aside>
  );
}

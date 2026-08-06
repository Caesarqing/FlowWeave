import { ChevronDown, ChevronRight, FileCode2, Folder, RefreshCw, Square } from "lucide-react";
import { useMemo } from "react";
import type { ProjectFileNode, ProjectFileRow } from "../types";
import { flattenVisibleProjectFiles } from "../utils/file-utils";
import { cn } from "../utils/classnames";
import { sortProjectFileNodes } from "../utils/project-file-sort";
import { useI18n } from "../utils/i18n";
import { Button } from "./Button";

export function ProjectExplorer({
  expandedPaths,
  files,
  isDesktopBridgeAvailable,
  isProjectLoading,
  maxVisibleRows,
  onOpenProject,
  onRefreshProject,
  onCancelOperation,
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
  onCancelOperation: () => void;
  onTogglePath: (path: string) => void;
  projectPath: string;
  statusMessage: string;
}) {
  const sortedFiles = useMemo(() => sortProjectFileNodes(files), [files]);
  const { rows, truncated } = flattenVisibleProjectFiles(sortedFiles, expandedPaths, maxVisibleRows);
  const { t } = useI18n();

  return (
    <aside className="left-panel">
      <div className="panel-header">
        <span>{t("project.files")}</span>
      </div>
      <div className="project-actions">
        <div className={cn("bridge-state", isDesktopBridgeAvailable ? "ready" : "browser")}>
          {isDesktopBridgeAvailable ? t("project.desktopReady") : t("project.browserOnly")}
        </div>
        <div className="project-path" title={projectPath || undefined}>
          {projectPath || t("project.noProject")}
        </div>
        <div className="project-action-row">
          <Button disabled={isProjectLoading} icon={<Folder size={14} />} size="default" variant="primary" type="button" onClick={onOpenProject}>
            {t("project.open")}
          </Button>
          <Button disabled={isProjectLoading || !projectPath} icon={<RefreshCw size={14} />} variant="secondary" type="button" onClick={onRefreshProject}>
            {t("project.refresh")}
          </Button>
          {isProjectLoading ? (
            <Button icon={<Square size={12} />} variant="danger" type="button" onClick={onCancelOperation}>
              {t("project.cancel")}
            </Button>
          ) : null}
        </div>
        <p className="project-status">{statusMessage}</p>
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
            <span>{file.isTruncatedNotice ? t("project.truncatedRow") : file.name}</span>
          </button>
        ))}
        {truncated ? <p className="tree-truncated">{t("project.truncated")}</p> : null}
      </div>
    </aside>
  );
}

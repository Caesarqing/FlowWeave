import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { WorkspacePanelPage, WorkspacePanelSide } from "../types";
import { usePreferencesStore } from "../stores/preferences.store";
import { cn } from "../utils/classnames";
import { useI18n } from "../utils/i18n";
import { Button } from "./Button";

export function WorkspaceLayout({
  actions,
  children,
  className,
  left,
  leftWidth,
  page,
  right,
  rightAttention,
  rightWidth,
  status,
  title
}: {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  left?: ReactNode;
  leftWidth?: string;
  page: WorkspacePanelPage;
  right?: ReactNode;
  rightAttention?: boolean;
  rightWidth?: string;
  status?: ReactNode;
  title: ReactNode;
}) {
  const { t } = useI18n();
  const panels = usePreferencesStore((state) => state.workspacePanels[page]);
  const setCollapsed = usePreferencesStore((state) => state.setWorkspacePanelCollapsed);
  const leftCollapsed = !left || panels.left;
  const rightCollapsed = !right || panels.right;

  function toggle(side: WorkspacePanelSide) {
    setCollapsed(page, side, !panels[side]);
  }

  return (
    <main
      className={cn(
        "workspace-layout",
        Boolean(left) && "has-left-panel",
        Boolean(right) && "has-right-panel",
        leftCollapsed && "left-panel-collapsed",
        rightCollapsed && "right-panel-collapsed",
        className
      )}
      style={{
        "--workspace-left-width": leftWidth ?? "clamp(220px, 18vw, 280px)",
        "--workspace-right-width": rightWidth ?? "clamp(300px, 24vw, 380px)"
      } as CSSProperties}
    >
      <header className="workspace-header">
        <div className="workspace-header-leading">
          {left ? (
            <PanelToggleButton
              collapsed={leftCollapsed}
              label={t(leftCollapsed ? "workspace.showLeft" : "workspace.hideLeft")}
              side="left"
              onClick={() => toggle("left")}
            />
          ) : null}
          <div className="workspace-header-title">
            <strong>{title}</strong>
            {status ? <span>{status}</span> : null}
          </div>
        </div>
        <div className="workspace-header-actions">
          {actions ? <div className="workspace-header-primary-actions">{actions}</div> : null}
          {right ? (
            <PanelToggleButton
              attention={Boolean(rightAttention) && rightCollapsed}
              collapsed={rightCollapsed}
              label={t(rightCollapsed ? "workspace.showRight" : "workspace.hideRight")}
              side="right"
              onClick={() => toggle("right")}
            />
          ) : null}
        </div>
      </header>
      {left && !leftCollapsed ? (
        <aside className="workspace-layout-panel workspace-layout-left">
          {left}
        </aside>
      ) : null}
      <section className="workspace-layout-main">
        {children}
      </section>
      {right && !rightCollapsed ? (
        <aside className="workspace-layout-panel workspace-layout-right">
          {right}
        </aside>
      ) : null}
    </main>
  );
}

function PanelToggleButton({
  attention,
  collapsed,
  label,
  onClick,
  side
}: {
  attention?: boolean;
  collapsed: boolean;
  label: string;
  onClick: () => void;
  side: WorkspacePanelSide;
}) {
  const Icon = side === "left"
    ? collapsed ? PanelLeftOpen : PanelLeftClose
    : collapsed ? PanelRightOpen : PanelRightClose;
  return (
    <Button
      className={cn("workspace-panel-toggle", side, Boolean(attention) && "attention")}
      icon={<Icon size={15} />}
      label={label}
      type="button"
      variant="icon"
      onClick={onClick}
    >
      {attention ? <span /> : null}
    </Button>
  );
}

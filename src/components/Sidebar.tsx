import { Bot, GitPullRequestArrow, Network, ScrollText, Settings2, UserRound, Workflow } from "lucide-react";
import type { ActivePage, UtilityPanel } from "../types";
import { BrandLogo } from "./BrandLogo";

export function Sidebar({
  activePage,
  activeUtilityPanel,
  onPageChange,
  onUtilityPanelChange
}: {
  activePage: ActivePage;
  activeUtilityPanel?: UtilityPanel;
  onPageChange: (page: ActivePage) => void;
  onUtilityPanelChange: (panel?: UtilityPanel) => void;
}) {
  return (
    <nav className="side-nav" aria-label="FlowWeave sections">
      <div className="nav-main">
        <div className="nav-mark">
          <BrandLogo className="brand-logo-nav" />
        </div>
        <button className={activePage === "canvas" ? "active" : ""} type="button" onClick={() => onPageChange("canvas")}>
          <Network size={18} />
          <span>Canvas</span>
        </button>
        <button className={activePage === "structure" ? "active" : ""} type="button" onClick={() => onPageChange("structure")}>
          <Workflow size={18} />
          <span>Sequence Diagram</span>
        </button>
        <button className={activePage === "docs" ? "active" : ""} type="button" onClick={() => onPageChange("docs")}>
          <ScrollText size={18} />
          <span>Docs</span>
        </button>
        <button className={activePage === "git-review" ? "active" : ""} type="button" onClick={() => onPageChange("git-review")}>
          <GitPullRequestArrow size={18} />
          <span>Git</span>
        </button>
        <button className={activePage === "tools" ? "active" : ""} type="button" onClick={() => onPageChange("tools")}>
          <Bot size={18} />
          <span>Agent</span>
        </button>
      </div>
      <div className="nav-utility" aria-label="FlowWeave utility actions">
        <button
          className={activeUtilityPanel === "profile" ? "active utility-active" : ""}
          type="button"
          onClick={() => onUtilityPanelChange(activeUtilityPanel === "profile" ? undefined : "profile")}
        >
          <UserRound size={18} />
          <span>个人</span>
        </button>
        <button
          className={activeUtilityPanel === "settings" ? "active utility-active" : ""}
          type="button"
          onClick={() => onUtilityPanelChange(activeUtilityPanel === "settings" ? undefined : "settings")}
        >
          <Settings2 size={18} />
          <span>设置</span>
        </button>
      </div>
    </nav>
  );
}

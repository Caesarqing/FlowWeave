import { Bot, GitPullRequestArrow, Network, ScrollText, Settings2, UserRound, Workflow } from "lucide-react";
import type { ActivePage, UtilityPanel } from "../types";
import { BrandLogo } from "./BrandLogo";
import { cn } from "../utils/classnames";
import { useI18n } from "../utils/i18n";

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
  const { t } = useI18n();

  return (
    <nav className="side-nav" aria-label="FlowWeave sections">
      <div className="nav-main">
        <div className="nav-mark">
          <BrandLogo className="brand-logo-nav" />
        </div>
        <button className={cn(activePage === "tools" && "active")} type="button" onClick={() => onPageChange("tools")}>
          <Bot size={18} />
          <span>{t("nav.agent")}</span>
        </button>
        <button className={cn(activePage === "canvas" && "active")} type="button" onClick={() => onPageChange("canvas")}>
          <Network size={18} />
          <span>{t("nav.canvas")}</span>
        </button>
        <button className={cn(activePage === "structure" && "active")} type="button" onClick={() => onPageChange("structure")}>
          <Workflow size={18} />
          <span>{t("nav.sequence")}</span>
        </button>
        <button className={cn(activePage === "docs" && "active")} type="button" onClick={() => onPageChange("docs")}>
          <ScrollText size={18} />
          <span>{t("nav.docs")}</span>
        </button>
        <button className={cn(activePage === "git-review" && "active")} type="button" onClick={() => onPageChange("git-review")}>
          <GitPullRequestArrow size={18} />
          <span>{t("nav.git")}</span>
        </button>
      </div>
      <div className="nav-utility" aria-label="FlowWeave utility actions">
        <button
          className={cn(activeUtilityPanel === "profile" && "active utility-active")}
          type="button"
          onClick={() => onUtilityPanelChange(activeUtilityPanel === "profile" ? undefined : "profile")}
        >
          <UserRound size={18} />
          <span>{t("nav.profile")}</span>
        </button>
        <button
          className={cn(activeUtilityPanel === "settings" && "active utility-active")}
          type="button"
          onClick={() => onUtilityPanelChange(activeUtilityPanel === "settings" ? undefined : "settings")}
        >
          <Settings2 size={18} />
          <span>{t("nav.settings")}</span>
        </button>
      </div>
    </nav>
  );
}

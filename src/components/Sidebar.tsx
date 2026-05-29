import { Bot, FolderTree, GitPullRequestArrow, Network, ScrollText } from "lucide-react";
import type { ActivePage } from "../types";
import { BrandLogo } from "./BrandLogo";

export function Sidebar({ activePage, onPageChange }: { activePage: ActivePage; onPageChange: (page: ActivePage) => void }) {
  return (
    <nav className="side-nav" aria-label="FlowWeave sections">
      <div className="nav-mark">
        <BrandLogo className="brand-logo-nav" />
      </div>
      <button className={activePage === "canvas" ? "active" : ""} type="button" onClick={() => onPageChange("canvas")}>
        <Network size={18} />
        <span>Canvas</span>
      </button>
      <button className={activePage === "structure" ? "active" : ""} type="button" onClick={() => onPageChange("structure")}>
        <FolderTree size={18} />
        <span>Structure</span>
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
    </nav>
  );
}

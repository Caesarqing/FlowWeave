import { Download, Send } from "lucide-react";
import type { ActivePage } from "../types";
import { BrandLogo } from "./BrandLogo";

const pageTitles: Record<ActivePage, string> = {
  canvas: "Canvas",
  structure: "Sequence Diagram",
  docs: "Docs",
  "git-review": "Git Review",
  tools: "Agent"
};

export function TopBar({
  activePage,
  onExport,
  onSendToTool,
  projectLabel
}: {
  activePage: ActivePage;
  onExport: () => void;
  onSendToTool: () => void;
  projectLabel: string;
}) {
  const showPageActions = activePage === "canvas" || activePage === "structure";

  return (
    <header className="top-bar">
      <div className="wordmark">
        <BrandLogo className="brand-logo-top" />
        <div>
          <h1>{pageTitles[activePage]}</h1>
          <p>FlowWeave / {projectLabel}</p>
        </div>
      </div>

      {showPageActions ? (
        <div className="top-actions">
          <button aria-label="发送到默认 Agent 生成计划" className="ghost-button" title="发送到默认 Agent 生成计划" type="button" onClick={onSendToTool}>
            <Send size={16} />
            <span className="button-label">发送到默认 Agent 生成计划</span>
          </button>
          <button aria-label="导出指导文件" className="export-button" title="导出指导文件" type="button" onClick={onExport}>
            <Download size={16} />
            <span className="button-label">导出指导文件</span>
          </button>
        </div>
      ) : null}
    </header>
  );
}

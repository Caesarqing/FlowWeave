import { Download, Send } from "lucide-react";
import type { ActivePage } from "../types";
import { BrandLogo } from "./BrandLogo";
import { useI18n } from "../utils/i18n";

const pageTitleKeys: Record<ActivePage, string> = {
  canvas: "nav.canvas",
  structure: "nav.sequence",
  docs: "nav.docs",
  "git-review": "git.diff",
  tools: "nav.agent"
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
  const { t } = useI18n();

  return (
    <header className="top-bar">
      <div className="wordmark">
        <BrandLogo className="brand-logo-top" />
        <div>
          <h1>{t(pageTitleKeys[activePage])}</h1>
          <p>FlowWeave / {projectLabel}</p>
        </div>
      </div>

      {showPageActions ? (
        <div className="top-actions">
          <button aria-label={t("top.send")} className="ghost-button" title={t("top.send")} type="button" onClick={onSendToTool}>
            <Send size={16} />
            <span className="button-label">{t("top.send")}</span>
          </button>
          <button aria-label={t("top.export")} className="export-button" title={t("top.export")} type="button" onClick={onExport}>
            <Download size={16} />
            <span className="button-label">{t("top.export")}</span>
          </button>
        </div>
      ) : null}
    </header>
  );
}

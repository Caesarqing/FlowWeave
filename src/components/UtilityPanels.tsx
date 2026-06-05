import { ChevronDown, ChevronRight, Languages, MonitorCog, Palette, Settings2, SlidersHorizontal, UserRound, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { HANDLE_COLLAPSE_THRESHOLD } from "../utils/graph-converters";
import { relationOptions } from "../utils/relation-styles";
import { usePreferencesStore } from "../stores/preferences.store";
import type { GraphEdgeRelation, UiThemeId, UtilityPanel } from "../types";
import { cn } from "../utils/classnames";
import { localeOptions, useI18n } from "../utils/i18n";

const themeOptions: Array<{ id: UiThemeId; labelKey: string; descriptionKey: string; swatches: string[] }> = [
  { id: "system", labelKey: "theme.system", descriptionKey: "theme.systemDesc", swatches: ["#030506", "#89ecff", "#42f5a7"] },
  { id: "light", labelKey: "theme.light", descriptionKey: "theme.lightDesc", swatches: ["#eef7f6", "#0f766e", "#2563eb"] },
  { id: "dark", labelKey: "theme.dark", descriptionKey: "theme.darkDesc", swatches: ["#030506", "#89ecff", "#42f5a7"] },
  { id: "terminal", labelKey: "theme.terminal", descriptionKey: "theme.terminalDesc", swatches: ["#020402", "#52ff9a", "#a3e635"] },
  { id: "hologrid", labelKey: "theme.hologrid", descriptionKey: "theme.hologridDesc", swatches: ["#02060a", "#9deaff", "#22d3ee"] }
];

export function UtilityPanels({ activePanel, onClose }: { activePanel?: UtilityPanel; onClose: () => void }) {
  if (!activePanel) return null;
  return (
    <div className="utility-panel-shell">
      {activePanel === "profile" ? <ProfilePanel onClose={onClose} /> : <SettingsPanel onClose={onClose} />}
    </div>
  );
}

function ProfilePanel({ onClose }: { onClose: () => void }) {
  const theme = usePreferencesStore((state) => state.theme);
  const setTheme = usePreferencesStore((state) => state.setTheme);
  const { t } = useI18n();

  return (
    <section className="utility-panel" aria-label={t("profile.title")}>
      <PanelHeader icon={<UserRound size={15} />} title={t("profile.title")} onClose={onClose} />
      <div className="utility-identity">
        <div className="avatar-mark">FW</div>
        <div>
          <strong>FlowWeave User</strong>
          <span>{t("profile.identity")}</span>
        </div>
      </div>
      <div className="utility-section">
        <h3><Palette size={14} />{t("profile.personalization")}</h3>
        <div className="theme-grid">
          {themeOptions.map((option) => (
            <button className={cn(theme === option.id && "active")} key={option.id} type="button" onClick={() => setTheme(option.id)}>
              <span>
                {option.swatches.map((swatch) => (
                  <i key={swatch} style={{ background: swatch }} />
                ))}
              </span>
              <strong>{t(option.labelKey)}</strong>
              <small>{t(option.descriptionKey)}</small>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const defaultRelation = usePreferencesStore((state) => state.defaultRelation);
  const locale = usePreferencesStore((state) => state.locale);
  const reducedMotion = usePreferencesStore((state) => state.reducedMotion);
  const setDefaultRelation = usePreferencesStore((state) => state.setDefaultRelation);
  const setLocale = usePreferencesStore((state) => state.setLocale);
  const setReducedMotion = usePreferencesStore((state) => state.setReducedMotion);
  const { t } = useI18n();
  const [openSections, setOpenSections] = useState({
    canvas: true,
    general: false
  });

  function toggleSection(section: keyof typeof openSections) {
    setOpenSections((current) => ({ ...current, [section]: !current[section] }));
  }

  return (
    <section className="utility-panel" aria-label={t("settings.title")}>
      <PanelHeader icon={<Settings2 size={15} />} title={t("settings.title")} onClose={onClose} />
      <div className="settings-overview">
        <div className="settings-overview-card primary">
          <SlidersHorizontal size={16} />
          <span>
            <small>{t("settings.defaultRelation")}</small>
            <strong>{t(`relation.${defaultRelation}Accent`)}</strong>
          </span>
        </div>
        <div className="settings-overview-card">
          <Languages size={16} />
          <span>
            <small>{t("settings.language")}</small>
            <strong>{localeOptions.find((option) => option.id === locale)?.label ?? locale}</strong>
          </span>
        </div>
      </div>
      <SettingsSection icon={<MonitorCog size={14} />} isOpen={openSections.canvas} title={t("settings.canvas")} onToggle={() => toggleSection("canvas")}>
        <label className="settings-row">
          <span>
            <strong>{t("settings.defaultRelation")}</strong>
            <small>{t("settings.defaultRelationHelp")}</small>
          </span>
          <select value={defaultRelation} onChange={(event) => setDefaultRelation(event.target.value as GraphEdgeRelation)}>
            {relationOptions.map((option) => (
              <option key={option} value={option}>
                {t(`relation.${option}Accent`)}
              </option>
            ))}
          </select>
        </label>
        <div className="settings-relation-help">
          {relationOptions.map((option) => (
            <span className={cn(defaultRelation === option && "active")} key={option}>
              <strong>{t(`relation.${option}Accent`)}</strong>
              <small>{t(`relation.${option}Description`)}</small>
            </span>
          ))}
        </div>
        <div className="settings-row static">
          <span>
            <strong>{t("settings.handleThreshold")}</strong>
            <small>{t("settings.handleThresholdHelp", { count: HANDLE_COLLAPSE_THRESHOLD })}</small>
          </span>
          <code>{HANDLE_COLLAPSE_THRESHOLD}</code>
        </div>
      </SettingsSection>
      <SettingsSection icon={<Settings2 size={14} />} isOpen={openSections.general} title={t("settings.general")} onToggle={() => toggleSection("general")}>
        <label className="settings-row">
          <span>
            <strong>{t("settings.language")}</strong>
            <small>{t("settings.languageHelp")}</small>
          </span>
          <div className="segmented-control compact">
            {localeOptions.map((option) => (
              <button className={cn(locale === option.id && "active")} key={option.id} type="button" onClick={() => setLocale(option.id)}>
                {option.label}
              </button>
            ))}
          </div>
        </label>
        <label className="settings-row">
          <span>
            <strong>{t("settings.reduceMotion")}</strong>
            <small>{t("settings.reduceMotionHelp")}</small>
          </span>
          <input checked={reducedMotion} type="checkbox" onChange={(event) => setReducedMotion(event.target.checked)} />
        </label>
      </SettingsSection>
    </section>
  );
}

function SettingsSection({
  children,
  icon,
  isOpen,
  onToggle,
  title
}: {
  children: ReactNode;
  icon: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  title: string;
}) {
  return (
    <div className={cn("utility-section settings-section", !isOpen && "collapsed")}>
      <button className="settings-section-header" type="button" onClick={onToggle} aria-expanded={isOpen}>
        <span>{icon}{title}</span>
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {isOpen ? <div className="settings-section-body">{children}</div> : null}
    </div>
  );
}

function PanelHeader({ icon, onClose, title }: { icon: ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="utility-header">
      <span>{icon}{title}</span>
      <button className="icon-button" type="button" onClick={onClose} aria-label={title}>
        <X size={15} />
      </button>
    </div>
  );
}

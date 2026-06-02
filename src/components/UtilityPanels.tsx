import { MonitorCog, Palette, Settings2, UserRound, X } from "lucide-react";
import type { ReactNode } from "react";
import { HANDLE_COLLAPSE_THRESHOLD } from "../utils/graph-converters";
import { relationOptions, relationStyle } from "../utils/relation-styles";
import { usePreferencesStore } from "../stores/preferences.store";
import type { GraphEdgeRelation, UiThemeId, UtilityPanel } from "../types";

const themeOptions: Array<{ id: UiThemeId; label: string; description: string; swatches: string[] }> = [
  { id: "system", label: "跟随系统", description: "使用系统明暗偏好", swatches: ["#030506", "#89ecff", "#42f5a7"] },
  { id: "light", label: "明亮", description: "高对比浅色工作台", swatches: ["#eef7f6", "#0f766e", "#2563eb"] },
  { id: "dark", label: "暗色", description: "默认黑色控制台", swatches: ["#030506", "#89ecff", "#42f5a7"] },
  { id: "terminal", label: "终端绿", description: "偏命令行的绿色焦点", swatches: ["#020402", "#52ff9a", "#a3e635"] },
  { id: "hologrid", label: "冰蓝网格", description: "更冷静的蓝青网格", swatches: ["#02060a", "#9deaff", "#22d3ee"] }
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

  return (
    <section className="utility-panel" aria-label="个人">
      <PanelHeader icon={<UserRound size={15} />} title="个人" onClose={onClose} />
      <div className="utility-identity">
        <div className="avatar-mark">FW</div>
        <div>
          <strong>FlowWeave User</strong>
          <span>本地桌面工作区</span>
        </div>
      </div>
      <div className="utility-section">
        <h3><Palette size={14} />个性化</h3>
        <div className="theme-grid">
          {themeOptions.map((option) => (
            <button className={theme === option.id ? "active" : ""} key={option.id} type="button" onClick={() => setTheme(option.id)}>
              <span>
                {option.swatches.map((swatch) => (
                  <i key={swatch} style={{ background: swatch }} />
                ))}
              </span>
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const defaultRelation = usePreferencesStore((state) => state.defaultRelation);
  const reducedMotion = usePreferencesStore((state) => state.reducedMotion);
  const setDefaultRelation = usePreferencesStore((state) => state.setDefaultRelation);
  const setReducedMotion = usePreferencesStore((state) => state.setReducedMotion);

  return (
    <section className="utility-panel" aria-label="设置">
      <PanelHeader icon={<Settings2 size={15} />} title="设置" onClose={onClose} />
      <div className="utility-section">
        <h3><MonitorCog size={14} />Canvas</h3>
        <label className="settings-row">
          <span>
            <strong>默认连接类型</strong>
            <small>拖拽或手动新增连接时使用</small>
          </span>
          <select value={defaultRelation} onChange={(event) => setDefaultRelation(event.target.value as GraphEdgeRelation)}>
            {relationOptions.map((option) => (
              <option key={option} value={option}>
                {relationStyle[option].accent}
              </option>
            ))}
          </select>
        </label>
        <div className="settings-relation-help">
          {relationOptions.map((option) => (
            <span key={option}>
              <strong>{relationStyle[option].accent}</strong>
              <small>{relationStyle[option].description}</small>
            </span>
          ))}
        </div>
        <div className="settings-row static">
          <span>
            <strong>多连接点阈值</strong>
            <small>{HANDLE_COLLAPSE_THRESHOLD} 条以内独立显示，更多折叠为聚合点</small>
          </span>
          <code>{HANDLE_COLLAPSE_THRESHOLD}</code>
        </div>
      </div>
      <div className="utility-section">
        <h3>通用</h3>
        <label className="settings-row">
          <span>
            <strong>降低动效</strong>
            <small>降低背景和悬浮过渡强度</small>
          </span>
          <input checked={reducedMotion} type="checkbox" onChange={(event) => setReducedMotion(event.target.checked)} />
        </label>
      </div>
    </section>
  );
}

function PanelHeader({ icon, onClose, title }: { icon: ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="utility-header">
      <span>{icon}{title}</span>
      <button className="icon-button" type="button" onClick={onClose} aria-label={`关闭${title}`}>
        <X size={15} />
      </button>
    </div>
  );
}

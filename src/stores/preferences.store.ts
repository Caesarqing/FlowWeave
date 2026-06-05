import { create } from "zustand";
import type { GraphEdgeRelation, LocaleId, UiThemeId, UtilityPanel } from "../types";
import { relationOptions } from "../utils/relation-styles";

const THEME_KEY = "flowweave.uiTheme";
const LOCALE_KEY = "flowweave.locale";
const DEFAULT_RELATION_KEY = "flowweave.defaultRelation";
const REDUCED_MOTION_KEY = "flowweave.reducedMotion";
const themeOptions: UiThemeId[] = ["system", "light", "dark", "terminal", "hologrid"];
const localeOptions: LocaleId[] = ["en", "zh-CN"];

type PreferencesState = {
  defaultRelation: GraphEdgeRelation;
  locale: LocaleId;
  reducedMotion: boolean;
  theme: UiThemeId;
  utilityPanel?: UtilityPanel;
  setDefaultRelation: (relation: GraphEdgeRelation) => void;
  setLocale: (locale: LocaleId) => void;
  setReducedMotion: (value: boolean) => void;
  setTheme: (theme: UiThemeId) => void;
  setUtilityPanel: (panel?: UtilityPanel) => void;
};

export const usePreferencesStore = create<PreferencesState>((set) => ({
  defaultRelation: readEnumValue(DEFAULT_RELATION_KEY, relationOptions, "depends_on"),
  locale: readEnumValue(LOCALE_KEY, localeOptions, "zh-CN"),
  reducedMotion: readStoredValue<"true" | "false">(REDUCED_MOTION_KEY, "false") === "true",
  theme: readEnumValue(THEME_KEY, themeOptions, "dark"),
  setDefaultRelation: (defaultRelation) => {
    writeStoredValue(DEFAULT_RELATION_KEY, defaultRelation);
    set({ defaultRelation });
  },
  setLocale: (locale) => {
    writeStoredValue(LOCALE_KEY, locale);
    set({ locale });
  },
  setReducedMotion: (reducedMotion) => {
    writeStoredValue(REDUCED_MOTION_KEY, String(reducedMotion));
    set({ reducedMotion });
  },
  setTheme: (theme) => {
    writeStoredValue(THEME_KEY, theme);
    set({ theme });
  },
  setUtilityPanel: (utilityPanel) => set({ utilityPanel })
}));

function readStoredValue<T extends string>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  return (window.localStorage.getItem(key) as T | null) ?? fallback;
}

function readEnumValue<T extends string>(key: string, options: readonly T[], fallback: T): T {
  const value = readStoredValue(key, fallback);
  return options.includes(value) ? value : fallback;
}

function writeStoredValue(key: string, value: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, value);
}

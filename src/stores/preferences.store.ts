import { create } from "zustand";
import type { GraphEdgeRelation, UiThemeId, UtilityPanel } from "../types";
import { relationOptions } from "../utils/relation-styles";

const THEME_KEY = "flowweave.uiTheme";
const DEFAULT_RELATION_KEY = "flowweave.defaultRelation";
const REDUCED_MOTION_KEY = "flowweave.reducedMotion";
const themeOptions: UiThemeId[] = ["system", "light", "dark", "terminal", "hologrid"];

type PreferencesState = {
  defaultRelation: GraphEdgeRelation;
  reducedMotion: boolean;
  theme: UiThemeId;
  utilityPanel?: UtilityPanel;
  setDefaultRelation: (relation: GraphEdgeRelation) => void;
  setReducedMotion: (value: boolean) => void;
  setTheme: (theme: UiThemeId) => void;
  setUtilityPanel: (panel?: UtilityPanel) => void;
};

export const usePreferencesStore = create<PreferencesState>((set) => ({
  defaultRelation: readEnumValue(DEFAULT_RELATION_KEY, relationOptions, "depends_on"),
  reducedMotion: readStoredValue<"true" | "false">(REDUCED_MOTION_KEY, "false") === "true",
  theme: readEnumValue(THEME_KEY, themeOptions, "dark"),
  setDefaultRelation: (defaultRelation) => {
    writeStoredValue(DEFAULT_RELATION_KEY, defaultRelation);
    set({ defaultRelation });
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

function writeStoredValue(key: string, value: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, value);
}

function readEnumValue<T extends string>(key: string, allowedValues: readonly T[], fallback: T): T {
  const storedValue = readStoredValue<T>(key, fallback);
  return allowedValues.includes(storedValue) ? storedValue : fallback;
}

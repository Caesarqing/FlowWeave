import { create } from "zustand";
import type {
  FlowWeaveErrorData,
  GraphEdgeRelation,
  LocaleId,
  UiThemeId,
  UtilityPanel,
  WorkspacePanelPage,
  WorkspacePanelPreferences,
  WorkspacePanelSide
} from "../types";
import { relationOptions } from "../utils/relation-styles";

const THEME_KEY = "flowweave.uiTheme";
const LOCALE_KEY = "flowweave.locale";
const DEFAULT_RELATION_KEY = "flowweave.defaultRelation";
const REDUCED_MOTION_KEY = "flowweave.reducedMotion";
const SCAN_MAX_ENTRIES_KEY = "flowweave.scanMaxEntries";
const SCAN_CONCURRENCY_KEY = "flowweave.scanConcurrency";
const EXECUTE_TIMEOUT_MINUTES_KEY = "flowweave.executeTimeoutMinutes";
const ONBOARDING_SEEN_KEY = "flowweave.onboardingSeen";
const WORKSPACE_PANELS_KEY = "flowweave.workspacePanels";
export const PREFERENCE_STORAGE_ERROR_EVENT = "flowweave-preference-storage-error";
const themeOptions: UiThemeId[] = ["system", "light", "dark", "terminal", "hologrid"];
const localeOptions: LocaleId[] = ["en", "zh-CN"];
const defaultWorkspacePanels: WorkspacePanelPreferences = {
  canvas: { left: false, right: false },
  structure: { left: false, right: false },
  docs: { left: false, right: false },
  "git-review": { left: false, right: false },
  tools: { left: false, right: false }
};

type PreferencesState = {
  defaultRelation: GraphEdgeRelation;
  locale: LocaleId;
  reducedMotion: boolean;
  scanMaxEntries: number;
  scanConcurrency: number;
  executeTimeoutMinutes: number;
  onboardingSeen: boolean;
  theme: UiThemeId;
  utilityPanel?: UtilityPanel;
  workspacePanels: WorkspacePanelPreferences;
  setDefaultRelation: (relation: GraphEdgeRelation) => void;
  setLocale: (locale: LocaleId) => void;
  setReducedMotion: (value: boolean) => void;
  setScanMaxEntries: (value: number) => void;
  setScanConcurrency: (value: number) => void;
  setExecuteTimeoutMinutes: (value: number) => void;
  completeOnboarding: () => void;
  setTheme: (theme: UiThemeId) => void;
  setUtilityPanel: (panel?: UtilityPanel) => void;
  setWorkspacePanelCollapsed: (page: WorkspacePanelPage, side: WorkspacePanelSide, collapsed: boolean) => void;
};

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  defaultRelation: readEnumValue(DEFAULT_RELATION_KEY, relationOptions, "depends_on"),
  locale: readEnumValue(LOCALE_KEY, localeOptions, "zh-CN"),
  reducedMotion: readStoredValue<"true" | "false">(REDUCED_MOTION_KEY, "false") === "true",
  scanMaxEntries: readStoredInteger(SCAN_MAX_ENTRIES_KEY, 10_000, 1_000, 100_000),
  scanConcurrency: readStoredInteger(SCAN_CONCURRENCY_KEY, 32, 1, 128),
  executeTimeoutMinutes: readStoredInteger(EXECUTE_TIMEOUT_MINUTES_KEY, 10, 1, 120),
  onboardingSeen: readStoredValue<"true" | "false">(ONBOARDING_SEEN_KEY, "false") === "true",
  theme: readEnumValue(THEME_KEY, themeOptions, "dark"),
  workspacePanels: readWorkspacePanels(),
  setDefaultRelation: (defaultRelation) => {
    if (!writeStoredValue(DEFAULT_RELATION_KEY, defaultRelation)) return;
    set({ defaultRelation });
  },
  setLocale: (locale) => {
    if (!writeStoredValue(LOCALE_KEY, locale)) return;
    set({ locale });
  },
  setReducedMotion: (reducedMotion) => {
    if (!writeStoredValue(REDUCED_MOTION_KEY, String(reducedMotion))) return;
    set({ reducedMotion });
  },
  setScanMaxEntries: (scanMaxEntries) => {
    if (!writeStoredValue(SCAN_MAX_ENTRIES_KEY, String(scanMaxEntries))) return;
    set({ scanMaxEntries });
  },
  setScanConcurrency: (scanConcurrency) => {
    if (!writeStoredValue(SCAN_CONCURRENCY_KEY, String(scanConcurrency))) return;
    set({ scanConcurrency });
  },
  setExecuteTimeoutMinutes: (executeTimeoutMinutes) => {
    if (!writeStoredValue(EXECUTE_TIMEOUT_MINUTES_KEY, String(executeTimeoutMinutes))) return;
    set({ executeTimeoutMinutes });
  },
  completeOnboarding: () => {
    if (!writeStoredValue(ONBOARDING_SEEN_KEY, "true")) return;
    set({ onboardingSeen: true });
  },
  setTheme: (theme) => {
    if (!writeStoredValue(THEME_KEY, theme)) return;
    set({ theme });
  },
  setUtilityPanel: (utilityPanel) => set({ utilityPanel }),
  setWorkspacePanelCollapsed: (page, side, collapsed) => {
    const workspacePanels = {
      ...get().workspacePanels,
      [page]: {
        ...get().workspacePanels[page],
        [side]: collapsed
      }
    };
    if (!writeStoredValue(WORKSPACE_PANELS_KEY, JSON.stringify(workspacePanels))) return;
    set({ workspacePanels });
  }
}));

function readStoredValue<T extends string>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    return (window.localStorage.getItem(key) as T | null) ?? fallback;
  } catch (error) {
    reportStorageError("read", key, error);
    return fallback;
  }
}

function readEnumValue<T extends string>(key: string, options: readonly T[], fallback: T): T {
  const value = readStoredValue(key, fallback);
  return options.includes(value) ? value : fallback;
}

function writeStoredValue(key: string, value: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    reportStorageError("write", key, error);
    return false;
  }
}

function readStoredInteger(key: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(readStoredValue(key, String(fallback)));
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function readWorkspacePanels(): WorkspacePanelPreferences {
  if (typeof window === "undefined") return defaultWorkspacePanels;
  return parseWorkspacePanels(readStoredValue(WORKSPACE_PANELS_KEY, ""));
}

export function parseWorkspacePanels(stored: string | null): WorkspacePanelPreferences {
  if (!stored) return defaultWorkspacePanels;
  try {
    const parsed = JSON.parse(stored) as Partial<WorkspacePanelPreferences>;
    return Object.fromEntries(
      Object.entries(defaultWorkspacePanels).map(([page, defaults]) => {
        const storedPage = parsed[page as WorkspacePanelPage];
        return [page, {
          left: typeof storedPage?.left === "boolean" ? storedPage.left : defaults.left,
          right: typeof storedPage?.right === "boolean" ? storedPage.right : defaults.right
        }];
      })
    ) as WorkspacePanelPreferences;
  } catch {
    return defaultWorkspacePanels;
  }
}

function reportStorageError(operation: "read" | "write", key: string, error: unknown): void {
  const data: FlowWeaveErrorData = {
    code: "preference-storage-failed",
    category: "filesystem",
    message: "FlowWeave could not persist desktop preferences.",
    context: { operation, key },
    suggestedActions: [
      "Check whether application storage is available.",
      "Restart FlowWeave and retry the preference change."
    ],
    technicalDetails: error instanceof Error ? error.message : String(error)
  };
  console.error("FlowWeave preference storage failed.", { operation, key, error });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<FlowWeaveErrorData>(PREFERENCE_STORAGE_ERROR_EVENT, { detail: data }));
  }
}

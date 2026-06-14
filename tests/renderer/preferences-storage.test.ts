import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowWeaveErrorData } from "../../src/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("preference storage failures", () => {
  it("reports a structured error and keeps the previous state when persistence fails", async () => {
    const events: Event[] = [];
    const windowStub = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("storage unavailable");
        }
      },
      dispatchEvent: (event: Event) => {
        events.push(event);
        return true;
      }
    };
    vi.stubGlobal("window", windowStub);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const {
      PREFERENCE_STORAGE_ERROR_EVENT,
      usePreferencesStore
    } = await import("../../src/stores/preferences.store");
    const previousTheme = usePreferencesStore.getState().theme;

    usePreferencesStore.getState().setTheme("light");

    expect(usePreferencesStore.getState().theme).toBe(previousTheme);
    const storageEvent = events.find((event) => event.type === PREFERENCE_STORAGE_ERROR_EVENT) as CustomEvent<FlowWeaveErrorData>;
    expect(storageEvent.detail).toMatchObject({
      code: "preference-storage-failed",
      category: "filesystem",
      context: {
        operation: "write",
        key: "flowweave.uiTheme"
      },
      technicalDetails: "storage unavailable"
    });
  });
});

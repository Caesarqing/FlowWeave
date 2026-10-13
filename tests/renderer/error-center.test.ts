// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCenter } from "../../src/components/ErrorCenter";
import { PREFERENCE_STORAGE_ERROR_EVENT } from "../../src/stores/preferences.store";
import { usePreferencesStore } from "../../src/stores/preferences.store";
import type { FlowWeaveErrorData } from "../../src/types";

let mountedRoot: ReturnType<typeof createRoot> | undefined;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("ErrorCenter", () => {
  afterEach(async () => {
    if (mountedRoot) {
      await act(async () => mountedRoot?.unmount());
      mountedRoot = undefined;
    }
    usePreferencesStore.getState().setLocale("en");
    document.body.innerHTML = "";
  });

  it("summarizes stale artifact errors and keeps their details available", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    mountedRoot = createRoot(container);
    const error: FlowWeaveErrorData = {
      code: "artifact-generation-mismatch",
      category: "validation",
      message: "Expected generation 4 but found generation 5.",
      context: { projectId: "project-1" },
      suggestedActions: ["Reload the project."],
      technicalDetails: "The saved Canvas belongs to generation 4."
    };

    await act(async () => {
      mountedRoot?.render(createElement(ErrorCenter));
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(PREFERENCE_STORAGE_ERROR_EVENT, { detail: error }));
    });

    expect(container.querySelector(".error-center > strong")?.textContent).toBe("Project changed. Reopen to continue.");
    expect(container.querySelector(".error-center details pre")?.textContent).toContain(error.message);
    expect(container.querySelector(".error-center details pre")?.textContent).toContain(error.technicalDetails);
  });
});

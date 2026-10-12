// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentWorkspace } from "../../src/components/DocumentWorkspace";
import { usePreferencesStore } from "../../src/stores/preferences.store";
import type { FlowWeaveApi } from "../../src/types";

let mountedRoot: ReturnType<typeof createRoot> | undefined;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("document workspace", () => {
  afterEach(async () => {
    if (mountedRoot) {
      await act(async () => mountedRoot?.unmount());
      mountedRoot = undefined;
    }
    delete (window as unknown as { flowweave?: FlowWeaveApi }).flowweave;
    delete (window as unknown as { confirm?: (message?: string) => boolean }).confirm;
    usePreferencesStore.getState().setLocale("en");
    document.body.innerHTML = "";
  });

  it("preserves unsaved regular-document edits when guidance preview changes", async () => {
    const readProjectFile = vi.fn(async (_projectId: string, filePath: string) =>
      filePath.endsWith("readme.md") ? "Saved README" : undefined
    );
    Object.defineProperty(window, "flowweave", {
      configurable: true,
      value: { readProjectFile } as unknown as FlowWeaveApi
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoot = root;
    const props = {
      projectId: "project-1",
      hasPendingGuidance: false,
      onExportGuidance: async () => undefined,
      onRefreshGuidance: async () => ({ markdown: "Updated guidance", contextJson: "{}" }),
      onSendGuidance: async () => "no-changes" as const
    };

    await act(async () => {
      root.render(createElement(DocumentWorkspace, {
        ...props,
        guidance: { markdown: "Initial guidance", contextJson: "{}" }
      }));
    });

    const readmeButton = container.querySelectorAll<HTMLButtonElement>(".doc-list button")[3];
    await act(async () => {
      readmeButton.click();
    });
    const editor = container.querySelector<HTMLTextAreaElement>(".doc-editor");
    if (!editor) throw new Error("Document editor was not rendered.");

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!valueSetter) throw new Error("Textarea value setter was not available.");
      valueSetter.call(editor, "Unsaved README edit");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(editor.value).toBe("Unsaved README edit");

    await act(async () => {
      root.render(createElement(DocumentWorkspace, {
        ...props,
        guidance: { markdown: "Refreshed guidance", contextJson: "{\"updated\":true}" }
      }));
    });

    expect(editor.value).toBe("Unsaved README edit");
    expect(readProjectFile).toHaveBeenCalledTimes(2);
  });

  it("keeps the selected document when guidance refresh completes after switching documents", async () => {
    let finishRefresh: ((files: { markdown: string; contextJson: string }) => void) | undefined;
    const onRefreshGuidance = vi.fn(() => new Promise<{ markdown: string; contextJson: string }>((resolve) => {
      finishRefresh = resolve;
    }));
    Object.defineProperty(window, "flowweave", {
      configurable: true,
      value: {
        readProjectFile: vi.fn(async (_projectId: string, filePath: string) =>
          filePath.endsWith("readme.md") ? "Saved README" : undefined)
      } as unknown as FlowWeaveApi
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoot = root;

    await act(async () => {
      root.render(createElement(DocumentWorkspace, {
        projectId: "project-1",
        guidance: { markdown: "Initial guidance", contextJson: "{}" },
        hasPendingGuidance: false,
        onExportGuidance: async () => undefined,
        onRefreshGuidance,
        onSendGuidance: async () => "no-changes" as const
      }));
    });
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".doc-list button")[0].click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".workspace-header-primary-actions button")?.click();
    });
    expect(onRefreshGuidance).toHaveBeenCalledOnce();
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".doc-list button")[3].click();
    });
    const editor = container.querySelector<HTMLTextAreaElement>(".doc-editor");
    expect(editor?.value).toBe("Saved README");

    await act(async () => {
      if (!finishRefresh) throw new Error("Guidance refresh did not start.");
      finishRefresh({ markdown: "Refreshed guidance", contextJson: "{}" });
    });
    expect(editor?.value).toBe("Saved README");
  });

  it("preserves unsaved document text when the interface language changes", async () => {
    Object.defineProperty(window, "flowweave", {
      configurable: true,
      value: { readProjectFile: vi.fn(async () => "Saved README") } as unknown as FlowWeaveApi
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoot = root;
    await act(async () => {
      root.render(createElement(DocumentWorkspace, {
        projectId: "project-1",
        hasPendingGuidance: false,
        onExportGuidance: async () => undefined,
        onRefreshGuidance: async () => ({ markdown: "", contextJson: "" }),
        onSendGuidance: async () => "no-changes" as const
      }));
    });
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".doc-list button")[3].click();
    });
    const editor = container.querySelector<HTMLTextAreaElement>(".doc-editor");
    if (!editor) throw new Error("Document editor was not rendered.");
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!valueSetter) throw new Error("Textarea value setter was not available.");
      valueSetter.call(editor, "Unsaved README edit");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      usePreferencesStore.getState().setLocale("zh-CN");
    });
    expect(editor.value).toBe("Unsaved README edit");
  });

  it("shows document read errors instead of treating them as missing files", async () => {
    Object.defineProperty(window, "flowweave", {
      configurable: true,
      value: { readProjectFile: vi.fn(async () => { throw new Error("Read permission denied"); }) } as unknown as FlowWeaveApi
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoot = root;
    await act(async () => {
      root.render(createElement(DocumentWorkspace, {
        projectId: "project-1",
        hasPendingGuidance: false,
        onExportGuidance: async () => undefined,
        onRefreshGuidance: async () => ({ markdown: "", contextJson: "" }),
        onSendGuidance: async () => "no-changes" as const
      }));
    });
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".doc-list button")[3].click();
    });
    expect(container.querySelector(".project-status")?.textContent).toContain("Read permission denied");
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".doc-list button")[0].click();
    });
    expect(container.querySelector(".project-status")?.textContent).toContain("Read permission denied");
  });

  it("asks before replacing unsaved text when switching documents", async () => {
    const readProjectFile = vi.fn(async (_projectId: string, filePath: string) =>
      filePath.endsWith("readme.md") ? "Saved README" : "Saved document"
    );
    Object.defineProperty(window, "flowweave", {
      configurable: true,
      value: { readProjectFile } as unknown as FlowWeaveApi
    });
    const confirm = vi.fn(() => false);
    Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoot = root;
    await act(async () => {
      root.render(createElement(DocumentWorkspace, {
        projectId: "project-1",
        hasPendingGuidance: false,
        onExportGuidance: async () => undefined,
        onRefreshGuidance: async () => ({ markdown: "", contextJson: "" }),
        onSendGuidance: async () => "no-changes" as const
      }));
    });
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".doc-list button")[3].click();
    });
    const editor = container.querySelector<HTMLTextAreaElement>(".doc-editor");
    if (!editor) throw new Error("Document editor was not rendered.");
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!valueSetter) throw new Error("Textarea value setter was not available.");
      valueSetter.call(editor, "Unsaved README edit");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".doc-list button")[2].click();
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(readProjectFile).toHaveBeenCalledTimes(2);
    expect(editor.value).toBe("Unsaved README edit");

    confirm.mockReturnValue(true);
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".doc-list button")[2].click();
    });
    expect(readProjectFile).toHaveBeenCalledTimes(3);
    expect(editor.value).toBe("Saved document");
  });
});

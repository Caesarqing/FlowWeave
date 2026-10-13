import { DiffEditor } from "@monaco-editor/react";
import { useResolvedTheme } from "../hooks/useResolvedTheme";
import { usePreferencesStore } from "../stores/preferences.store";

export function DiffViewer({ emptyMessage, patch }: { emptyMessage: string; patch: string }) {
  const theme = usePreferencesStore((state) => state.theme);
  const resolvedTheme = useResolvedTheme(theme);
  if (!patch.trim()) {
    return <div className="diff-empty-state" role="status">{emptyMessage}</div>;
  }

  return (
    <div className="monaco-diff-shell">
      <DiffEditor
        height="100%"
        language="diff"
        modified={patch}
        original=""
        options={{
          readOnly: true,
          renderSideBySide: false,
          minimap: { enabled: false },
          fontSize: 12,
          scrollBeyondLastLine: false,
          wordWrap: "on"
        }}
        theme={resolvedTheme === "light" ? "vs" : "vs-dark"}
      />
    </div>
  );
}

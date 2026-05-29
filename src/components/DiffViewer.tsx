import { DiffEditor } from "@monaco-editor/react";

export function DiffViewer({ patch }: { patch: string }) {
  if (patch.trim()) {
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
          theme="vs-dark"
        />
      </div>
    );
  }

  const lines = patch ? patch.split("\n") : ["No diff available."];
  return (
    <pre className="diff-viewer">
      {lines.map((line, index) => (
        <div className={lineClass(line)} key={`${index}-${line}`}>
          <span className="diff-line-number">{index + 1}</span>
          <code>{line || " "}</code>
        </div>
      ))}
    </pre>
  );
}

function lineClass(line: string) {
  if (line.startsWith("+") && !line.startsWith("+++")) return "diff-line added";
  if (line.startsWith("-") && !line.startsWith("---")) return "diff-line removed";
  if (line.startsWith("@@")) return "diff-line hunk";
  return "diff-line";
}

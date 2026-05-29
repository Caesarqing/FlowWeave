import { useState } from "react";

const docTypes = ["PRD", "README", "API Doc", "Task Spec"];

export function DocumentWorkspace({ projectPath }: { projectPath: string }) {
  const [docId, setDocId] = useState("task-spec");
  const [content, setContent] = useState("# FlowWeave Task Spec\n\n文档将保存到 .flowweave/docs/。");
  const [status, setStatus] = useState("尚未保存。");

  async function saveDoc() {
    if (!window.flowweave || !projectPath) {
      setStatus("请使用桌面版并先打开项目。");
      return;
    }
    try {
      const path = await window.flowweave.saveFlowWeaveDoc(projectPath, docId, content);
      setStatus(`已保存：${path}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="workspace-page docs-workspace">
      <section className="workspace-column">
        <div className="panel-header"><span>Docs</span></div>
        <div className="doc-list">
          {docTypes.map((docType) => (
            <button className="tree-row" key={docType} onClick={() => setDocId(docType.toLowerCase().replace(/\s+/g, "-"))} type="button">
              <span>{docType}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="workspace-main">
        <div className="panel-header">
          <span>Markdown Editor · {docId}</span>
          <button className="ghost-button" type="button" onClick={() => void saveDoc()}>保存</button>
        </div>
        <textarea className="doc-editor" value={content} onChange={(event) => setContent(event.target.value)} />
        <p className="project-status">{status}</p>
      </section>
    </main>
  );
}

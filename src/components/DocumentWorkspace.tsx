import { useState } from "react";
import { useI18n } from "../utils/i18n";

const docTypes = ["PRD", "README", "API Doc", "Task Spec"];

export function DocumentWorkspace({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const [docId, setDocId] = useState("task-spec");
  const [content, setContent] = useState(() => t("docs.initialContent"));
  const [status, setStatus] = useState(() => t("docs.notSaved"));

  async function saveDoc() {
    if (!window.flowweave || !projectId) {
      setStatus(t("docs.needDesktop"));
      return;
    }
    try {
      const path = await window.flowweave.saveFlowWeaveDoc(projectId, docId, content);
      setStatus(t("docs.saved", { path }));
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
          <button className="ghost-button" type="button" onClick={() => void saveDoc()}>{t("docs.save")}</button>
        </div>
        <textarea className="doc-editor" value={content} onChange={(event) => setContent(event.target.value)} />
        <p className="project-status">{status}</p>
      </section>
    </main>
  );
}

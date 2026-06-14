import { useState } from "react";
import { useI18n } from "../utils/i18n";
import { WorkspaceLayout } from "./WorkspaceLayout";
import { Button } from "./Button";
import { Save } from "lucide-react";

const docTypes = [
  { id: "prd", labelKey: "docs.type.prd" },
  { id: "readme", labelKey: "docs.type.readme" },
  { id: "api-doc", labelKey: "docs.type.api" },
  { id: "task-spec", labelKey: "docs.type.task" }
];

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

  const documentList = (
    <section className="workspace-column">
        <div className="panel-header"><span>{t("docs.list")}</span></div>
        <div className="doc-list">
          {docTypes.map((docType) => (
            <button className="tree-row" key={docType.id} onClick={() => setDocId(docType.id)} type="button">
              <span>{t(docType.labelKey)}</span>
            </button>
          ))}
        </div>
    </section>
  );

  return (
    <WorkspaceLayout
      actions={<Button icon={<Save size={14} />} variant="primary" onClick={() => void saveDoc()}>{t("docs.save")}</Button>}
      className="workspace-page docs-workspace"
      left={documentList}
      page="docs"
      leftWidth="280px"
      status={`Markdown · ${docId}`}
      title={t("nav.docs")}
    >
      <section className="workspace-main">
        <textarea className="doc-editor" value={content} onChange={(event) => setContent(event.target.value)} />
        <p className="project-status">{status}</p>
      </section>
    </WorkspaceLayout>
  );
}

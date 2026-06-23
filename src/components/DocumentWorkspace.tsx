import { useEffect, useState } from "react";
import { useI18n } from "../utils/i18n";
import { WorkspaceLayout } from "./WorkspaceLayout";
import { Button } from "./Button";
import { Save } from "lucide-react";

const docTypes = [
  { id: "modification-guidance", labelKey: "docs.type.modificationGuidance", extension: "md", generated: true },
  { id: "modification-context", labelKey: "docs.type.modificationContext", extension: "json", generated: true },
  { id: "prd", labelKey: "docs.type.prd", extension: "md" },
  { id: "readme", labelKey: "docs.type.readme", extension: "md" },
  { id: "api-doc", labelKey: "docs.type.api", extension: "md" },
  { id: "task-spec", labelKey: "docs.type.task", extension: "md" }
];

export function DocumentWorkspace({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const [docId, setDocId] = useState("task-spec");
  const [content, setContent] = useState(() => t("docs.initialContent"));
  const [status, setStatus] = useState(() => t("docs.notSaved"));
  const selectedDoc = docTypes.find((docType) => docType.id === docId) ?? docTypes[0];
  const selectedDocPath = `.flowweave/docs/${selectedDoc.id}.${selectedDoc.extension}`;

  useEffect(() => {
    let canceled = false;
    async function loadDoc() {
      if (!window.flowweave || !projectId) {
        setStatus(t("docs.needDesktop"));
        return;
      }
      try {
        const text = await window.flowweave.readProjectFile(projectId, selectedDocPath);
        if (canceled) return;
        setContent(text);
        setStatus(t("docs.loaded", { path: selectedDocPath }));
      } catch {
        if (canceled) return;
        setContent(defaultDocContent(docId, t));
        setStatus(t("docs.notSaved"));
      }
    }
    void loadDoc();
    return () => {
      canceled = true;
    };
  }, [docId, projectId, selectedDocPath, t]);

  async function saveDoc() {
    if (selectedDoc.generated) {
      setStatus(t("docs.generatedReadOnly"));
      return;
    }
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
              {docType.generated ? <small>{t("docs.generated")}</small> : null}
            </button>
          ))}
        </div>
    </section>
  );

  return (
    <WorkspaceLayout
      actions={<Button disabled={selectedDoc.generated} icon={<Save size={14} />} variant="primary" onClick={() => void saveDoc()}>{t("docs.save")}</Button>}
      className="workspace-page docs-workspace"
      left={documentList}
      page="docs"
      leftWidth="280px"
      status={`${selectedDoc.extension.toUpperCase()} · ${docId}`}
      title={t("nav.docs")}
    >
      <section className="workspace-main">
        <textarea className="doc-editor" value={content} onChange={(event) => setContent(event.target.value)} />
        <p className="project-status">{status}</p>
      </section>
    </WorkspaceLayout>
  );
}

function defaultDocContent(docId: string, t: (key: string) => string): string {
  if (docId === "modification-guidance") {
    return t("docs.modificationGuidanceEmpty");
  }
  if (docId === "modification-context") {
    return "{\n  \"schemaVersion\": 1,\n  \"source\": \"FlowWeave\"\n}\n";
  }
  return t("docs.initialContent");
}

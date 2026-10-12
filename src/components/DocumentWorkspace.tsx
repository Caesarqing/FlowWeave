import { useEffect, useRef, useState } from "react";
import { useI18n } from "../utils/i18n";
import { WorkspaceLayout } from "./WorkspaceLayout";
import { Button } from "./Button";
import { Download, RefreshCw, Save, Send } from "lucide-react";

const docTypes = [
  { id: "modification-guidance", labelKey: "docs.type.modificationGuidance", extension: "md", generated: true },
  { id: "modification-context", labelKey: "docs.type.modificationContext", extension: "json", generated: true },
  { id: "prd", labelKey: "docs.type.prd", extension: "md" },
  { id: "readme", labelKey: "docs.type.readme", extension: "md" },
  { id: "api-doc", labelKey: "docs.type.api", extension: "md" },
  { id: "task-spec", labelKey: "docs.type.task", extension: "md" }
];

type ModificationGuidanceFiles = { markdown: string; contextJson: string };
type GuidanceSendResult = "completed" | "no-changes" | "failed" | "canceled";

export function DocumentWorkspace({
  projectId,
  guidance,
  hasPendingGuidance,
  onExportGuidance,
  onRefreshGuidance,
  onSendGuidance
}: {
  projectId: string;
  guidance?: ModificationGuidanceFiles;
  hasPendingGuidance: boolean;
  onExportGuidance: () => Promise<void>;
  onRefreshGuidance: () => Promise<ModificationGuidanceFiles>;
  onSendGuidance: () => Promise<GuidanceSendResult>;
}) {
  const { t } = useI18n();
  const [docId, setDocId] = useState("task-spec");
  const initialContent = t("docs.initialContent");
  const [content, setContent] = useState(initialContent);
  const [status, setStatus] = useState(() => t("docs.notSaved"));
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<"refresh" | "export" | "send" | "">("");
  const activeDocId = useRef(docId);
  const savedDocument = useRef({ id: docId, content: initialContent });
  const selectedDoc = docTypes.find((docType) => docType.id === docId) ?? docTypes[0];
  const selectedDocPath = `.flowweave/docs/${selectedDoc.id}.${selectedDoc.extension}`;
  const guidanceForSelectedDoc = selectedDoc.generated ? guidance : undefined;

  // Changing language must not reload and overwrite unsaved editor content.
  useEffect(() => {
    setIsLoading(true);
    let canceled = false;
    if (selectedDoc.generated) {
      const preview = docId === "modification-guidance" ? guidanceForSelectedDoc?.markdown
        : docId === "modification-context" ? guidanceForSelectedDoc?.contextJson
          : undefined;
      if (preview !== undefined) {
        setContent(preview);
        setStatus(t("docs.guidancePreview"));
        savedDocument.current = { id: docId, content: preview };
        setIsLoading(false);
        return () => { canceled = true; };
      }
      async function loadGeneratedDoc() {
        if (!window.flowweave || !projectId) {
          setContent("");
          setStatus(t("docs.needDesktop"));
          savedDocument.current = { id: docId, content: "" };
          setIsLoading(false);
          return;
        }
        try {
          const text = await window.flowweave.readProjectFile(projectId, selectedDocPath);
          if (canceled) return;
          const nextContent = text ?? defaultDocContent(docId, t);
          setContent(nextContent);
          setStatus(text === undefined ? t("docs.guidanceUnavailable") : t("docs.guidanceSavedPreview"));
          savedDocument.current = { id: docId, content: nextContent };
          setIsLoading(false);
        } catch (error) {
          if (canceled) return;
          setContent("");
          setStatus(`${selectedDocPath}: ${error instanceof Error ? error.message : String(error)}`);
          savedDocument.current = { id: docId, content: "" };
          setIsLoading(false);
        }
      }
      void loadGeneratedDoc();
      return () => { canceled = true; };
    }
    async function loadDoc() {
      if (!window.flowweave || !projectId) {
        setContent("");
        setStatus(t("docs.needDesktop"));
        savedDocument.current = { id: docId, content: "" };
        setIsLoading(false);
        return;
      }
      try {
        const text = await window.flowweave.readProjectFile(projectId, selectedDocPath);
        if (canceled) return;
        const nextContent = text ?? defaultDocContent(docId, t);
        setContent(nextContent);
        setStatus(text === undefined ? t("docs.notSaved") : t("docs.loaded", { path: selectedDocPath }));
        savedDocument.current = { id: docId, content: nextContent };
        setIsLoading(false);
      } catch (error) {
        if (canceled) return;
        setContent("");
        setStatus(`${selectedDocPath}: ${error instanceof Error ? error.message : String(error)}`);
        savedDocument.current = { id: docId, content: "" };
        setIsLoading(false);
      }
    }
    void loadDoc();
    return () => {
      canceled = true;
    };
  }, [docId, guidanceForSelectedDoc, projectId, selectedDoc.generated, selectedDocPath]);

  function selectDocument(nextDocId: string) {
    if (nextDocId === docId || isLoading) return;
    if (!selectedDoc.generated && savedDocument.current.id === docId && content !== savedDocument.current.content &&
      !window.confirm(t("docs.unsavedChanges"))) return;
    activeDocId.current = nextDocId;
    setIsLoading(true);
    setDocId(nextDocId);
  }

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
      if (activeDocId.current === docId) {
        savedDocument.current = { id: docId, content };
        setStatus(t("docs.saved", { path }));
      }
    } catch (error) {
      if (activeDocId.current === docId) setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshGuidance() {
    setBusy("refresh");
    setStatus(t("docs.guidanceRefreshing"));
    try {
      const files = await onRefreshGuidance();
      if (activeDocId.current !== docId) return;
      setContent(docId === "modification-context" ? files.contextJson : files.markdown);
      setStatus(t("docs.guidanceRefreshed"));
    } catch (error) {
      if (activeDocId.current === docId) setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function exportGuidance() {
    setBusy("export");
    setStatus(t("docs.guidanceExporting"));
    try {
      await onExportGuidance();
      setStatus(t("docs.guidanceExported"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function sendGuidance() {
    setBusy("send");
    setStatus(t("docs.guidanceSending"));
    try {
      const result = await onSendGuidance();
      setStatus(t(`docs.guidanceSend.${result}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  const actions = selectedDoc.id === "modification-guidance" ? (
    <>
      <Button disabled={Boolean(busy)} icon={<RefreshCw size={14} />} variant="subtle" onClick={() => void refreshGuidance()}>{t("docs.refreshGuidance")}</Button>
      <Button disabled={Boolean(busy)} icon={<Download size={14} />} variant="secondary" onClick={() => void exportGuidance()}>{t("docs.exportGuidance")}</Button>
      <Button disabled={Boolean(busy) || !hasPendingGuidance} icon={<Send size={14} />} variant="primary" onClick={() => void sendGuidance()}>{t("docs.sendGuidance")}</Button>
    </>
  ) : selectedDoc.generated ? null : (
    <Button disabled={Boolean(busy)} icon={<Save size={14} />} variant="primary" onClick={() => void saveDoc()}>{t("docs.save")}</Button>
  );

  const documentList = (
    <section className="workspace-column">
        <div className="panel-header"><span>{t("docs.list")}</span></div>
        <div className="doc-list">
          {docTypes.map((docType) => (
            <button className="tree-row" disabled={isLoading} key={docType.id} onClick={() => selectDocument(docType.id)} type="button">
              <span>{t(docType.labelKey)}</span>
              {docType.generated ? <small>{t("docs.generated")}</small> : null}
            </button>
          ))}
        </div>
    </section>
  );

  return (
    <WorkspaceLayout
      actions={actions}
      className="workspace-page docs-workspace"
      left={documentList}
      page="docs"
      leftWidth="280px"
      status={`${selectedDoc.extension.toUpperCase()} · ${docId}`}
      title={t("nav.docs")}
    >
      <section className="workspace-main">
        <textarea className="doc-editor" value={content} readOnly={selectedDoc.generated || isLoading} onChange={(event) => setContent(event.target.value)} />
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

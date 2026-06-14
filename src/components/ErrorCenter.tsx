import { AlertTriangle, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { FlowWeaveErrorData } from "../types";
import { useI18n } from "../utils/i18n";
import { PREFERENCE_STORAGE_ERROR_EVENT } from "../stores/preferences.store";

export function ErrorCenter() {
  const [error, setError] = useState<FlowWeaveErrorData>();
  const { t } = useI18n();

  useEffect(() => {
    const handlePreferenceError = (event: Event) => {
      setError((event as CustomEvent<FlowWeaveErrorData>).detail);
    };
    window.addEventListener(PREFERENCE_STORAGE_ERROR_EVENT, handlePreferenceError);
    const unsubscribe = window.flowweave?.onFlowWeaveError((nextError) => setError(nextError));
    return () => {
      window.removeEventListener(PREFERENCE_STORAGE_ERROR_EVENT, handlePreferenceError);
      unsubscribe?.();
    };
  }, []);

  if (!error) return null;
  return (
    <aside className="error-center" aria-live="assertive">
      <header>
        <span><AlertTriangle size={15} />{t("error.title")}</span>
        <button className="icon-button" type="button" onClick={() => setError(undefined)} aria-label={t("error.dismiss")}>
          <X size={14} />
        </button>
      </header>
      <strong>{error.message}</strong>
      {error.suggestedActions.length > 0 ? (
        <section>
          <small>{t("error.actions")}</small>
          <ul>{error.suggestedActions.map((action) => <li key={action}>{action}</li>)}</ul>
        </section>
      ) : null}
      {error.technicalDetails ? (
        <details>
          <summary>{t("error.technicalDetails")}</summary>
          <pre>{error.technicalDetails}</pre>
        </details>
      ) : null}
      <code>{error.code}</code>
    </aside>
  );
}

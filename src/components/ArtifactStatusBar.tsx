import type { ProjectArtifactState, ProjectArtifactStatuses } from "../types";
import { useI18n } from "../utils/i18n";

const artifactKeys: Array<keyof ProjectArtifactStatuses> = [
  "project",
  "canvas",
  "task",
  "context",
  "architecture",
  "sequences"
];

export function ArtifactStatusBar({
  scanFingerprint,
  statuses
}: {
  scanFingerprint: string;
  statuses?: ProjectArtifactStatuses;
}) {
  const { t } = useI18n();
  if (!statuses) return null;
  const abnormalKeys = artifactKeys.filter((key) => statuses[key] !== "current");
  if (abnormalKeys.length === 0) return null;

  return (
    <details className="artifact-status-bar">
      <summary aria-label={t("artifact.statuses")}>
        {abnormalKeys.map((key) => (
          <span className={`artifact-status artifact-status-${statuses[key]}`} key={key}>
            {t(`artifact.${key}`)}: {t(stateKey(statuses[key]))}
          </span>
        ))}
      </summary>
      <div className="artifact-status-details">
        <div className="artifact-status-list">
          {artifactKeys.map((key) => (
            <span className={`artifact-status artifact-status-${statuses[key]}`} key={key}>
              {t(`artifact.${key}`)}: {t(stateKey(statuses[key]))}
            </span>
          ))}
        </div>
        <code>{t("artifact.scanFingerprint")}: {scanFingerprint || t("artifact.unavailable")}</code>
      </div>
    </details>
  );
}

function stateKey(state: ProjectArtifactState) {
  return `artifact.state.${state}`;
}

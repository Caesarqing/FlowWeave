import type {
  ArchitectureDiffCounts,
  ArchitectureReviewStatus,
  ProjectArtifactState,
  ProjectArtifactStatuses,
  SequenceDiffCounts,
  SequenceReviewStatus
} from "../types";
import { cn } from "../utils/classnames";
import { useI18n } from "../utils/i18n";

const artifactKeys: Array<keyof ProjectArtifactStatuses> = [
  "project",
  "canvas",
  "task",
  "context",
  "sequences"
];

export function ArtifactStatusBar({
  architectureReview,
  onRetryArchitectureReview,
  onRetrySequenceReview,
  scanFingerprint,
  sequenceReview,
  statuses
}: {
  architectureReview?: ArchitectureReviewStatus;
  onRetryArchitectureReview?: () => void;
  onRetrySequenceReview?: () => void;
  scanFingerprint: string;
  sequenceReview?: SequenceReviewStatus;
  statuses?: ProjectArtifactStatuses;
}) {
  const { t } = useI18n();
  if (!statuses) return null;
  const showSequenceReview = Boolean(sequenceReview) || statuses.sequences === "current";
  const abnormalKeys = artifactKeys.filter((key) => {
    if (key === "sequences" && showSequenceReview) return false;
    return statuses[key] !== "current";
  });
  const visibleReview = architectureReview ?? {
    state: statuses.architecture === "stale"
      ? "stale"
      : statuses.architecture === "missing"
        ? "missing"
        : "local"
  };
  const visibleSequenceReview = sequenceReview ?? {
    state: statuses.sequences === "stale"
      ? "stale"
      : statuses.sequences === "missing"
        ? "missing"
        : "local"
  };

  return (
    <details className="artifact-status-bar">
      <summary aria-label={t("artifact.statuses")}>
        <span
          className={cn("artifact-status", `artifact-status-${reviewClassName(visibleReview)}`)}
          title={reviewTitle(visibleReview)}
        >
          {t("artifact.architecture")}: {reviewLabel(visibleReview, t)}
        </span>
        {showSequenceReview ? (
          <span
            className={cn("artifact-status", `artifact-status-${reviewClassName(visibleSequenceReview)}`)}
            title={reviewTitle(visibleSequenceReview)}
          >
            {t("artifact.sequences")}: {reviewLabel(visibleSequenceReview, t)}
          </span>
        ) : null}
        {abnormalKeys.map((key) => (
          <span className={cn("artifact-status", `artifact-status-${statuses[key]}`)} key={key}>
            {t(`artifact.${key}`)}: {t(stateKey(statuses[key]))}
          </span>
        ))}
      </summary>
      <div className="artifact-status-details">
        <div className="artifact-status-list">
          {artifactKeys.map((key) => (
            <span className={cn("artifact-status", `artifact-status-${statuses[key]}`)} key={key}>
              {t(`artifact.${key}`)}: {t(stateKey(statuses[key]))}
            </span>
          ))}
        </div>
        <ArchitectureReviewDetails
          onRetry={onRetryArchitectureReview}
          review={visibleReview}
          t={t}
        />
        {showSequenceReview ? (
          <SequenceReviewDetails
            onRetry={onRetrySequenceReview}
            review={visibleSequenceReview}
            t={t}
          />
        ) : null}
        <code>{t("artifact.scanFingerprint")}: {scanFingerprint || t("artifact.unavailable")}</code>
      </div>
    </details>
  );
}

function SequenceReviewDetails({
  onRetry,
  review,
  t
}: {
  onRetry?: () => void;
  review: SequenceReviewStatus;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  return (
    <div className="artifact-review-details">
      {review.agentId ? <span>{t("artifact.review.agent")}: {review.agentId}</span> : null}
      {review.completedAt ? <span>{t("artifact.review.completedAt")}: {review.completedAt}</span> : null}
      {review.runId ? <span>{t("artifact.review.runId")}: {review.runId}</span> : null}
      {review.softTimedOutAt ? <span>{t("artifact.review.softTimedOutAt")}: {review.softTimedOutAt}</span> : null}
      {review.message ? <span>{review.message}</span> : null}
      {review.diff ? <span>{formatSequenceDiff(review.diff, t)}</span> : null}
      {review.error ? <span>{review.error.message}</span> : null}
      {review.state === "review-failed" && onRetry ? (
        <button type="button" onClick={onRetry}>{t("artifact.review.retry")}</button>
      ) : null}
    </div>
  );
}

function ArchitectureReviewDetails({
  onRetry,
  review,
  t
}: {
  onRetry?: () => void;
  review: ArchitectureReviewStatus;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  return (
    <div className="artifact-review-details">
      {review.agentId ? <span>{t("artifact.review.agent")}: {review.agentId}</span> : null}
      {review.completedAt ? <span>{t("artifact.review.completedAt")}: {review.completedAt}</span> : null}
      {review.runId ? <span>{t("artifact.review.runId")}: {review.runId}</span> : null}
      {review.softTimedOutAt ? <span>{t("artifact.review.softTimedOutAt")}: {review.softTimedOutAt}</span> : null}
      {review.message ? <span>{review.message}</span> : null}
      {review.diff ? <span>{formatDiff(review.diff, t)}</span> : null}
      {review.error ? <span>{review.error.message}</span> : null}
      {review.state === "review-failed" && onRetry ? (
        <button type="button" onClick={onRetry}>{t("artifact.review.retry")}</button>
      ) : null}
    </div>
  );
}

function formatDiff(
  diff: ArchitectureDiffCounts,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  const values = [
    t("artifact.review.diffAdded", { count: diff.modules.added + diff.relationships.added }),
    t("artifact.review.diffRemoved", { count: diff.modules.removed + diff.relationships.removed }),
    t("artifact.review.diffModified", { count: diff.modules.modified + diff.relationships.modified })
  ];
  return values.join(" · ");
}

function formatSequenceDiff(
  diff: SequenceDiffCounts,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  const values = [
    t("artifact.review.diffAdded", { count: diff.participants.added + diff.messages.added }),
    t("artifact.review.diffRemoved", { count: diff.participants.removed + diff.messages.removed }),
    t("artifact.review.diffModified", { count: diff.participants.modified + diff.messages.modified })
  ];
  return values.join(" · ");
}

function stateKey(state: ProjectArtifactState) {
  return `artifact.state.${state}`;
}

function reviewClassName(review: ArchitectureReviewStatus | SequenceReviewStatus): string {
  if (review.state === "reviewing" && review.softTimedOutAt) return "review-late";
  return review.state;
}

function reviewLabel(
  review: ArchitectureReviewStatus | SequenceReviewStatus,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  if (review.state === "reviewing" && review.softTimedOutAt) return t("artifact.review.late");
  return t(`artifact.review.${review.state}`);
}

function reviewTitle(review: ArchitectureReviewStatus | SequenceReviewStatus): string | undefined {
  if (review.message) return review.message;
  if (review.state === "reviewing" && review.runId) return review.runId;
  return undefined;
}

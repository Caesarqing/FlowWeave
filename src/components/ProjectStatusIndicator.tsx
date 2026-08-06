import {
  CircleCheck,
  CircleDashed,
  CircleX,
  LoaderCircle,
  TriangleAlert
} from "lucide-react";
import { useId } from "react";
import type {
  ArchitectureReviewStatus,
  ProjectArtifactState,
  ProjectArtifactStatuses,
  SequenceReviewStatus
} from "../types";
import { useI18n } from "../utils/i18n";

export type ProjectStatusKind = "ready" | "pending" | "checking" | "stale" | "failed";

export type ProjectStatusAction = "refresh-project" | "update-architecture" | "update-sequences";

export type ProjectStatusItem = {
  key: "project" | "architecture" | "sequences";
  kind: ProjectStatusKind;
  source?: "local" | "reviewed";
  action?: ProjectStatusAction;
  error?: string;
};

export type ProjectStatusViewModel = {
  kind: ProjectStatusKind;
  items: ProjectStatusItem[];
};

export type ProjectStatusInput = {
  isProjectLoading: boolean;
  statuses?: ProjectArtifactStatuses;
  architectureReview: ArchitectureReviewStatus;
  sequenceReview: SequenceReviewStatus;
};

export type ActiveProjectStatus = ProjectStatusInput & {
  onRefreshProject: () => void;
  onUpdateArchitecture: () => void;
  onUpdateSequences: () => void;
};

const statusPriority: Record<ProjectStatusKind, number> = {
  ready: 0,
  pending: 1,
  stale: 2,
  checking: 3,
  failed: 4
};

export function buildProjectStatusViewModel(input: ProjectStatusInput): ProjectStatusViewModel {
  if (!input.statuses) {
    return {
      kind: "checking",
      items: [{ key: "project", kind: "checking" }]
    };
  }

  const projectKind = resolveProjectKind(input.statuses, input.isProjectLoading);
  const architecture = reviewedArtifactItem(
    "architecture",
    input.statuses.architecture,
    input.architectureReview,
    "update-architecture"
  );
  const sequences = reviewedArtifactItem(
    "sequences",
    input.statuses.sequences,
    input.sequenceReview,
    "update-sequences"
  );
  const project: ProjectStatusItem = {
    key: "project",
    kind: projectKind,
    action: actionable(projectKind) ? "refresh-project" : undefined
  };
  const items = [project, architecture, sequences];
  const kind = items.reduce<ProjectStatusKind>(
    (current, item) => statusPriority[item.kind] > statusPriority[current] ? item.kind : current,
    "ready"
  );

  return {
    kind,
    items: kind === "ready" ? [] : items.filter((item) => item.kind !== "ready")
  };
}

export function ProjectStatusIndicator({
  architectureReview,
  isProjectLoading,
  onRefreshProject,
  onUpdateArchitecture,
  onUpdateSequences,
  sequenceReview,
  statuses
}: ActiveProjectStatus) {
  const { t } = useI18n();
  const popoverId = useId();
  const model = buildProjectStatusViewModel({
    architectureReview,
    isProjectLoading,
    sequenceReview,
    statuses
  });
  const statusLabel = t(`projectStatus.${model.kind}`);
  const actionCallbacks: Record<ProjectStatusAction, () => void> = {
    "refresh-project": onRefreshProject,
    "update-architecture": onUpdateArchitecture,
    "update-sequences": onUpdateSequences
  };

  return (
    <div className={`project-status-indicator project-status-${model.kind}`}>
      <button
        aria-label={t("projectStatus.aria", { status: statusLabel })}
        className="project-status-trigger"
        popoverTarget={popoverId}
        title={statusLabel}
        type="button"
      >
        <StatusIcon kind={model.kind} />
        <span aria-live="polite" className="project-status-label">{statusLabel}</span>
      </button>
      <div
        aria-label={t("projectStatus.details")}
        className="project-status-popover"
        id={popoverId}
        popover="auto"
      >
        {model.items.length === 0 ? (
          <p className="project-status-healthy">
            <CircleCheck aria-hidden="true" size={15} />
            {t("projectStatus.healthy")}
          </p>
        ) : model.items.map((item) => (
          <div className="project-status-item" key={item.key}>
            <div>
              <strong>{t(`artifact.${item.key}`)}</strong>
              <span>
                {t(`projectStatus.${item.kind}`)}
                {item.source ? ` · ${t(`projectStatus.source.${item.source}`)}` : ""}
              </span>
              {item.error ? <small>{item.error}</small> : null}
            </div>
            {item.action ? (
              <button type="button" onClick={actionCallbacks[item.action]}>
                {t(actionLabelKey(item))}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function resolveProjectKind(statuses: ProjectArtifactStatuses, isProjectLoading: boolean): ProjectStatusKind {
  const requiredStates = [statuses.project, statuses.canvas, statuses.task, statuses.context];
  if (requiredStates.includes("failed")) return "failed";
  if (isProjectLoading) return "checking";
  if (requiredStates.includes("stale")) return "stale";
  if (requiredStates.includes("missing")) return "pending";
  return "ready";
}

function reviewedArtifactItem(
  key: "architecture" | "sequences",
  artifactState: ProjectArtifactState,
  review: ArchitectureReviewStatus | SequenceReviewStatus,
  action: ProjectStatusAction
): ProjectStatusItem {
  const kind = reviewedArtifactKind(artifactState, review);
  return {
    key,
    kind,
    source: kind === "stale" ? reviewSource(review) : undefined,
    action: actionable(kind) ? action : undefined,
    error: review.state === "review-failed" ? review.error?.message : undefined
  };
}

function reviewedArtifactKind(
  artifactState: ProjectArtifactState,
  review: ArchitectureReviewStatus | SequenceReviewStatus
): ProjectStatusKind {
  if (artifactState === "failed" || review.state === "review-failed") return "failed";
  if (review.state === "reviewing") return "checking";
  if (artifactState === "stale" || review.state === "stale") return "stale";
  if (artifactState === "missing" || review.state === "missing") return "pending";
  return "ready";
}

function reviewSource(
  review: ArchitectureReviewStatus | SequenceReviewStatus
): ProjectStatusItem["source"] {
  if (review.state === "local") return "local";
  if (review.state === "reviewed") return "reviewed";
  return undefined;
}

function actionable(kind: ProjectStatusKind): boolean {
  return kind === "pending" || kind === "stale" || kind === "failed";
}

function actionLabelKey(item: ProjectStatusItem): string {
  if (item.action === "refresh-project") return "projectStatus.action.rescan";
  if (item.kind === "pending") return "projectStatus.action.generate";
  if (item.kind === "stale") return "projectStatus.action.update";
  return "projectStatus.action.retry";
}

function StatusIcon({ kind }: { kind: ProjectStatusKind }) {
  if (kind === "ready") return <CircleCheck aria-hidden="true" size={13} />;
  if (kind === "pending") return <CircleDashed aria-hidden="true" size={13} />;
  if (kind === "checking") return <LoaderCircle aria-hidden="true" className="project-status-spinner" size={13} />;
  if (kind === "stale") return <TriangleAlert aria-hidden="true" size={13} />;
  return <CircleX aria-hidden="true" size={13} />;
}

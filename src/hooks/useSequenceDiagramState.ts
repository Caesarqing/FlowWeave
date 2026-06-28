import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ProjectFileNode,
  RuntimeAgentId,
  SequenceDiagram,
  SequenceDiagramBundle,
  SequenceDiagramGenerationResult,
  SequenceMessage,
  SequenceParticipant,
  ProjectArtifactState,
  SequenceReviewEvent,
  SequenceReviewStatus
} from "../types";
import { useI18n } from "../utils/i18n";
import { useProjectStore } from "../stores/project.store";
import { usePreferencesStore } from "../stores/preferences.store";

export type SequenceDiagramState = {
  bundle?: SequenceDiagramBundle;
  diagram?: SequenceDiagram;
  fileCount: number;
  instruction: string;
  guidanceOperation: "save" | "send" | "";
  hasPendingInstruction: boolean;
  review: SequenceReviewStatus;
  isBusy: boolean;
  selectedMessage?: SequenceMessage;
  selectedMessageId: string;
  selectedParticipant?: SequenceParticipant;
  selectedParticipantId: string;
  status: string;
  cancelOperation: () => Promise<void>;
  generateDiagrams: (agentId?: RuntimeAgentId) => Promise<void>;
  reviseDiagram: () => Promise<void>;
  saveInstruction: () => Promise<void>;
  selectMessage: (messageId: string) => void;
  selectParticipant: (participantId: string) => void;
  setInstruction: (instruction: string) => void;
  setStatus: (status: string) => void;
};

export function useSequenceDiagramState({
  files,
  projectId,
  projectPath,
  selectedAgentId,
  hasPendingInstruction,
  onModificationAcknowledged
}: {
  files: ProjectFileNode[];
  projectId: string;
  projectPath: string;
  selectedAgentId: RuntimeAgentId;
  hasPendingInstruction: boolean;
  onModificationAcknowledged: () => void | Promise<void>;
}): SequenceDiagramState {
  const { t } = useI18n();
  const setArtifactStatuses = useProjectStore((state) => state.setArtifactStatuses);
  const scanFingerprint = useProjectStore((state) => state.scanFingerprint);
  const sequenceReview = useProjectStore((state) => state.sequenceReview);
  const setSequenceReview = useProjectStore((state) => state.setSequenceReview);
  const planTimeoutMinutes = usePreferencesStore((state) => state.planTimeoutMinutes);
  const [bundle, setBundle] = useState<SequenceDiagramBundle | undefined>();
  const [selectedMessageId, setSelectedMessageId] = useState("");
  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [guidanceOperation, setGuidanceOperation] = useState<"save" | "send" | "">("");
  const [status, setStatus] = useState(() => t("sequence.openProject"));
  const [isBusy, setIsBusy] = useState(false);
  const activeOperationId = useRef<string | null>(null);
  const sequenceReviewRef = useRef(sequenceReview);
  const fileCount = useMemo(() => countFiles(files), [files]);
  const diagram = bundle?.architectural;
  const selectedMessage = diagram?.messages.find((message) => message.id === selectedMessageId);
  const selectedParticipant = diagram?.participants.find((participant) => participant.id === selectedParticipantId);

  useEffect(() => {
    sequenceReviewRef.current = sequenceReview;
    if (sequenceReview.state === "reviewing") {
      setStatus(sequenceReview.message ?? t("sequence.reviewing", { agent: sequenceReview.agentId ?? "" }));
    } else if (sequenceReview.state === "review-failed") {
      setStatus(t("sequence.reviewFailed", {
        error: sequenceReview.error?.message ?? t("artifact.unavailable")
      }));
    }
  }, [sequenceReview, t]);

  useEffect(() => {
    if (!window.flowweave) return undefined;
    return window.flowweave.onOperationProgress((operation) => {
      if (operation.kind !== "sequence-analysis") return;
      const isTerminal =
        operation.stage === "completed" ||
        operation.stage === "failed" ||
        operation.stage === "canceled";
      activeOperationId.current = isTerminal ? null : operation.operationId;
      if (operation.stage === "canceled") {
        setStatus(t("sequence.canceled"));
        return;
      }
      if (isTerminal) return;
      setStatus(t("operation.progress", {
        stage: t(`operation.stage.${operation.stage}`),
        completed: operation.completed,
        total: operation.total
      }));
    });
  }, [t]);

  useEffect(() => {
    if (!window.flowweave) return undefined;
    return window.flowweave.onSequenceReview((event) => {
      if (!shouldApplySequenceReviewEvent(
        event,
        projectId,
        scanFingerprint,
        sequenceReviewRef.current
      )) return;
      sequenceReviewRef.current = event.status;
      setSequenceReview(event.status);
      if (event.status.state === "reviewed" && event.bundle) {
        setBundle(event.bundle);
        setSelectedMessageId(event.bundle.architectural.messages[0]?.id ?? "");
        setSelectedParticipantId("");
        setArtifactStatuses((current) => current ? { ...current, sequences: "current" } : current);
        setStatus(t("sequence.reviewed", { agent: event.status.agentId ?? "" }));
      } else if (event.status.state === "review-failed") {
        setStatus(t("sequence.reviewFailed", {
          error: event.status.error?.message ?? t("artifact.unavailable")
        }));
      } else if (event.status.state === "reviewing") {
        setStatus(event.status.message ?? t("sequence.reviewing", { agent: event.status.agentId ?? "" }));
      }
    });
  }, [projectId, scanFingerprint, setArtifactStatuses, setSequenceReview, t]);

  useEffect(() => {
    let isMounted = true;
    setSelectedMessageId("");
    setSelectedParticipantId("");
    setBundle(undefined);
    if (!projectId || !window.flowweave) {
      setStatus(projectPath ? t("sequence.needDesktop") : t("sequence.openProject"));
      return;
    }
    void window.flowweave.readSequenceDiagrams(projectId).then((nextBundle) => {
      if (!isMounted) return;
      setBundle(nextBundle);
      setStatus(nextBundle ? t("sequence.loaded", { kind: t("structure.architectural") }) : t("sequence.noneYet"));
    });
    return () => {
      isMounted = false;
    };
  }, [projectId, projectPath, t]);

  useEffect(() => {
    if (!diagram) return;
    setSelectedMessageId(diagram.messages[0]?.id ?? "");
    setSelectedParticipantId(diagram.messages[0] ? "" : diagram.participants[0]?.id ?? "");
  }, [bundle?.generatedAt]);

  async function generateDiagrams(agentId?: import("../types").RuntimeAgentId) {
    if (!window.flowweave || !projectId) {
      setStatus(t("docs.needDesktop"));
      return;
    }
    const runAgentId = agentId ?? selectedAgentId;
    setIsBusy(true);
    setStatus(t("sequence.generatingWith", { agent: runAgentId }));
    try {
      const result = await window.flowweave.generateSequenceDiagrams(projectId, runAgentId, planTimeoutMinutes * 60_000);
      if (result.outcome === "failed") {
        throw new Error(`${result.error.agentId} run ${result.error.runId ?? "unknown"}: ${result.error.message}`);
      }
      const nextBundle = result.bundle;
      setBundle(nextBundle);
      if (result.outcome === "generated") {
        sequenceReviewRef.current = result.review;
        setSequenceReview(result.review);
      }
      setArtifactStatuses((current) => current ? { ...current, sequences: sequenceArtifactStateFromGenerationResult(result) } : current);
      setSelectedMessageId(nextBundle.architectural.messages[0]?.id ?? "");
      setSelectedParticipantId("");
      setStatus(generationStatusMessage(result, t));
    } catch (error) {
      if (!isCancellationError(error)) {
        setArtifactStatuses((current) => current ? { ...current, sequences: "failed" } : current);
      }
      setStatus(isCancellationError(error)
        ? t("sequence.canceled")
        : t("sequence.generationFailed", { error: formatErrorMessage(error) }));
    } finally {
      setIsBusy(false);
    }
  }

  async function reviseDiagram() {
    if (!window.flowweave || !projectId) {
      setStatus(t("docs.needDesktop"));
      return;
    }
    if (!instruction.trim()) {
      setStatus(t("sequence.enterRevision"));
      return;
    }
    setGuidanceOperation("send");
    setIsBusy(true);
    setStatus(t("sequence.revising", { kind: t("structure.architectural") }));
    try {
      const sent = await persistInstruction();
      const nextBundle = await window.flowweave.reviseSequenceDiagram(projectId, selectedAgentId, instruction.trim(), planTimeoutMinutes * 60_000);
      await window.flowweave.acknowledgeModificationChanges(projectId, sent.snapshot, { kind: "sequence" });
      await window.flowweave.saveModificationDocs(projectId, instruction.trim());
      setBundle(nextBundle);
      await onModificationAcknowledged();
      setSelectedMessageId(nextBundle.architectural.messages[0]?.id ?? "");
      setSelectedParticipantId("");
      setStatus(t("sequence.revised"));
    } catch (error) {
      setStatus(isCancellationError(error)
        ? t("sequence.canceled")
        : t("sequence.revisionFailed", { error: formatErrorMessage(error) }));
    } finally {
      setIsBusy(false);
      setGuidanceOperation("");
    }
  }

  async function saveInstruction() {
    if (!window.flowweave || !projectId) {
      setStatus(t("docs.needDesktop"));
      return;
    }
    if (!instruction.trim()) {
      setStatus(t("sequence.enterRevision"));
      return;
    }
    setGuidanceOperation("save");
    try {
      await persistInstruction();
    } finally {
      setGuidanceOperation("");
    }
  }

  async function persistInstruction(): Promise<import("../types").ModificationDeltaResult> {
    if (!window.flowweave || !projectId) {
      throw new Error(t("docs.needDesktop"));
    }
    try {
      const paths = await window.flowweave.saveModificationDocs(projectId, instruction.trim());
      setStatus(t("sequence.instructionSaved", { path: paths.guidancePath }));
      const result = await window.flowweave.readModificationDelta(projectId, instruction.trim());
      return result;
    } catch (error) {
      setStatus(t("sequence.instructionSaveFailed", { error: formatErrorMessage(error) }));
      throw error;
    }
  }

  function selectMessage(messageId: string) {
    setSelectedMessageId(messageId);
    setSelectedParticipantId("");
  }

  function selectParticipant(participantId: string) {
    setSelectedParticipantId(participantId);
    setSelectedMessageId("");
  }

  async function cancelOperation() {
    const operationId = activeOperationId.current;
    if (!window.flowweave || !operationId) return;
    await window.flowweave.cancelOperation(operationId);
  }

  return {
    bundle,
    cancelOperation,
    diagram,
    fileCount,
    generateDiagrams,
    guidanceOperation,
    hasPendingInstruction,
    instruction,
    isBusy,
    review: sequenceReview,
    reviseDiagram,
    saveInstruction,
    selectedMessage,
    selectedMessageId,
    selectedParticipant,
    selectedParticipantId,
    selectMessage,
    selectParticipant,
    setInstruction,
    setStatus,
    status
  };
}

export function shouldApplySequenceReviewEvent(
  event: SequenceReviewEvent,
  projectId: string,
  scanFingerprint: string,
  current: SequenceReviewStatus
): boolean {
  if (event.projectId !== projectId || event.scanFingerprint !== scanFingerprint) return false;
  if (event.status.state === "reviewing") return true;
  return !current.reviewId || current.reviewId === event.reviewId;
}

function countFiles(nodes: ProjectFileNode[]): number {
  return nodes.reduce((count, node) => count + (node.type === "file" ? 1 : 0) + countFiles(node.children ?? []), 0);
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isCancellationError(error: unknown) {
  return /cancel(?:ed|led)/i.test(formatErrorMessage(error));
}

export function sequenceArtifactStateFromGenerationResult(result: SequenceDiagramGenerationResult): ProjectArtifactState {
  if (result.outcome === "failed") return "failed";
  return result.bundle ? "current" : "failed";
}

function generationStatusMessage(result: SequenceDiagramGenerationResult, t: (key: string, params?: Record<string, string | number>) => string) {
  if (result.outcome === "failed") {
    return t("sequence.generationFailed", { error: result.error.message });
  }
  const counts = t("sequence.messageCounts", {
    architectural: result.bundle.architectural.messages.length
  });
  if (result.outcome === "cached") {
    return t("sequence.cached", { warning: ` ${result.error.message}` });
  }
  if (result.warning) {
    return t("sequence.localWithAgentWarning", { counts, warning: ` ${result.warning.message}` });
  }
  return t("sequence.generated", { counts });
}

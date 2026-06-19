import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ProjectFileNode,
  RuntimeAgentId,
  SequenceDiagram,
  SequenceDiagramBundle,
  SequenceDiagramGenerationResult,
  SequenceMessage,
  SequenceParticipant,
  ProjectArtifactState
} from "../types";
import { useI18n } from "../utils/i18n";
import { useProjectStore } from "../stores/project.store";
import { usePreferencesStore } from "../stores/preferences.store";

export type SequenceDiagramState = {
  bundle?: SequenceDiagramBundle;
  diagram?: SequenceDiagram;
  fileCount: number;
  instruction: string;
  isBusy: boolean;
  selectedMessage?: SequenceMessage;
  selectedMessageId: string;
  selectedParticipant?: SequenceParticipant;
  selectedParticipantId: string;
  status: string;
  cancelOperation: () => Promise<void>;
  generateDiagrams: () => Promise<void>;
  reviseDiagram: () => Promise<void>;
  selectMessage: (messageId: string) => void;
  selectParticipant: (participantId: string) => void;
  setInstruction: (instruction: string) => void;
  setStatus: (status: string) => void;
};

export function useSequenceDiagramState({
  files,
  projectId,
  projectPath,
  selectedAgentId
}: {
  files: ProjectFileNode[];
  projectId: string;
  projectPath: string;
  selectedAgentId: RuntimeAgentId;
}): SequenceDiagramState {
  const { t } = useI18n();
  const setArtifactStatuses = useProjectStore((state) => state.setArtifactStatuses);
  const planTimeoutMinutes = usePreferencesStore((state) => state.planTimeoutMinutes);
  const [bundle, setBundle] = useState<SequenceDiagramBundle | undefined>();
  const [selectedMessageId, setSelectedMessageId] = useState("");
  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState(() => t("sequence.openProject"));
  const [isBusy, setIsBusy] = useState(false);
  const activeOperationId = useRef<string | null>(null);
  const fileCount = useMemo(() => countFiles(files), [files]);
  const diagram = bundle?.architectural;
  const selectedMessage = diagram?.messages.find((message) => message.id === selectedMessageId);
  const selectedParticipant = diagram?.participants.find((participant) => participant.id === selectedParticipantId);

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

  async function generateDiagrams() {
    if (!window.flowweave || !projectId) {
      setStatus(t("docs.needDesktop"));
      return;
    }
    setIsBusy(true);
    setStatus(t("sequence.generatingWith", { agent: selectedAgentId }));
    try {
      const result = await window.flowweave.generateSequenceDiagrams(projectId, selectedAgentId, planTimeoutMinutes * 60_000);
      if (result.outcome === "failed") {
        throw new Error(`${result.error.agentId} run ${result.error.runId ?? "unknown"}: ${result.error.message}`);
      }
      const nextBundle = result.bundle;
      setBundle(nextBundle);
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
    setIsBusy(true);
    setStatus(t("sequence.revising", { kind: t("structure.architectural") }));
    try {
      const nextBundle = await window.flowweave.reviseSequenceDiagram(projectId, selectedAgentId, instruction.trim(), planTimeoutMinutes * 60_000);
      setBundle(nextBundle);
      setInstruction("");
      setSelectedMessageId(nextBundle.architectural.messages[0]?.id ?? "");
      setSelectedParticipantId("");
      setStatus(t("sequence.revised"));
    } catch (error) {
      setStatus(isCancellationError(error)
        ? t("sequence.canceled")
        : t("sequence.revisionFailed", { error: formatErrorMessage(error) }));
    } finally {
      setIsBusy(false);
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
    instruction,
    isBusy,
    reviseDiagram,
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
  if (result.outcome === "cached") return "failed";
  if (result.warning) return "failed";
  return result.bundle.source === "fallback" ? "failed" : "current";
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
    return t("sequence.fallback", { counts, warning: ` ${result.warning.message}` });
  }
  return t("sequence.generated", { counts });
}

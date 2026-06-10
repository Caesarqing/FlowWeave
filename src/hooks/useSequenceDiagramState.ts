import { useEffect, useMemo, useState } from "react";
import type {
  ProjectFileNode,
  RuntimeAgentId,
  SequenceDiagram,
  SequenceDiagramBundle,
  SequenceDiagramGenerationResult,
  SequenceDiagramKind,
  SequenceMessage,
  SequenceParticipant
} from "../types";
import { useI18n } from "../utils/i18n";
import { useWorkspaceStore } from "../stores/workspace.store";

const diagramLabelKeys: Record<SequenceDiagramKind, string> = {
  architectural: "structure.architectural",
  "detailed-design": "structure.detailedDesign"
};

export type SequenceDiagramState = {
  activeKind: SequenceDiagramKind;
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
  generateDiagrams: () => Promise<void>;
  reviseDiagram: () => Promise<void>;
  selectMessage: (messageId: string) => void;
  selectParticipant: (participantId: string) => void;
  setActiveKind: (kind: SequenceDiagramKind) => void;
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
  const setArtifactStatuses = useWorkspaceStore((state) => state.setArtifactStatuses);
  const [bundle, setBundle] = useState<SequenceDiagramBundle | undefined>();
  const [activeKind, setActiveKind] = useState<SequenceDiagramKind>("architectural");
  const [selectedMessageId, setSelectedMessageId] = useState("");
  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState(() => t("sequence.openProject"));
  const [isBusy, setIsBusy] = useState(false);
  const fileCount = useMemo(() => countFiles(files), [files]);
  const diagram = activeKind === "architectural" ? bundle?.architectural : bundle?.detailedDesign;
  const selectedMessage = diagram?.messages.find((message) => message.id === selectedMessageId);
  const selectedParticipant = diagram?.participants.find((participant) => participant.id === selectedParticipantId);

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
      setStatus(nextBundle ? t("sequence.loaded", { kind: t(diagramLabelKeys[activeKind]) }) : t("sequence.noneYet"));
    });
    return () => {
      isMounted = false;
    };
  }, [projectId, projectPath]);

  useEffect(() => {
    if (!diagram) return;
    setSelectedMessageId(diagram.messages[0]?.id ?? "");
    setSelectedParticipantId(diagram.messages[0] ? "" : diagram.participants[0]?.id ?? "");
  }, [activeKind, bundle?.generatedAt]);

  async function generateDiagrams() {
    if (!window.flowweave || !projectId) {
      setStatus(t("docs.needDesktop"));
      return;
    }
    setIsBusy(true);
    setStatus(t("sequence.generatingWith", { agent: selectedAgentId }));
    try {
      const result = await window.flowweave.generateSequenceDiagrams(projectId, selectedAgentId);
      if (result.outcome === "failed") {
        throw new Error(`${result.error.agentId} run ${result.error.runId ?? "unknown"}: ${result.error.message}`);
      }
      const nextBundle = result.bundle;
      setBundle(nextBundle);
      if (result.outcome === "generated") {
        setArtifactStatuses((current) => current ? { ...current, sequences: "current" } : current);
      }
      setSelectedMessageId(selectDiagram(nextBundle, activeKind).messages[0]?.id ?? "");
      setSelectedParticipantId("");
      setStatus(generationStatusMessage(result, t));
    } catch (error) {
      setStatus(t("sequence.generationFailed", { error: formatErrorMessage(error) }));
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
    setStatus(t("sequence.revising", { kind: t(diagramLabelKeys[activeKind]) }));
    try {
      const nextBundle = await window.flowweave.reviseSequenceDiagram(projectId, selectedAgentId, activeKind, instruction.trim());
      setBundle(nextBundle);
      setInstruction("");
      setSelectedMessageId(selectDiagram(nextBundle, activeKind).messages[0]?.id ?? "");
      setSelectedParticipantId("");
      setStatus(t("sequence.revised"));
    } catch (error) {
      setStatus(t("sequence.revisionFailed", { error: formatErrorMessage(error) }));
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

  return {
    activeKind,
    bundle,
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
    setActiveKind,
    setInstruction,
    setStatus,
    status
  };
}

function selectDiagram(bundle: SequenceDiagramBundle, kind: SequenceDiagramKind) {
  return kind === "architectural" ? bundle.architectural : bundle.detailedDesign;
}

function countFiles(nodes: ProjectFileNode[]): number {
  return nodes.reduce((count, node) => count + (node.type === "file" ? 1 : 0) + countFiles(node.children ?? []), 0);
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function generationStatusMessage(result: SequenceDiagramGenerationResult, t: (key: string, params?: Record<string, string | number>) => string) {
  if (result.outcome === "failed") {
    return t("sequence.generationFailed", { error: result.error.message });
  }
  const counts = t("sequence.messageCounts", {
    architectural: result.bundle.architectural.messages.length,
    detailed: result.bundle.detailedDesign.messages.length
  });
  if (result.outcome === "cached") {
    return t("sequence.cached", { warning: ` ${result.error.message}` });
  }
  return t("sequence.generated", { counts });
}

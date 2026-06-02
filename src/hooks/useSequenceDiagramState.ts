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

const diagramLabels: Record<SequenceDiagramKind, string> = {
  architectural: "Architectural",
  "detailed-design": "Detailed Design"
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
  projectPath,
  selectedAgentId
}: {
  files: ProjectFileNode[];
  projectPath: string;
  selectedAgentId: RuntimeAgentId;
}): SequenceDiagramState {
  const { t } = useI18n();
  const [bundle, setBundle] = useState<SequenceDiagramBundle | undefined>();
  const [activeKind, setActiveKind] = useState<SequenceDiagramKind>("architectural");
  const [selectedMessageId, setSelectedMessageId] = useState("");
  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState("Open a project to generate a Sequence Diagram.");
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
    if (!projectPath || !window.flowweave) {
      setStatus(projectPath ? "Use the Electron desktop app to read sequence diagram artifacts." : "Open a project first.");
      return;
    }
    void window.flowweave.readSequenceDiagrams(projectPath).then((nextBundle) => {
      if (!isMounted) return;
      setBundle(nextBundle);
      setStatus(nextBundle ? `Loaded ${diagramLabels[activeKind]} sequence diagram.` : "No sequence diagram artifact yet. Click generate.");
    });
    return () => {
      isMounted = false;
    };
  }, [projectPath]);

  useEffect(() => {
    if (!diagram) return;
    setSelectedMessageId(diagram.messages[0]?.id ?? "");
    setSelectedParticipantId(diagram.messages[0] ? "" : diagram.participants[0]?.id ?? "");
  }, [activeKind, bundle?.generatedAt]);

  async function generateDiagrams() {
    if (!window.flowweave || !projectPath) {
      setStatus(t("docs.needDesktop"));
      return;
    }
    setIsBusy(true);
    setStatus(`Generating sequence diagrams with ${selectedAgentId}...`);
    try {
      const result = await window.flowweave.generateSequenceDiagrams(projectPath, selectedAgentId);
      const nextBundle = result.bundle;
      setBundle(nextBundle);
      setSelectedMessageId(selectDiagram(nextBundle, activeKind).messages[0]?.id ?? "");
      setSelectedParticipantId("");
      setStatus(generationStatusMessage(result));
    } catch (error) {
      setStatus(`Generation failed: ${formatErrorMessage(error)}`);
    } finally {
      setIsBusy(false);
    }
  }

  async function reviseDiagram() {
    if (!window.flowweave || !projectPath) {
      setStatus(t("docs.needDesktop"));
      return;
    }
    if (!instruction.trim()) {
      setStatus("Enter a sequence diagram revision request.");
      return;
    }
    setIsBusy(true);
    setStatus(`Revising ${diagramLabels[activeKind]} sequence diagram...`);
    try {
      const nextBundle = await window.flowweave.reviseSequenceDiagram(projectPath, selectedAgentId, activeKind, instruction.trim());
      setBundle(nextBundle);
      setInstruction("");
      setSelectedMessageId(selectDiagram(nextBundle, activeKind).messages[0]?.id ?? "");
      setSelectedParticipantId("");
      setStatus("Sequence diagram updated from the revision request.");
    } catch (error) {
      setStatus(`Revision failed; kept the previous diagram: ${formatErrorMessage(error)}`);
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

function generationStatusMessage(result: SequenceDiagramGenerationResult) {
  const counts = `${result.bundle.architectural.messages.length} 条架构消息，${result.bundle.detailedDesign.messages.length} 条详细设计消息`;
  if (result.outcome === "cached") {
    return `Agent 输出无效/失败，已保留上次序列图。${result.warning ? ` ${result.warning}` : ""}`;
  }
  if (result.outcome === "fallback") {
    return `Agent 输出无效/失败，已生成基础 fallback 序列图：${counts}。${result.warning ? ` ${result.warning}` : ""}`;
  }
  return `序列图生成完成：${counts}。`;
}

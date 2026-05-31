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
  const [bundle, setBundle] = useState<SequenceDiagramBundle | undefined>();
  const [activeKind, setActiveKind] = useState<SequenceDiagramKind>("architectural");
  const [selectedMessageId, setSelectedMessageId] = useState("");
  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState("打开项目后可生成 Sequence Diagram。");
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
      setStatus(projectPath ? "需要 Electron 桌面版读取序列图产物。" : "请先打开项目。");
      return;
    }
    void window.flowweave.readSequenceDiagrams(projectPath).then((nextBundle) => {
      if (!isMounted) return;
      setBundle(nextBundle);
      setStatus(nextBundle ? `已读取 ${diagramLabels[activeKind]} 序列图。` : "还没有序列图产物，请点击生成。");
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
      setStatus("请先在 Electron 桌面版打开项目。");
      return;
    }
    setIsBusy(true);
    setStatus(`正在使用 ${selectedAgentId} 生成序列图...`);
    try {
      const result = await window.flowweave.generateSequenceDiagrams(projectPath, selectedAgentId);
      const nextBundle = result.bundle;
      setBundle(nextBundle);
      setSelectedMessageId(selectDiagram(nextBundle, activeKind).messages[0]?.id ?? "");
      setSelectedParticipantId("");
      setStatus(generationStatusMessage(result));
    } catch (error) {
      setStatus(`生成失败：${formatErrorMessage(error)}`);
    } finally {
      setIsBusy(false);
    }
  }

  async function reviseDiagram() {
    if (!window.flowweave || !projectPath) {
      setStatus("请先在 Electron 桌面版打开项目。");
      return;
    }
    if (!instruction.trim()) {
      setStatus("请输入需要调整的序列图要求。");
      return;
    }
    setIsBusy(true);
    setStatus(`正在修订 ${diagramLabels[activeKind]} 序列图...`);
    try {
      const nextBundle = await window.flowweave.reviseSequenceDiagram(projectPath, selectedAgentId, activeKind, instruction.trim());
      setBundle(nextBundle);
      setInstruction("");
      setSelectedMessageId(selectDiagram(nextBundle, activeKind).messages[0]?.id ?? "");
      setSelectedParticipantId("");
      setStatus("序列图已按输入要求更新。");
    } catch (error) {
      setStatus(`修订失败，已保留旧图：${formatErrorMessage(error)}`);
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

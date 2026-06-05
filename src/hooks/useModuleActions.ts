import type { Dispatch, SetStateAction } from "react";
import type { GraphNode } from "../types";
import { useI18n } from "../utils/i18n";

export function useModuleActions({
  addModuleNode,
  dialogText,
  selectedNode,
  setDialogText,
  setSelectedNodeId,
  togglePath,
  updateModule
}: {
  addModuleNode: () => void;
  dialogText: string;
  selectedNode?: GraphNode;
  setDialogText: Dispatch<SetStateAction<string>>;
  setSelectedNodeId: (nodeId: string) => void;
  togglePath: (path: string) => void;
  updateModule: (nodeId: string, update: (node: GraphNode) => GraphNode) => void;
}) {
  const { t } = useI18n();
  function selectNode(nodeId: string) {
    setSelectedNodeId(nodeId);
    setDialogText("");
  }

  function addNode() {
    addModuleNode();
    setDialogText("");
  }

  function updateGuidance(value: string) {
    if (!selectedNode) return;
    updateModule(selectedNode.id, (node) => ({ ...node, guidanceDraft: value, status: "needs-review" }));
  }

  function applyDialog() {
    if (!selectedNode || !dialogText.trim()) return;
    updateModule(selectedNode.id, (node) => ({
      ...node,
      guidanceDraft: `${node.guidanceDraft}\n\n${t("module.dialog")}: ${dialogText.trim()}`,
      status: "needs-review"
    }));
    setDialogText("");
  }

  function writeDraft() {
    if (!selectedNode) return;
    updateModule(selectedNode.id, (node) => ({ ...node, status: "mapped" }));
  }

  return {
    addNode,
    applyDialog,
    selectNode,
    toggleProjectPath: togglePath,
    updateGuidance,
    writeDraft
  };
}

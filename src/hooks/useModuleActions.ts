import type { GraphNode } from "../types";

export function useModuleActions({
  addModuleNode,
  selectedNode,
  setSelectedNodeId,
  togglePath,
  updateModule
}: {
  addModuleNode: () => void;
  selectedNode?: GraphNode;
  setSelectedNodeId: (nodeId: string) => void;
  togglePath: (path: string) => void;
  updateModule: (nodeId: string, update: (node: GraphNode) => GraphNode) => void;
}) {
  function selectNode(nodeId: string) {
    setSelectedNodeId(nodeId);
  }

  function addNode() {
    addModuleNode();
  }

  function updateGuidance(value: string) {
    if (!selectedNode) return;
    updateModule(selectedNode.id, (node) => ({ ...node, guidanceDraft: value, status: "needs-review" }));
  }

  return {
    addNode,
    selectNode,
    toggleProjectPath: togglePath,
    updateGuidance
  };
}

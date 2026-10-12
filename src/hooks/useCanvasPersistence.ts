import { useEffect, useRef } from "react";
import type { CanvasLayoutState, CanvasSaveReceipt, CodeflowCanvas, GraphEdge, GraphNode } from "../types";
import { useAgentStore } from "../stores/agents.store";
import { useCanvasStore } from "../stores/canvas.store";
import { useProjectStore } from "../stores/project.store";
import { useI18n } from "../utils/i18n";
import { canvasSaveCoordinator } from "./canvas-save-coordinator";

type PersistenceState = {
  key: string;
  hydrationVersion: number;
  savedSignature: string;
  timeout?: number;
  inFlight?: Promise<CanvasSaveReceipt>;
};

export function canvasPersistenceSignature(canvas: CodeflowCanvas): string {
  return JSON.stringify([
    canvas.nodes, canvas.edges, canvas.layout, canvas.orphanedEdges, canvas.generation, canvas.groups,
    canvas.quality, canvas.orphanedNodeEdits, canvas.migrationPendingItems, canvas.hiddenGeneratedNodeIds,
    canvas.hiddenGeneratedEdgeIds
  ]);
}

export function useCanvasPersistence(
  projectId: string,
  projectPath: string,
  scanFingerprint: string,
  isProjectLoading: boolean,
  artifactState: import("../types").ProjectArtifactState | undefined,
  hydrationVersion: number,
  userRevision: number,
  modules: GraphNode[],
  relations: GraphEdge[],
  layout: CanvasLayoutState,
  orphanedEdges: GraphEdge[],
  metadata: Pick<CodeflowCanvas, "generation" | "generatedAt" | "groups" | "quality" | "orphanedNodeEdits" | "migrationPendingItems" | "hiddenGeneratedNodeIds" | "hiddenGeneratedEdgeIds">
) {
  const { t } = useI18n();
  const setLastRunStatus = useAgentStore((state) => state.setLastRunStatus);
  const state = useRef<PersistenceState>({ key: "", hydrationVersion: -1, savedSignature: "" });
  const key = `${projectId}:${metadata.generation?.requestId ?? ""}`;
  const canvas: CodeflowCanvas = {
    userRevision, id: "main", title: "Main Canvas", projectPath, scanFingerprint,
    artifactState: "current", layout, nodes: modules, edges: relations, orphanedEdges, ...metadata
  };
  const signature = canvasPersistenceSignature(canvas);

  async function persist(value: CodeflowCanvas, valueSignature: string): Promise<CanvasSaveReceipt> {
    const task = canvasSaveCoordinator.save(projectId, value);
    state.current.inFlight = task;
    try {
      const receipt = await task;
      if (state.current.key === `${projectId}:${receipt.generationId}`) state.current.savedSignature = valueSignature;
      if (useProjectStore.getState().projectId === projectId && useCanvasStore.getState().generation?.requestId === receipt.generationId) {
        useCanvasStore.getState().setUserRevision(receipt.userRevision);
      }
      return receipt;
    } finally {
      if (state.current.inFlight === task) state.current.inFlight = undefined;
    }
  }

  useEffect(() => {
    const current = state.current;
    if (current.key !== key || current.hydrationVersion !== hydrationVersion) {
      if (current.timeout !== undefined) window.clearTimeout(current.timeout);
      state.current = { key, hydrationVersion, savedSignature: signature };
      return;
    }
    if (!window.flowweave || !projectId || isProjectLoading || !scanFingerprint || artifactState !== "current" ||
      current.savedSignature === signature) return;
    if (current.timeout !== undefined) window.clearTimeout(current.timeout);
    current.timeout = window.setTimeout(() => {
      current.timeout = undefined;
      void persist(canvas, signature).catch((error) => {
        setLastRunStatus(t("agent.connectionRefreshFailed", { error: formatErrorMessage(error) }));
      });
    }, 500);
    return () => { if (current.timeout !== undefined) window.clearTimeout(current.timeout); };
  }, [projectId, scanFingerprint, isProjectLoading, artifactState, hydrationVersion, signature]);

  async function flushCurrentCanvas(buildCanvas: () => CodeflowCanvas): Promise<void> {
    if (!projectId || !scanFingerprint || isProjectLoading || artifactState !== "current") return;
    const current = state.current;
    if (current.timeout !== undefined) {
      window.clearTimeout(current.timeout);
      current.timeout = undefined;
    }
    if (current.inFlight) await current.inFlight;
    const value = { ...buildCanvas(), generatedAt: metadata.generatedAt };
    const valueSignature = canvasPersistenceSignature(value);
    if (current.key !== `${projectId}:${value.generation?.requestId ?? ""}`) {
      throw new Error(`Canvas save barrier generation changed: project ${projectId}`);
    }
    if (current.savedSignature !== valueSignature) await persist(value, valueSignature);
    await canvasSaveCoordinator.flush(projectId, value.generation?.requestId ?? "");
  }

  return { flushCurrentCanvas };
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

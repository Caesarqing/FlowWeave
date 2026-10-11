import type { AutoConnectionHandleLayout, CanvasLayoutMode, CanvasLayoutState } from "../types";
import { matchesOverviewIdentity, type OverviewFrontierInput } from "./graph-view-projection";
import type { CanvasLayoutResult } from "./canvas-layout";

export type CanvasLayoutRequestContext = {
  identity: OverviewFrontierInput["identity"];
  layoutMode: CanvasLayoutMode;
  activeMode: CanvasLayoutState["activeMode"];
  manualPositionRevision: string;
  topologyFingerprint: string;
};

export type CanvasLocalLayoutScope = {
  projectId: string;
  generationId: string;
  layoutMode: CanvasLayoutMode;
  activeMode: CanvasLayoutState["activeMode"];
};

export function canUseLocalCanvasLayout(request: CanvasLocalLayoutScope, current: CanvasLocalLayoutScope): boolean {
  return request.projectId === current.projectId &&
    request.generationId === current.generationId &&
    request.layoutMode === current.layoutMode &&
    request.activeMode === current.activeMode &&
    current.activeMode !== "manual";
}

export async function applyCanvasLayoutResult(
  result: Promise<CanvasLayoutResult>,
  request: CanvasLayoutRequestContext,
  readCurrentContext: () => CanvasLayoutRequestContext,
  onApplyAutoLayout: (
    mode: CanvasLayoutMode,
    positions: Record<string, { x: number; y: number }>,
    topologyFingerprint: string,
    handleLayout: AutoConnectionHandleLayout
  ) => void,
  signal: AbortSignal
): Promise<void> {
  const layout = await result;
  if (signal.aborted) return;
  const current = readCurrentContext();
  if (!matchesOverviewIdentity(request.identity, current.identity) ||
    request.topologyFingerprint !== current.topologyFingerprint ||
    request.manualPositionRevision !== current.manualPositionRevision ||
    request.activeMode !== current.activeMode) return;
  onApplyAutoLayout(
    request.layoutMode,
    Object.fromEntries(layout.nodes.map((node) => [node.id, node.position])),
    request.topologyFingerprint,
    layout.handleLayout
  );
}

import {
  Background,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  SmoothStepEdge,
  type Connection,
  type Edge,
  type EdgeProps,
  type EdgeChange,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
  type NodeChange
} from "@xyflow/react";
import { ArrowLeft, BrainCircuit, GitBranch, Search, LayoutGrid, LoaderCircle, RotateCcw } from "lucide-react";
import { Profiler, useEffect, useMemo, useRef, useState, version as reactVersion } from "react";
import { AgentNode } from "./nodes/AgentNode";
import { DiffNode } from "./nodes/DiffNode";
import { DocNode } from "./nodes/DocNode";
import { FileNode } from "./nodes/FileNode";
import { HologridScene } from "./HologridScene";
import { ModuleNode } from "./nodes/ModuleNode";
import { RequirementNode } from "./nodes/RequirementNode";
import { TaskNode } from "./nodes/TaskNode";
import { createFlowEdge, createFlowNode, decorateFlowGraph, expandedGroupsForGroup, expandedGroupsForNode, graphEdgeFromFlow, nodeDisplayGroups, projectCollapsedFlowGraph, traceDisplayNodeIds, type FlowWeaveNode } from "../utils/graph-converters";
import { useI18n } from "../utils/i18n";
import type { ArchitectureLayer, ArchitectureRelationDiagnostic, AutoConnectionHandleLayout, CanvasLayoutMode, CanvasLayoutState, CanvasMigrationReviewRequest, CodeflowCanvas, GraphEdge, GraphEdgeRelation, GraphViewMode, ProjectArtifactState, TechnologyStack } from "../types";
import {
  autoLayoutIsCurrent,
  handleLayoutIsCurrent,
  layoutExpandedCanvasNodes,
  layoutCanvasConnectionHandles,
  layoutCanvasNodes,
  canvasTopologyFingerprint,
  nodeGroupKey,
  type TraceDirection
} from "../utils/canvas-layout";
import { chooseInitialGraphView, matchesOverviewIdentity, nodeConnectionExplanation, projectGraphForView, selectOverviewFrontier } from "../utils/graph-view-projection";
import type { GraphProjectionDiagnostics } from "../utils/graph-view-projection";
import { filterCanvasNodes, type CanvasFilters } from "../utils/canvas-filters";
import { relationOptions, relationStyle } from "../utils/relation-styles";
import { downloadText } from "../utils/export-artifacts";
import { Button } from "./Button";
import { canvasMigrationPendingItemId } from "../utils/canvas-migration";
import { applyCanvasLayoutResult, canUseLocalCanvasLayout, type CanvasLocalLayoutScope } from "../utils/canvas-layout-request";
import { recordCanvasProfilerWindowCommit } from "../utils/react-profiler";

type StaticGraphMeasurementWindow = Window & {
  __flowweaveStaticGraphMeasurement?: { collectMetrics: boolean; detailClickStartedAtEpochMs?: number };
};

const reactProfilerEnabled = import.meta.env.DEV && import.meta.env.VITE_FLOWWEAVE_REACT_PROFILE === "1";

function ProfiledModuleNode(props: NodeProps<FlowWeaveNode>) {
  const componentId = props.type === "groupNode" ? "CanvasGroupNode" : "CanvasModuleNode";
  return (
    <Profiler id={componentId} onRender={recordCanvasProfilerWindowCommit}>
      <ModuleNode {...props} />
    </Profiler>
  );
}

function ProfiledSmoothStepEdge(props: EdgeProps<Edge>) {
  return (
    <Profiler id="CanvasSmoothStepEdge" onRender={recordCanvasProfilerWindowCommit}>
      <SmoothStepEdge {...props} />
    </Profiler>
  );
}

const canvasModuleNodeType = reactProfilerEnabled ? ProfiledModuleNode : ModuleNode;
const canvasEdgeTypes = reactProfilerEnabled ? { smoothstep: ProfiledSmoothStepEdge } : undefined;

const relationGroups: Array<{ id: string; relations: GraphEdgeRelation[] }> = [
  { id: "runtime", relations: ["calls", "process_invocation"] },
  { id: "data", relations: ["reads", "writes", "reads_writes"] },
  { id: "integration", relations: ["http_contract", "external_api"] },
  { id: "events", relations: ["publishes_event", "subscribes_event"] },
  { id: "structure", relations: ["depends_on"] },
  { id: "tests", relations: ["tests"] }
];

const nodeTypes = {
  moduleNode: canvasModuleNodeType,
  groupNode: canvasModuleNodeType,
  requirementNode: RequirementNode,
  taskNode: TaskNode,
  fileNode: FileNode,
  docNode: DocNode,
  agentNode: AgentNode,
  diffNode: DiffNode
};

export type ExecutionCoverageSummary = {
  percent: number;
  hasLimitedEvidence: boolean;
};

type PendingLocalLayout = {
  scope: CanvasLocalLayoutScope;
} & (
  | { kind: "expand"; previousNodeIds: Set<string>; anchors: FlowWeaveNode[]; fixedNodes: FlowWeaveNode[] }
  | { kind: "collapse"; previousNodeIds: Set<string> }
);

export function executionCoverageSummary(diagnostics: GraphProjectionDiagnostics): ExecutionCoverageSummary {
  const percent = diagnostics.executableModuleCount === 0
    ? 100
    : Math.round((diagnostics.connectedExecutableModuleCount / diagnostics.executableModuleCount) * 100);
  return {
    percent,
    hasLimitedEvidence: percent < 100 || diagnostics.unresolvedEventCount > 0 || diagnostics.hiddenDependencyEdgeCount > 0
  };
}

export function CanvasStalePreviewBanner({ generatedAt }: { generatedAt: string }) {
  const { locale, t } = useI18n();
  return (
    <div className="canvas-stale-banner" role="status" aria-readonly="true" data-preview-state="pending-verification">
      <span>{t("canvas.previousAnalysis")}</span>
      <span>{t("canvas.cachedGraphPendingVerification")}</span>
      <time dateTime={generatedAt}>{new Date(generatedAt).toLocaleString(locale)}</time>
    </div>
  );
}

type ControlledFlowCanvasProps = {
  readOnly: boolean;
  canvasLayout: CanvasLayoutState;
  hiddenGeneratedCount: number;
  projectId?: string;
  projectPath?: string;
  generationId?: string;
  userRevision?: number;
  preservedCounts?: CodeflowCanvas["preservedCounts"];
  edges: Edge[];
  nodes: FlowWeaveNode[];
  relationDiagnostics: ArchitectureRelationDiagnostic[];
  quality?: CodeflowCanvas["quality"];
  orphanedNodeEdits?: CodeflowCanvas["orphanedNodeEdits"];
  migrationPendingItems?: CodeflowCanvas["migrationPendingItems"];
  orphanedEdges?: GraphEdge[];
  onApplyAutoLayout: (
    mode: CanvasLayoutMode,
    positions: Record<string, { x: number; y: number }>,
    topologyFingerprint: string,
    handleLayout: AutoConnectionHandleLayout
  ) => void;
  onConnect: (connection: Connection) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onNodesChange: (changes: NodeChange<FlowWeaveNode>[]) => void;
  onPaneClick: () => void;
  onSelectEdge: (edge: GraphEdge) => void;
  onSelectNode: (nodeId: string) => void;
  onRestoreManualLayout: () => void;
  onRestoreGeneratedItems: () => Promise<void>;
  onResolveMigrationItem: (request: CanvasMigrationReviewRequest) => Promise<CodeflowCanvas>;
  onSetCollapsedGroups: (groups: string[]) => void;
  onSetViewMode: (mode: GraphViewMode) => void;
};

export function CanvasWorkspace({
  readOnly,
  hiddenGeneratedCount,
  projectId,
  projectPath,
  generationId,
  userRevision,
  preservedCounts,
  graphStatus,
  generatedAt,
  edges,
  isProjectLoading,
  nodes,
  relationDiagnostics,
  quality,
  orphanedNodeEdits,
  migrationPendingItems,
  orphanedEdges,
  onConnect,
  onApplyAutoLayout,
  onEdgesChange,
  onOpenProject,
  onNodesChange,
  onPaneClick,
  onSelectEdge,
  onSelectNode,
  onRestoreManualLayout,
  onRestoreGeneratedItems,
  onResolveMigrationItem,
  onSetCollapsedGroups,
  onSetViewMode,
  canvasLayout
}: {
  readOnly: boolean;
  canvasLayout: CanvasLayoutState;
  hiddenGeneratedCount: number;
  projectId?: string;
  projectPath?: string;
  generationId?: string;
  userRevision?: number;
  preservedCounts?: CodeflowCanvas["preservedCounts"];
  graphStatus?: ProjectArtifactState;
  generatedAt: string;
  edges: Edge[];
  isProjectLoading: boolean;
  nodes: FlowWeaveNode[];
  relationDiagnostics: ArchitectureRelationDiagnostic[];
  quality?: CodeflowCanvas["quality"];
  orphanedNodeEdits?: CodeflowCanvas["orphanedNodeEdits"];
  migrationPendingItems?: CodeflowCanvas["migrationPendingItems"];
  orphanedEdges?: GraphEdge[];
  onConnect: (connection: Connection) => void;
  onApplyAutoLayout: (
    mode: CanvasLayoutMode,
    positions: Record<string, { x: number; y: number }>,
    topologyFingerprint: string,
    handleLayout: AutoConnectionHandleLayout
  ) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onOpenProject: () => void;
  onNodesChange: (changes: NodeChange<FlowWeaveNode>[]) => void;
  onPaneClick: () => void;
  onSelectEdge: (edge: GraphEdge) => void;
  onSelectNode: (nodeId: string) => void;
  onRestoreManualLayout: () => void;
  onRestoreGeneratedItems: () => Promise<void>;
  onResolveMigrationItem: (request: CanvasMigrationReviewRequest) => Promise<CodeflowCanvas>;
  onSetCollapsedGroups: (groups: string[]) => void;
  onSetViewMode: (mode: GraphViewMode) => void;
}) {
  const { t } = useI18n();

  if (reactProfilerEnabled && typeof window !== "undefined" && !window.__flowweaveReactProfiler) {
    window.__flowweaveReactProfiler = { reactVersion, currentAction: "initial-render", samples: [] };
  }

  const canvas = (
    <main
      className="canvas-shell"
      data-generation-id={generationId}
      data-user-revision={userRevision}
    >
      <section className="graph-stage" aria-label={t("canvas.graphAria")}>
        <HologridScene />
        <ControlledFlowCanvas
          readOnly={readOnly}
          hiddenGeneratedCount={hiddenGeneratedCount}
          projectId={projectId}
          projectPath={projectPath}
          generationId={generationId}
          userRevision={userRevision}
          preservedCounts={preservedCounts}
          edges={edges}
          canvasLayout={canvasLayout}
          nodes={nodes}
          relationDiagnostics={relationDiagnostics}
          quality={quality}
          orphanedNodeEdits={orphanedNodeEdits}
          migrationPendingItems={migrationPendingItems}
          orphanedEdges={orphanedEdges}
          onConnect={onConnect}
          onApplyAutoLayout={onApplyAutoLayout}
          onEdgesChange={onEdgesChange}
          onNodesChange={onNodesChange}
          onPaneClick={onPaneClick}
          onSelectEdge={onSelectEdge}
          onSelectNode={onSelectNode}
          onRestoreManualLayout={onRestoreManualLayout}
          onRestoreGeneratedItems={onRestoreGeneratedItems}
          onResolveMigrationItem={onResolveMigrationItem}
          onSetCollapsedGroups={onSetCollapsedGroups}
          onSetViewMode={onSetViewMode}
        />
        {nodes.length > 0 && graphStatus === "stale" ? (
          <CanvasStalePreviewBanner generatedAt={generatedAt} />
        ) : null}
        {nodes.length === 0 ? (
          isProjectLoading ? (
            <div className="canvas-empty-state" role="status" aria-live="polite">
              <LoaderCircle className="spin" size={30} />
              <strong>{t("status.analyzingProject")}</strong>
              <span>{t("canvas.analyzingProjectBody")}</span>
            </div>
          ) : (
            <div className="canvas-empty-state">
              <BrainCircuit size={34} />
              <strong>{t("canvas.emptyTitle")}</strong>
              <span>{t("canvas.emptyBody")}</span>
              <Button size="default" variant="primary" type="button" onClick={onOpenProject}>
                {t("project.open")}
              </Button>
            </div>
          )
        ) : null}
      </section>
    </main>
  );
  return reactProfilerEnabled
    ? <Profiler id="CanvasWorkspace" onRender={recordCanvasProfilerWindowCommit}>{canvas}</Profiler>
    : canvas;
}

function ControlledFlowCanvas({
  readOnly,
  canvasLayout,
  hiddenGeneratedCount,
  projectId,
  projectPath,
  generationId,
  userRevision,
  preservedCounts,
  edges,
  nodes,
  relationDiagnostics,
  quality,
  orphanedNodeEdits,
  migrationPendingItems,
  orphanedEdges,
  onConnect,
  onApplyAutoLayout,
  onEdgesChange,
  onNodesChange,
  onPaneClick,
  onSelectEdge,
  onSelectNode,
  onRestoreManualLayout,
  onRestoreGeneratedItems,
  onResolveMigrationItem,
  onSetCollapsedGroups,
  onSetViewMode
}: ControlledFlowCanvasProps) {
  /*
   * FlowWeave persists Canvas state in Zustand so autosave and Agent export can use
   * the same graph. Keep the controlled React Flow boundary isolated here.
  */
  const { t } = useI18n();
  const [showPreservedData, setShowPreservedData] = useState(false);
  const [loadedFullCanvas, setLoadedFullCanvas] = useState<CodeflowCanvas>();
  const [preservedDataError, setPreservedDataError] = useState("");
  const [migrationActionError, setMigrationActionError] = useState("");
  const [resolvingMigrationItemId, setResolvingMigrationItemId] = useState("");
  const [migrationNodeTargets, setMigrationNodeTargets] = useState<Record<string, string>>({});
  const [migrationEdgeEndpoints, setMigrationEdgeEndpoints] = useState<Record<string, { source: string; target: string }>>({});
  const [qualityError, setQualityError] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [expandedGroupIds, setExpandedGroupIds] = useState<string[]>([]);
  const [localLayoutSpaceInsufficient, setLocalLayoutSpaceInsufficient] = useState(false);
  const [overviewViewport, setOverviewViewport] = useState({ width: 0, height: 0 });
  const [layoutViewport, setLayoutViewport] = useState({ width: 0, height: 0 });
  const [hasMeasuredViewport, setHasMeasuredViewport] = useState(false);
  const overviewViewportRef = useRef<HTMLDivElement | null>(null);
  const lastOverviewViewport = useRef({ width: 0, height: 0 });
  const viewRequestId = useRef(0);
  const overviewCollapseSnapshot = useRef<string[] | undefined>(undefined);
  const overviewFocusGroupNodeId = useRef<string | undefined>(undefined);
  const pendingGroupFocus = useRef<string[]>([]);
  const pendingLocalLayout = useRef<PendingLocalLayout | undefined>(undefined);
  const viewIdentity = useMemo(() => ({
    generationId: generationId ?? "unversioned",
    userRevision: userRevision ?? 0,
    viewRequestId: `${projectId ?? "project"}:${generationId ?? "unversioned"}:${userRevision ?? 0}:${viewRequestId.current}`
  }), [generationId, overviewViewport, projectId, userRevision]);
  const currentProject = useRef({ projectId, generationId });
  currentProject.current = { projectId, generationId };
  useEffect(() => {
    const element = overviewViewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextSize = { width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) };
      if (lastOverviewViewport.current.width === nextSize.width && lastOverviewViewport.current.height === nextSize.height) return;
      lastOverviewViewport.current = nextSize;
      viewRequestId.current += 1;
      setOverviewViewport(nextSize);
      setHasMeasuredViewport(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const timeout = window.setTimeout(() => setLayoutViewport(overviewViewport), 180);
    return () => window.clearTimeout(timeout);
  }, [overviewViewport]);
  useEffect(() => {
    setLoadedFullCanvas(undefined);
    setShowPreservedData(false);
    setPreservedDataError("");
    setMigrationActionError("");
    setResolvingMigrationItemId("");
    setMigrationNodeTargets({});
    setMigrationEdgeEndpoints({});
    setQualityError("");
    setExpandedGroupIds([]);
    overviewCollapseSnapshot.current = undefined;
    overviewFocusGroupNodeId.current = undefined;
    pendingGroupFocus.current = [];
    pendingLocalLayout.current = undefined;
  }, [projectId, generationId]);
  const inlinePreservedData = {
    schemaVersion: 1,
    migrationReviewActions: [],
    migrationPendingItems: migrationPendingItems ?? [],
    orphanedNodeEdits: orphanedNodeEdits ?? [],
    orphanedEdges: orphanedEdges ?? []
  } as const;
  const preservedData = loadedFullCanvas ? {
    schemaVersion: 1 as const,
    migrationReviewActions: loadedFullCanvas.migrationReviewActions ?? [],
    migrationPendingItems: loadedFullCanvas.migrationPendingItems ?? [],
    orphanedNodeEdits: loadedFullCanvas.orphanedNodeEdits ?? [],
    orphanedEdges: loadedFullCanvas.orphanedEdges ?? []
  } : inlinePreservedData;
  const detailedQuality = loadedFullCanvas?.quality ?? quality;
  const preservedDataCount = loadedFullCanvas
    ? (loadedFullCanvas.migrationPendingItems?.length ?? 0) + (loadedFullCanvas.orphanedNodeEdits?.length ?? 0) + (loadedFullCanvas.orphanedEdges?.length ?? 0)
    : preservedCounts
      ? preservedCounts.pending + preservedCounts.nodeEdits + preservedCounts.edges
      : inlinePreservedData.migrationPendingItems.length + inlinePreservedData.orphanedNodeEdits.length + inlinePreservedData.orphanedEdges.length;
  const currentOrphanedNodeEdits = loadedFullCanvas?.orphanedNodeEdits ?? orphanedNodeEdits ?? [];
  const currentOrphanedEdges = loadedFullCanvas?.orphanedEdges ?? orphanedEdges ?? [];
  const currentMigrationPendingItems = loadedFullCanvas?.migrationPendingItems ?? migrationPendingItems ?? [];
  const currentPreservedNodeEditCount = loadedFullCanvas
    ? currentOrphanedNodeEdits.length
    : preservedCounts?.nodeEdits ?? currentOrphanedNodeEdits.length;
  const migrationCandidates = (loadedFullCanvas?.nodes ?? nodes.map((node) => node.data))
    .filter((node) => node.kind === "module" && !node.resource && node.origin !== "manual")
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  const migrationEndpoints = (loadedFullCanvas?.nodes ?? nodes.map((node) => node.data))
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  async function getFullCanvas(): Promise<CodeflowCanvas> {
    if (loadedFullCanvas) return loadedFullCanvas;
    if (!projectId || !window.flowweave) throw new Error("Project data is unavailable for graph details.");
    const result = await window.flowweave.readCanvas(projectId);
    if (!result || currentProject.current.projectId !== projectId ||
      currentProject.current.generationId !== generationId || result.canvas.generation?.requestId !== generationId) {
      throw new Error("The project graph changed while loading details. Retry after analysis completes.");
    }
    setLoadedFullCanvas(result.canvas);
    return result.canvas;
  }
  async function getPreservedData() {
    if (loadedFullCanvas) return preservedData;
    const inlineCount = inlinePreservedData.migrationPendingItems.length + inlinePreservedData.orphanedNodeEdits.length + inlinePreservedData.orphanedEdges.length;
    if (inlineCount === preservedDataCount) return inlinePreservedData;
    const canvas = await getFullCanvas();
    return {
      schemaVersion: 1 as const,
      migrationReviewActions: canvas.migrationReviewActions ?? [],
      migrationPendingItems: canvas.migrationPendingItems ?? [],
      orphanedNodeEdits: canvas.orphanedNodeEdits ?? [],
      orphanedEdges: canvas.orphanedEdges ?? []
    };
  }
  async function runMigrationAction(
    kind: "node-edit" | "edge" | "migration-pending",
    itemId: string,
    action: CanvasMigrationReviewRequest["action"],
    targets: Pick<CanvasMigrationReviewRequest, "sourceNodeId" | "targetNodeId">
  ) {
    const targetGenerationId = loadedFullCanvas?.generation?.requestId ?? generationId;
    const targetRevision = loadedFullCanvas?.userRevision ?? userRevision;
    if (!targetGenerationId || targetRevision === undefined) {
      setMigrationActionError(t("canvas.migrationReviewIdentityMissing"));
      return;
    }
    setResolvingMigrationItemId(itemId);
    setMigrationActionError("");
    try {
      const next = await onResolveMigrationItem({
        generationId: targetGenerationId,
        userRevision: targetRevision,
        item: { kind, id: itemId },
        action,
        ...targets
      });
      setLoadedFullCanvas(next);
    } catch (error) {
      setMigrationActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setResolvingMigrationItemId("");
    }
  }
  const [additionalRelations, setAdditionalRelations] = useState<Array<GraphEdgeRelation | "manual">>([]);
  const [showInferredCalls, setShowInferredCalls] = useState(false);
  const [roleFilter, setRoleFilter] = useState<ArchitectureLayer | "all">("all");
  const [technologyFilter, setTechnologyFilter] = useState<TechnologyStack | "all">("all");
  const layoutMode: CanvasLayoutMode = canvasLayout.viewMode ?? chooseInitialGraphView(edges.map(graphEdgeFromFlow));
  useEffect(() => {
    const pending = pendingLocalLayout.current;
    if (pending && !canUseLocalCanvasLayout(pending.scope, {
      projectId: projectId ?? "project",
      generationId: generationId ?? "unversioned",
      layoutMode,
      activeMode: canvasLayout.activeMode
    })) pendingLocalLayout.current = undefined;
  }, [canvasLayout.activeMode, generationId, layoutMode, projectId]);
  const [traceDirection, setTraceDirection] = useState<TraceDirection | "off">("off");
  const [focusedNodeId, setFocusedNodeId] = useState("");
  const [isLayoutRunning, setIsLayoutRunning] = useState(false);
  const [layoutError, setLayoutError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedModuleGroups, setSelectedModuleGroups] = useState<string[]>([]);
  const [focusRequest, setFocusRequest] = useState<string[]>([]);
  const runtimeTags = useMemo(() => technologyFilter === "all" ? [] : [technologyFilter], [technologyFilter]);
  const classificationFilters = useMemo<CanvasFilters>(() => ({ role: roleFilter, runtimeTags, domain: "all" }), [roleFilter, runtimeTags]);
  const projectionViewIdentity = useMemo(() => ({
    ...viewIdentity,
    viewRequestId: `${viewIdentity.viewRequestId}:${layoutMode}:${roleFilter}:${technologyFilter}:${canvasLayout.collapsedGroups.slice().sort().join(",")}:${expandedGroupIds.slice().sort().join(",")}:${selectedModuleGroups.slice().sort().join(",")}:${additionalRelations.slice().sort().join(",")}:${showInferredCalls}`
  }), [additionalRelations, canvasLayout.collapsedGroups, expandedGroupIds, layoutMode, roleFilter, selectedModuleGroups, showInferredCalls, technologyFilter, viewIdentity]);
  const currentViewIdentity = useRef(projectionViewIdentity);
  currentViewIdentity.current = projectionViewIdentity;
  const flowInstance = useRef<ReactFlowInstance<FlowWeaveNode> | null>(null);
  const rawGraphEdges = useMemo(() => edges.map(graphEdgeFromFlow), [edges]);
  const moduleGroupOptions = useMemo(() => {
    const groups = new Map<string, { id: string; title: string; moduleIds: Set<string> }>();
    for (const node of nodes) {
      if (node.data.origin === "manual" || node.data.resource || node.data.kind !== "module") continue;
      const areaId = nodeGroupKey(node.data);
      const area = node.data.groupPath?.find((group) => group.id === areaId);
      const option = groups.get(areaId) ?? { id: areaId, title: area?.title ?? node.data.title, moduleIds: new Set<string>() };
      option.moduleIds.add(node.id);
      groups.set(areaId, option);
    }
    return [...groups.values()].map(({ moduleIds, ...group }) => ({ ...group, count: moduleIds.size }))
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  }, [nodes]);
  const projection = useMemo(
    () => projectGraphForView(
      nodes.map((node) => node.data),
      rawGraphEdges,
      graphViewMode(layoutMode),
      { additionalRelations, showInferredCalls }
    ),
    [additionalRelations, layoutMode, nodes, rawGraphEdges, showInferredCalls]
  );
  const projectedFlowGraph = useMemo(() => {
    const originalNodesById = new Map(nodes.map((node) => [node.id, node]));
    const projectedNodes = projection.nodes.map((node) => {
      const original = originalNodesById.get(node.id);
      const preservedManualPosition = node.origin === "manual" ? canvasLayout.manualPositions[node.id] : undefined;
      const savedPosition = preservedManualPosition ?? (canvasLayout.activeMode === "manual" ? undefined : canvasLayout.autoLayouts[layoutMode]?.[node.id]);
      const flowNode = original
        ? { ...original, data: { ...original.data, ...node } }
        : createFlowNode(node);
      return {
        ...flowNode,
        ...(savedPosition ? { position: savedPosition } : {}),
        ...(node.syntheticKind ? { draggable: false, selectable: false, connectable: false } : {})
      };
    });
    const originalEdgesById = new Map(edges.map((edge) => [edge.id, edge]));
    const projectedEdges = projection.edges.map((edge) => {
      const sourceEdge = originalEdgesById.get(edge.sourceEdgeIds[0]);
      const flowEdge = createFlowEdge(edge);
      return {
        ...flowEdge,
        selected: sourceEdge?.selected,
        style: {
          ...flowEdge.style,
          ...(edge.confidence === "inferred" ? { strokeDasharray: "6 5" } : {})
        },
        data: {
          ...flowEdge.data,
          edgeClass: edge.edgeClass,
          confidence: edge.confidence,
          participatesInLayering: edge.participatesInLayering,
          sourceEdgeIds: edge.sourceEdgeIds,
          evidenceIds: edge.evidenceIds,
          aggregatedEdgeIds: edge.aggregatedEdgeIds
        }
      };
    });
    return { nodes: projectedNodes, edges: projectedEdges };
  }, [canvasLayout.activeMode, canvasLayout.autoLayouts, canvasLayout.manualPositions, edges, layoutMode, nodes, projection]);
  const projectedNodes = projectedFlowGraph.nodes;
  const projectedEdges = projectedFlowGraph.edges;
  const filteredProjectionGraph = useMemo(
    () => filterCanvasGraph(projectedNodes, projectedEdges, classificationFilters, selectedModuleGroups),
    [classificationFilters, projectedEdges, projectedNodes, selectedModuleGroups]
  );
  const visibleModuleCount = countCanvasModules(filteredProjectionGraph.nodes);
  const totalModuleCount = countCanvasModules(projectedNodes);
  const activeModuleFilterCount = Number(roleFilter !== "all") + Number(technologyFilter !== "all") + selectedModuleGroups.length;
  const hasActiveModuleFilters = activeModuleFilterCount > 0;
  const hasNoVisibleModules = filteredProjectionGraph.nodes.length === 0 && hasActiveModuleFilters;
  const overviewFrontier = useMemo(() => {
    if (!hasMeasuredViewport || overviewViewport.width < 1 || overviewViewport.height < 1 || !generationId ||
      canvasLayout.activeMode === "manual" || layoutMode === "dependency") return undefined;
    return selectOverviewFrontier({
      nodes: filteredProjectionGraph.nodes.map((node) => node.data),
      viewport: overviewViewport,
      cardSize: { width: 280, height: 176 },
      collapsedGroupIds: canvasLayout.collapsedGroups,
      expandedGroupIds,
      identity: projectionViewIdentity
    });
  }, [canvasLayout.activeMode, canvasLayout.collapsedGroups, expandedGroupIds, filteredProjectionGraph.nodes,
    generationId, hasMeasuredViewport, layoutMode, overviewViewport, projectionViewIdentity]);
  const displayCollapsedGroups = overviewFrontier?.collapsedGroupIds ?? canvasLayout.collapsedGroups;
  const executionCoverage = executionCoverageSummary(projection.diagnostics);
  const collapsedGraph = useMemo(
    () => projectCollapsedFlowGraph(
      filteredProjectionGraph.nodes,
      filteredProjectionGraph.edges,
      layoutMode,
      displayCollapsedGroups
    ),
    [displayCollapsedGroups, filteredProjectionGraph, layoutMode]
  );
  const layoutGraph = useMemo(
    () => projectCollapsedFlowGraph(projectedNodes, projectedEdges, layoutMode, displayCollapsedGroups),
    [displayCollapsedGroups, layoutMode, projectedEdges, projectedNodes]
  );
  const staticHandleLayout = canvasLayout.autoConnectionHandles?.[layoutMode];
  const layoutHandles = handleLayoutIsCurrent(layoutGraph.nodes, layoutGraph.edges, staticHandleLayout)
    ? staticHandleLayout?.handles : undefined;
  const collapsedLayoutHandles = handleLayoutIsCurrent(collapsedGraph.nodes, collapsedGraph.edges, staticHandleLayout)
    ? staticHandleLayout?.handles : undefined;
  const decoratedLayoutGraph = useMemo(
    () => decorateFlowGraph(layoutGraph.nodes.map((node) => ({
      ...node,
      ...(node.data.syntheticKind === "group" && canvasLayout.autoLayouts[layoutMode]?.[node.id]
        ? { position: canvasLayout.autoLayouts[layoutMode]![node.id] } : {})
    })), layoutGraph.edges, undefined, layoutHandles),
    [canvasLayout.autoLayouts, layoutGraph, layoutHandles, layoutMode]
  );
  const tracedNodeIds = useMemo(() => {
    if (!focusedNodeId || traceDirection === "off") return undefined;
    return traceDisplayNodeIds(focusedNodeId, projectedNodes, projectedEdges, collapsedGraph.nodes, layoutMode, traceDirection);
  }, [collapsedGraph, focusedNodeId, layoutMode, projectedEdges, projectedNodes, traceDirection]);
  const collapsedVisibleNodeIds = useMemo(() => new Set(collapsedGraph.nodes.map((node) => node.id)), [collapsedGraph.nodes]);
  const decoratedCollapsedGraph = useMemo(
    () => decorateFlowGraph(collapsedGraph.nodes.map((node) => ({
      ...node,
      ...(node.data.syntheticKind === "group" && canvasLayout.autoLayouts[layoutMode]?.[node.id]
        ? { position: canvasLayout.autoLayouts[layoutMode]![node.id] } : {})
    })), collapsedGraph.edges, undefined, collapsedLayoutHandles),
    [canvasLayout.autoLayouts, collapsedGraph, collapsedLayoutHandles, layoutMode]
  );
  const filteredEdges = useMemo(
    () => decoratedCollapsedGraph.edges.filter((edge) =>
      collapsedVisibleNodeIds.has(edge.source) &&
        collapsedVisibleNodeIds.has(edge.target) &&
        (!tracedNodeIds || (tracedNodeIds.has(edge.source) && tracedNodeIds.has(edge.target)))
    ),
    [decoratedCollapsedGraph.edges, collapsedVisibleNodeIds, tracedNodeIds]
  );
  const layoutEdges = useMemo(() => decoratedLayoutGraph.edges.filter((edge) => {
    const relation = (edge.data?.relation as GraphEdgeRelation | undefined) ?? "depends_on";
    if ((edge.data as GraphEdge | undefined)?.origin === "manual") return false;
    if (layoutMode === "dependency") return relation === "depends_on";
    if (layoutMode === "execution") return relation === "calls";
    return true;
  }), [decoratedLayoutGraph.edges, layoutMode]);
  const emptyEdgeReason = canvasEmptyEdgeReason(nodes.length, rawGraphEdges.length, projection.edges.length, filteredEdges.length, collapsedGraph.nodes.some((node) => node.data.internalEdgeIds?.length) ? collapsedGraph.edges.length : undefined);
  const availableView: GraphViewMode = layoutMode === "dependency" ? "execution" : "dependency";
  const availableRelationOverlays = useMemo(() => {
    const primaryRelation = layoutMode === "dependency" ? "depends_on" : "calls";
    const relations: Array<GraphEdgeRelation | "manual"> = rawGraphEdges
      .filter((edge) => edge.origin !== "manual")
      .map((edge) => edge.relation);
    if (rawGraphEdges.some((edge) => edge.origin === "manual")) relations.push("manual");
    return [...new Set(relations)].filter((relation) => relation !== primaryRelation);
  }, [layoutMode, rawGraphEdges]);
  const relationCounts = useMemo(() => {
    const generated = new Map<GraphEdgeRelation | "manual", number>();
    const visible = new Map<GraphEdgeRelation | "manual", number>();
    for (const edge of rawGraphEdges) {
      const relation = edge.origin === "manual" ? "manual" : edge.relation;
      generated.set(relation, (generated.get(relation) ?? 0) + 1);
    }
    for (const edge of filteredEdges) {
      const relation = (edge.data as GraphEdge | undefined)?.origin === "manual"
        ? "manual"
        : (edge.data?.relation as GraphEdgeRelation | undefined);
      if (relation) visible.set(relation, (visible.get(relation) ?? 0) + 1);
    }
    return { generated, visible };
  }, [filteredEdges, rawGraphEdges]);
  const inferredCallCount = rawGraphEdges.filter((edge) => edge.relation === "calls" && edge.confidence !== "confirmed" && edge.origin !== "manual").length;
  const skippedRelationSummary = relationDiagnostics
    .filter((diagnostic) => diagnostic.count > 0)
    .map((diagnostic) => t(`canvas.skippedRelation.${diagnostic.reason}`, { count: diagnostic.count }))
    .join(" · ");
  const visibleNodes = useMemo(
    () => decoratedCollapsedGraph.nodes.map((node) => ({
      ...node,
      hidden: !collapsedVisibleNodeIds.has(node.id) || Boolean(tracedNodeIds && !tracedNodeIds.has(node.id)),
      data: {
        ...node.data,
        ...(node.data.groupId ? { onExpandGroup: () => expandGroup(node) } : {
          connectionExplanation: t(`canvas.nodeConnections.${rawGraphEdges.some((edge) => edge.source === node.id || edge.target === node.id) && !filteredEdges.some((edge) => edge.source === node.id || edge.target === node.id)
            ? "hidden" : nodeConnectionExplanation(node.data, rawGraphEdges) ?? "connected"}`)
        })
      }
    })),
    [decoratedCollapsedGraph.nodes, collapsedVisibleNodeIds, displayCollapsedGroups, expandedGroupIds, filteredEdges, rawGraphEdges, t, tracedNodeIds]
  );
  const visibleTopologyFingerprint = useMemo(
    () => canvasTopologyFingerprint(visibleNodes.filter((node) => !node.hidden), layoutEdges),
    [layoutEdges, visibleNodes]
  );
  const manualPositionRevision = useMemo(() => JSON.stringify(Object.entries(canvasLayout.manualPositions)
    .sort(([left], [right]) => left.localeCompare(right))), [canvasLayout.manualPositions]);
  const layoutContext = useMemo(() => {
    if (!hasMeasuredViewport || layoutViewport.width < 1 || layoutViewport.height < 1 || !projectId || !generationId) return undefined;
    return {
      projectId,
      generationId,
      viewport: layoutViewport,
      manualPositionRevision
    };
  }, [generationId, hasMeasuredViewport, layoutViewport, manualPositionRevision, projectId]);
  const layoutTopologyFingerprint = useMemo(
    () => canvasTopologyFingerprint(decoratedLayoutGraph.nodes, layoutEdges, layoutContext),
    [decoratedLayoutGraph.nodes, layoutContext, layoutEdges]
  );
  const layoutRequestContext = {
    identity: projectionViewIdentity,
    layoutMode,
    activeMode: canvasLayout.activeMode,
    manualPositionRevision,
    topologyFingerprint: layoutTopologyFingerprint
  };
  const currentLayoutRequestContext = useRef(layoutRequestContext);
  currentLayoutRequestContext.current = layoutRequestContext;
  const explicitLayoutRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { explicitLayoutRequest.current?.abort(); }, []);
  const layoutReadyForViewport = !hasMeasuredViewport ||
    (overviewViewport.width === layoutViewport.width && overviewViewport.height === layoutViewport.height);
  const layoutNeedsRefresh = canvasLayout.activeMode !== "manual" &&
    !autoLayoutIsCurrent(canvasLayout, layoutMode, layoutTopologyFingerprint);
  const layoutPending = canvasLayout.activeMode !== "manual" && layoutGraph.nodes.some((node) =>
    node.data.origin !== "manual" && !canvasLayout.autoLayouts[layoutMode]?.[node.id]);
  const localizedEdges = useMemo(
    () => localizeCanvasEdgeLabels(filteredEdges, t),
    [filteredEdges, t]
  );
  async function applyAutoLayout() {
    explicitLayoutRequest.current?.abort();
    const controller = new AbortController();
    explicitLayoutRequest.current = controller;
    const nodesToLayout = decoratedLayoutGraph.nodes;
    setIsLayoutRunning(true);
    setLayoutError("");
    setLocalLayoutSpaceInsufficient(false);
    try {
      await applyCanvasLayoutResult(
        layoutCanvasNodes(nodesToLayout, layoutEdges, layoutMode, decoratedLayoutGraph.edges),
        layoutRequestContext,
        () => currentLayoutRequestContext.current,
        onApplyAutoLayout,
        controller.signal
      );
    } catch (error) {
      if (!controller.signal.aborted) setLayoutError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) setIsLayoutRunning(false);
    }
  }
  useEffect(() => {
    if (!layoutReadyForViewport || !(layoutPending || layoutNeedsRefresh)) return;
    let active = true;
    const nodesToLayout = decoratedLayoutGraph.nodes;
    const requestIdentity = overviewFrontier?.identity ?? projectionViewIdentity;
    const queuedLocalRequest = pendingLocalLayout.current;
    pendingLocalLayout.current = undefined;
    const localRequest = queuedLocalRequest && canUseLocalCanvasLayout(queuedLocalRequest.scope, {
      projectId: projectId ?? "project",
      generationId: generationId ?? "unversioned",
      layoutMode,
      activeMode: canvasLayout.activeMode
    }) ? queuedLocalRequest : undefined;
    if (localRequest?.kind === "expand") {
      const anchorIds = new Set(localRequest.anchors.map((node) => node.id));
      const fixedNodes = [
        ...localRequest.fixedNodes,
        ...nodesToLayout.filter((node) => node.data.origin === "manual" && !localRequest.previousNodeIds.has(node.id))
      ].filter((node, index, all) => !anchorIds.has(node.id) && all.findIndex((candidate) => candidate.id === node.id) === index);
      setIsLayoutRunning(true);
      setLayoutError("");
      void layoutExpandedCanvasNodes(
        nodesToLayout,
        layoutEdges,
        layoutMode,
        localRequest.previousNodeIds,
        localRequest.anchors,
        fixedNodes,
        async (regionNodes, regionEdges, regionMode) =>
          (await layoutCanvasNodes(regionNodes, regionEdges, regionMode, regionEdges)).nodes
      ).then(async (localNodes) => {
        if (!active || !matchesOverviewIdentity(requestIdentity, currentViewIdentity.current) ||
          currentLayoutRequestContext.current.topologyFingerprint !== layoutTopologyFingerprint) return;
        const positionedNodes = localNodes ?? nodesToLayout.filter((node) => !localRequest.previousNodeIds.has(node.id));
        setLocalLayoutSpaceInsufficient(localNodes === undefined);
        const positionedById = new Map(positionedNodes.map((node) => [node.id, node]));
        const finalNodes = nodesToLayout.map((node) => positionedById.get(node.id) ?? node);
        const handleLayout = await layoutCanvasConnectionHandles(finalNodes, decoratedLayoutGraph.edges);
        if (!active || !matchesOverviewIdentity(requestIdentity, currentViewIdentity.current) ||
          currentLayoutRequestContext.current.topologyFingerprint !== layoutTopologyFingerprint) return;
        setIsLayoutRunning(false);
        onApplyAutoLayout(
          layoutMode,
          Object.fromEntries(positionedNodes.map((node) => [node.id, node.position])),
          layoutTopologyFingerprint,
          handleLayout
        );
      }).catch((error: unknown) => {
        if (active) setLayoutError(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        if (active) setIsLayoutRunning(false);
      });
      return () => { active = false; };
    }
    if (localRequest?.kind === "collapse") {
      const groups = nodesToLayout.filter((node) =>
        !localRequest.previousNodeIds.has(node.id) && node.data.syntheticKind === "group"
      );
      setLocalLayoutSpaceInsufficient(false);
      setIsLayoutRunning(true);
      void layoutCanvasConnectionHandles(nodesToLayout, decoratedLayoutGraph.edges)
        .then((handleLayout) => {
          if (active && matchesOverviewIdentity(requestIdentity, currentViewIdentity.current) &&
            currentLayoutRequestContext.current.topologyFingerprint === layoutTopologyFingerprint) {
            setIsLayoutRunning(false);
            onApplyAutoLayout(
              layoutMode,
              Object.fromEntries(groups.map((node) => [node.id, node.position])),
              layoutTopologyFingerprint,
              handleLayout
            );
          }
        })
        .catch((error: unknown) => {
          if (active) setLayoutError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (active) setIsLayoutRunning(false);
        });
      return () => { active = false; };
    }
    setIsLayoutRunning(true);
    setLayoutError("");
    void layoutCanvasNodes(nodesToLayout, layoutEdges, layoutMode, decoratedLayoutGraph.edges)
      .then((layout) => {
        if (active && matchesOverviewIdentity(requestIdentity, currentViewIdentity.current)) {
          setIsLayoutRunning(false);
          onApplyAutoLayout(
            layoutMode,
            Object.fromEntries(layout.nodes.map((node) => [node.id, node.position])),
            layoutTopologyFingerprint,
            layout.handleLayout
          );
        }
      })
      .catch((error: unknown) => {
        if (active) setLayoutError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setIsLayoutRunning(false);
      });
    return () => { active = false; };
  }, [decoratedLayoutGraph.nodes, layoutEdges, layoutMode, layoutNeedsRefresh, layoutPending, layoutReadyForViewport, onApplyAutoLayout, overviewFrontier, projectionViewIdentity, layoutTopologyFingerprint, canvasLayout.activeMode, generationId, projectId]);
  function queueLocalExpansion(anchors: FlowWeaveNode[]) {
    if (canvasLayout.activeMode === "manual" || anchors.length === 0) {
      pendingLocalLayout.current = undefined;
      return;
    }
    setLocalLayoutSpaceInsufficient(false);
    const anchorIds = new Set(anchors.map((node) => node.id));
    pendingLocalLayout.current = {
      scope: {
        projectId: projectId ?? "project",
        generationId: generationId ?? "unversioned",
        layoutMode,
        activeMode: canvasLayout.activeMode
      },
      kind: "expand",
      previousNodeIds: new Set(decoratedLayoutGraph.nodes.map((node) => node.id)),
      anchors,
      fixedNodes: decoratedLayoutGraph.nodes.filter((node) => !anchorIds.has(node.id))
    };
  }
  function expandGroup(node: FlowWeaveNode) {
    if (!node.data.groupId) return;
    queueLocalExpansion([node]);
    if (expandedGroupIds.length === 0) {
      overviewCollapseSnapshot.current = [...canvasLayout.collapsedGroups];
      overviewFocusGroupNodeId.current = node.id;
    }
    onSetCollapsedGroups(expandedGroupsForGroup(nodes.map((item) => item.data), layoutMode, node.data.groupId, canvasLayout.collapsedGroups));
    setExpandedGroupIds((current) => [...new Set([...current, node.data.groupId!])]);
    setFocusRequest(node.data.memberNodeIds ?? []);
    pendingGroupFocus.current = node.data.memberNodeIds ?? [];
  }
  function focusModule(node: FlowWeaveNode) {
    setRoleFilter("all");
    setTechnologyFilter("all");
    setSelectedModuleGroups([]);
    setAdditionalRelations([]);
    setShowInferredCalls(false);
    setTraceDirection("off");
    const ancestors = nodeDisplayGroups(node.data, layoutMode).map((group) => group.id);
    queueLocalExpansion(decoratedLayoutGraph.nodes.filter((groupNode) =>
      groupNode.data.groupId && groupNode.data.memberNodeIds?.includes(node.id)
    ));
    if (expandedGroupIds.length === 0) overviewCollapseSnapshot.current = [...canvasLayout.collapsedGroups];
    onSetCollapsedGroups(expandedGroupsForNode(node.data, layoutMode, canvasLayout.collapsedGroups));
    setExpandedGroupIds((current) => [...new Set([...current, ...ancestors])]);
    setFocusedNodeId(node.id);
    setFocusRequest([node.id]);
    pendingGroupFocus.current = [node.id];
    setSearchQuery("");
    onSelectNode(node.id);
  }
  function expandAllGroups() {
    const groupIds = nodes.flatMap((node) => nodeDisplayGroups(node.data, layoutMode).map((group) => group.id));
    queueLocalExpansion(decoratedLayoutGraph.nodes.filter((node) => node.data.groupId));
    if (expandedGroupIds.length === 0) overviewCollapseSnapshot.current = [...canvasLayout.collapsedGroups];
    onSetCollapsedGroups([]);
    setExpandedGroupIds((current) => [...new Set([...current, ...groupIds])]);
  }
  function backToOverview() {
    const focusNodeId = overviewFocusGroupNodeId.current;
    onSetCollapsedGroups(overviewCollapseSnapshot.current ?? []);
    setExpandedGroupIds([]);
    overviewCollapseSnapshot.current = undefined;
    overviewFocusGroupNodeId.current = undefined;
    pendingGroupFocus.current = focusNodeId ? [focusNodeId] : [];
  }
  function resetCanvasFilters() {
    setRoleFilter("all");
    setTechnologyFilter("all");
    setSelectedModuleGroups([]);
    setAdditionalRelations([]);
    setShowInferredCalls(false);
    setTraceDirection("off");
    setFocusedNodeId("");
  }
  function fitRequestedNodes(instance: ReactFlowInstance<FlowWeaveNode>) {
    if (focusRequest.length === 0) return;
    const requested = visibleNodes.filter((node) => focusRequest.includes(node.id) || node.data.memberNodeIds?.some((id) => focusRequest.includes(id)));
    if (requested.length > 0) void instance.fitView({ nodes: requested, padding: 0.25, duration: 250 }).then(() => setFocusRequest([]));
  }
  useEffect(() => {
    if (!layoutPending && flowInstance.current) fitRequestedNodes(flowInstance.current);
  }, [layoutPending, focusRequest, visibleTopologyFingerprint]);
  useEffect(() => {
    if (layoutPending || pendingGroupFocus.current.length === 0) return;
    const memberIds = new Set(pendingGroupFocus.current);
    const target = visibleNodes.find((node) => memberIds.has(node.id) || node.data.memberNodeIds?.some((id) => memberIds.has(id)));
    const flowStage = overviewViewportRef.current;
    if (!target || !flowStage) return;
    const frame = window.requestAnimationFrame(() => {
      const flowNodes = [...flowStage.querySelectorAll<HTMLElement>(".react-flow__node")];
      const targetElement = flowNodes.find((element) => element.dataset.id === target.id);
      if (!targetElement) return;
      const focusTarget = target.data.syntheticKind === "group"
        ? targetElement.querySelector<HTMLElement>("button") ?? targetElement
        : targetElement;
      focusTarget.focus({ preventScroll: true });
      if (document.activeElement === focusTarget) pendingGroupFocus.current = [];
    });
    return () => window.cancelAnimationFrame(frame);
  }, [layoutPending, visibleNodes, visibleTopologyFingerprint]);
  const searchMatches = searchQuery.trim() ? nodes.filter((node) => !node.data.resource &&
    [node.data.title, ...node.data.files].some((text) => text.toLowerCase().includes(searchQuery.trim().toLowerCase()))).slice(0, 8) : [];
  return (
    <div className="canvas-flow-shell" onKeyDown={(event) => {
      if (event.key !== "Escape" || expandedGroupIds.length === 0) return;
      const activeNode = document.activeElement instanceof HTMLElement
        ? document.activeElement.closest(".react-flow__node")
        : null;
      if (!activeNode) return;
      event.preventDefault();
      backToOverview();
    }}>
      <div className="canvas-view-tools">
        <div className="canvas-view-tools-content">
          <div className="canvas-module-search">
            <label>
              <Search size={14} />
              <input aria-label={t("canvas.searchModules")} placeholder={t("canvas.searchModules")} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
            </label>
          </div>
          <label className="canvas-view-mode">
            <select value={layoutMode} onChange={(event) => {
              const mode = event.target.value as GraphViewMode;
              onSetViewMode(mode);
            }} aria-label={t("canvas.layoutMode")} title={t("canvas.layoutMode")}>
              <option value="execution">{t("canvas.layoutExecution")}</option>
              <option value="dependency">{t("canvas.layoutDependency")}</option>
            </select>
          </label>
          <details className="canvas-relation-display">
            <summary>{t("canvas.relationDisplay")}{additionalRelations.length || showInferredCalls ? ` · ${additionalRelations.length + Number(showInferredCalls)}` : ""}</summary>
            <div className="canvas-toolbar-popover">
              {relationGroups.map((group) => {
                const relations = group.relations.filter((relation) => availableRelationOverlays.includes(relation));
                if (relations.length === 0) return null;
                return (
                  <fieldset key={group.id}>
                    <legend>{t(`canvas.relationGroup.${group.id}`)}</legend>
                    {relations.map((relation) => (
                      <label key={relation}>
                        <input
                          checked={additionalRelations.includes(relation)}
                          onChange={() => setAdditionalRelations((current) => current.includes(relation)
                            ? current.filter((item) => item !== relation)
                            : [...current, relation])}
                          type="checkbox"
                        />
                        <span>{t(`relation.${relation}`)}</span>
                        <small title={t("canvas.visibleOfDetected", { visible: relationCounts.visible.get(relation) ?? 0, detected: relationCounts.generated.get(relation) ?? 0 })}>{relationCounts.visible.get(relation) ?? 0}/{relationCounts.generated.get(relation) ?? 0}</small>
                      </label>
                    ))}
                  </fieldset>
                );
              })}
              {availableRelationOverlays.includes("manual") ? (
                <fieldset>
                  <legend>{t("canvas.relationGroup.manual")}</legend>
                  <label>
                    <input checked={additionalRelations.includes("manual")} onChange={() => setAdditionalRelations((current) => current.includes("manual")
                      ? current.filter((item) => item !== "manual")
                      : [...current, "manual"])} type="checkbox" />
                    <span>{t("canvas.manualRelations")}</span>
                    <small title={t("canvas.visibleOfDetected", { visible: relationCounts.visible.get("manual") ?? 0, detected: relationCounts.generated.get("manual") ?? 0 })}>{relationCounts.visible.get("manual") ?? 0}/{relationCounts.generated.get("manual") ?? 0}</small>
                  </label>
                </fieldset>
              ) : null}
              {layoutMode === "execution" && inferredCallCount > 0 ? (
                <fieldset>
                  <legend>{t("canvas.relationGroup.inferred")}</legend>
                  <label>
                    <input checked={showInferredCalls} onChange={(event) => setShowInferredCalls(event.target.checked)} type="checkbox" />
                    <span>{t("canvas.inferredCalls")}</span>
                    <small title={t("canvas.visibleOfDetected", { visible: showInferredCalls ? inferredCallCount : 0, detected: inferredCallCount })}>{showInferredCalls ? inferredCallCount : 0}/{inferredCallCount}</small>
                  </label>
                </fieldset>
              ) : null}
              {focusedNodeId ? (
                <fieldset className="canvas-trace-controls" aria-label={t("canvas.traceControls")}>
                  <legend><GitBranch size={14} /> {t("canvas.traceControls")}</legend>
                  {(["upstream", "downstream", "all"] as TraceDirection[]).map((direction) => (
                    <label key={direction}>
                      <input checked={traceDirection === direction} onChange={() => setTraceDirection(direction)} type="radio" name="canvas-trace-direction" />
                      <span>{t(`canvas.trace${direction[0].toUpperCase()}${direction.slice(1)}`)}</span>
                    </label>
                  ))}
                  {tracedNodeIds ? <Button size="tool" type="button" variant="subtle" onClick={() => {
                    setTraceDirection("off");
                    setFocusedNodeId("");
                  }}>{t("canvas.clearTrace")}</Button> : null}
                </fieldset>
              ) : null}
              {additionalRelations.length || showInferredCalls ? <Button size="tool" type="button" variant="subtle" onClick={() => {
                setAdditionalRelations([]);
                setShowInferredCalls(false);
              }}>{t("canvas.clearRelationDisplay")}</Button> : null}
            </div>
          </details>
          <details className="canvas-filter-display">
            <summary>{t("canvas.filters")}{activeModuleFilterCount ? ` · ${activeModuleFilterCount}` : ""}</summary>
            <div className="canvas-toolbar-popover">
              <fieldset>
                <legend>{t("canvas.classificationFilters")}</legend>
                <label>
                  <span>{t("canvas.technologyFilter")}</span>
                  <select value={technologyFilter} onChange={(event) => setTechnologyFilter(event.target.value as TechnologyStack | "all")}>
                    <option value="all">{t("canvas.filterAll")}</option>
                    {(["frontend", "mobile", "backend", "data", "infrastructure", "shared", "unknown"] as TechnologyStack[])
                      .map((stack) => <option key={stack} value={stack}>{t(`technology.${stack}`)}</option>)}
                  </select>
                </label>
                <label>
                  <span>{t("canvas.layerFilter")}</span>
                  <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as ArchitectureLayer | "all")}>
                    <option value="all">{t("canvas.filterAll")}</option>
                    {(["presentation", "api", "domain", "data", "integration", "infrastructure", "test", "unknown"] as ArchitectureLayer[])
                      .map((layer) => <option key={layer} value={layer}>{t(`architectureLayer.${layer}`)}</option>)}
                  </select>
                </label>
              </fieldset>
              <details className="canvas-module-scope">
                <summary>{t("canvas.moduleScope")}{selectedModuleGroups.length ? ` · ${selectedModuleGroups.length}` : ""}</summary>
                <fieldset>
                  <legend>{t("canvas.moduleGroups")}</legend>
                  {moduleGroupOptions.length ? moduleGroupOptions.map((group) => (
                    <label key={group.id}>
                      <input
                        checked={selectedModuleGroups.includes(group.id)}
                        onChange={() => setSelectedModuleGroups((current) => current.includes(group.id)
                          ? current.filter((id) => id !== group.id)
                          : [...current, group.id])}
                        type="checkbox"
                      />
                      <span>{group.title}</span>
                      <small>{group.count}</small>
                    </label>
                  )) : <span className="canvas-scope-empty">{t("canvas.noModuleGroups")}</span>}
                </fieldset>
              </details>
              <span className="canvas-execution-summary" role="status">
                {t("canvas.filterMatches", { visible: visibleModuleCount, total: totalModuleCount })}
              </span>
              {hasActiveModuleFilters ? <Button size="tool" type="button" variant="subtle" onClick={resetCanvasFilters}>{t("canvas.clearFilters")}</Button> : null}
            </div>
          </details>
          {layoutError ? <span className="canvas-layout-error" title={layoutError}>{t("canvas.layoutFailed")}</span> : null}
        </div>
        {searchQuery.trim() ? (
          <div className="canvas-search-results">
            {searchMatches.length > 0 ? searchMatches.map((node) => (
              <button key={node.id} type="button" onClick={() => focusModule(node)}>{node.data.title}<small>{node.data.files[0]}</small></button>
            )) : <span>{t("canvas.filterEmpty")}</span>}
          </div>
        ) : null}
        {quality || currentPreservedNodeEditCount ? (
          <details className="canvas-analysis-status" onToggle={(event) => {
            if (event.currentTarget.open && !loadedFullCanvas &&
              (quality?.factOutcomes?.some((outcome) => outcome.count > 0 && outcome.relationIds.length === 0) || currentPreservedNodeEditCount)) {
              void getFullCanvas().then(() => setQualityError(""))
                .catch((error: unknown) => setQualityError(error instanceof Error ? error.message : String(error)));
            }
          }}>
            <summary>
              {quality ? t(quality.complete ? "canvas.analysisComplete" : "canvas.analysisIncomplete", { parsed: quality.parsedFiles, eligible: quality.eligibleFiles }) : null}
              {currentPreservedNodeEditCount ? ` · ${t("canvas.unresolvedEdits", { count: currentPreservedNodeEditCount })}` : ""}
            </summary>
            {quality ? <p>{t("canvas.analysisQuality", {
              failed: quality.failedFiles, unsupported: quality.unsupportedFiles,
              resolvedImports: quality.resolvedInternalImports, imports: quality.internalImports,
              unresolvedImports: quality.unresolvedInternalImports,
              resolvedCalls: quality.resolvedCalls, calls: quality.calls, ambiguousCalls: quality.ambiguousCalls
            })}</p> : null}
            {qualityError ? <p role="alert">{qualityError}</p> : null}
            {detailedQuality?.factOutcomes?.length ? (
              <table className="canvas-fact-outcomes">
                <thead><tr><th>{t("connection.semanticKinds")}</th><th>{t("canvas.factOutcome")}</th><th>{t("canvas.factCount")}</th></tr></thead>
                <tbody>{detailedQuality.factOutcomes.map((fact) => <tr key={`${fact.kind}:${fact.outcome}`} title={fact.relationIds.join(" · ")}><td>{t(`connection.semantic.${fact.kind}`)}</td><td>{t(`canvas.factOutcome.${fact.outcome}`)}</td><td>{fact.count}</td></tr>)}</tbody>
              </table>
            ) : null}
            {currentOrphanedNodeEdits.map(({ node, reason }) => (
              <article key={node.id}>
                <strong>{node.title} · {t(`canvas.unresolvedEdit.${reason}`)}</strong>
                <p>{node.description}</p>
                <small>{node.files.join(" · ")}</small>
                {node.guidanceDraft ? <pre>{node.guidanceDraft}</pre> : null}
                {node.assessment?.risk.override ? <p>{t(`risk.${node.assessment.risk.override.level}`)} · {node.assessment.risk.override.reason}</p> : null}
              </article>
            ))}
          </details>
        ) : null}
        {preservedDataCount > 0 || hiddenGeneratedCount > 0 ? (
          <details className="canvas-analysis-status canvas-migration-review">
            <summary>{t("canvas.migrationReview", { count: preservedDataCount + hiddenGeneratedCount })}</summary>
            <div className="canvas-migration-actions">
              <Button size="tool" type="button" variant="subtle" onClick={() => {
                if (showPreservedData) { setShowPreservedData(false); return; }
                void getPreservedData().then(() => { setPreservedDataError(""); setShowPreservedData(true); })
                  .catch((error: unknown) => setPreservedDataError(error instanceof Error ? error.message : String(error)));
              }}>
                {t(showPreservedData ? "canvas.hidePreservedData" : "canvas.viewPreservedData")}
              </Button>
              <Button size="tool" type="button" variant="subtle" onClick={() => {
                void getPreservedData().then((data) => {
                  setPreservedDataError("");
                  downloadText("flowweave-preserved-canvas-data.json", JSON.stringify(data, null, 2));
                }).catch((error: unknown) => setPreservedDataError(error instanceof Error ? error.message : String(error)));
              }}>
                {t("canvas.exportPreservedData")}
              </Button>
              {currentMigrationPendingItems.length ? <Button size="tool" type="button" variant="subtle" onClick={() => downloadText("flowweave-migration-pending.json", JSON.stringify({
                schemaVersion: 1,
                projectPath,
                items: currentMigrationPendingItems
              }, null, 2))}>{t("canvas.exportMigrationPending")}</Button> : null}
              {hiddenGeneratedCount > 0 ? <Button disabled={readOnly} size="tool" type="button" variant="subtle" onClick={() => {
                setRestoreError("");
                void onRestoreGeneratedItems().catch((error) => setRestoreError(error instanceof Error ? error.message : String(error)));
              }}>{t("canvas.restoreGeneratedItems")}</Button> : null}
            </div>
            {restoreError ? <p role="alert">{t("canvas.restoreGeneratedFailed", { error: restoreError })}</p> : null}
            {preservedDataError ? <p role="alert">{preservedDataError}</p> : null}
            {migrationActionError ? <p role="alert">{migrationActionError}</p> : null}
            {showPreservedData ? (
              <>
                {currentOrphanedNodeEdits.map((orphan) => {
                  const target = migrationCandidates.find((candidate) => candidate.id === migrationNodeTargets[orphan.node.id]);
                  const sharedFiles = target ? orphan.node.files.filter((file) => target.files.includes(file)) : [];
                  const hasUserFieldDelta = Boolean(orphan.edits && Object.keys(orphan.edits).length > 0);
                  const busy = resolvingMigrationItemId === orphan.node.id;
                  const priorActions = loadedFullCanvas?.migrationReviewActions?.filter((item) => item.kind === "node-edit" && item.itemId === orphan.node.id) ?? [];
                  const wasKept = priorActions[priorActions.length - 1]?.action === "keep";
                  return (
                    <article key={`node:${orphan.node.id}`} className="canvas-migration-item">
                      <strong>{orphan.node.title} · {t(`canvas.unresolvedEdit.${orphan.reason}`)}</strong>
                      <p>{orphan.node.description}</p>
                      <small>{t("canvas.migrationSourceEvidence", { files: orphan.node.files.join(" · ") || t("canvas.noSourceFiles") })}</small>
                      {orphan.node.guidanceDraft ? <pre>{orphan.node.guidanceDraft}</pre> : null}
                      <label>
                        {t("canvas.migrationTargetNode")}
                        <select value={migrationNodeTargets[orphan.node.id] ?? ""} onChange={(event) => setMigrationNodeTargets((current) => ({
                          ...current, [orphan.node.id]: event.target.value
                        }))}>
                          <option value="">{t("canvas.migrationChooseTarget")}</option>
                          {migrationCandidates.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>{candidate.title} · {candidate.id}</option>
                          ))}
                        </select>
                      </label>
                      {target ? (
                        <small>{t("canvas.migrationTargetEvidence", {
                          target: target.title,
                          files: (sharedFiles.length ? sharedFiles : target.files).join(" · ") || t("canvas.noSourceFiles")
                        })}</small>
                      ) : null}
                      {wasKept ? <small>{t("canvas.migrationKeptAtRevision", {
                        revision: priorActions[priorActions.length - 1]?.revision ?? 0
                      })}</small> : null}
                      {!hasUserFieldDelta ? <small>{t("canvas.migrationRebindUnavailable")}</small> : null}
                      <div className="canvas-migration-actions">
                        <Button size="tool" type="button" variant="subtle" disabled={readOnly || busy || !target || !hasUserFieldDelta}
                          onClick={() => void runMigrationAction("node-edit", orphan.node.id, "rebind", { targetNodeId: target?.id })}>
                          {t("canvas.migrationRebind")}
                        </Button>
                        <Button size="tool" type="button" variant="subtle" disabled={readOnly || busy || wasKept}
                          onClick={() => void runMigrationAction("node-edit", orphan.node.id, "keep", {})}>
                          {t(wasKept ? "canvas.migrationKept" : "canvas.migrationKeep")}
                        </Button>
                        <Button size="tool" type="button" variant="subtle" disabled={readOnly || busy}
                          onClick={() => void runMigrationAction("node-edit", orphan.node.id, "discard", {})}>
                          {t("canvas.migrationDiscard")}
                        </Button>
                      </div>
                    </article>
                  );
                })}
                {currentOrphanedEdges.map((edge) => {
                  const endpoints = migrationEdgeEndpoints[edge.id] ?? { source: "", target: "" };
                  const sourceCandidate = migrationEndpoints.find((candidate) => candidate.id === endpoints.source);
                  const targetCandidate = migrationEndpoints.find((candidate) => candidate.id === endpoints.target);
                  const busy = resolvingMigrationItemId === edge.id;
                  const priorActions = loadedFullCanvas?.migrationReviewActions?.filter((item) => item.kind === "edge" && item.itemId === edge.id) ?? [];
                  const wasKept = priorActions[priorActions.length - 1]?.action === "keep";
                  return (
                    <article key={`edge:${edge.id}`} className="canvas-migration-item">
                      <strong>{edge.id} · {t("canvas.migrationRelationship")}</strong>
                      <p>{edge.source} → {edge.target} · {t(`relation.${edge.relation}`)}</p>
                      {edge.guidanceNote ? <pre>{edge.guidanceNote}</pre> : null}
                      {edge.evidence?.length ? <small>{t("canvas.migrationSourceEvidence", { files: edge.evidence.map((item) => item.detail).join(" · ") })}</small> : null}
                      {wasKept ? <small>{t("canvas.migrationKeptAtRevision", {
                        revision: priorActions[priorActions.length - 1]?.revision ?? 0
                      })}</small> : null}
                      <label>
                        {t("canvas.migrationSourceEndpoint")}
                        <select value={endpoints.source} onChange={(event) => setMigrationEdgeEndpoints((current) => ({
                          ...current, [edge.id]: { ...endpoints, source: event.target.value }
                        }))}>
                          <option value="">{t("canvas.migrationChooseSource")}</option>
                          {migrationEndpoints.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>{candidate.title} · {candidate.id}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {t("canvas.migrationTargetEndpoint")}
                        <select value={endpoints.target} onChange={(event) => setMigrationEdgeEndpoints((current) => ({
                          ...current, [edge.id]: { ...endpoints, target: event.target.value }
                        }))}>
                          <option value="">{t("canvas.migrationChooseTarget")}</option>
                          {migrationEndpoints.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>{candidate.title} · {candidate.id}</option>
                          ))}
                        </select>
                      </label>
                      {sourceCandidate || targetCandidate ? <small>{t("canvas.migrationEndpointEvidence", {
                        source: sourceCandidate ? `${sourceCandidate.title} (${sourceCandidate.files.join(", ") || t("canvas.noSourceFiles")})` : t("canvas.migrationChooseSource"),
                        target: targetCandidate ? `${targetCandidate.title} (${targetCandidate.files.join(", ") || t("canvas.noSourceFiles")})` : t("canvas.migrationChooseTarget")
                      })}</small> : null}
                      <div className="canvas-migration-actions">
                        <Button size="tool" type="button" variant="subtle" disabled={readOnly || busy || !endpoints.source || !endpoints.target || endpoints.source === endpoints.target}
                          onClick={() => void runMigrationAction("edge", edge.id, "rebind", {
                            sourceNodeId: endpoints.source, targetNodeId: endpoints.target
                          })}>
                          {t("canvas.migrationRebind")}
                        </Button>
                        <Button size="tool" type="button" variant="subtle" disabled={readOnly || busy || wasKept}
                          onClick={() => void runMigrationAction("edge", edge.id, "keep", {})}>
                          {t(wasKept ? "canvas.migrationKept" : "canvas.migrationKeep")}
                        </Button>
                        <Button size="tool" type="button" variant="subtle" disabled={readOnly || busy}
                          onClick={() => void runMigrationAction("edge", edge.id, "discard", {})}>
                          {t("canvas.migrationDiscard")}
                        </Button>
                      </div>
                    </article>
                  );
                })}
                {currentMigrationPendingItems.map((item) => {
                  const itemId = canvasMigrationPendingItemId(item);
                  const busy = resolvingMigrationItemId === itemId;
                  const priorActions = loadedFullCanvas?.migrationReviewActions?.filter((action) => action.kind === "migration-pending" && action.itemId === itemId) ?? [];
                  const wasKept = priorActions[priorActions.length - 1]?.action === "keep";
                  return (
                    <article key={`migration-pending:${itemId}`} className="canvas-migration-item">
                      <strong>{t("canvas.migrationPendingRecord", { kind: item.kind, version: item.sourceVersion })}</strong>
                      <small>{t("canvas.migrationPendingSource", {
                        generation: item.sourceGenerationId ?? t("canvas.migrationSourceUnknown"),
                        id: item.sourceId ?? t("canvas.migrationSourceUnknown")
                      })}</small>
                      <p>{item.reason}</p>
                      {wasKept ? <small>{t("canvas.migrationKeptAtRevision", {
                        revision: priorActions[priorActions.length - 1]?.revision ?? 0
                      })}</small> : null}
                      <pre>{JSON.stringify(item.raw, null, 2)}</pre>
                      <small>{t("canvas.migrationPendingRebindUnavailable")}</small>
                      <div className="canvas-migration-actions">
                        <Button size="tool" type="button" variant="subtle" disabled>
                          {t("canvas.migrationRebind")}
                        </Button>
                        <Button size="tool" type="button" variant="subtle" disabled={readOnly || busy || wasKept}
                          onClick={() => void runMigrationAction("migration-pending", itemId, "keep", {})}>
                          {t(wasKept ? "canvas.migrationKept" : "canvas.migrationKeep")}
                        </Button>
                        <Button size="tool" type="button" variant="subtle" disabled={readOnly || busy}
                          onClick={() => void runMigrationAction("migration-pending", itemId, "discard", {})}>
                          {t("canvas.migrationDiscard")}
                        </Button>
                      </div>
                    </article>
                  );
                })}
                {currentOrphanedNodeEdits.length === 0 && currentOrphanedEdges.length === 0 && currentMigrationPendingItems.length === 0
                  ? <p>{t("canvas.migrationNoActionableItems")}</p>
                  : null}
                <pre>{JSON.stringify(preservedData, null, 2)}</pre>
              </>
            ) : null}
          </details>
        ) : null}
        {layoutMode === "execution" ? (
          <div className="canvas-execution-info">
            <span className="canvas-execution-summary" role="status">
              {t("canvas.executionCoverage", {
                connected: projection.diagnostics.connectedExecutableModuleCount,
                total: projection.diagnostics.executableModuleCount,
                percent: executionCoverage.percent
              })}
              {projection.diagnostics.isolatedModuleIds.length > 0 ? ` · ${t("canvas.isolatedExecutableModules", { count: projection.diagnostics.isolatedModuleIds.length })}` : ""}
              {projection.diagnostics.unresolvedEventCount > 0 ? ` · ${t("canvas.unresolvedEvents", { count: projection.diagnostics.unresolvedEventCount })}` : ""}
            </span>
            <span className="canvas-execution-note">
              {t("canvas.executionStaticInference")}
              {executionCoverage.hasLimitedEvidence && projection.diagnostics.hiddenDependencyEdgeCount > 0 && !additionalRelations.includes("depends_on")
                ? ` ${t("canvas.executionEvidenceWarning", { count: projection.diagnostics.hiddenDependencyEdgeCount })}`
                : ""}
            </span>
          </div>
        ) : null}
      </div>
      <div className="canvas-flow-stage" ref={overviewViewportRef}>
        {hasNoVisibleModules ? (
          <div className="canvas-filter-empty" role="status">
            <span>{t("canvas.filterEmpty")}</span>
            <Button size="tool" type="button" variant="subtle" onClick={resetCanvasFilters}>{t("canvas.clearFilters")}</Button>
          </div>
        ) : null}
        {hasMeasuredViewport && overviewFrontier && !overviewFrontier.readability.isReadable ? (
          <div className="canvas-readability-warning" role="status">
            {t("canvas.readabilityWarning", {
              visible: overviewFrontier.readability.visibleNodeCount,
              maximum: overviewFrontier.readability.maximumReadableNodeCount
            })}
            <Button disabled={isLayoutRunning || readOnly} size="tool" type="button" variant="subtle" onClick={() => void applyAutoLayout()}>
              {t("canvas.autoLayout")}
            </Button>
          </div>
        ) : null}
        {localLayoutSpaceInsufficient ? (
          <div className="canvas-layout-pending has-error" role="status" aria-live="polite">
            <strong>{t("canvas.localLayoutSpaceInsufficient")}</strong>
            <Button disabled={isLayoutRunning || readOnly} size="tool" type="button" variant="subtle" onClick={() => void applyAutoLayout()}>
              {t("canvas.autoLayout")}
            </Button>
          </div>
        ) : null}
        {layoutPending ? (
          <div className={`canvas-layout-pending${layoutError ? " has-error" : ""}`} role="status" aria-live="polite" title={layoutError || undefined}>
            {layoutError ? (
              <>
                <strong>{t("canvas.layoutFailed")}</strong>
                <Button disabled={readOnly} size="tool" type="button" variant="subtle" onClick={() => void applyAutoLayout()}>{t("canvas.autoLayout")}</Button>
              </>
            ) : (
              <>
                <LoaderCircle className="spin" size={28} />
                <strong>{t("canvas.layoutPending")}</strong>
              </>
            )}
          </div>
        ) : null}
        <details className="canvas-relation-legend">
          <summary>{t("canvas.relationLegend")}</summary>
          <div>
            {relationOptions.filter((relation) => rawGraphEdges.some((edge) => edge.relation === relation)).map((relation) => (
              <span key={relation}>
                <i style={{ background: relationStyle[relation].color }} />
                {t(`relation.${relation}Accent`)}
              </span>
            ))}
          </div>
        </details>
        {emptyEdgeReason ? (
          <div className="canvas-edge-empty" role="status">
            <strong>{t(`canvas.emptyEdges.${emptyEdgeReason}`)}</strong>
            {emptyEdgeReason === "none" && skippedRelationSummary ? <span>{skippedRelationSummary}</span> : null}
            {emptyEdgeReason === "none" && relationDiagnostics.some((diagnostic) => diagnostic.relationIds?.length) ? (
              <details><summary>{t("canvas.skippedRelationDetails")}</summary>{relationDiagnostics.map((diagnostic) => <p key={`${diagnostic.kind}:${diagnostic.reason}`}>{t(`canvas.skippedRelation.${diagnostic.reason}`, { count: diagnostic.count })}<small>{diagnostic.relationIds?.join(" · ")}</small></p>)}</details>
            ) : null}
            {emptyEdgeReason === "collapsed" ? <Button size="tool" type="button" variant="subtle" onClick={expandAllGroups}>{t("canvas.expandGroup")}</Button> : null}
            {emptyEdgeReason === "view" ? (
              <Button size="tool" type="button" variant="subtle" onClick={() => onSetViewMode(availableView)}>
                {t("canvas.showAvailableRelations")}
              </Button>
            ) : null}
            {emptyEdgeReason === "filters" ? (
              <Button size="tool" type="button" variant="subtle" onClick={() => {
                resetCanvasFilters();
                expandAllGroups();
              }}>
                {t("canvas.clearFilters")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <ReactFlow<FlowWeaveNode, Edge>
            className={`flow-canvas${layoutPending ? " layout-pending" : ""}`}
            edges={localizedEdges}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            maxZoom={1.35}
            minZoom={0.05}
            nodes={visibleNodes}
            nodeTypes={nodeTypes as NodeTypes}
            edgeTypes={canvasEdgeTypes}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            deleteKeyCode={readOnly ? null : "Backspace"}
            onEdgeClick={(_, edge) => onSelectEdge(graphEdgeFromFlow(edge))}
            onConnect={onConnect}
            onEdgesChange={onEdgesChange}
            onNodesChange={(changes) => onNodesChange(changes.filter((change) =>
              !("id" in change) || nodes.some((node) => node.id === change.id)
            ))}
            onInit={(instance) => {
              flowInstance.current = instance;
              fitRequestedNodes(instance);
            }}
            onNodeDoubleClick={(_, node) => {
              if (node.data.syntheticKind === "group") expandGroup(node);
            }}
            onNodeClick={(_, node) => {
              const measurement = (window as StaticGraphMeasurementWindow).__flowweaveStaticGraphMeasurement;
              if (measurement?.collectMetrics) measurement.detailClickStartedAtEpochMs = performance.timeOrigin + performance.now();
              setFocusedNodeId(node.id);
              if (!node.data.syntheticKind) onSelectNode(node.id);
            }}
            onPaneClick={() => {
              setFocusedNodeId("");
              setTraceDirection("off");
              onPaneClick();
            }}
            panOnDrag
            panOnScroll
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--graph-grid)" gap={28} size={1} />
            <Controls position="bottom-left" showInteractive={false}>
              <ControlButton className="canvas-control-auto-layout" disabled={isLayoutRunning || readOnly} title={isLayoutRunning ? t("canvas.layoutRunning") : t("canvas.autoLayout")} aria-label={isLayoutRunning ? t("canvas.layoutRunning") : t("canvas.autoLayout")} onClick={() => void applyAutoLayout()}>
                <LayoutGrid size={14} />
              </ControlButton>
              {canvasLayout.activeMode !== "manual" ? <ControlButton disabled={readOnly} title={t("canvas.restoreManualLayout")} aria-label={t("canvas.restoreManualLayout")} onClick={onRestoreManualLayout}>
                <RotateCcw size={14} />
              </ControlButton> : null}
              {expandedGroupIds.length > 0 ? <ControlButton className="canvas-control-back-overview" title={t("canvas.backToOverview")} aria-label={t("canvas.backToOverview")} onClick={backToOverview}>
                <ArrowLeft size={14} />
              </ControlButton> : null}
            </Controls>
            <MiniMap position="bottom-right" maskColor="var(--minimap-mask)" nodeColor="var(--minimap-node)" pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}

export function canvasEmptyEdgeReason(
  nodeCount: number,
  rawEdgeCount: number,
  projectedEdgeCount: number,
  visibleEdgeCount: number,
  foldedEdgeCount?: number
): "none" | "view" | "filters" | "collapsed" | undefined {
  if (nodeCount === 0 || visibleEdgeCount > 0) return undefined;
  if (rawEdgeCount === 0) return "none";
  if (projectedEdgeCount === 0) return "view";
  if (foldedEdgeCount === 0) return "collapsed";
  return "filters";
}

export function filterCanvasGraph(
  nodes: FlowWeaveNode[],
  edges: Edge[],
  classificationFilters: CanvasFilters,
  selectedGroups: string[]
): { nodes: FlowWeaveNode[]; edges: Edge[] } {
  const matchingNodes = filterCanvasNodes(nodes, classificationFilters);
  const matchingIds = new Set(matchingNodes.map((node) => node.id));
  const matchingEdges = edges.filter((edge) => matchingIds.has(edge.source) && matchingIds.has(edge.target));
  return filterCanvasToModuleGroups(matchingNodes, matchingEdges, selectedGroups);
}

export function countCanvasModules(nodes: FlowWeaveNode[]): number {
  return nodes.filter((node) => node.data.kind === "module" && !node.data.resource && node.data.syntheticKind !== "group").length;
}

export function filterCanvasToModuleGroups(nodes: FlowWeaveNode[], edges: Edge[], selectedGroups: string[]): { nodes: FlowWeaveNode[]; edges: Edge[] } {
  if (selectedGroups.length === 0) return { nodes, edges };
  const selected = new Set(selectedGroups);
  const selectedModuleIds = new Set(nodes.filter((node) =>
    node.data.kind === "module" && !node.data.resource && node.data.origin !== "manual" &&
      (selected.has(nodeGroupKey(node.data)) || !node.data.areaId &&
        node.data.groupPath?.some((group) => selected.has(group.id)))
  ).map((node) => node.id));
  const visibleIds = new Set(nodes.filter((node) => node.data.origin === "manual" || selectedModuleIds.has(node.id)).map((node) => node.id));
  for (const edge of edges) {
    const endpoints = [edge.source, edge.target];
    if (!endpoints.some((id) => selectedModuleIds.has(id))) continue;
    for (const endpoint of endpoints) {
      if (nodes.find((node) => node.id === endpoint)?.data.resource) visibleIds.add(endpoint);
    }
  }
  return {
    nodes: nodes.filter((node) => visibleIds.has(node.id)),
    edges: edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
  };
}

export function localizeCanvasEdgeLabels(edges: Edge[], t: (key: string) => string) {
  return edges.map((edge) => {
    const relation = (edge.data?.relation as GraphEdgeRelation | undefined) ?? "depends_on";
    const label = t(`relation.${relation}Accent`);
    return { ...edge, label: edge.data?.confidence === "inferred" ? `${label} · ${t("canvas.inferred")}` : label };
  });
}

function graphViewMode(mode: CanvasLayoutMode): GraphViewMode { return mode; }

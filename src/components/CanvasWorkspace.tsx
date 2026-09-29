import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeTypes,
  type ReactFlowInstance,
  type NodeChange
} from "@xyflow/react";
import { BrainCircuit, ChevronsDownUp, GitBranch, Search, LayoutGrid, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import type { ArchitectureLayer, ArchitectureRelationDiagnostic, CanvasLayoutMode, CanvasLayoutState, CodeflowCanvas, GraphEdge, GraphEdgeRelation, GraphViewMode, TechnologyStack } from "../types";
import {
  layoutCanvasNodes,
  autoLayoutIsCurrent,
  canvasTopologyFingerprint,
  type TraceDirection
} from "../utils/canvas-layout";
import { filterCanvasNodes, getCanvasFilterResult } from "../utils/canvas-filters";
import { chooseInitialGraphView, nodeConnectionExplanation, projectGraphForView } from "../utils/graph-view-projection";
import type { GraphProjectionDiagnostics } from "../utils/graph-view-projection";
import { relationOptions, relationStyle } from "../utils/relation-styles";
import { Button } from "./Button";

const nodeTypes = {
  moduleNode: ModuleNode,
  groupNode: ModuleNode,
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

export function executionCoverageSummary(diagnostics: GraphProjectionDiagnostics): ExecutionCoverageSummary {
  const percent = diagnostics.executableModuleCount === 0
    ? 100
    : Math.round((diagnostics.connectedExecutableModuleCount / diagnostics.executableModuleCount) * 100);
  return {
    percent,
    hasLimitedEvidence: percent < 100 || diagnostics.unresolvedEventCount > 0 || diagnostics.hiddenDependencyEdgeCount > 0
  };
}

type ControlledFlowCanvasProps = {
  canvasLayout: CanvasLayoutState;
  edges: Edge[];
  nodes: FlowWeaveNode[];
  relationDiagnostics: ArchitectureRelationDiagnostic[];
  quality?: CodeflowCanvas["quality"];
  readOnly: boolean;
  orphanedNodeEdits?: CodeflowCanvas["orphanedNodeEdits"];
  onApplyAutoLayout: (
    mode: CanvasLayoutMode,
    positions: Record<string, { x: number; y: number }>,
    topologyFingerprint: string
  ) => void;
  onConnect: (connection: Connection) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onNodesChange: (changes: NodeChange<FlowWeaveNode>[]) => void;
  onPaneClick: () => void;
  onSelectEdge: (edge: GraphEdge) => void;
  onSelectNode: (nodeId: string) => void;
  onRestoreManualLayout: () => void;
  onSetCollapsedGroups: (groups: string[]) => void;
  onSetViewMode: (mode: GraphViewMode) => void;
};

export function CanvasWorkspace({
  edges,
  nodes,
  relationDiagnostics,
  quality,
  readOnly,
  orphanedNodeEdits,
  onConnect,
  onApplyAutoLayout,
  onEdgesChange,
  onOpenProject,
  onNodesChange,
  onPaneClick,
  onSelectEdge,
  onSelectNode,
  onRestoreManualLayout,
  onSetCollapsedGroups,
  onSetViewMode,
  canvasLayout
}: {
  canvasLayout: CanvasLayoutState;
  edges: Edge[];
  nodes: FlowWeaveNode[];
  relationDiagnostics: ArchitectureRelationDiagnostic[];
  quality?: CodeflowCanvas["quality"];
  readOnly: boolean;
  orphanedNodeEdits?: CodeflowCanvas["orphanedNodeEdits"];
  onConnect: (connection: Connection) => void;
  onApplyAutoLayout: (
    mode: CanvasLayoutMode,
    positions: Record<string, { x: number; y: number }>,
    topologyFingerprint: string
  ) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onOpenProject: () => void;
  onNodesChange: (changes: NodeChange<FlowWeaveNode>[]) => void;
  onPaneClick: () => void;
  onSelectEdge: (edge: GraphEdge) => void;
  onSelectNode: (nodeId: string) => void;
  onRestoreManualLayout: () => void;
  onSetCollapsedGroups: (groups: string[]) => void;
  onSetViewMode: (mode: GraphViewMode) => void;
}) {
  const { t } = useI18n();

  return (
    <main className="canvas-shell">
      <section className="graph-stage" aria-label={t("canvas.graphAria")}>
        <HologridScene />
        <ControlledFlowCanvas
          edges={edges}
          canvasLayout={canvasLayout}
          nodes={nodes}
          relationDiagnostics={relationDiagnostics}
          quality={quality}
          readOnly={readOnly}
          orphanedNodeEdits={orphanedNodeEdits}
          onConnect={onConnect}
          onApplyAutoLayout={onApplyAutoLayout}
          onEdgesChange={onEdgesChange}
          onNodesChange={onNodesChange}
          onPaneClick={onPaneClick}
          onSelectEdge={onSelectEdge}
          onSelectNode={onSelectNode}
          onRestoreManualLayout={onRestoreManualLayout}
          onSetCollapsedGroups={onSetCollapsedGroups}
          onSetViewMode={onSetViewMode}
        />
        {nodes.length === 0 ? (
          <div className="canvas-empty-state">
            <BrainCircuit size={34} />
            <strong>{t("canvas.emptyTitle")}</strong>
            <span>{t("canvas.emptyBody")}</span>
            <Button size="default" variant="primary" type="button" onClick={onOpenProject}>
              {t("project.open")}
            </Button>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function ControlledFlowCanvas({
  canvasLayout,
  edges,
  nodes,
  relationDiagnostics,
  quality,
  readOnly,
  orphanedNodeEdits,
  onConnect,
  onApplyAutoLayout,
  onEdgesChange,
  onNodesChange,
  onPaneClick,
  onSelectEdge,
  onSelectNode,
  onRestoreManualLayout,
  onSetCollapsedGroups,
  onSetViewMode
}: ControlledFlowCanvasProps) {
  /*
   * FlowWeave persists Canvas state in Zustand so autosave and Agent export can use
   * the same graph. Keep the controlled React Flow boundary isolated here.
  */
  const { t } = useI18n();
  const [relationFilter, setRelationFilter] = useState<GraphEdgeRelation | "all">("all");
  const [runtimeFilter, setRuntimeFilter] = useState<TechnologyStack | "all">("all");
  const [roleFilter, setRoleFilter] = useState<ArchitectureLayer | "all">("all");
  const layoutMode: CanvasLayoutMode = canvasLayout.viewMode ?? chooseInitialGraphView(edges.map(graphEdgeFromFlow));
  const [includeInferredDependencyOverlay, setIncludeInferredDependencyOverlay] = useState(false);
  const [traceDirection, setTraceDirection] = useState<TraceDirection | "off">("off");
  const [focusedNodeId, setFocusedNodeId] = useState("");
  const [isLayoutRunning, setIsLayoutRunning] = useState(false);
  const [layoutError, setLayoutError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [focusRequest, setFocusRequest] = useState<string[]>([]);
  const flowInstance = useRef<ReactFlowInstance<FlowWeaveNode> | null>(null);
  const runtimeTags = runtimeFilter === "all" ? [] : [runtimeFilter];
  const rawGraphEdges = useMemo(() => edges.map(graphEdgeFromFlow), [edges]);
  const hasLegacyGeneratedResult = !quality && nodes.some((node) => node.data.origin !== "manual" && node.data.kind === "module");
  const projection = useMemo(
    () => projectGraphForView(
      nodes.map((node) => node.data),
      rawGraphEdges,
      graphViewMode(layoutMode),
      { includeInferredDependencyOverlay }
    ),
    [includeInferredDependencyOverlay, layoutMode, nodes, rawGraphEdges]
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
        ...(readOnly ? { draggable: false, connectable: false } : {}),
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
  }, [canvasLayout.activeMode, canvasLayout.autoLayouts, canvasLayout.manualPositions, edges, layoutMode, nodes, projection, readOnly]);
  const projectedNodes = projectedFlowGraph.nodes;
  const projectedEdges = projectedFlowGraph.edges;
  const executionCoverage = executionCoverageSummary(projection.diagnostics);
  const filterResult = useMemo(
    () => getCanvasFilterResult(projectedNodes, { role: roleFilter, runtimeTags, domain: "all" }),
    [projectedNodes, roleFilter, runtimeTags]
  );
  const filterVisibleNodeIds = useMemo(
    () => new Set(filterCanvasNodes(projectedNodes, { role: roleFilter, runtimeTags, domain: "all" }).map((node) => node.id)),
    [projectedNodes, roleFilter, runtimeTags]
  );
  const collapsedGraph = useMemo(
    () => projectCollapsedFlowGraph(
      projectedNodes.filter((node) => filterVisibleNodeIds.has(node.id)),
      projectedEdges.filter((edge) => filterVisibleNodeIds.has(edge.source) && filterVisibleNodeIds.has(edge.target)),
      layoutMode,
      canvasLayout.collapsedGroups
    ),
    [canvasLayout.collapsedGroups, filterVisibleNodeIds, layoutMode, projectedEdges, projectedNodes]
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
    })), collapsedGraph.edges),
    [canvasLayout.autoLayouts, collapsedGraph, layoutMode]
  );
  const filteredEdges = useMemo(
    () => decoratedCollapsedGraph.edges.filter((edge) => {
      const relation = (edge.data?.relation as GraphEdgeRelation | undefined) ?? "depends_on";
      return (relationFilter === "all" || relation === relationFilter) &&
        collapsedVisibleNodeIds.has(edge.source) &&
        collapsedVisibleNodeIds.has(edge.target) &&
        (!tracedNodeIds || (tracedNodeIds.has(edge.source) && tracedNodeIds.has(edge.target)));
    }),
    [decoratedCollapsedGraph.edges, relationFilter, collapsedVisibleNodeIds, tracedNodeIds]
  );
  const emptyEdgeReason = filterResult.state === "no-matches"
    ? undefined
    : canvasEmptyEdgeReason(nodes.length, rawGraphEdges.length, projection.edges.length, filteredEdges.length, collapsedGraph.nodes.some((node) => node.data.internalEdgeIds?.length) ? collapsedGraph.edges.length : undefined);
  const availableView = chooseInitialGraphView(rawGraphEdges);
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
    [canvasLayout.collapsedGroups, decoratedCollapsedGraph.nodes, collapsedVisibleNodeIds, filteredEdges, rawGraphEdges, t, tracedNodeIds]
  );
  const visibleTopologyFingerprint = useMemo(
    () => canvasTopologyFingerprint(visibleNodes.filter((node) => !node.hidden), filteredEdges),
    [filteredEdges, visibleNodes]
  );
  const layoutPending = canvasLayout.activeMode !== "manual" &&
    !autoLayoutIsCurrent(canvasLayout, layoutMode, visibleTopologyFingerprint);
  const localizedEdges = useMemo(
    () => localizeCanvasEdgeLabels(filteredEdges, t),
    [filteredEdges, t]
  );
  async function applyAutoLayout() {
    const nodesToLayout = visibleNodes.filter((node) => !node.hidden);
    setIsLayoutRunning(true);
    setLayoutError("");
    try {
      const layout = await layoutCanvasNodes(nodesToLayout, filteredEdges, layoutMode);
      onApplyAutoLayout(
        layoutMode,
        Object.fromEntries(layout.map((node) => [node.id, node.position])),
        visibleTopologyFingerprint
      );
    } catch (error) {
      setLayoutError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLayoutRunning(false);
    }
  }
  useEffect(() => {
    if (canvasLayout.activeMode === "manual" || autoLayoutIsCurrent(canvasLayout, layoutMode, visibleTopologyFingerprint)) return;
    let active = true;
    const nodesToLayout = visibleNodes.filter((node) => !node.hidden);
    setIsLayoutRunning(true);
    setLayoutError("");
    void layoutCanvasNodes(nodesToLayout, filteredEdges, layoutMode)
      .then((layout) => {
        if (active) {
          onApplyAutoLayout(
            layoutMode,
            Object.fromEntries(layout.map((node) => [node.id, node.position])),
            visibleTopologyFingerprint
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
  }, [canvasLayout, filteredEdges, layoutMode, onApplyAutoLayout, visibleNodes, visibleTopologyFingerprint]);
  function toggleGroupCollapse() {
    if (layoutMode === "dependency") return;
    const paths = nodes.filter((node) => filterVisibleNodeIds.has(node.id)).map((node) => nodeDisplayGroups(node.data, layoutMode));
    const topGroups = [...new Set(paths.flatMap((path) => path[0] ? [path[0].id] : []))];
    const visibleCollapsed = collapsedGraph.nodes.filter((node) => node.data.groupId).map((node) => node.data.groupId!);
    onSetCollapsedGroups(visibleCollapsed.length > 0
      ? canvasLayout.collapsedGroups.filter((id) => !visibleCollapsed.includes(id))
      : [...canvasLayout.collapsedGroups, ...topGroups]);
  }
  function expandGroup(node: FlowWeaveNode) {
    if (!node.data.groupId) return;
    onSetCollapsedGroups(expandedGroupsForGroup(nodes.map((item) => item.data), layoutMode, node.data.groupId, canvasLayout.collapsedGroups));
    setFocusRequest(node.data.memberNodeIds ?? []);
  }
  function focusModule(node: FlowWeaveNode) {
    setRuntimeFilter("all");
    setRoleFilter("all");
    setRelationFilter("all");
    setTraceDirection("off");
    onSetCollapsedGroups(expandedGroupsForNode(node.data, layoutMode, canvasLayout.collapsedGroups));
    setFocusedNodeId(node.id);
    setFocusRequest([node.id]);
    setSearchQuery("");
    onSelectNode(node.id);
  }
  function fitRequestedNodes(instance: ReactFlowInstance<FlowWeaveNode>) {
    if (focusRequest.length === 0) return;
    const requested = visibleNodes.filter((node) => focusRequest.includes(node.id) || node.data.memberNodeIds?.some((id) => focusRequest.includes(id)));
    if (requested.length > 0) void instance.fitView({ nodes: requested, padding: 0.25, duration: 250 }).then(() => setFocusRequest([]));
  }
  useEffect(() => {
    if (!layoutPending && flowInstance.current) fitRequestedNodes(flowInstance.current);
  }, [layoutPending, focusRequest, visibleTopologyFingerprint]);
  const searchMatches = searchQuery.trim() ? nodes.filter((node) => !node.data.resource &&
    [node.data.title, ...node.data.files].some((text) => text.toLowerCase().includes(searchQuery.trim().toLowerCase()))).slice(0, 8) : [];
  return (
    <div className="canvas-flow-shell">
      <div className="canvas-view-tools">
        <div className="canvas-view-tools-content">
          <div className="canvas-module-search">
            <label>
              <Search size={14} />
              <input aria-label={t("canvas.searchModules")} placeholder={t("canvas.searchModules")} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
            </label>

          </div>
          <Button disabled={isLayoutRunning} icon={<LayoutGrid size={14} />} label={isLayoutRunning ? t("canvas.layoutRunning") : t("canvas.autoLayout")} variant="subtle" type="button" onClick={() => void applyAutoLayout()}>
            <span className="canvas-tool-label">{isLayoutRunning ? t("canvas.layoutRunning") : t("canvas.autoLayout")}</span>
          </Button>
          <Button disabled={canvasLayout.activeMode === "manual"} icon={<RotateCcw size={14} />} label={t("canvas.restoreManualLayout")} variant="subtle" type="button" onClick={onRestoreManualLayout}>
            <span className="canvas-tool-label">{t("canvas.restoreManualLayout")}</span>
          </Button>
          <Button disabled={layoutMode === "dependency"} icon={<ChevronsDownUp size={14} />} label={t("canvas.toggleGroups")} variant="subtle" type="button" onClick={toggleGroupCollapse}>
            <span className="canvas-tool-label">{t("canvas.toggleGroups")}</span>
          </Button>
          {layoutError ? <span className="canvas-layout-error" title={layoutError}>{t("canvas.layoutFailed")}</span> : null}
          <label>
            <span>{t("canvas.layoutMode")}</span>
            <select value={layoutMode} onChange={(event) => {
              const mode = event.target.value as GraphViewMode;
              onSetViewMode(mode);
            }}>
              <option value="execution">{t("canvas.layoutExecution")}</option>
              <option value="dependency">{t("canvas.layoutDependency")}</option>
              <option value="architecture">{t("canvas.layoutArchitecture")}</option>
              <option value="technology">{t("canvas.layoutTechnology")}</option>
              <option value="domain">{t("canvas.layoutFunctional")}</option>
            </select>
          </label>
          {layoutMode === "execution" ? (
            <label className="canvas-inferred-overlay-toggle">
              <input
                checked={includeInferredDependencyOverlay}
                onChange={(event) => setIncludeInferredDependencyOverlay(event.target.checked)}
                type="checkbox"
              />
              <span>{t("canvas.inferredDependencyOverlay")}</span>
            </label>
          ) : null}
          <label>
            <span>{t("canvas.technologyFilter")}</span>
            <select value={runtimeFilter} onChange={(event) => setRuntimeFilter(event.target.value as TechnologyStack | "all")}>
              <option value="all">{t("canvas.filterAll")}</option>
              {(["frontend", "backend", "mobile", "data", "infrastructure", "shared", "unknown"] as TechnologyStack[])
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
          <label>
            <span>{t("canvas.relationFilter")}</span>
            <select value={relationFilter} onChange={(event) => setRelationFilter(event.target.value as GraphEdgeRelation | "all")}>
              <option value="all">{t("canvas.filterAll")}</option>
              {(["depends_on", "calls", "reads_writes", "external_api", "publishes_event", "subscribes_event", "tests"] as GraphEdgeRelation[])
                .map((relation) => <option key={relation} value={relation}>{t(`relation.${relation}`)}</option>)}
            </select>
          </label>
          {focusedNodeId ? (
            <div className="canvas-trace-controls" aria-label={t("canvas.traceControls")}>
              <GitBranch size={14} />
              {(["upstream", "downstream", "all"] as TraceDirection[]).map((direction) => (
                <Button
                  key={direction}
                  aria-pressed={traceDirection === direction}
                  className={traceDirection === direction ? "canvas-trace-active" : undefined}
                  label={t(`canvas.trace${direction[0].toUpperCase()}${direction.slice(1)}`)}
                  size="tool"
                  type="button"
                  variant="subtle"
                  onClick={() => setTraceDirection(direction)}
                >
                  {t(`canvas.trace${direction[0].toUpperCase()}${direction.slice(1)}`)}
                </Button>
              ))}
            </div>
          ) : null}
          {tracedNodeIds ? (
            <Button label={t("canvas.clearTrace")} variant="icon" type="button" onClick={() => {
              setTraceDirection("off");
              setFocusedNodeId("");
            }}>
              <X size={14} />
            </Button>
          ) : null}
        </div>
        {searchQuery.trim() ? (
          <div className="canvas-search-results">
            {searchMatches.length > 0 ? searchMatches.map((node) => (
              <button key={node.id} type="button" onClick={() => focusModule(node)}>{node.data.title}<small>{node.data.files[0]}</small></button>
            )) : <span>{t("canvas.filterEmpty")}</span>}
          </div>
        ) : null}
        {quality || hasLegacyGeneratedResult || orphanedNodeEdits?.length ? (
          <details className="canvas-analysis-status">
            <summary>
              {quality ? t(quality.complete ? "canvas.analysisComplete" : "canvas.analysisIncomplete", { parsed: quality.parsedFiles, eligible: quality.eligibleFiles }) : hasLegacyGeneratedResult ? t("canvas.legacyGeneratedResult") : null}
              {orphanedNodeEdits?.length ? ` · ${t("canvas.unresolvedEdits", { count: orphanedNodeEdits.length })}` : ""}
            </summary>
            {quality ? <p>{t("canvas.analysisQuality", {
              failed: quality.failedFiles, unsupported: quality.unsupportedFiles,
              resolvedImports: quality.resolvedInternalImports, imports: quality.internalImports,
              unresolvedImports: quality.unresolvedInternalImports,
              resolvedCalls: quality.resolvedCalls, calls: quality.calls, ambiguousCalls: quality.ambiguousCalls
            })}</p> : null}
            {hasLegacyGeneratedResult ? <p>{t("canvas.legacyGeneratedDiagnostics")}</p> : null}
            {quality?.factOutcomes?.length ? (
              <table className="canvas-fact-outcomes">
                <thead><tr><th>{t("connection.semanticKinds")}</th><th>{t("canvas.factOutcome")}</th><th>{t("canvas.factCount")}</th></tr></thead>
                <tbody>{quality.factOutcomes.map((fact) => <tr key={`${fact.kind}:${fact.outcome}`} title={fact.relationIds.join(" · ")}><td>{t(`connection.semantic.${fact.kind}`)}</td><td>{t(`canvas.factOutcome.${fact.outcome}`)}</td><td>{fact.count}</td></tr>)}</tbody>
              </table>
            ) : null}
            {orphanedNodeEdits?.map(({ node, reason }) => (
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
              {executionCoverage.hasLimitedEvidence && projection.diagnostics.hiddenDependencyEdgeCount > 0 && !includeInferredDependencyOverlay
                ? ` ${t("canvas.executionEvidenceWarning", { count: projection.diagnostics.hiddenDependencyEdgeCount })}`
                : ""}
            </span>
          </div>
        ) : null}
      </div>
      <div className="canvas-flow-stage">
        <details className="canvas-relation-legend">
          <summary>{t("canvas.relationLegend")}</summary>
          <div>
            {relationOptions.map((relation) => (
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
            {emptyEdgeReason === "collapsed" ? <Button size="tool" type="button" variant="subtle" onClick={() => onSetCollapsedGroups([])}>{t("canvas.expandGroup")}</Button> : null}
            {emptyEdgeReason === "view" ? (
              <Button size="tool" type="button" variant="subtle" onClick={() => onSetViewMode(availableView)}>
                {t("canvas.showAvailableRelations")}
              </Button>
            ) : null}
            {emptyEdgeReason === "filters" ? (
              <Button size="tool" type="button" variant="subtle" onClick={() => {
                setRuntimeFilter("all");
                setRoleFilter("all");
                setRelationFilter("all");
                setTraceDirection("off");
                setFocusedNodeId("");
                onSetCollapsedGroups([]);
              }}>
                {t("canvas.clearFilters")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {filterResult.state === "no-matches" ? (
          <div className="canvas-filter-empty" role="status">
            <span>{t("canvas.filterEmpty")}</span>
            <Button
              label={t("canvas.clearFilters")}
              size="tool"
              type="button"
              variant="subtle"
              onClick={() => {
                setRuntimeFilter("all");
                setRoleFilter("all");
                setRelationFilter("all");
              }}
            >
              {t("canvas.clearFilters")}
            </Button>
          </div>
        ) : null}
        {layoutPending && !layoutError ? (
          <div className="canvas-layout-pending" role="status">{t("canvas.layoutRunning")}</div>
        ) : (
          <ReactFlow<FlowWeaveNode, Edge>
            className="flow-canvas"
            edges={localizedEdges}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            maxZoom={1.35}
            minZoom={0.05}
            nodes={visibleNodes}
            nodeTypes={nodeTypes as NodeTypes}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            onConnect={(connection) => { if (!readOnly) onConnect(connection); }}
            onEdgeClick={(_, edge) => onSelectEdge(graphEdgeFromFlow(edge))}
            onEdgesChange={(changes) => onEdgesChange(readOnly ? changes.filter((change) => change.type === "select") : changes)}
            onNodesChange={(changes) => onNodesChange(changes.filter((change) =>
              (!readOnly || change.type === "select") && (!("id" in change) || nodes.some((node) => node.id === change.id))
            ))}
            onInit={(instance) => {
              flowInstance.current = instance;
              fitRequestedNodes(instance);
            }}
            onNodeDoubleClick={(_, node) => {
              if (node.data.syntheticKind === "group") expandGroup(node);
            }}
            onNodeClick={(_, node) => {
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
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap maskColor="var(--minimap-mask)" nodeColor="var(--minimap-node)" pannable zoomable />
          </ReactFlow>
        )}
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

export function localizeCanvasEdgeLabels(edges: Edge[], t: (key: string) => string) {
  return edges.map((edge) => {
    const relation = (edge.data?.relation as GraphEdgeRelation | undefined) ?? "depends_on";
    const label = t(`relation.${relation}Accent`);
    return { ...edge, label: edge.data?.confidence === "inferred" ? `${label} · ${t("canvas.inferred")}` : label };
  });
}

function graphViewMode(mode: CanvasLayoutMode): GraphViewMode { return mode; }

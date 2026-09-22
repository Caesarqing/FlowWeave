import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeTypes,
  type NodeChange
} from "@xyflow/react";
import { BrainCircuit, ChevronsDownUp, GitBranch, LayoutGrid, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AgentNode } from "./nodes/AgentNode";
import { DiffNode } from "./nodes/DiffNode";
import { DocNode } from "./nodes/DocNode";
import { FileNode } from "./nodes/FileNode";
import { HologridScene } from "./HologridScene";
import { ModuleNode } from "./nodes/ModuleNode";
import { RequirementNode } from "./nodes/RequirementNode";
import { TaskNode } from "./nodes/TaskNode";
import { createFlowEdge, createFlowNode, decorateFlowGraph, graphEdgeFromFlow, type FlowWeaveNode } from "../utils/graph-converters";
import { useI18n } from "../utils/i18n";
import type { ArchitectureLayer, CanvasLayoutMode, CanvasLayoutState, GraphEdgeRelation, GraphViewMode, TechnologyStack } from "../types";
import {
  layoutCanvasNodes,
  nodeGroupKey,
  traceNodeIds,
  type TraceDirection
} from "../utils/canvas-layout";
import { filterCanvasNodes, getCanvasFilterResult } from "../utils/canvas-filters";
import { projectGraphForView } from "../utils/graph-view-projection";
import type { GraphProjectionDiagnostics } from "../utils/graph-view-projection";
import { relationOptions, relationStyle } from "../utils/relation-styles";
import { Button } from "./Button";

const nodeTypes = {
  moduleNode: ModuleNode,
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
  onApplyAutoLayout: (mode: CanvasLayoutMode, positions: Record<string, { x: number; y: number }>) => void;
  onConnect: (connection: Connection) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onNodesChange: (changes: NodeChange<FlowWeaveNode>[]) => void;
  onPaneClick: () => void;
  onSelectEdge: (edgeId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onRestoreManualLayout: () => void;
  onSetCollapsedGroups: (groups: string[]) => void;
};

export function CanvasWorkspace({
  edges,
  nodes,
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
  canvasLayout
}: {
  canvasLayout: CanvasLayoutState;
  edges: Edge[];
  nodes: FlowWeaveNode[];
  onConnect: (connection: Connection) => void;
  onApplyAutoLayout: (mode: CanvasLayoutMode, positions: Record<string, { x: number; y: number }>) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onOpenProject: () => void;
  onNodesChange: (changes: NodeChange<FlowWeaveNode>[]) => void;
  onPaneClick: () => void;
  onSelectEdge: (edgeId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onRestoreManualLayout: () => void;
  onSetCollapsedGroups: (groups: string[]) => void;
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
          onConnect={onConnect}
          onApplyAutoLayout={onApplyAutoLayout}
          onEdgesChange={onEdgesChange}
          onNodesChange={onNodesChange}
          onPaneClick={onPaneClick}
          onSelectEdge={onSelectEdge}
          onSelectNode={onSelectNode}
          onRestoreManualLayout={onRestoreManualLayout}
          onSetCollapsedGroups={onSetCollapsedGroups}
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
  onConnect,
  onApplyAutoLayout,
  onEdgesChange,
  onNodesChange,
  onPaneClick,
  onSelectEdge,
  onSelectNode,
  onRestoreManualLayout,
  onSetCollapsedGroups
}: ControlledFlowCanvasProps) {
  /*
   * FlowWeave persists Canvas state in Zustand so autosave and Agent export can use
   * the same graph. Keep the controlled React Flow boundary isolated here.
  */
  const { t } = useI18n();
  const [relationFilter, setRelationFilter] = useState<GraphEdgeRelation | "all">("all");
  const [runtimeFilter, setRuntimeFilter] = useState<TechnologyStack | "all">("all");
  const [roleFilter, setRoleFilter] = useState<ArchitectureLayer | "all">("all");
  const [layoutMode, setLayoutMode] = useState<CanvasLayoutMode>("execution");
  const [includeInferredDependencyOverlay, setIncludeInferredDependencyOverlay] = useState(false);
  const [traceDirection, setTraceDirection] = useState<TraceDirection | "off">("off");
  const [focusedNodeId, setFocusedNodeId] = useState("");
  const [isLayoutRunning, setIsLayoutRunning] = useState(false);
  const [layoutError, setLayoutError] = useState("");
  const runtimeTags = runtimeFilter === "all" ? [] : [runtimeFilter];
  const projection = useMemo(
    () => projectGraphForView(
      nodes.map((node) => node.data),
      edges.map(graphEdgeFromFlow),
      graphViewMode(layoutMode),
      { includeInferredDependencyOverlay }
    ),
    [edges, includeInferredDependencyOverlay, layoutMode, nodes]
  );
  const projectedFlowGraph = useMemo(() => {
    const originalNodesById = new Map(nodes.map((node) => [node.id, node]));
    const projectedNodes = projection.nodes.map((node) => {
      const original = originalNodesById.get(node.id);
      const savedPosition = canvasLayout.autoLayouts[layoutMode]?.[node.id];
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
    return decorateFlowGraph(projectedNodes, projectedEdges);
  }, [canvasLayout.autoLayouts, edges, layoutMode, nodes, projection]);
  const projectedNodes = projectedFlowGraph.nodes;
  const projectedEdges = projectedFlowGraph.edges;
  const executionCoverage = executionCoverageSummary(projection.diagnostics);
  const tracedNodeIds = useMemo(
    () => focusedNodeId && traceDirection !== "off" ? traceNodeIds(focusedNodeId, projectedEdges, traceDirection) : undefined,
    [projectedEdges, focusedNodeId, traceDirection]
  );
  const filterResult = useMemo(
    () => getCanvasFilterResult(projectedNodes, { role: roleFilter, runtimeTags, domain: "all" }),
    [projectedNodes, roleFilter, runtimeTags]
  );
  const filterVisibleNodeIds = useMemo(
    () => new Set(filterCanvasNodes(projectedNodes, { role: roleFilter, runtimeTags, domain: "all" }).map((node) => node.id)),
    [projectedNodes, roleFilter, runtimeTags]
  );
  const collapsedVisibleNodeIds = useMemo(() => {
    if (layoutMode === "dependency" || canvasLayout.collapsedGroups.length === 0) {
      return filterVisibleNodeIds;
    }
    const representatives = new Map<string, string>();
    for (const node of projectedNodes.filter((item) => filterVisibleNodeIds.has(item.id)).sort((left, right) => left.id.localeCompare(right.id))) {
      const group = nodeGroupKey(node.data, layoutMode);
      if (!representatives.has(group)) representatives.set(group, node.id);
    }
    return new Set(projectedNodes
      .filter((node) => {
        if (!filterVisibleNodeIds.has(node.id)) return false;
        const group = nodeGroupKey(node.data, layoutMode);
        return !canvasLayout.collapsedGroups.includes(group) || representatives.get(group) === node.id;
      })
      .map((node) => node.id));
  }, [canvasLayout.collapsedGroups, filterVisibleNodeIds, layoutMode, projectedNodes]);
  const filteredEdges = useMemo(
    () => projectedEdges.filter((edge) => {
      const relation = (edge.data?.relation as GraphEdgeRelation | undefined) ?? "depends_on";
      return (relationFilter === "all" || relation === relationFilter) &&
        collapsedVisibleNodeIds.has(edge.source) &&
        collapsedVisibleNodeIds.has(edge.target) &&
        (!tracedNodeIds || (tracedNodeIds.has(edge.source) && tracedNodeIds.has(edge.target)));
    }),
    [projectedEdges, relationFilter, collapsedVisibleNodeIds, tracedNodeIds]
  );
  const visibleNodes = useMemo(
    () => projectedNodes.map((node) => ({
      ...node,
      hidden: !collapsedVisibleNodeIds.has(node.id) || Boolean(tracedNodeIds && !tracedNodeIds.has(node.id))
    })),
    [projectedNodes, collapsedVisibleNodeIds, tracedNodeIds]
  );
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
        Object.fromEntries(layout.map((node) => [node.id, node.position]))
      );
    } catch (error) {
      setLayoutError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLayoutRunning(false);
    }
  }
  useEffect(() => {
    if (layoutMode !== "execution" || canvasLayout.activeMode !== "execution" || canvasLayout.autoLayouts.execution) return;
    let active = true;
    const nodesToLayout = visibleNodes.filter((node) => !node.hidden);
    setIsLayoutRunning(true);
    setLayoutError("");
    void layoutCanvasNodes(nodesToLayout, filteredEdges, "execution")
      .then((layout) => {
        if (active) {
          onApplyAutoLayout("execution", Object.fromEntries(layout.map((node) => [node.id, node.position])));
        }
      })
      .catch((error: unknown) => {
        if (active) setLayoutError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setIsLayoutRunning(false);
      });
    return () => { active = false; };
  }, [canvasLayout.activeMode, canvasLayout.autoLayouts.execution, filteredEdges, layoutMode, onApplyAutoLayout, visibleNodes]);
  function toggleGroupCollapse() {
    if (layoutMode === "dependency") return;
    const groups = [...new Set(nodes
      .filter((node) => filterVisibleNodeIds.has(node.id))
      .map((node) => nodeGroupKey(node.data, layoutMode)))];
    const allCollapsed = groups.every((group) => canvasLayout.collapsedGroups.includes(group));
    onSetCollapsedGroups(allCollapsed
      ? canvasLayout.collapsedGroups.filter((group) => !groups.includes(group))
      : [...canvasLayout.collapsedGroups, ...groups]);
  }
  return (
    <div className="canvas-flow-shell">
      <div className="canvas-view-tools">
        <div className="canvas-view-tools-content">
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
            <select value={layoutMode} onChange={(event) => setLayoutMode(event.target.value as CanvasLayoutMode)}>
              <option value="execution">{t("canvas.layoutExecution")}</option>
              <option value="dependency">{t("canvas.layoutDependency")}</option>
              <option value="architecture">{t("canvas.layoutArchitecture")}</option>
              <option value="technology">{t("canvas.layoutTechnology")}</option>
              <option value="domain">{t("canvas.layoutFunctional")}</option>
            </select>
          </label>
          {layoutMode === "execution" ? (
            <>
              <label className="canvas-inferred-overlay-toggle">
                <input
                  checked={includeInferredDependencyOverlay}
                  onChange={(event) => setIncludeInferredDependencyOverlay(event.target.checked)}
                  type="checkbox"
                />
                <span>{t("canvas.inferredDependencyOverlay")}</span>
              </label>
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
            </>
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
        <ReactFlow
          className="flow-canvas"
          edges={localizedEdges}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          maxZoom={1.35}
          minZoom={0.45}
          nodes={visibleNodes}
          nodeTypes={nodeTypes as NodeTypes}
          nodesDraggable
          onConnect={onConnect}
          onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
          onEdgesChange={onEdgesChange}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => {
            setFocusedNodeId(node.id);
            onSelectNode(node.id);
          }}
          onPaneClick={() => {
            setFocusedNodeId("");
            setTraceDirection("off");
            onPaneClick();
          }}
          panOnDrag
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--graph-grid)" gap={28} size={1} />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap maskColor="var(--minimap-mask)" nodeColor="var(--minimap-node)" pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}

export function localizeCanvasEdgeLabels(edges: Edge[], t: (key: string) => string) {
  return edges.map((edge) => {
    const relation = (edge.data?.relation as GraphEdgeRelation | undefined) ?? "depends_on";
    const label = t(`relation.${relation}Accent`);
    return { ...edge, label: edge.data?.confidence === "inferred" ? `${label} · ${t("canvas.inferred")}` : label };
  });
}

function graphViewMode(mode: CanvasLayoutMode): GraphViewMode {
  if (mode === "role") return "architecture";
  if (mode === "runtime") return "technology";
  if (mode === "functional") return "domain";
  return mode;
}

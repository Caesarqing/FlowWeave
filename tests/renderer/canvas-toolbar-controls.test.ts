import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { CanvasWorkspace, filterCanvasGraph } from '../../src/components/CanvasWorkspace';
import { usePreferencesStore } from '../../src/stores/preferences.store';
import { createFlowNode } from '../../src/utils/graph-converters';
import { translate } from '../../src/utils/i18n';
import type { ArchitectureLayer, GraphEdge, GraphNode, TechnologyStack } from '../../src/types';

const previousLocale = usePreferencesStore.getState().locale;

describe('canvas toolbar controls', () => {
  afterEach(() => usePreferencesStore.setState({ locale: previousLocale }));

  it('keeps the filter toolbar compact and visually consistent', () => {
    const source = readSourceText(new URL('../../src/components/CanvasWorkspace.tsx', import.meta.url));
    const styles = readSourceText(new URL('../../src/styles.css', import.meta.url));

    expect(source).not.toContain('<select multiple');
    expect(source).not.toContain('canvas.functionalFilter');
    expect(source).not.toContain('canvas.traceOff');
    expect(source).toContain('proOptions={{ hideAttribution: true }}');
    expect(source).toContain('canvas-trace-controls');
    expect(styles).toContain('.canvas-view-tools-content {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  justify-content: center;');
    expect(styles).toContain('.canvas-view-tools {\n  position: relative;');
  });

  it('uses the persisted functional view and keeps secondary relations optional', () => {
    const source = readSourceText(new URL('../../src/components/CanvasWorkspace.tsx', import.meta.url));

    expect(source).toContain('canvasLayout.viewMode ?? chooseInitialGraphView(edges.map(graphEdgeFromFlow))');
    expect(source).toContain('onSetViewMode(mode)');
    expect(source).toContain('if (!layoutReadyForViewport || !(layoutPending || layoutNeedsRefresh)) return;');
    expect(source).toContain('<option value="execution">');
    expect(source).toContain('canvas.relationDisplay');
    expect(source).toContain('canvas.moduleScope');
    expect(source).toContain('canvas.moduleGroups');
    expect(source).toContain('canvas.additionalRelations');
    expect(source).not.toContain('canvas.inferredDependencyOverlay');
    expect(source).toContain('className={`canvas-layout-pending${layoutError ? " has-error" : ""}`}');
    expect(source).toContain('className={`flow-canvas${layoutPending ? " layout-pending" : ""}`}');
    expect(source).toContain('projectGraphForView(');
  });

  it('wires role and technology filters into the graph while retaining area and relation filters', () => {
    const source = readSourceText(new URL('../../src/components/CanvasWorkspace.tsx', import.meta.url));
    const nodes = [
      createFlowNode(classifiedNode('billing-api', 'billing', 'api', ['backend'])),
      createFlowNode(classifiedNode('billing-ui', 'billing', 'presentation', ['frontend'])),
      createFlowNode(classifiedNode('account-api', 'account', 'api', ['backend']))
    ];
    const edges: GraphEdge[] = [
      { id: 'billing-call', source: 'billing-api', target: 'billing-ui', relation: 'calls', confidence: 'confirmed', evidence: [] },
      { id: 'account-call', source: 'account-api', target: 'billing-api', relation: 'calls', confidence: 'confirmed', evidence: [] }
    ];

    expect(source).toContain('canvas.technologyFilter');
    expect(source).toContain('canvas.layerFilter');
    expect(source).toContain('filterCanvasGraph(');
    expect(source).toContain('canvas.moduleScope');
    expect(source).toContain('canvas.relationDisplay');
    expect(filterCanvasGraph(nodes, edges, { role: 'api', runtimeTags: ['backend'], domain: 'all' }, ['area:billing']))
      .toMatchObject({ nodes: [{ id: 'billing-api' }], edges: [] });

    usePreferencesStore.setState({ locale: 'en' });
    const markup = renderToStaticMarkup(createElement(CanvasWorkspace, {
      readOnly: false,
      canvasLayout: { activeMode: 'execution', manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
      hiddenGeneratedCount: 0,
      generatedAt: '2026-10-05T00:00:00.000Z',
      edges: [],
      isProjectLoading: false,
      nodes,
      relationDiagnostics: [],
      onApplyAutoLayout: () => undefined,
      onConnect: () => undefined,
      onEdgesChange: () => undefined,
      onOpenProject: () => undefined,
      onNodesChange: () => undefined,
      onPaneClick: () => undefined,
      onSelectEdge: () => undefined,
      onSelectNode: () => undefined,
      onRestoreManualLayout: () => undefined,
      onRestoreGeneratedItems: async () => undefined,
      onResolveMigrationItem: async () => { throw new Error('Not used by toolbar rendering.'); },
      onSetCollapsedGroups: () => undefined,
      onSetViewMode: () => undefined
    }));
    expect(markup).toContain(translate('en', 'canvas.technologyFilter'));
    expect(markup).toContain(translate('en', 'canvas.layerFilter'));
    expect(markup).toContain(translate('en', 'canvas.moduleScope'));
    expect(markup).toContain(translate('en', 'canvas.relationDisplay'));
  });

  it('keeps cached positions visible while recalculating stale view layouts', () => {
    const source = readSourceText(new URL('../../src/components/CanvasWorkspace.tsx', import.meta.url));
    const layoutEffect = source.split('if (!layoutReadyForViewport || !(layoutPending || layoutNeedsRefresh)) return;')[1]?.split('  }, [decoratedLayoutGraph.nodes')[0];

    expect(source).toContain('layoutGraph.nodes.some((node) =>');
    expect(source).toContain('node.data.origin !== "manual" && !canvasLayout.autoLayouts[layoutMode]?.[node.id]');
    expect(source).toContain('!autoLayoutIsCurrent(canvasLayout, layoutMode, layoutTopologyFingerprint)');
    expect(layoutEffect).toContain('layoutTopologyFingerprint');
    expect(layoutEffect).not.toContain('visibleTopologyFingerprint');
  });

  it('relayouts expanded groups locally and offers whole-graph arrange only when local placement fails', () => {
    const source = readSourceText(new URL('../../src/components/CanvasWorkspace.tsx', import.meta.url));

    expect(source).toContain('queueLocalExpansion([node]);');
    expect(source).toContain('layoutExpandedCanvasNodes(');
    expect(source).toContain('kind: "collapse"');
    expect(source).toContain('setLocalLayoutSpaceInsufficient(localNodes === undefined)');
    expect(source).toContain('canvas.localLayoutSpaceInsufficient');
  });

  it('measures the actual view, rejects stale layout work, and exposes group navigation to keyboard users', () => {
    const source = readSourceText(new URL('../../src/components/CanvasWorkspace.tsx', import.meta.url));

    expect(source).toContain('new ResizeObserver(');
    expect(source).toContain('observer.observe(element)');
    expect(source).toContain('selectOverviewFrontier({');
    expect(source).toContain('matchesOverviewIdentity(requestIdentity, currentViewIdentity.current)');
    expect(source).toContain('pendingGroupFocus.current');
    expect(source).toContain('window.requestAnimationFrame(() => {');
    expect(source).toContain('target.data.syntheticKind === "group"');
    expect(source).toContain('targetElement.querySelector<HTMLElement>("button")');
    expect(source).toContain('document.activeElement === focusTarget');
    expect(source).toContain('event.key !== "Escape"');
    expect(source).toContain('overviewFocusGroupNodeId.current = node.id');
    expect(source).toContain('pendingGroupFocus.current = focusNodeId ? [focusNodeId] : []');
    expect(source).toContain('canvas.backToOverview');
    expect(source).toContain('onClick={backToOverview}');
    expect(source).not.toContain('INITIAL_NODE_BUDGET');
  });

  it('reports filter matches and moves keyboard focus from search to the selected module', () => {
    const source = readSourceText(new URL('../../src/components/CanvasWorkspace.tsx', import.meta.url));

    expect(source).toContain('canvas.filterMatches');
    expect(source).toContain('countCanvasModules(filteredProjectionGraph.nodes)');
    expect(source).toContain('role="status"');
    expect(source).toContain('pendingGroupFocus.current = [node.id]');
  });

  it('offers the existing auto-layout action from the insufficient-space warning', () => {
    const source = readSourceText(new URL('../../src/components/CanvasWorkspace.tsx', import.meta.url));
    const warning = source.split('<div className="canvas-readability-warning"')[1]?.split('</div>')[0];

    expect(warning).toContain('onClick={() => void applyAutoLayout()}');
  });
});

function readSourceText(path: URL): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function classifiedNode(
  id: string,
  domain: string,
  role: ArchitectureLayer,
  runtimeTags: TechnologyStack[]
): GraphNode {
  return {
    id, title: id, subtitle: id, kind: 'module', nodeType: 'service', risk: 'unknown', description: id,
    files: [`src/${domain}/${id}.ts`], guidanceDraft: '', status: 'mapped', x: 0, y: 0,
    areaId: `area:${domain}`, classification: { role, runtimeTags, domain }
  };
}

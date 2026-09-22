import { describe, expect, it } from 'vitest';
import { filterCanvasNodes, getCanvasFilterResult } from '../../src/utils/canvas-filters';
import type { GraphNode } from '../../src/types';
import { createFlowNode, decorateFlowGraph, graphEdgeFromFlow, projectCollapsedFlowGraph } from '../../src/utils/graph-converters';

describe('canvas filters', () => {
  it('keeps a mixed frontend/backend module visible in the frontend filter', () => {
    const nodes = [createFlowNode(node('full-stack', ['src/App.tsx', 'server/app.py']))];

    expect(filterCanvasNodes(nodes, 'frontend', 'all').map((item) => item.id)).toEqual(['full-stack']);
  });

  it('identifies an empty filter result separately from an empty canvas', () => {
    const nodes = [createFlowNode(node('backend', ['server/app.py']))];

    expect(getCanvasFilterResult(nodes, 'frontend', 'all')).toBe('no-matches');
    expect(getCanvasFilterResult([], 'frontend', 'all')).toBe('empty-canvas');
  });

  it('combines role, runtime tags, and domain filters with explanatory zero results', () => {
    const nodes = [
      createFlowNode({ ...node('account-web', ['src/features/account/view.tsx', 'server/account.py']), classification: {
        role: 'presentation', runtimeTags: ['frontend', 'backend'], domain: 'account'
      } }),
      createFlowNode({ ...node('billing-api', ['src/features/billing/api.ts']), classification: {
        role: 'api', runtimeTags: ['backend'], domain: 'billing'
      } })
    ];

    expect(filterCanvasNodes(nodes, { role: 'presentation', runtimeTags: ['backend'], domain: 'account' }).map((item) => item.id)).toEqual(['account-web']);
    expect(getCanvasFilterResult(nodes, { role: 'presentation', runtimeTags: ['backend'], domain: 'billing' })).toEqual({
      state: 'no-matches',
      cause: 'combination'
    });
  });

  it('projects connections from collapsed groups to their stable representative', () => {
    const nodes = [
      createFlowNode({ ...node('billing-api', ['src/billing/api.ts']), classification: { role: 'api', runtimeTags: ['backend'], domain: 'billing' } }),
      createFlowNode({ ...node('billing-service', ['src/billing/service.ts']), classification: { role: 'domain', runtimeTags: ['backend'], domain: 'billing' } }),
      createFlowNode({ ...node('ledger', ['src/ledger.ts']), classification: { role: 'data', runtimeTags: ['data'], domain: 'ledger' } })
    ];
    const edges = [
      flowEdge('api-ledger', 'billing-api', 'ledger', 'reads_writes'),
      flowEdge('service-ledger', 'billing-service', 'ledger', 'reads_writes')
    ];

    const projected = projectCollapsedFlowGraph(nodes, edges, 'domain', ['domain:billing']);

    expect(projected.nodes.map((item) => item.id)).toEqual(['billing-api', 'ledger']);
    expect(projected.edges).toHaveLength(1);
    expect(projected.edges[0]).toMatchObject({ source: 'billing-api', target: 'ledger' });
    expect(projected.edges[0].data?.aggregatedEdgeIds).toEqual(['api-ledger', 'service-ledger']);
  });

  it('removes original endpoint handles before an aggregated edge is decorated for its representative', () => {
    const nodes = [
      createFlowNode({ ...node('billing-api', ['src/billing/api.ts']), classification: { role: 'api', runtimeTags: ['backend'], domain: 'billing' } }),
      createFlowNode({ ...node('billing-service', ['src/billing/service.ts']), classification: { role: 'domain', runtimeTags: ['backend'], domain: 'billing' } }),
      createFlowNode({ ...node('ledger', ['src/ledger.ts']), classification: { role: 'data', runtimeTags: ['data'], domain: 'ledger' } })
    ];
    const decorated = decorateFlowGraph(nodes, [flowEdge('service-ledger', 'billing-service', 'ledger', 'reads_writes')]);

    const projected = projectCollapsedFlowGraph(decorated.nodes, decorated.edges, 'domain', ['domain:billing']);

    expect(projected.edges[0]).not.toHaveProperty('sourceHandle');
    expect(projected.edges[0]).not.toHaveProperty('targetHandle');
    expect(graphEdgeFromFlow(projected.edges[0]).aggregatedEdgeIds).toEqual(['service-ledger']);
  });

  it('restores original edges when groups are expanded without mutating the graph', () => {
    const nodes = [createFlowNode(node('one', ['src/one.ts'])), createFlowNode(node('two', ['src/two.ts']))];
    const edges = [flowEdge('one-two', 'one', 'two', 'calls')];
    const original = structuredClone(edges);

    const projected = projectCollapsedFlowGraph(nodes, edges, 'architecture', []);

    expect(projected.edges).toEqual(edges);
    expect(edges).toEqual(original);
  });
});

function flowEdge(id: string, source: string, target: string, relation: 'calls' | 'reads_writes') {
  return {
    id,
    source,
    target,
    data: { relation, evidence: [{ filePath: `${id}.ts`, detail: id }] }
  };
}

function node(id: string, files: string[]): GraphNode {
  return {
    id,
    title: id,
    subtitle: id,
    kind: 'module',
    nodeType: 'module',
    risk: 'normal',
    description: id,
    files,
    guidanceDraft: '',
    status: 'mapped',
    x: 0,
    y: 0
  };
}

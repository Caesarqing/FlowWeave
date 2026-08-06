import { describe, expect, it } from 'vitest';
import { filterCanvasNodes, getCanvasFilterResult } from '../../src/utils/canvas-filters';
import type { GraphNode } from '../../src/types';
import { createFlowNode } from '../../src/utils/graph-converters';

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
});

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

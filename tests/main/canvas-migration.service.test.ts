import { describe, expect, it } from 'vitest';
import { reconcileGeneratedCanvas } from '../../src/main/services/canvas-migration.service';
import type { CodeflowCanvas } from '../../src/types';

describe('canvas v5 reconciliation', () => {
  it('discards every legacy Canvas field when a project scan rebuilds v5', () => {
    const legacy = {
      ...canvasFixture({
      layout: {
        activeMode: 'role',
        manualPositions: { api: { x: 12, y: 24 } },
        autoLayouts: { role: { api: { x: 4, y: 8 } } },
        collapsedGroups: []
      },
      nodes: [{
        id: 'legacy-note', title: 'Legacy note', subtitle: '', kind: 'doc', nodeType: 'doc', risk: 'unknown', description: '',
        files: [], guidanceDraft: 'discard me', status: 'mapped', x: 12, y: 24, origin: 'manual'
      }],
      edges: [{ id: 'legacy-edge', source: 'legacy-note', target: 'gone', relation: 'calls', origin: 'manual' }]
      }),
      version: 4
    } as unknown as CodeflowCanvas;
    const generated = canvasFixture({
      version: 5,
      nodes: [{
        id: 'api', title: 'API', subtitle: '', kind: 'module', nodeType: 'api', risk: 'unknown', description: '',
        files: [], guidanceDraft: '', status: 'mapped', x: 0, y: 0, origin: 'generated'
      }],
      edges: [],
      orphanedEdges: []
    });

    const rebuilt = reconcileGeneratedCanvas(generated, legacy);

    expect(rebuilt).toBe(generated);
    expect(rebuilt.nodes).toEqual(generated.nodes);
    expect(rebuilt.edges).toEqual([]);
    expect(rebuilt.layout?.activeMode).toBe('manual');
    expect(rebuilt.orphanedEdges).toEqual([]);
  });

  it('keeps manual nodes, edges, layout, and orphaned edges from an existing v5 Canvas', () => {
    const existing = canvasFixture({
      version: 5,
      layout: { activeMode: 'manual', manualPositions: { api: { x: 99, y: 88 } }, autoLayouts: {}, collapsedGroups: [] },
      nodes: [
        { id: 'api', title: 'API', subtitle: '', kind: 'module', nodeType: 'api', risk: 'unknown', description: '', files: [], guidanceDraft: '', status: 'mapped', x: 0, y: 0, origin: 'generated' },
        { id: 'note', title: 'Note', subtitle: '', kind: 'doc', nodeType: 'doc', risk: 'unknown', description: '', files: [], guidanceDraft: '', status: 'mapped', x: 0, y: 0, origin: 'manual' }
      ],
      edges: [{ id: 'manual-link', source: 'note', target: 'api', relation: 'depends_on', origin: 'manual' }],
      orphanedEdges: [{ id: 'orphan', source: 'note', target: 'removed', relation: 'calls', origin: 'manual' }]
    });
    const generated = canvasFixture({ version: 5, nodes: [existing.nodes[0]], edges: [] });

    const merged = reconcileGeneratedCanvas(generated, existing);

    expect(merged.nodes.map((node) => node.id)).toEqual(['api', 'note']);
    expect(merged.edges).toEqual([expect.objectContaining({ id: 'manual-link' })]);
    expect(merged.layout?.manualPositions.api).toEqual({ x: 99, y: 88 });
    expect(merged.orphanedEdges).toEqual([expect.objectContaining({ id: 'orphan' })]);
  });
});

function canvasFixture(overrides: Partial<CodeflowCanvas>): CodeflowCanvas {
  return {
    version: 5,
    id: 'main',
    title: 'Main',
    projectPath: '/project',
    generatedAt: '2026-09-22T00:00:00.000Z',
    layout: { activeMode: 'manual', manualPositions: {}, autoLayouts: {}, collapsedGroups: [] },
    nodes: [{ id: 'api', title: 'API', subtitle: 'API', kind: 'module', nodeType: 'api', risk: 'unknown', description: '', files: [], guidanceDraft: 'keep it', status: 'mapped', x: 0, y: 0 }],
    edges: [],
    ...overrides
  };
}

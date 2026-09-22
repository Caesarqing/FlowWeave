import { describe, expect, it } from 'vitest';
import { buildModuleDisplaySummary, relationDisplayTitle } from '../../src/components/ModulePanel';
import type { GraphEdge, GraphNode } from '../../src/types';

describe('module panel presentation', () => {
  it('summarizes entry symbols, directional relation counts, and evidence state', () => {
    const node = graphNode('service', 'A very long service title that stays descriptive');
    const edges: GraphEdge[] = [
      { id: 'in', source: 'api', target: 'service', relation: 'calls', evidence: [{ detail: 'call' }] },
      { id: 'out', source: 'service', target: 'db', relation: 'reads_writes' }
    ];

    expect(buildModuleDisplaySummary(node, edges)).toEqual({ entrySymbol: 'handleRequest', upstreamCount: 1, downstreamCount: 1, evidenceState: 'partial' });
  });

  it('uses module titles for relation display', () => {
    const names = new Map([['api', 'Public API'], ['service', 'Billing Service']]);

    expect(relationDisplayTitle({ id: 'edge', source: 'api', target: 'service', relation: 'calls' }, names)).toBe('Public API -> Billing Service');
  });
});

function graphNode(id: string, title: string): GraphNode {
  return { id, title, subtitle: '', kind: 'module', nodeType: 'service', risk: 'unknown', description: '', files: [], guidanceDraft: '', status: 'mapped', x: 0, y: 0, symbols: [{ name: 'handleRequest', kind: 'function', filePath: 'service.ts', role: 'entry' }] };
}

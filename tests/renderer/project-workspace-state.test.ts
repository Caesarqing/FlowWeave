import { describe, expect, it } from 'vitest';
import {
  capturePersistedProjectWorkspaceContext,
  captureProjectWorkspaceState,
  clearProjectWorkspaceState,
  restorePersistedProjectWorkspaceContext,
  restoreProjectWorkspaceState
} from '../../src/stores/project-workspace-state';
import { useAgentStore } from '../../src/stores/agents.store';
import { useCanvasStore } from '../../src/stores/canvas.store';
import { useNavigationStore } from '../../src/stores/navigation.store';
import { useProjectStore } from '../../src/stores/project.store';
import { useGitStore } from '../../src/stores/git.store';
import { useRunsStore } from '../../src/stores/runs.store';
import type { GraphNode } from '../../src/types';

describe('project workspace state', () => {
  it('retains relationship diagnostics in source and display nodes across snapshot restoration', () => {
    const node: GraphNode = {
      id: 'orders', title: 'Orders', subtitle: '', kind: 'module', nodeType: 'service', risk: 'unknown',
      description: '', files: ['src/orders.ts'], guidanceDraft: '', status: 'mapped', x: 0, y: 0, origin: 'generated',
      relationSummary: { dependencies: 1, internalRelations: 2, unresolvedRelations: 1, externalRelations: 0 },
      relationDiagnostics: [{ code: 'dynamic-call', severity: 'warning', message: 'Receiver cannot be resolved.', filePath: 'src/orders.ts', relationId: 'call-1', range: { start: { line: 8, column: 12 }, end: { line: 8, column: 20 } } }]
    };
    useCanvasStore.getState().setGraph([node], [], []);
    const snapshot = captureProjectWorkspaceState();
    clearProjectWorkspaceState();
    restoreProjectWorkspaceState(snapshot);
    expect(useCanvasStore.getState().modules[0]).toEqual(node);
    expect(useCanvasStore.getState().nodes[0].data.relationSummary).toEqual(node.relationSummary);
    expect(useCanvasStore.getState().nodes[0].data.relationDiagnostics).toEqual(node.relationDiagnostics);
    expect(useCanvasStore.getState().quality).toBeUndefined();
  });

  it('clears project-specific Agent and plugin state when no snapshot is available', () => {
    useAgentStore.setState({
      agents: [{
        id: 'codex-local',
        name: 'Codex',
        kind: 'cli',
        command: 'codex',
        args: [],
        capabilities: ['implementation-plan'],
        description: 'Codex CLI',
        builtIn: true,
        createdAt: 'builtin',
        updatedAt: 'builtin'
      }],
      pluginStatuses: [{
        pluginId: 'flowweave',
        hostId: 'codex',
        displayName: 'Codex',
        status: 'installed',
        bundledVersion: '1.0.0',
        installTarget: '/project/.agents',
        message: 'Installed'
      }],
      toolStatuses: {
        'codex-local': {
          toolId: 'codex-local',
          available: true,
          method: 'cli',
          checking: false
        }
      }
    });

    clearProjectWorkspaceState();

    expect(useAgentStore.getState().agents).toEqual([]);
    expect(useAgentStore.getState().pluginStatuses).toEqual([]);
    expect(useAgentStore.getState().toolStatuses).toEqual({});
  });

  it('restores independent project, canvas, and page state after switching projects', () => {
    useProjectStore.setState({ projectId: 'project-a', projectLabel: 'Alpha', projectPath: '/alpha', legacyCanvasReadOnly: true });
    useCanvasStore.setState({
      selectedNodeId: 'alpha-node', expandedPaths: new Set(['src']),
      groups: [{ id: 'group:alpha', title: 'Alpha', rootPath: 'alpha', moduleIds: ['alpha-node'] }],
      orphanedEdges: [{ id: 'pending-edge', source: 'alpha-node', target: 'gone', relation: 'calls', origin: 'manual' }],
      orphanedNodeEdits: [{ reason: 'removed', node: { id: 'gone', title: 'Gone', subtitle: '', kind: 'module', nodeType: 'module', risk: 'unknown', description: '', files: [], guidanceDraft: 'Preserved instructions', status: 'mapped', x: 0, y: 0 } }]
    });
    useNavigationStore.setState({ activePage: 'docs' });
    useGitStore.setState({ checkpointId: 'alpha-checkpoint' });
    useAgentStore.setState({
      pluginStatuses: [{
        pluginId: 'flowweave',
        hostId: 'codex',
        displayName: 'Codex',
        status: 'installed',
        bundledVersion: '1.0.0',
        installTarget: '/alpha/.agents',
        message: 'Installed'
      }]
    });
    const alpha = captureProjectWorkspaceState();

    useProjectStore.setState({ projectId: 'project-b', projectLabel: 'Beta', projectPath: '/beta', legacyCanvasReadOnly: false });
    useCanvasStore.setState({ selectedNodeId: 'beta-node', expandedPaths: new Set(['app']), groups: [], orphanedEdges: [], orphanedNodeEdits: [] });
    useNavigationStore.setState({ activePage: 'tools' });
    useGitStore.setState({ checkpointId: 'beta-checkpoint' });
    useAgentStore.setState({ pluginStatuses: [] });
    const beta = captureProjectWorkspaceState();

    restoreProjectWorkspaceState(alpha);
    expect(useProjectStore.getState().projectId).toBe('project-a');
    expect(useProjectStore.getState().legacyCanvasReadOnly).toBe(true);
    expect(useCanvasStore.getState().selectedNodeId).toBe('alpha-node');
    expect(useCanvasStore.getState().groups[0].id).toBe('group:alpha');
    expect(useCanvasStore.getState().orphanedEdges[0].id).toBe('pending-edge');
    expect(useCanvasStore.getState().orphanedNodeEdits[0].node.guidanceDraft).toBe('Preserved instructions');
    expect(useCanvasStore.getState().expandedPaths).toEqual(new Set(['src']));
    expect(useNavigationStore.getState().activePage).toBe('docs');
    expect(useGitStore.getState().checkpointId).toBe('alpha-checkpoint');
    expect(useAgentStore.getState().pluginStatuses).toEqual([
      expect.objectContaining({ hostId: 'codex', installTarget: '/alpha/.agents' })
    ]);

    restoreProjectWorkspaceState(beta);
    expect(useProjectStore.getState().projectId).toBe('project-b');
    expect(useProjectStore.getState().legacyCanvasReadOnly).toBe(false);
    expect(useCanvasStore.getState().selectedNodeId).toBe('beta-node');
    expect(useNavigationStore.getState().activePage).toBe('tools');
    expect(useGitStore.getState().checkpointId).toBe('beta-checkpoint');
  });

  it('captures and restores only the durable project workspace context', () => {
    useCanvasStore.setState({
      expandedPaths: new Set(['src', 'src/features']),
      selectedNodeId: 'feature-node'
    });
    useNavigationStore.setState({ activePage: 'tools' });
    useAgentStore.setState({ selectedAgentId: 'codex-local', executionMode: 'execute' });
    useRunsStore.setState({ selectedRunId: 'run-42', runArtifactTab: 'result' });
    useGitStore.setState({ checkpointId: 'checkpoint-42', diff: { files: [] } as never });

    const context = capturePersistedProjectWorkspaceContext();

    expect(context).toEqual({
      activePage: 'tools',
      expandedPaths: ['src', 'src/features'],
      selectedNodeId: 'feature-node',
      selectedAgentId: 'codex-local',
      executionMode: 'execute',
      selectedRunId: 'run-42',
      runArtifactTab: 'result',
      checkpointId: 'checkpoint-42'
    });
    expect(context).not.toHaveProperty('diff');

    useCanvasStore.setState({ expandedPaths: new Set(), selectedNodeId: '' });
    useNavigationStore.setState({ activePage: 'canvas' });
    useAgentStore.setState({ selectedAgentId: 'claude-code', executionMode: 'plan' });
    useRunsStore.setState({ selectedRunId: '', runArtifactTab: 'plan' });
    useGitStore.setState({ checkpointId: '' });

    restorePersistedProjectWorkspaceContext(context);

    expect(useCanvasStore.getState().expandedPaths).toEqual(new Set(['src', 'src/features']));
    expect(useCanvasStore.getState().selectedNodeId).toBe('feature-node');
    expect(useNavigationStore.getState().activePage).toBe('tools');
    expect(useAgentStore.getState().selectedAgentId).toBe('codex-local');
    expect(useAgentStore.getState().executionMode).toBe('execute');
    expect(useRunsStore.getState().selectedRunId).toBe('run-42');
    expect(useRunsStore.getState().runArtifactTab).toBe('result');
    expect(useGitStore.getState().checkpointId).toBe('checkpoint-42');
  });
});

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

describe('project workspace state', () => {
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
    useProjectStore.setState({ projectId: 'project-a', projectLabel: 'Alpha', projectPath: '/alpha' });
    useCanvasStore.setState({ selectedNodeId: 'alpha-node', expandedPaths: new Set(['src']) });
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

    useProjectStore.setState({ projectId: 'project-b', projectLabel: 'Beta', projectPath: '/beta' });
    useCanvasStore.setState({ selectedNodeId: 'beta-node', expandedPaths: new Set(['app']) });
    useNavigationStore.setState({ activePage: 'tools' });
    useGitStore.setState({ checkpointId: 'beta-checkpoint' });
    useAgentStore.setState({ pluginStatuses: [] });
    const beta = captureProjectWorkspaceState();

    restoreProjectWorkspaceState(alpha);
    expect(useProjectStore.getState().projectId).toBe('project-a');
    expect(useCanvasStore.getState().selectedNodeId).toBe('alpha-node');
    expect(useCanvasStore.getState().expandedPaths).toEqual(new Set(['src']));
    expect(useNavigationStore.getState().activePage).toBe('docs');
    expect(useGitStore.getState().checkpointId).toBe('alpha-checkpoint');
    expect(useAgentStore.getState().pluginStatuses).toEqual([
      expect.objectContaining({ hostId: 'codex', installTarget: '/alpha/.agents' })
    ]);

    restoreProjectWorkspaceState(beta);
    expect(useProjectStore.getState().projectId).toBe('project-b');
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

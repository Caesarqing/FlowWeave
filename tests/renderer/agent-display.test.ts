import { describe, expect, it } from 'vitest';
import { sortAgentsForSelection } from '../../src/utils/agent-display';
import type { AgentDefinition, ToolUiStatus } from '../../src/types';

describe('agent selection display', () => {
  it('places detected agents before unavailable agents while preserving name order within each group', () => {
    const agents = [agent('zeta'), agent('alpha'), agent('beta')];
    const statuses: Record<string, ToolUiStatus> = {
      'custom:zeta': status('custom:zeta', false),
      'custom:alpha': status('custom:alpha', true),
      'custom:beta': status('custom:beta', true)
    };

    expect(sortAgentsForSelection(agents, statuses).map((item) => item.id)).toEqual(['custom:alpha', 'custom:beta', 'custom:zeta']);
  });
});

function agent(id: string): AgentDefinition {
  return {
    id: `custom:${id}`,
    name: id,
    kind: 'cli',
    command: id,
    protocol: 'cli-stdin',
    protocolVersion: 1,
    capabilities: ['implementation-plan'],
    builtIn: false
  };
}

function status(toolId: `custom:${string}`, available: boolean): ToolUiStatus {
  return { toolId, available, method: available ? 'path' : 'none', checking: false };
}

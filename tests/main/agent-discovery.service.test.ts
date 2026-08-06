import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { AgentDefinition, ToolDetectionResult } from '../../src/types';
import { discoverAgentDefinitions } from '../../src/main/services/agent-discovery.service';
import {
  configureAgentRegistry,
  getAgentDefinition,
  registerDiscoveredAgentDefinitions
} from '../../src/main/services/agent-registry.service';

const builtin: AgentDefinition = {
  id: 'codex-local',
  name: 'Codex CLI',
  kind: 'cli',
  protocol: 'cli-stdin',
  command: 'codex',
  args: [],
  capabilities: ['implementation-plan'],
  description: 'Builtin',
  builtIn: true,
  createdAt: 'builtin',
  updatedAt: 'builtin'
};

describe('agent-discovery.service', () => {
  it('keeps project manifest definitions isolated by project id', async () => {
    configureAgentRegistry(await mkdtemp(join(tmpdir(), 'flowweave-agent-registry-')));
    const projectA = manifest({ id: 'custom:reviewer', name: 'Project A reviewer', command: 'review-a' });
    const projectB = manifest({ id: 'custom:reviewer', name: 'Project B reviewer', command: 'review-b' });

    registerDiscoveredAgentDefinitions('project-a', [projectA]);
    registerDiscoveredAgentDefinitions('project-b', [projectB]);

    await expect(getAgentDefinition('custom:reviewer', 'project-a')).resolves.toMatchObject({ command: 'review-a' });
    await expect(getAgentDefinition('custom:reviewer', 'project-b')).resolves.toMatchObject({ command: 'review-b' });
  });

  it('discovers builtins and safe user/project manifests with project override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowweave-agent-discovery-'));
    const projectPath = join(root, 'project');
    const userManifestRoot = join(root, 'agents', 'connectors');
    const projectManifestRoot = join(projectPath, '.flowweave', 'agent-connectors');
    await mkdir(userManifestRoot, { recursive: true });
    await mkdir(projectManifestRoot, { recursive: true });
    await writeFile(join(userManifestRoot, 'reviewer.json'), JSON.stringify(manifest({
      id: 'custom:reviewer', name: 'User reviewer', command: 'reviewer'
    })), 'utf8');
    await writeFile(join(projectManifestRoot, 'reviewer.json'), JSON.stringify(manifest({
      id: 'custom:reviewer', name: 'Project reviewer', command: 'project-reviewer'
    })), 'utf8');

    const results = await discoverAgentDefinitions({
      builtinDefinitions: [builtin],
      projectPath,
      userDataPath: root,
      detectDefinition: async (definition) => detection(definition.command !== 'project-reviewer')
    });

    expect(results.map((result) => [result.definition.id, result.source])).toEqual([
      ['codex-local', 'builtin'],
      ['custom:reviewer', 'project-manifest']
    ]);
    expect(results[1]?.definition.name).toBe('Project reviewer');
    expect(results[0]?.availability.available).toBe(true);
    expect(results[1]?.availability.available).toBe(false);
  });

  it('rejects invalid manifests and unsupported protocols with actionable errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowweave-agent-discovery-'));
    const manifestRoot = join(root, 'agents', 'connectors');
    await mkdir(manifestRoot, { recursive: true });
    await writeFile(join(manifestRoot, 'invalid.json'), JSON.stringify({ id: 'custom:bad', protocol: 'http' }), 'utf8');

    await expect(discoverAgentDefinitions({
      builtinDefinitions: [],
      userDataPath: root,
      detectDefinition: async () => detection(true)
    })).rejects.toThrow('Unsupported Agent protocol');
  });
});

function manifest(input: { id: string; name: string; command: string }): AgentDefinition {
  return {
    id: input.id as AgentDefinition['id'],
    name: input.name,
    kind: 'cli',
    protocol: 'cli-stdin',
    command: input.command,
    args: [],
    capabilities: ['implementation-plan'],
    description: input.name,
    builtIn: false,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z'
  };
}

function detection(available: boolean): ToolDetectionResult {
  return { available, message: available ? 'Available' : 'Not available' };
}

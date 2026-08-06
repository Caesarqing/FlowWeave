import type { AgentDefinition, ToolUiStatus } from '../types';

const AGENT_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortAgentsForSelection(
  agents: AgentDefinition[],
  statuses: Record<string, ToolUiStatus>
): AgentDefinition[] {
  return [...agents].sort((left, right) => {
    const availability = Number(Boolean(statuses[right.id]?.available)) - Number(Boolean(statuses[left.id]?.available));
    if (availability !== 0) return availability;
    return AGENT_NAME_COLLATOR.compare(left.name, right.name);
  });
}

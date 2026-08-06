import type { ArchitectureLayer, TechnologyStack } from '../types';
import type { FlowWeaveNode } from './graph-converters';
import { nodeArchitectureLayer, nodeClassification, nodeTechnologyStacks } from './canvas-layout';

export type CanvasFilterResult = 'matches' | 'no-matches' | 'empty-canvas';
export type CanvasFilters = {
  role: ArchitectureLayer | 'all';
  runtimeTags: TechnologyStack[];
  domain: string | 'all';
};
export type CanvasFilterExplanation =
  | { state: 'matches' }
  | { state: 'empty-canvas' }
  | { state: 'no-matches'; cause: 'role' | 'runtime' | 'domain' | 'combination' };

export function filterCanvasNodes(nodes: FlowWeaveNode[], filters: CanvasFilters): FlowWeaveNode[];
export function filterCanvasNodes(
  nodes: FlowWeaveNode[],
  technology: TechnologyStack | 'all',
  layer: ArchitectureLayer | 'all'
): FlowWeaveNode[];
export function filterCanvasNodes(
  nodes: FlowWeaveNode[],
  filtersOrTechnology: CanvasFilters | TechnologyStack | 'all',
  legacyLayer?: ArchitectureLayer | 'all'
): FlowWeaveNode[] {
  const filters = typeof filtersOrTechnology === 'object'
    ? filtersOrTechnology
    : { role: legacyLayer ?? 'all', runtimeTags: filtersOrTechnology === 'all' ? [] : [filtersOrTechnology], domain: 'all' };
  return nodes.filter((node) => (
    (filters.role === 'all' || nodeArchitectureLayer(node.data) === filters.role) &&
    (filters.runtimeTags.length === 0 || filters.runtimeTags.some((tag) => nodeTechnologyStacks(node.data).includes(tag))) &&
    (filters.domain === 'all' || nodeClassification(node.data).domain === filters.domain)
  ));
}

export function getCanvasFilterResult(nodes: FlowWeaveNode[], filters: CanvasFilters): CanvasFilterExplanation;
export function getCanvasFilterResult(
  nodes: FlowWeaveNode[],
  technology: TechnologyStack | 'all',
  layer: ArchitectureLayer | 'all'
): CanvasFilterResult;
export function getCanvasFilterResult(
  nodes: FlowWeaveNode[],
  filtersOrTechnology: CanvasFilters | TechnologyStack | 'all',
  legacyLayer?: ArchitectureLayer | 'all'
): CanvasFilterResult | CanvasFilterExplanation {
  const usesThreeAxisFilters = typeof filtersOrTechnology === 'object';
  const filters = usesThreeAxisFilters
    ? filtersOrTechnology
    : { role: legacyLayer ?? 'all', runtimeTags: filtersOrTechnology === 'all' ? [] : [filtersOrTechnology], domain: 'all' };
  if (nodes.length === 0) return usesThreeAxisFilters ? { state: 'empty-canvas' } : 'empty-canvas';
  if (filterCanvasNodes(nodes, filters).length > 0) return usesThreeAxisFilters ? { state: 'matches' } : 'matches';
  if (!usesThreeAxisFilters) return 'no-matches';
  const hasRole = filters.role === 'all' || nodes.some((node) => nodeClassification(node.data).role === filters.role);
  const hasRuntime = filters.runtimeTags.length === 0 || nodes.some((node) => filters.runtimeTags.some((tag) => nodeClassification(node.data).runtimeTags.includes(tag)));
  const hasDomain = filters.domain === 'all' || nodes.some((node) => nodeClassification(node.data).domain === filters.domain);
  const cause = !hasRole ? 'role' : !hasRuntime ? 'runtime' : !hasDomain ? 'domain' : 'combination';
  return { state: 'no-matches', cause };
}

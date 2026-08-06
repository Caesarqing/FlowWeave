import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('light theme semantic surfaces', () => {
  it('does not leave component surfaces pinned to dark literal backgrounds', () => {
    const styles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

    expect(styles).not.toContain('background: #030607;');
    expect(styles).not.toContain('background: #020405;');
    expect(styles).not.toContain('background: #090d0f;');
    expect(styles).not.toContain('background: rgba(2, 4, 5, 0.72);');
    expect(styles).not.toContain('background: rgba(2, 4, 5, 0.7);');
    expect(styles).not.toContain('background: rgba(6, 9, 11, 0.96);');
  });

  it('uses explicit light-aware Monaco and React Flow tokens and exposes build identity', () => {
    const styles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
    const diffViewer = readFileSync(new URL('../../src/components/DiffViewer.tsx', import.meta.url), 'utf8');
    const canvas = readFileSync(new URL('../../src/components/CanvasWorkspace.tsx', import.meta.url), 'utf8');
    const settings = readFileSync(new URL('../../src/components/UtilityPanels.tsx', import.meta.url), 'utf8');

    expect(styles).toContain(':root[data-theme="light"] .react-flow__controls');
    expect(diffViewer).toContain('resolvedTheme === "light" ? "vs" : "vs-dark"');
    expect(canvas).toContain('maskColor="var(--minimap-mask)"');
    expect(settings).toContain('build-metadata');
  });

  it('keeps agent and module detail cards on semantic theme tokens', () => {
    const styles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

    expect(styles).toContain('--surface:');
    expect(styles).toContain('.run-status {\n  display: inline-flex;');
    expect(styles).toContain('background: var(--surface);');
    expect(styles).toContain('.agent-plugin-status.installed {\n  color: var(--success);');
    expect(styles).toContain('.module-role {\n  color: var(--muted);');
    expect(styles).toContain('.assessment-factor {\n  display: grid;');
    expect(styles).toContain('background: var(--surface);');
  });
});

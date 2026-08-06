import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('canvas toolbar controls', () => {
  it('keeps the filter toolbar compact and visually consistent', () => {
    const source = readFileSync(new URL('../../src/components/CanvasWorkspace.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

    expect(source).not.toContain('<select multiple');
    expect(source).not.toContain('canvas.functionalFilter');
    expect(source).not.toContain('canvas.traceOff');
    expect(source).toContain('proOptions={{ hideAttribution: true }}');
    expect(source).toContain('canvas-trace-controls');
    expect(styles).toContain('.canvas-view-tools-content {\n  display: flex;\n  align-items: center;\n  width: max-content;\n  min-width: max-content;\n  margin-inline: auto;');
  });
});

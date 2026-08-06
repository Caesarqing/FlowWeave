import { describe, expect, it } from 'vitest';
import { createSerializedExecutor } from '../../src/utils/serialized-executor';

describe('createSerializedExecutor', () => {
  it('runs async tasks in invocation order even when an earlier task is delayed', async () => {
    const execute = createSerializedExecutor();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = execute(async () => {
      events.push('first-start');
      await firstGate;
      events.push('first-end');
    });
    const second = execute(async () => {
      events.push('second');
    });

    await Promise.resolve();
    expect(events).toEqual(['first-start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'first-end', 'second']);
  });
});

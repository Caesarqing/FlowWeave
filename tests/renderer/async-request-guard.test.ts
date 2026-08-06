import { describe, expect, it } from 'vitest';
import { createAsyncRequestGuard } from '../../src/utils/async-request-guard';

describe('createAsyncRequestGuard', () => {
  it('accepts only the latest request while the owner is active', () => {
    const guard = createAsyncRequestGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);

    guard.invalidate();
    expect(guard.isCurrent(second)).toBe(false);

    guard.activate();
    const third = guard.begin();
    expect(guard.isCurrent(third)).toBe(true);
  });
});

/**
 * The memo, on its own, with no database in the way.
 *
 * The behaviour it exists for is about failures and timing, and both are awkward to
 * arrange through a real load. The three call sites have their own tests proving they
 * delegate to this; these prove what they are delegating to.
 */

import { describe, expect, it } from 'vitest';
import { isolateMemo } from './memo.js';

/** A loader whose outcome the test decides, one call at a time. */
function scripted(outcomes: readonly ('ok' | 'fail')[]): {
  load: () => Promise<string>;
  calls: () => number;
} {
  let index = 0;
  return {
    load: async () => {
      const outcome = outcomes[index] ?? 'ok';
      index += 1;
      if (outcome === 'fail') throw new Error(`attempt ${index} failed`);
      return `value ${index}`;
    },
    calls: () => index,
  };
}

describe('a memo that keeps a success', () => {
  it('loads once and hands back the same promise', async () => {
    const memo = isolateMemo<string>();
    const script = scripted(['ok']);

    const first = memo.get(script.load);
    const second = memo.get(script.load);

    expect(first).toBe(second);
    expect(await first).toBe('value 1');
    expect(script.calls()).toBe(1);
  });

  it('shares one load between callers that arrive together', async () => {
    // Not an optimisation. It is what bounds the retry rate below: while an attempt
    // is in flight it is already in the memo, so traffic cannot multiply the load.
    const memo = isolateMemo<string>();
    const script = scripted(['ok']);

    await Promise.all([memo.get(script.load), memo.get(script.load), memo.get(script.load)]);

    expect(script.calls()).toBe(1);
  });

  it('loads again after a reset', async () => {
    const memo = isolateMemo<string>();
    const script = scripted(['ok', 'ok']);

    expect(await memo.get(script.load)).toBe('value 1');
    memo.reset();
    expect(await memo.get(script.load)).toBe('value 2');
  });
});

describe('a memo that forgets a failure', () => {
  it('retries instead of replaying the rejection', async () => {
    // 🔴 Debt F4. `cached ??= load()` kept the rejected promise, because a rejected
    // promise is not null, so the isolate answered with that same failure until it
    // recycled and repairing the cause did nothing.
    const memo = isolateMemo<string>();
    const script = scripted(['fail', 'fail', 'ok']);

    await expect(memo.get(script.load)).rejects.toThrow('attempt 1 failed');
    await expect(memo.get(script.load)).rejects.toThrow('attempt 2 failed');

    // The message says attempt 3, so this is a real third call rather than a
    // memoised anything.
    expect(await memo.get(script.load)).toBe('value 3');
  });

  it('keeps the value once one attempt succeeds', async () => {
    const memo = isolateMemo<string>();
    const script = scripted(['fail', 'ok']);

    await expect(memo.get(script.load)).rejects.toThrow();
    await memo.get(script.load);
    await memo.get(script.load);

    expect(script.calls()).toBe(2);
  });

  it('does not let an abandoned failure discard the load that replaced it', async () => {
    // ⚠️ The obvious fix clears the memo from the failure handler unconditionally,
    // and this is the case that makes it wrong. `reset` runs while a load is in
    // flight; the next call starts a fresh one, which succeeds; then the abandoned
    // one fails and throws away a good result nobody asked it to touch.
    const memo = isolateMemo<string>();

    let failAbandoned: (cause: Error) => void = () => {};
    const abandoned = memo
      .get(
        () =>
          new Promise<string>((_, reject) => {
            failAbandoned = reject;
          }),
      )
      .then(
        () => 'resolved',
        () => 'rejected',
      );

    memo.reset();

    const script = scripted(['ok']);
    const good = memo.get(script.load);
    expect(await good).toBe('value 1');

    failAbandoned(new Error('too late'));
    expect(await abandoned).toBe('rejected');

    expect(memo.get(script.load)).toBe(good);
    expect(script.calls()).toBe(1);
  });
});

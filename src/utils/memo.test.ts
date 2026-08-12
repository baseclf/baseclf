/**
 * The memo, on its own, with no database in the way.
 *
 * The behaviour it exists for is about failures and timing, and both are awkward to
 * arrange through a real load. The three call sites have their own tests proving they
 * delegate to this; these prove what they are delegating to.
 */

import { describe, expect, it } from 'vitest';
import { isolateMemo, MAX_REGISTRY_AGE_MS } from './memo.js';

/** A clock the test moves by hand, so the window can be watched rather than waited out. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000_000;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

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

describe('a memo that expires', () => {
  it('keeps the value until the window closes, and reloads once it has', async () => {
    // 🔴 Debt F2. Without this a change to the underlying data landed whenever the
    // isolate happened to recycle, and nothing bounded that. Measured against a live
    // deployment: 393 seconds in one run, 57 in another.
    const time = clock();
    const memo = isolateMemo<string>({ maxAgeMs: 1000, now: time.now });
    const script = scripted(['ok', 'ok']);

    expect(await memo.get(script.load)).toBe('value 1');

    time.advance(999);
    expect(await memo.get(script.load)).toBe('value 1');
    expect(script.calls()).toBe(1);

    time.advance(1);
    expect(await memo.get(script.load)).toBe('value 2');
  });

  it('measures the age from when the load began, not from when it landed', async () => {
    // A load that takes a second is already a second out of date when it arrives.
    // Stamping on arrival would hand back that second, every time, for free.
    const time = clock();
    const memo = isolateMemo<string>({ maxAgeMs: 1000, now: time.now });

    let land: (value: string) => void = () => {};
    const slow = memo.get(
      () =>
        new Promise<string>((resolve) => {
          land = resolve;
        }),
    );

    // The load takes 900ms of the window before it even lands.
    time.advance(900);
    land('slow value');
    expect(await slow).toBe('slow value');

    const script = scripted(['ok']);
    time.advance(100);

    // Stamped at the start, so the window is over. Stamped on arrival, it would have
    // 900ms left and this would still be the slow value.
    expect(await memo.get(script.load)).toBe('value 1');
  });

  it('does not expire when no window was asked for', async () => {
    // The catalogue relies on this. A schema change has `resetCatalogue`, and
    // expiring it would repeat the PRAGMA sweeps rather than three small queries.
    const time = clock();
    const memo = isolateMemo<string>({ now: time.now });
    const script = scripted(['ok', 'ok']);

    await memo.get(script.load);
    time.advance(MAX_REGISTRY_AGE_MS * 1000);

    expect(await memo.get(script.load)).toBe('value 1');
    expect(script.calls()).toBe(1);
  });

  it('does not serve the expired value while the reload is still running', async () => {
    // ⚠️ The opposite choice, stale-while-revalidate, is the right default nearly
    // everywhere and the wrong one here. What this memo holds is who may read what,
    // and a window that reopens whenever a reload is slow is not a window.
    const time = clock();
    const memo = isolateMemo<string>({ maxAgeMs: 1000, now: time.now });

    await memo.get(scripted(['ok']).load);
    time.advance(1000);

    let land: (value: string) => void = () => {};
    const reloading = memo.get(
      () =>
        new Promise<string>((resolve) => {
          land = resolve;
        }),
    );

    // A caller arriving mid reload waits for the new value rather than being handed
    // the old one.
    const alongside = memo.get(async () => 'should not be called');

    land('fresh');
    expect(await reloading).toBe('fresh');
    expect(await alongside).toBe('fresh');
  });

  it('leaves nothing behind when the reload fails, so the request fails closed', async () => {
    // The cost of the choice above, stated as a test. An expired registry plus a
    // failed reload is a refusal, not a fallback to what it used to say.
    const time = clock();
    const memo = isolateMemo<string>({ maxAgeMs: 1000, now: time.now });
    const script = scripted(['ok', 'fail', 'ok']);

    expect(await memo.get(script.load)).toBe('value 1');

    time.advance(1000);
    await expect(memo.get(script.load)).rejects.toThrow('attempt 2 failed');

    // And it recovers on the next try rather than staying broken, which is F4.
    expect(await memo.get(script.load)).toBe('value 3');
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

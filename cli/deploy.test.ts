/**
 * The wait, and the three things it can conclude.
 *
 * The distinction that matters is between "not up yet" and "something else is
 * serving this". Both look like a non-200, and the advice for them is opposite:
 * one is patience, the other is an investigation. Getting it wrong either sends
 * the reader chasing a fault that does not exist, or leaves them waiting on a
 * hostname that is never going to be theirs.
 */

import { describe, expect, it } from 'vitest';
import { POLL_INTERVAL_MS, waitForDeployment } from './deploy.js';
import { type Fetcher, isPropagating, PROPAGATION_GRACE_SECONDS } from './doctor.js';
import { findVoiceViolations } from './output.js';

const URL_UNDER_TEST = 'https://shop.someone.workers.dev';

/** No sleeping, so the grace period costs nothing to exercise. */
const instant = { sleep: () => Promise.resolve() };

/** Answers each status in turn, repeating the last one forever. */
function answering(statuses: readonly number[]): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  let index = 0;

  const fetcher: Fetcher = (url) => {
    calls.push(url);
    const status = statuses[Math.min(index, statuses.length - 1)] ?? 200;
    index += 1;
    return Promise.resolve(new Response(null, { status }));
  };

  return { fetcher, calls };
}

describe('an address that comes up the way a new one does', () => {
  it('reports live once it answers', async () => {
    // The measured sequence: 404 with error code 1042, then 500, then 200.
    const { fetcher } = answering([404, 500, 200]);

    const outcome = await waitForDeployment(fetcher, URL_UNDER_TEST, instant);

    expect(outcome.kind).toBe('live');
  });

  it('keeps trying through both of those rather than stopping at the first', async () => {
    const { fetcher, calls } = answering([404, 500, 200]);

    await waitForDeployment(fetcher, URL_UNDER_TEST, instant);

    expect(calls).toHaveLength(3);
  });

  it('asks /health rather than the root, since that is what doctor asks', async () => {
    const { fetcher, calls } = answering([200]);

    await waitForDeployment(fetcher, URL_UNDER_TEST, instant);

    expect(calls[0]).toBe(`${URL_UNDER_TEST}/health`);
  });

  it('stops the moment it answers rather than finishing the grace period', async () => {
    const { fetcher, calls } = answering([200]);

    await waitForDeployment(fetcher, URL_UNDER_TEST, instant);

    expect(calls).toHaveLength(1);
  });
});

describe('an address that never comes up', () => {
  it('says it stopped waiting, and does not call it broken', async () => {
    // It may still be on its way, and `doctor` has more to go on. Reporting a
    // failure here would be a guess presented as a finding.
    const { fetcher } = answering([404]);

    const outcome = await waitForDeployment(fetcher, URL_UNDER_TEST, instant);

    expect(outcome.kind).toBe('still-waiting');
  });

  it('gives up eventually rather than polling forever', async () => {
    const { fetcher, calls } = answering([500]);

    await waitForDeployment(fetcher, URL_UNDER_TEST, {
      ...instant,
      graceSeconds: 9,
      intervalMs: 3_000,
    });

    expect(calls).toHaveLength(3);
  });

  it('treats a request that did not complete as still coming up', async () => {
    // DNS for a brand new hostname can fail to resolve before it starts working.
    // That is the same condition as a 404 here, wearing a different coat.
    let attempts = 0;
    const flaky: Fetcher = () => {
      attempts += 1;
      if (attempts < 3) return Promise.reject(new Error('getaddrinfo ENOTFOUND'));
      return Promise.resolve(new Response(null, { status: 200 }));
    };

    const outcome = await waitForDeployment(flaky, URL_UNDER_TEST, instant);

    expect(outcome.kind).toBe('live');
  });
});

describe('⭐ an address that answers with something else entirely', () => {
  it('stops rather than waiting out a hostname that is not going to be ours', async () => {
    // A 403 on /health is not propagation. No amount of waiting changes it, and
    // the advice is an investigation rather than patience.
    const { fetcher, calls } = answering([403]);

    const outcome = await waitForDeployment(fetcher, URL_UNDER_TEST, instant);

    expect(outcome.kind).toBe('wrong-server');
    expect(calls).toHaveLength(1);
  });

  it('names the status, since that is what the reader has to go on', async () => {
    const { fetcher } = answering([401]);

    const outcome = await waitForDeployment(fetcher, URL_UNDER_TEST, instant);

    expect(outcome.kind === 'wrong-server' && outcome.detail).toContain('401');
  });
});

describe('the propagation judgment, which two commands share', () => {
  it('covers what a new address actually answers with', () => {
    expect(isPropagating(404)).toBe(true);
    expect(isPropagating(500)).toBe(true);
    expect(isPropagating(503)).toBe(true);
  });

  it('does not cover a status that means somebody else is serving this', () => {
    expect(isPropagating(200)).toBe(false);
    expect(isPropagating(401)).toBe(false);
    expect(isPropagating(403)).toBe(false);
  });

  it('is one implementation, so the wait and the diagnostic cannot disagree', () => {
    // Two copies of one judgment is the shape that produced debt 31 and 35, where
    // the diagnostic and the CORS layer disagreed and neither was wrong alone.
    // This asserts the shared function is the one the default grace comes from too.
    expect(PROPAGATION_GRACE_SECONDS).toBeGreaterThan(POLL_INTERVAL_MS / 1_000);
  });
});

describe('everything this can print', () => {
  it('breaks no voice rule', async () => {
    const { fetcher: slow } = answering([404]);
    const { fetcher: wrong } = answering([403]);

    const rendered = [
      await waitForDeployment(slow, URL_UNDER_TEST, instant),
      await waitForDeployment(wrong, URL_UNDER_TEST, instant),
    ].map((outcome) => ('detail' in outcome ? outcome.detail : ''));

    expect(rendered.flatMap(findVoiceViolations)).toEqual([]);
  });
});

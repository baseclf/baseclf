/**
 * The usage read, tested where it decides what a person is told.
 *
 * Two properties carry this file, and neither is "the numbers add up".
 *
 * The first is that a failure count is split by KIND. `errors` on its own puts
 * code that threw and a request the platform killed under one number, and those
 * send a reader in opposite directions. The split is the whole reason the third
 * query exists.
 *
 * The second is that adding that query did not quietly break the quantiles. The
 * dataset returns one row per group, and the medians are only meaningful while
 * exactly one row comes back, so grouping in the SAME query would have turned a
 * median into a median of medians without any error being raised. The test for
 * that asserts the medians survive alongside a multi-row outcome breakdown.
 */

import { describe, expect, it } from 'vitest';

import type { Fetcher } from './d1-api.js';
import { ANALYTICS_PERMISSION, readUsage } from './usage.js';

const CREDENTIALS = { accountId: '0'.repeat(32), token: 'cfut_not-a-real-token' };
const NOW = Date.parse('2026-08-25T00:00:00Z');

/** One row of `workersInvocationsAdaptive`, as the API shapes it. */
const invocationRow = (sum: Record<string, number>, quantiles?: Record<string, number>) => ({
  sum,
  ...(quantiles === undefined ? {} : { quantiles }),
});

const outcomeRow = (status: string, requests: number) => ({
  sum: { requests },
  dimensions: { status },
});

/**
 * Answer each of the three queries by name.
 *
 * Keyed on what the query asks for rather than on call order, because the three
 * run through `Promise.all` and a fetcher that answered positionally would be
 * asserting the order they happen to resolve in.
 */
function fetcherFor(answers: {
  readonly invocations?: unknown[];
  readonly outcomes?: unknown[];
  readonly d1?: unknown[];
  readonly refuse?: { readonly which: 'invocations' | 'outcomes' | 'd1'; readonly message: string };
}): Fetcher {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
    const query = body.query ?? '';

    const which = query.includes('d1AnalyticsAdaptiveGroups')
      ? 'd1'
      : query.includes('dimensions')
        ? 'outcomes'
        : 'invocations';

    if (answers.refuse?.which === which) {
      return new Response(JSON.stringify({ errors: [{ message: answers.refuse.message }] }), {
        status: 200,
      });
    }

    const rows =
      which === 'd1'
        ? (answers.d1 ?? [])
        : which === 'outcomes'
          ? (answers.outcomes ?? [])
          : (answers.invocations ?? []);

    const key = which === 'd1' ? 'd1AnalyticsAdaptiveGroups' : 'workersInvocationsAdaptive';
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{ [key]: rows }] } } }), {
      status: 200,
    });
  };
}

const read = (fetcher: Fetcher) =>
  readUsage({
    fetcher,
    credentials: CREDENTIALS,
    scriptName: 'baseclf',
    databaseId: 'db',
    now: NOW,
  });

describe('the kinds behind an error count', () => {
  it('separates a request the platform killed from code that threw', async () => {
    // The distinction this whole change exists for. One of these is somebody's
    // bug and the other is a limit being hit; a single "2 errors" says neither.
    const answer = await read(
      fetcherFor({
        invocations: [invocationRow({ requests: 150, errors: 3 })],
        outcomes: [
          outcomeRow('success', 147),
          outcomeRow('scriptThrewException', 2),
          outcomeRow('exceededResources', 1),
        ],
      }),
    );

    expect(answer.kind).toBe('numbers');
    if (answer.kind !== 'numbers') return;

    expect(answer.numbers.failures).toEqual([
      { status: 'scriptThrewException', requests: 2 },
      { status: 'exceededResources', requests: 1 },
    ]);
  });

  it('keeps a status nobody has seen before rather than dropping it', async () => {
    // The vocabulary of this field is not a closed set: `exceededResources` was
    // only observed on 2026-08-25, after months of reading this dataset. Filtering
    // to a known list would mean a new kind of failure arriving as silence.
    const answer = await read(
      fetcherFor({
        invocations: [invocationRow({ requests: 10, errors: 1 })],
        outcomes: [outcomeRow('success', 9), outcomeRow('somethingNobodyHasNamedYet', 1)],
      }),
    );

    if (answer.kind !== 'numbers') throw new Error('expected numbers');
    expect(answer.numbers.failures).toEqual([
      { status: 'somethingNobodyHasNamedYet', requests: 1 },
    ]);
  });

  it('reports an empty list when everything succeeded, which is not the same as unreadable', async () => {
    const answer = await read(
      fetcherFor({
        invocations: [invocationRow({ requests: 150, errors: 0 })],
        outcomes: [outcomeRow('success', 150)],
      }),
    );

    if (answer.kind !== 'numbers') throw new Error('expected numbers');
    expect(answer.numbers.failures).toEqual([]);
  });

  it('orders them by size, so the biggest problem is the first one read', async () => {
    const answer = await read(
      fetcherFor({
        invocations: [invocationRow({ requests: 100, errors: 30 })],
        outcomes: [
          outcomeRow('scriptThrewException', 5),
          outcomeRow('exceededResources', 25),
          outcomeRow('success', 70),
        ],
      }),
    );

    if (answer.kind !== 'numbers') throw new Error('expected numbers');
    expect(answer.numbers.failures.map((failure) => failure.status)).toEqual([
      'exceededResources',
      'scriptThrewException',
    ]);
  });
});

describe('the quantiles the outcome query could have broken', () => {
  it('still reports medians while the outcome breakdown has several rows', async () => {
    // 🔴 The failure this guards is silent. Grouping by status inside the
    // invocations query would return one row per status, and the medians are read
    // only when exactly one row comes back, so they would have become null with
    // nothing raised. Separate queries are what keep both answerable.
    const answer = await read(
      fetcherFor({
        invocations: [
          invocationRow({ requests: 150, errors: 2 }, { cpuTimeP50: 2300, cpuTimeP99: 22_500 }),
        ],
        outcomes: [
          outcomeRow('success', 148),
          outcomeRow('scriptThrewException', 1),
          outcomeRow('exceededResources', 1),
        ],
      }),
    );

    if (answer.kind !== 'numbers') throw new Error('expected numbers');
    expect(answer.numbers.cpuP50).toBe(2300);
    expect(answer.numbers.cpuP99).toBe(22_500);
    expect(answer.numbers.failures).toHaveLength(2);
  });

  it('leaves the medians null when the filter matched several things', async () => {
    // Unchanged behaviour, pinned because the outcome query made it easy to
    // confuse "several outcome rows" with "several invocation rows".
    const answer = await read(
      fetcherFor({
        invocations: [
          invocationRow({ requests: 10, errors: 0 }, { cpuTimeP50: 1000, cpuTimeP99: 2000 }),
          invocationRow({ requests: 20, errors: 0 }, { cpuTimeP50: 3000, cpuTimeP99: 4000 }),
        ],
        outcomes: [outcomeRow('success', 30)],
      }),
    );

    if (answer.kind !== 'numbers') throw new Error('expected numbers');
    expect(answer.numbers.cpuP50).toBeNull();
    expect(answer.numbers.requests).toBe(30);
  });
});

describe('a refusal from any one of the three queries', () => {
  it('is reported as a refusal naming the permission, not as numbers with a hole', async () => {
    // The likeliest outcome in the field: `REQUIRED_TOKEN_PERMISSIONS` does not
    // ask for analytics, so a token built by following the CLI exactly lands here.
    const answer = await read(
      fetcherFor({
        invocations: [invocationRow({ requests: 1, errors: 0 })],
        d1: [],
        refuse: { which: 'outcomes', message: 'not entitled to this dataset' },
      }),
    );

    expect(answer.kind).toBe('refused');
    if (answer.kind !== 'refused') return;
    expect(answer.message).toContain('not entitled');
    expect(answer.permission).toBe(ANALYTICS_PERMISSION);
  });
});

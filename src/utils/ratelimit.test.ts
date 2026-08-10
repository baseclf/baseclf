/**
 * The point of these tests is that a rate limiter fails quietly.
 *
 * A broken one returns `allowed: true` forever and every request succeeds, which
 * is exactly what a working one looks like from the outside until somebody
 * attacks it. So nothing here asserts that traffic is permitted. Everything
 * asserts that something is refused: over the limit, on a database failure, on a
 * row that came back the wrong shape.
 */

import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { D1Executor } from '../db/dialect.js';
import {
  checkRateLimit,
  cleanupRateLimits,
  deriveRateLimitKey,
  ensureRateLimitTable,
  RATE_LIMIT_TABLE,
  RATE_LIMIT_TABLE_DDL,
} from './ratelimit.js';

const CLIENT_IP = '203.0.113.7';

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request('https://example.test/api/auth/sign-in', { headers });
}

/** Backdate a row so its window looks closed, without waiting for a clock. */
async function backdateWindow(key: string, seconds: number): Promise<void> {
  await env.DB.prepare('UPDATE _rate_limit SET window_start = window_start - ?1 WHERE key = ?2')
    .bind(seconds, key)
    .run();
}

beforeAll(async () => {
  await env.DB.prepare('DROP TABLE IF EXISTS _rate_limit').run();
  await ensureRateLimitTable(env.DB);
});

describe('the table cannot represent a broken row', () => {
  it('declares the key NOT NULL, so a text primary key cannot arrive null', async () => {
    // Rule 01 §G1: on SQLite a plain `TEXT PRIMARY KEY` accepts NULL. A null key
    // would merge unrelated callers into one counter.
    const columns = await env.DB.prepare('PRAGMA table_info(_rate_limit)').all<{
      name: string;
      notnull: number;
    }>();

    const key = columns.results.find((column) => column.name === 'key');
    expect(key?.notnull).toBe(1);
  });

  it('refuses a null key at the database', async () => {
    await expect(
      env.DB.prepare('INSERT INTO _rate_limit (key, window_start, hits) VALUES (?1, 1, 1)')
        .bind(null)
        .run(),
    ).rejects.toThrow();
  });

  it('refuses a non-integer count, because the table is STRICT', async () => {
    await expect(
      env.DB.prepare('INSERT INTO _rate_limit (key, window_start, hits) VALUES (?1, 1, ?2)')
        .bind('strict-probe', 'not-a-number')
        .run(),
    ).rejects.toThrow();
  });

  it('carries no index on window_start, so a write costs one row and not two', async () => {
    // Rule 01 §D: writing an indexed column bills two rows written. This table is
    // written on every request; the cleanup sweep is the one allowed to scan.
    const indexes = await env.DB.prepare('PRAGMA index_list(_rate_limit)').all<{ name: string }>();

    // The primary key brings its own index. Seeing exactly one proves the loop
    // below had something to examine rather than nothing.
    expect(indexes.results).toHaveLength(1);

    for (const index of indexes.results) {
      const info = await env.DB.prepare(`PRAGMA index_info("${index.name}")`).all<{
        name: string;
      }>();
      const covered = info.results.map((column) => column.name);
      expect(covered).not.toContain('window_start');
    }
  });

  it('can be created twice without failing', async () => {
    await ensureRateLimitTable(env.DB);
    await ensureRateLimitTable(env.DB);
    expect(RATE_LIMIT_TABLE_DDL).toContain('IF NOT EXISTS');
    expect(RATE_LIMIT_TABLE_DDL).toContain('STRICT');
  });

  it('names the same table in the DDL that it exports', () => {
    // The statements spell the table out rather than interpolating the constant,
    // because building an identifier by concatenation is the habit rule 00
    // invariant I6 exists to prevent. That leaves the two able to drift, so the
    // agreement is asserted instead.
    expect(RATE_LIMIT_TABLE).toBe('_rate_limit');
    expect(RATE_LIMIT_TABLE_DDL).toContain(`"${RATE_LIMIT_TABLE}"`);
  });

  it('is a system table, so it carries the underscore prefix that hides it', () => {
    // Rule 00 invariant I8. Enforcement lives in the registry loader and the
    // REST router; what is checked here is that the name stays eligible for it.
    expect(RATE_LIMIT_TABLE.startsWith('_')).toBe(true);
  });
});

describe('key derivation refuses to trust the caller', () => {
  it('ignores X-Forwarded-For even when the client sends one', () => {
    // Cloudflare appends to X-Forwarded-For rather than replacing it, so its
    // contents are partly chosen by the client. Keying on it would hand an
    // attacker an unlimited supply of fresh buckets.
    const spoofed = deriveRateLimitKey(
      requestWithHeaders({
        'X-Forwarded-For': '198.51.100.1',
        'CF-Connecting-IP': CLIENT_IP,
      }),
      'signin',
    );
    const clean = deriveRateLimitKey(
      requestWithHeaders({ 'CF-Connecting-IP': CLIENT_IP }),
      'signin',
    );

    // Pinned to the exact key rather than just compared to each other: two keys
    // that both said "unknown" would agree with each other while proving that
    // the trusted header was ignored too.
    expect(clean).toBe(`signin|${CLIENT_IP}`);
    expect(spoofed).toBe(clean);
    expect(spoofed).not.toContain('198.51.100.1');
  });

  it('gives a client no way to change its own key by adding headers', () => {
    const base = deriveRateLimitKey(
      requestWithHeaders({ 'CF-Connecting-IP': CLIENT_IP }),
      'signin',
    );

    for (const header of ['X-Forwarded-For', 'X-Real-IP', 'Forwarded', 'True-Client-IP']) {
      const attempt = deriveRateLimitKey(
        requestWithHeaders({ [header]: '198.51.100.99', 'CF-Connecting-IP': CLIENT_IP }),
        'signin',
      );
      expect(attempt).toBe(base);
    }
  });

  it('collapses an IPv6 client to its /64, so one allocation is one bucket', () => {
    // A residential IPv6 block holds more addresses than we could ever count.
    // Keying on the full address is the same as having no limit.
    const first = deriveRateLimitKey(
      requestWithHeaders({ 'CF-Connecting-IP': '2001:db8:abcd:1234::1' }),
      'signin',
    );
    const second = deriveRateLimitKey(
      requestWithHeaders({ 'CF-Connecting-IP': '2001:db8:abcd:1234:ffff:ffff:ffff:ffff' }),
      'signin',
    );

    expect(first).toBe('signin|2001:0db8:abcd:1234::/64');
    expect(first).toBe(second);
  });

  it('keeps separate IPv6 networks in separate buckets', () => {
    const first = deriveRateLimitKey(
      requestWithHeaders({ 'CF-Connecting-IP': '2001:db8:abcd:1234::1' }),
      'signin',
    );
    const second = deriveRateLimitKey(
      requestWithHeaders({ 'CF-Connecting-IP': '2001:db8:abcd:9999::1' }),
      'signin',
    );

    expect(first).not.toBe(second);
  });

  it('gives one client one bucket whichever notation it arrives in', () => {
    const mapped = deriveRateLimitKey(
      requestWithHeaders({ 'CF-Connecting-IP': '::ffff:203.0.113.7' }),
      'signin',
    );
    const plain = deriveRateLimitKey(
      requestWithHeaders({ 'CF-Connecting-IP': CLIENT_IP }),
      'signin',
    );

    expect(plain).toBe(`signin|${CLIENT_IP}`);
    expect(mapped).toBe(plain);
  });

  it('separates buckets, so exhausting one endpoint does not lock another', () => {
    const signin = deriveRateLimitKey(
      requestWithHeaders({ 'CF-Connecting-IP': CLIENT_IP }),
      'signin',
    );
    const reset = deriveRateLimitKey(
      requestWithHeaders({ 'CF-Connecting-IP': CLIENT_IP }),
      'reset',
    );

    expect(signin).not.toBe(reset);
  });

  it('still produces a key when no address can be resolved', () => {
    // Unidentifiable callers share one budget. Skipping the limit would be a
    // bypass; throwing would turn a missing header into a 500.
    const key = deriveRateLimitKey(requestWithHeaders({}), 'signin');
    expect(key).toBe('signin|unknown');
  });

  it('does not let the header decide how long the key is', () => {
    // An address longer than any address can be is not one. Keeping it would let
    // a header set the key length, and an over-long key is rejected later, on a
    // request path, as a 500 rather than as a limit.
    const key = deriveRateLimitKey(
      requestWithHeaders({ 'CF-Connecting-IP': '9'.repeat(4_000) }),
      'signin',
    );

    expect(key).toBe('signin|unknown');
  });

  it('rejects a bucket name that could forge the key separator', () => {
    expect(() => deriveRateLimitKey(requestWithHeaders({}), 'sign|in')).toThrow();
    expect(() => deriveRateLimitKey(requestWithHeaders({}), '')).toThrow();
    expect(() => deriveRateLimitKey(requestWithHeaders({}), '203.0.113.7')).toThrow();
  });
});

describe('the limit is actually enforced', () => {
  it('refuses the request after the limit is reached', async () => {
    const key = 'signin|over-the-limit';

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await checkRateLimit(env.DB, { key, limit: 3, windowSeconds: 60 });
      expect(result.allowed).toBe(true);
      expect(result.hits).toBe(attempt);
    }

    const denied = await checkRateLimit(env.DB, { key, limit: 3, windowSeconds: 60 });
    expect(denied.allowed).toBe(false);
    expect(denied.hits).toBe(4);
  });

  it('reports a retry delay inside the window and never zero', async () => {
    const key = 'signin|retry-after';

    await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 60 });
    const denied = await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 60 });

    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('keeps refusing while the window is open', async () => {
    const key = 'signin|stays-shut';

    await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 60 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 60 });
      expect(result.allowed).toBe(false);
    }
  });

  it('counts from one again once the window has closed', async () => {
    const key = 'signin|window-rolls-over';

    await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 60 });
    const denied = await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 60 });
    expect(denied.allowed).toBe(false);

    await backdateWindow(key, 61);

    const reopened = await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 60 });
    expect(reopened.allowed).toBe(true);
    expect(reopened.hits).toBe(1);
  });

  it('closes the window on the database clock, with nobody touching the row', async () => {
    // The test above moves the row. This one moves nothing and waits, which is
    // the only way to show that unixepoch() is what drives the reset.
    const key = 'signin|real-clock';

    await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 1 });
    expect((await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 1 })).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const reopened = await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 1 });
    expect(reopened.allowed).toBe(true);
    expect(reopened.hits).toBe(1);
  });

  it('does not let one caller consume another caller budget', async () => {
    const exhausted = 'signin|tenant-a';
    const untouched = 'signin|tenant-b';

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await checkRateLimit(env.DB, { key: exhausted, limit: 2, windowSeconds: 60 });
    }
    expect(
      (await checkRateLimit(env.DB, { key: exhausted, limit: 2, windowSeconds: 60 })).allowed,
    ).toBe(false);

    const other = await checkRateLimit(env.DB, { key: untouched, limit: 2, windowSeconds: 60 });
    expect(other.allowed).toBe(true);
    expect(other.hits).toBe(1);
  });

  it('rejects a configuration that would silently disable it', async () => {
    const key = 'signin|bad-config';

    await expect(checkRateLimit(env.DB, { key, limit: 0, windowSeconds: 60 })).rejects.toThrow();
    await expect(checkRateLimit(env.DB, { key, limit: -1, windowSeconds: 60 })).rejects.toThrow();
    await expect(checkRateLimit(env.DB, { key, limit: 1.5, windowSeconds: 60 })).rejects.toThrow();
    await expect(checkRateLimit(env.DB, { key, limit: 5, windowSeconds: 0 })).rejects.toThrow();
    await expect(
      checkRateLimit(env.DB, { key, limit: 5, windowSeconds: Number.NaN }),
    ).rejects.toThrow();
    await expect(
      checkRateLimit(env.DB, { key: '', limit: 5, windowSeconds: 60 }),
    ).rejects.toThrow();
  });
});

describe('a broken database refuses requests rather than waving them through', () => {
  it('refuses when the table is missing', async () => {
    // A real D1 failure, not a stand-in: the statement is sent and rejected.
    await env.DB.prepare('DROP TABLE IF EXISTS _rate_limit').run();
    try {
      const result = await checkRateLimit(env.DB, {
        key: 'signin|no-table',
        limit: 5,
        windowSeconds: 60,
      });

      expect(result.allowed).toBe(false);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      await ensureRateLimitTable(env.DB);
    }
  });

  it('refuses when the connection itself fails', async () => {
    const throwing: D1Executor = {
      prepare(): never {
        throw new Error('connection lost');
      },
      batch(): never {
        throw new Error('connection lost');
      },
    };

    const result = await checkRateLimit(throwing, {
      key: 'signin|connection-lost',
      limit: 5,
      windowSeconds: 30,
    });

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(30);
  });

  it('refuses when a count comes back as text rather than a number', async () => {
    // This is what double-quoted string literals do on D1 (rule 00 invariant
    // I6): a mistyped identifier yields the identifier text for every row
    // instead of raising. Comparing a string against a limit must not pass.
    const stringy: D1Executor = {
      prepare: () =>
        ({
          bind: () => ({
            first: async () => ({ hits: 'hits', window_start: 'window_start', now: 'now' }),
          }),
        }) as unknown as D1PreparedStatement,
      batch(): never {
        throw new Error('not used');
      },
    };

    const result = await checkRateLimit(stringy, {
      key: 'signin|dqs',
      limit: 5,
      windowSeconds: 30,
    });

    expect(result.allowed).toBe(false);
  });

  it('refuses when no row comes back at all', async () => {
    const empty: D1Executor = {
      prepare: () =>
        ({ bind: () => ({ first: async () => null }) }) as unknown as D1PreparedStatement,
      batch(): never {
        throw new Error('not used');
      },
    };

    const result = await checkRateLimit(empty, {
      key: 'signin|empty',
      limit: 5,
      windowSeconds: 30,
    });

    expect(result.allowed).toBe(false);
  });
});

describe('logs carry the count, never the caller', () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    const capture = (...args: unknown[]): void => {
      written.push(args.map(String).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the count and limit but no address when refusing', async () => {
    const key = deriveRateLimitKey(requestWithHeaders({ 'CF-Connecting-IP': CLIENT_IP }), 'signin');

    await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 60 });
    await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 60 });

    const combined = written.join('\n');
    expect(combined).toContain('RATE_LIMITED');
    expect(combined).toContain('hits=');
    expect(combined).toContain('limit=1');
    expect(combined).not.toContain(CLIENT_IP);
    expect(combined).not.toContain(key);
  });

  it('writes no address when the limiter itself fails', async () => {
    const throwing: D1Executor = {
      prepare(): never {
        throw new Error('connection lost');
      },
      batch(): never {
        throw new Error('connection lost');
      },
    };
    const key = deriveRateLimitKey(requestWithHeaders({ 'CF-Connecting-IP': CLIENT_IP }), 'signin');

    await checkRateLimit(throwing, { key, limit: 5, windowSeconds: 60 });

    const combined = written.join('\n');
    expect(combined).toContain('RATE_LIMIT_UNAVAILABLE');
    expect(combined).not.toContain(CLIENT_IP);
    expect(combined).not.toContain(key);
  });

  it('writes no address when a real database error is what failed', async () => {
    // The test above supplies its own error text. This one lets D1 write the
    // message, which is the case where an address could arrive from outside.
    const key = deriveRateLimitKey(requestWithHeaders({ 'CF-Connecting-IP': CLIENT_IP }), 'signin');
    await env.DB.prepare('DROP TABLE IF EXISTS _rate_limit').run();

    try {
      const result = await checkRateLimit(env.DB, { key, limit: 5, windowSeconds: 60 });
      expect(result.allowed).toBe(false);
    } finally {
      await ensureRateLimitTable(env.DB);
    }

    const combined = written.join('\n');
    expect(combined).toContain('RATE_LIMIT_UNAVAILABLE');
    expect(combined).not.toContain(CLIENT_IP);
  });

  it('drops the failure text entirely rather than let it carry the key', async () => {
    // If a database ever did echo a bound value back in its error string, the
    // message is discarded instead of logged. Invariant I9 does not get to
    // depend on the error text of software we do not control.
    const key = deriveRateLimitKey(requestWithHeaders({ 'CF-Connecting-IP': CLIENT_IP }), 'signin');
    const echoing: D1Executor = {
      prepare(): never {
        throw new Error(`constraint failed for row ${key}`);
      },
      batch(): never {
        throw new Error('not used');
      },
    };

    await checkRateLimit(echoing, { key, limit: 5, windowSeconds: 60 });

    const combined = written.join('\n');
    expect(combined).toContain('cause=redacted');
    expect(combined).not.toContain(CLIENT_IP);
  });

  it('logs nothing at all for a request that is allowed', async () => {
    await checkRateLimit(env.DB, {
      key: 'signin|quiet-path',
      limit: 100,
      windowSeconds: 60,
    });

    expect(written).toEqual([]);
  });

  it('cannot be made to log an address by hand-crafting a key', async () => {
    // The bucket is re-derived through a pattern no address can match, so a key
    // that was not built by deriveRateLimitKey still cannot smuggle one out.
    const key = `${CLIENT_IP}|forged`;

    await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 60 });
    await checkRateLimit(env.DB, { key, limit: 1, windowSeconds: 60 });

    const combined = written.join('\n');
    expect(combined).toContain('RATE_LIMITED');
    expect(combined).toContain('bucket=unknown');
    expect(combined).not.toContain(CLIENT_IP);
  });
});

describe('cleanup', () => {
  it('removes closed windows and leaves open ones counting', async () => {
    const stale = 'signin|stale-row';
    const live = 'signin|live-row';

    await checkRateLimit(env.DB, { key: stale, limit: 5, windowSeconds: 60 });
    await checkRateLimit(env.DB, { key: live, limit: 5, windowSeconds: 60 });
    await backdateWindow(stale, 7_200);

    const deleted = await cleanupRateLimits(env.DB, 3_600);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await env.DB.prepare('SELECT key FROM _rate_limit WHERE key IN (?1, ?2)')
      .bind(stale, live)
      .all<{ key: string }>();
    const keys = remaining.results.map((row) => row.key);

    expect(keys).not.toContain(stale);
    expect(keys).toContain(live);

    // The surviving row must still be mid-window, not reset by the sweep.
    const next = await checkRateLimit(env.DB, { key: live, limit: 5, windowSeconds: 60 });
    expect(next.hits).toBe(2);
  });

  it('rejects a retention that would delete rows still being counted', async () => {
    await expect(cleanupRateLimits(env.DB, 0)).rejects.toThrow();
    await expect(cleanupRateLimits(env.DB, -60)).rejects.toThrow();
    await expect(cleanupRateLimits(env.DB, 1.5)).rejects.toThrow();
  });
});

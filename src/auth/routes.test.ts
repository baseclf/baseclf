/**
 * The auth routes as they are actually mounted.
 *
 * The modules underneath are tested on their own. What is left, and what those
 * tests cannot see, is the wiring: whether the diagnostic is reachable before
 * the identity provider gets the path, whether the limiter is in front of the
 * endpoints worth guessing at and out of the way of the ones that would break,
 * and whether the callback address this deployment reports is the one it
 * actually serves.
 *
 * Every request carries its own CF-Connecting-IP so that one test cannot spend
 * another test's budget. That is also the header the limiter is supposed to key
 * on, so the arrangement exercises the thing it depends on.
 */

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import worker, { type Env, resetRateLimitTableMemo } from '../index.js';
import { AUTH_PREFIX } from './index.js';
import { callbackUrl } from './providers.js';

const BASE_URL = 'https://baseclf.test';

const configured: Env = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: BASE_URL,
};

/**
 * The same deployment with nothing configured at all.
 *
 * Not cast into shape: both fields are optional on Env, so leaving them out is
 * a value the type already allows. A cast here would be a way of asserting the
 * exact thing under test.
 */
const bare: Env = (({ BETTER_AUTH_SECRET, BETTER_AUTH_URL, ...rest }) => rest)(configured);

function call(path: string, ip: string, on: Env = configured): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE_URL}${path}`, { headers: { 'CF-Connecting-IP': ip } }),
    on,
  );
}

describe('the diagnostic endpoint', () => {
  it('answers for a deployment with no secret, which is when it is needed', async () => {
    // Everything else on this deployment answers 500. If the diagnostic did
    // too, the endpoint whose job is to explain the outage would be part of it.
    const response = await call('/api/auth/_diagnose', '203.0.113.10', bare);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { secret_configured: boolean; warnings: string[] };
    expect(body.secret_configured).toBe(false);
    expect(body.warnings.some((warning) => warning.includes('BETTER_AUTH_SECRET'))).toBe(true);
  });

  it('is reached before the identity provider sees the path', async () => {
    // It lives under the auth prefix, so the only thing keeping it from being
    // a 404 from Better Auth's router is the order of the checks.
    const response = await call('/api/auth/_diagnose', '203.0.113.11');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { base_url_config: string }).base_url_config).toBe(BASE_URL);
  });

  it('never reports a credential value', async () => {
    const canary = 'canary-9f2c31-must-not-be-reported';
    const response = await call('/api/auth/_diagnose', '203.0.113.12', {
      ...configured,
      GOOGLE_CLIENT_ID: `id-${canary}`,
      GOOGLE_CLIENT_SECRET: `secret-${canary}`,
    });

    expect(JSON.stringify(await response.json())).not.toContain(canary);
  });

  it('reports a binding missing from the live deployment, read off env rather than the type', async () => {
    // `Env` declares BUCKET as required, so the deployment state under test is
    // the one the type forbids, and exactly the state the real deployment was
    // in on 2026-08-11: a config without `r2_buckets` deploys, reports success,
    // and leaves `env.BUCKET` undefined at runtime. The cast constructs what
    // the type cannot express, which is the whole point of the check.
    const missingBucket = (({ BUCKET, ...rest }) => rest)(configured) as Env;

    const response = await call('/api/auth/_diagnose', '203.0.113.13', missingBucket);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      bindings: { name: string; present: boolean }[];
      warnings: string[];
    };
    expect(body.bindings).toContainEqual({ name: 'DB', present: true });
    expect(body.bindings).toContainEqual({ name: 'BUCKET', present: false });
    expect(body.warnings.some((warning) => warning.includes('env.BUCKET'))).toBe(true);
  });
});

describe('the rate limiter in front of the auth endpoints', () => {
  it('stops a caller hammering a credential endpoint, and says when to come back', async () => {
    resetRateLimitTableMemo();
    const ip = '203.0.113.20';
    const limit = 20;

    for (let attempt = 1; attempt <= limit; attempt += 1) {
      const response = await call('/api/auth/sign-in/email', ip);
      // What the handler answers is beside the point. The limiter runs before
      // it, so the assertion is only that the budget has not been spent.
      expect(response.status).not.toBe(429);
    }

    const refused = await call('/api/auth/sign-in/email', ip);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { code: string }).code).toBe('RATE_LIMITED');

    const retryAfter = Number(refused.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    // Never zero. A Retry-After of zero invites the immediate retry that is
    // being limited in the first place.
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('charges one caller without charging another', async () => {
    resetRateLimitTableMemo();

    for (let attempt = 1; attempt <= 21; attempt += 1) {
      await call('/api/auth/sign-in/email', '203.0.113.30');
    }

    expect((await call('/api/auth/sign-in/email', '203.0.113.30')).status).toBe(429);
    expect((await call('/api/auth/sign-in/email', '203.0.113.31')).status).not.toBe(429);
  });

  it('leaves the key set alone, because limiting it would be a self-inflicted outage', async () => {
    // The verifier fetches this from this same worker on the way to checking a
    // token. A budget here means a burst on cold isolates turns every request
    // into a 401, in exchange for protecting a public key.
    resetRateLimitTableMemo();
    const ip = '203.0.113.40';

    for (let attempt = 1; attempt <= 40; attempt += 1) {
      expect((await call('/api/auth/jwks', ip)).status).not.toBe(429);
    }
  });

  it('leaves the diagnostic alone, so it still answers under a flood', async () => {
    resetRateLimitTableMemo();
    const ip = '203.0.113.41';

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      expect((await call('/api/auth/_diagnose', ip)).status).toBe(200);
    }
  });
});

describe('the scheduled sweep', () => {
  it('removes a counter nothing could still be counting against, and spares a live one', async () => {
    // Only the platform calls this handler, so without a test the cron is a
    // statement nobody has ever run. It is also the one job that could become a
    // bypass: deleting a row still inside its window hands its owner a fresh
    // allowance, which is why the retention is an order of magnitude past the
    // longest window rather than merely longer than it.
    resetRateLimitTableMemo();
    await call('/api/auth/sign-in/email', '203.0.113.50');

    await env.DB.prepare(
      'INSERT OR REPLACE INTO "_rate_limit" ("key", "window_start", "hits") VALUES (?1, unixepoch() - 86400, 9)',
    )
      .bind('sweep_test|stale')
      .run();
    await env.DB.prepare(
      'INSERT OR REPLACE INTO "_rate_limit" ("key", "window_start", "hits") VALUES (?1, unixepoch(), 9)',
    )
      .bind('sweep_test|live')
      .run();

    await worker.scheduled({ scheduledTime: 0, cron: '17 * * * *', noRetry: () => {} }, configured);

    const remaining = await env.DB.prepare('SELECT "key" FROM "_rate_limit" WHERE "key" LIKE ?1')
      .bind('sweep_test|%')
      .all<{ key: string }>();
    const keys = remaining.results.map((row) => row.key);

    expect(keys).not.toContain('sweep_test|stale');
    expect(keys).toContain('sweep_test|live');
  });

  it('still runs the second job when the first fails, and still reports the failure', async () => {
    // The two jobs are isolated on purpose: an hour where the rate limit table
    // is broken must not become an hour where storage drift goes unswept. The
    // isolation is proven positively (the storage sweep is observed going to
    // the database) rather than inferred from the absence of its failure.
    let sessionStatements = 0;

    const rateLimitsUnreachable = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return () => {
            throw new Error('the rate limit table is unreachable in this test');
          };
        }
        if (property === 'withSession') {
          return (constraint?: string) =>
            new Proxy(target.withSession(constraint), {
              get(session, name, sessionReceiver) {
                if (name === 'prepare') {
                  return (sql: string) => {
                    sessionStatements += 1;
                    return session.prepare(sql);
                  };
                }
                return Reflect.get(session, name, sessionReceiver);
              },
            });
        }
        return Reflect.get(target, property, receiver);
      },
    });

    // The platform's view of a cron is whether the handler resolved, so a run
    // with a failed job still has to throw, and to throw the aggregate that
    // names the job, not the raw error, which would mean the first failure
    // escaped before the second job had its turn.
    await expect(
      worker.scheduled(
        { scheduledTime: 0, cron: '17 * * * *', noRetry: () => {} },
        { ...configured, DB: rateLimitsUnreachable },
      ),
    ).rejects.toThrow('Scheduled jobs failed: rate limit sweep.');

    expect(sessionStatements).toBeGreaterThan(0);
  });

  it('reports a failed storage sweep even when the rate limit sweep was fine', async () => {
    // The other direction of the same property. A handler that logs the failure
    // and resolves is a sweep that can die silently, which for this job means
    // drift nobody sees.
    resetRateLimitTableMemo();
    await call('/api/auth/sign-in/email', '203.0.113.52');

    const storageUnreachable = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === 'withSession') {
          return () => {
            throw new Error('the storage session is unreachable in this test');
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(
      worker.scheduled(
        { scheduledTime: 0, cron: '17 * * * *', noRetry: () => {} },
        { ...configured, DB: storageUnreachable },
      ),
    ).rejects.toThrow('Scheduled jobs failed: storage sweep.');
  });
});

describe('the callback address this deployment reports', () => {
  it('is under the prefix the worker actually routes to the identity provider', () => {
    // These two constants live in different modules on purpose, to keep the
    // import graph acyclic. Nothing else notices when one moves, and the
    // symptom of them disagreeing is redirect_uri_mismatch in production, which
    // is the exact failure the diagnostic exists to prevent.
    expect(callbackUrl(BASE_URL, 'google').startsWith(`${BASE_URL}${AUTH_PREFIX}`)).toBe(true);
    expect(callbackUrl(BASE_URL, 'github').startsWith(`${BASE_URL}${AUTH_PREFIX}`)).toBe(true);
  });
});

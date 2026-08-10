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

/** The same deployment with nothing configured at all. */
const { BETTER_AUTH_SECRET: _noSecret, BETTER_AUTH_URL: _noUrl, ...bare } = configured;

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
    const response = await call('/api/auth/_diagnose', '203.0.113.10', bare as Env);
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

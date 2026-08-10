/**
 * Who may read a response, and who may not.
 *
 * This is a security boundary rather than a convenience. Getting it wrong in
 * the permissive direction means any page on the internet can call this API
 * with a token it borrowed from a logged-in user and read the answer, so the
 * tests that matter most here are the ones about refusal.
 *
 * The other half is less obvious and was found on a real deployment rather
 * than in review: a refusal that carries no CORS headers reaches the browser as
 * an opaque CORS failure, so a caller sees neither the 401 nor the 429 that
 * would have told them what to do. Errors are asserted as carefully as
 * successes.
 */

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import worker, { type Env, resetRateLimitTableMemo } from './index.js';

const BASE_URL = 'https://baseclf.test';
const TRUSTED = 'https://app.example.com';
const UNTRUSTED = 'https://evil.example.com';

function envWith(trustedOrigins: string): Env {
  return {
    ...env,
    BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
    BETTER_AUTH_URL: BASE_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: trustedOrigins,
  };
}

const configured = envWith(TRUSTED);

function call(
  path: string,
  init: RequestInit & { origin?: string | null; ip?: string } = {},
  on: Env = configured,
): Promise<Response> {
  const { origin = TRUSTED, ip = '198.51.100.1', ...rest } = init;
  const headers = new Headers(rest.headers);
  if (origin !== null) headers.set('Origin', origin);
  headers.set('CF-Connecting-IP', ip);

  return worker.fetch(new Request(`${BASE_URL}${path}`, { ...rest, headers }), on);
}

function preflight(path: string, origin: string | null, on: Env = configured): Promise<Response> {
  return call(
    path,
    { method: 'OPTIONS', origin, headers: { 'Access-Control-Request-Method': 'POST' } },
    on,
  );
}

describe('a preflight from an origin on the list', () => {
  it('is allowed, and says what the browser may then send', async () => {
    const response = await preflight('/rest/v1/posts', TRUSTED);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(TRUSTED);
    expect(response.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(Number(response.headers.get('access-control-max-age'))).toBeGreaterThan(0);
  });

  it('lets the browser read the headers a client actually needs', async () => {
    // Without this the bookmark is invisible cross-origin, and read after write
    // silently stops working for the callers most likely to need it.
    const exposed = (await call('/health')).headers.get('access-control-expose-headers') ?? '';

    expect(exposed).toContain('x-d1-bookmark');
    expect(exposed).toContain('retry-after');
  });

  it('matches a configured value written with a trailing slash', async () => {
    // Both sides go through URL.origin. Comparing raw strings would turn one
    // stray character into a frontend that cannot reach its own backend.
    const response = await preflight('/health', TRUSTED, envWith(`${TRUSTED}/`));

    expect(response.headers.get('access-control-allow-origin')).toBe(TRUSTED);
  });

  it('matches whatever case the host was written in', async () => {
    const response = await preflight('/health', TRUSTED, envWith('https://APP.Example.COM'));

    expect(response.headers.get('access-control-allow-origin')).toBe(TRUSTED);
  });

  it('picks the caller out of a list of several', async () => {
    const on = envWith(`https://one.example.com, ${TRUSTED} , https://two.example.com`);
    const response = await preflight('/health', TRUSTED, on);

    expect(response.headers.get('access-control-allow-origin')).toBe(TRUSTED);
  });
});

describe('a caller that is not on the list', () => {
  it('is refused, and is not told which origins are', async () => {
    // 204 rather than 403 on purpose. The browser decides by the absence of the
    // header, and a status code here would both confuse the console message and
    // hand an attacker a way to probe the allowlist.
    const response = await preflight('/rest/v1/posts', UNTRUSTED);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-methods')).toBeNull();
  });

  it('cannot read a real response either', async () => {
    const response = await call('/health', { origin: UNTRUSTED });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('is refused when no origin has been configured at all', async () => {
    // Fail closed. An empty allowlist grants nothing rather than everything.
    const response = await preflight('/health', TRUSTED, envWith(''));

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('gains nothing by sending something that is not an origin', async () => {
    for (const bogus of ['null', 'not a url', '*', `${TRUSTED}.evil.example.com`]) {
      const response = await preflight('/health', bogus);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });
});

describe('what every response carries', () => {
  it('varies on Origin even when the origin was refused', async () => {
    // A cache keyed on the URL alone would hand one origin's response to
    // another, and then the allowlist has decided nothing at all.
    for (const origin of [TRUSTED, UNTRUSTED, null]) {
      const response = await call('/health', { origin });
      expect(response.headers.get('vary')).toContain('Origin');
    }
  });

  it('never answers with a wildcard', async () => {
    // This API returns rows belonging to whoever holds the token. A wildcard
    // would make BETTER_AUTH_TRUSTED_ORIGINS decorative.
    for (const origin of [TRUSTED, UNTRUSTED]) {
      for (const path of ['/health', '/rest/v1/posts', '/api/auth/_diagnose']) {
        const response = await call(path, { origin });
        expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
      }
    }
  });

  it('never allows credentials, because the transport is a bearer token', async () => {
    // Turning this on would invite the browser to attach the ambient cookies
    // the whole session design avoids.
    const response = await preflight('/rest/v1/posts', TRUSTED);

    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('sends no allow-origin to a caller that sent no origin', async () => {
    const response = await call('/health', { origin: null });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.status).toBe(200);
  });
});

describe('a response the caller will not like', () => {
  it('is still readable, so the browser reports the status and not a CORS error', async () => {
    // A 404 without these headers reaches the page as an opaque CORS failure,
    // and whoever is debugging goes looking at the wrong layer entirely.
    const response = await call('/nothing-here', { origin: TRUSTED });

    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBe(TRUSTED);
  });

  it('carries the headers on a rate limit refusal too', async () => {
    resetRateLimitTableMemo();
    const ip = '198.51.100.90';

    let refused: Response | null = null;
    for (let attempt = 1; attempt <= 25 && refused === null; attempt += 1) {
      const response = await call('/api/auth/sign-in/email', { method: 'POST', ip });
      if (response.status === 429) refused = response;
    }

    expect(refused).not.toBeNull();
    expect(refused?.headers.get('access-control-allow-origin')).toBe(TRUSTED);
    // The one header a 429 is useless without, and it is only readable
    // cross-origin because it is named in expose-headers.
    expect(refused?.headers.get('retry-after')).not.toBeNull();
    expect(refused?.headers.get('access-control-expose-headers')).toContain('retry-after');
  });
});

describe('the preflight and the rate limiter', () => {
  it('does not spend the budget a real request needs', async () => {
    // A preflight carries no credentials and touches no database, so charging
    // for it would only mean a browser locks itself out by asking permission.
    resetRateLimitTableMemo();
    // The same caller throughout. Preflighting from one address and then
    // calling from another would prove nothing, since they are separate
    // buckets anyway.
    const ip = '198.51.100.99';

    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const response = await call('/api/auth/sign-in/email', { method: 'OPTIONS', ip });
      expect(response.status).toBe(204);
    }

    const real = await call('/api/auth/sign-in/email', { method: 'POST', ip });
    expect(real.status).not.toBe(429);
  });
});

/**
 * Who gets into `/mcp`, and what an outsider is told about how to get in.
 *
 * Every assertion here is about a refusal or about a discovery document, because a
 * broken gate looks exactly like a working one from the inside. Nothing asserts that a
 * valid token succeeds beyond "it was not refused": what happens after the gate is the
 * SDK's protocol handling, and tests for that would be tests of somebody else's code.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import worker, { type Env } from '../index.js';
import { createTokenVerifier } from './auth.js';
import { metadataUrlFor } from './server.js';

const BASE = 'https://baseclf.test';
const TOKEN = 'a-shared-secret-of-ordinary-length';

/** Auth has to be configured or `identify` refuses before anything here is reached. */
const configured = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: BASE,
  MCP_TOKEN: TOKEN,
} as unknown as Env;

/** The same deployment with the secret never set, which must refuse everybody. */
const { MCP_TOKEN: _unset, ...unconfigured } = configured as Env & { MCP_TOKEN?: string };

function call(
  path: string,
  init: RequestInit = {},
  on: Env = configured,
  ip = '203.0.113.200',
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('CF-Connecting-IP', ip);
  return worker.fetch(new Request(`${BASE}${path}`, { ...init, headers }), on);
}

/** A POST shaped enough to reach the gate. The gate runs before any of it is read. */
function post(token?: string, ip?: string): Promise<Response> {
  return call(
    '/mcp',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    },
    configured,
    ip,
  );
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM _rate_limit')
    .run()
    .catch(() => undefined);
});

describe('the gate on /mcp', () => {
  it('refuses a request with no token', async () => {
    const response = await post(undefined, '203.0.113.201');
    expect(response.status).toBe(401);
  });

  it('tells an unauthenticated caller where to look, which is what makes it discoverable', async () => {
    // RFC 9728. Without this header a client that has never seen the server has no way
    // to learn what it should present, and the endpoint is undiscoverable rather than
    // merely locked.
    const response = await post(undefined, '203.0.113.202');
    const challenge = response.headers.get('www-authenticate') ?? '';

    expect(challenge).toContain('Bearer');
    expect(challenge).toContain(metadataUrlFor(BASE));
  });

  it('refuses a wrong token', async () => {
    const response = await post('not-the-secret', '203.0.113.203');
    expect(response.status).toBe(401);
  });

  it('refuses a wrong token of a different length', async () => {
    // ⚠️ Not a duplicate of the test above. `crypto.subtle.timingSafeEqual` throws on
    // buffers of different lengths, so a comparison that fed it the raw secrets would
    // turn a length mismatch into a 500 while a same-length mismatch returned 401,
    // and the difference between those two answers is a length oracle. Hashing both
    // sides first is what makes this case indistinguishable from the one above.
    const response = await post('x', '203.0.113.204');
    expect(response.status).toBe(401);
  });

  it('refuses everybody when the deployment has no MCP_TOKEN, token or not', async () => {
    // 🔴 Invariant I1 on a new surface. An endpoint nobody configured is not an
    // endpoint without a lock, and the tempting reading of an unset secret is that
    // there is nothing to check.
    const response = await call(
      '/mcp',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
      unconfigured as Env,
      '203.0.113.205',
    );

    expect(response.status).toBe(401);
  });

  it('refuses an empty secret, which is the case the explicit check is for', async () => {
    // 🔴 A mutation found this gap. Removing the "is the secret set" check left every
    // test green, because the comparison below it refuses anything that does not match
    // the string `undefined`. The second layer was hiding the absence of the first,
    // which is debt D3 in this project.
    //
    // The case it hides is a secret set to the empty string, which `wrangler secret
    // put` will happily accept. Without the explicit check, an empty token presented
    // against an empty secret hashes equal and the endpoint is open to anybody who
    // sends `Authorization: Bearer` and nothing after it.
    const emptied = { ...configured, MCP_TOKEN: '' } as Env;

    for (const token of ['', 'anything']) {
      const response = await call(
        '/mcp',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'MCP-Protocol-Version': '2026-07-28',
            'Mcp-Method': 'tools/list',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        },
        emptied,
        '203.0.113.208',
      );

      expect(response.status).toBe(401);
    }
  });

  it('lets the right token past the gate', async () => {
    // Deliberately weak: what happens after the gate belongs to the SDK. All this
    // pins is that a correct secret is not refused, which is the half a broken
    // comparison would get wrong in the direction nobody notices.
    const response = await post(TOKEN, '203.0.113.206');
    expect(response.status).not.toBe(401);
  });

  it('counts guesses against a budget of their own', async () => {
    // Guessing a shared secret is what the credential budget exists for. Its own
    // bucket, so a run at `/mcp` cannot lock the operator out of signing in.
    const ip = '203.0.113.207';
    let limited: Response | null = null;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await post('wrong', ip);
      if (response.status === 429) {
        limited = response;
        break;
      }
      expect(response.status).toBe(401);
    }

    expect(limited).not.toBeNull();
    expect(limited?.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});

describe('the verifier on its own terms', () => {
  // ⚠️ Called directly rather than through a request, and a mutation is why. Removing
  // the "is the secret set" check survived every HTTP-level test here: the SDK's
  // middleware refuses a malformed or empty bearer before the verifier is ever
  // reached, so the branch is unreachable from outside.
  //
  // That makes it defence in depth, and defence in depth that no test can reach is
  // debt D3: a layer nobody would notice going missing. The verifier's contract is
  // "refuse when there is no secret" whoever calls it, so that is what is asserted.
  const resource = new URL(`${BASE}/mcp`);

  it('refuses when the deployment has no secret at all', async () => {
    const verifier = createTokenVerifier({}, resource);
    await expect(verifier.verifyAccessToken('anything')).rejects.toThrow();
  });

  it('refuses when the secret is the empty string', async () => {
    // 🔴 The case worth having. `wrangler secret put` accepts an empty value, and
    // without this check an empty secret and an empty token hash equal, which opens
    // the endpoint to anybody sending `Authorization: Bearer` and nothing after it.
    const verifier = createTokenVerifier({ MCP_TOKEN: '' }, resource);

    await expect(verifier.verifyAccessToken('')).rejects.toThrow();
    await expect(verifier.verifyAccessToken('anything')).rejects.toThrow();
  });

  it('carries an expiry, because the SDK refuses a token without one', async () => {
    // Documented in the SDK: bearer verification "rejects tokens whose
    // `AuthInfo.expiresAt` is unset". A static secret does not expire, so the value
    // is an assertion; leaving it out would refuse every valid token instead.
    const verifier = createTokenVerifier({ MCP_TOKEN: TOKEN }, resource);
    const info = await verifier.verifyAccessToken(TOKEN);

    expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(info.resource.href).toBe(resource.href);
    expect(info.scopes).toEqual(['mcp']);
  });
});

describe('the discovery document', () => {
  it('is served without a token, because that is the point of it', async () => {
    const response = await call(new URL(metadataUrlFor(BASE)).pathname);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: `${BASE}/mcp`,
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
    });
  });

  it('advertises no authorization server, because there is not one', async () => {
    // ⚠️ Absent rather than empty, and it matters that it stays that way. A
    // fabricated entry here would send a client off to authorise against something
    // that does not exist, and the field is optional precisely so a resource server
    // with a shared secret can say so. `@modelcontextprotocol/client` reads it as
    // `authorization_servers && length > 0`.
    const response = await call(new URL(metadataUrlFor(BASE)).pathname);
    const body = (await response.json()) as Record<string, unknown>;

    expect('authorization_servers' in body).toBe(false);
  });

  it('refuses a method that is not a read', async () => {
    const response = await call(new URL(metadataUrlFor(BASE)).pathname, { method: 'POST' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toContain('GET');
  });

  it('sits under .well-known, where RFC 9728 says to look', async () => {
    expect(metadataUrlFor(BASE)).toBe(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  });
});

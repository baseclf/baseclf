/**
 * The point of V3, end to end: the same request, two identities, two answers.
 *
 * Everything below goes through the worker's `fetch`, so the whole chain runs:
 * a bearer token arrives, gets verified against a key set the worker itself
 * serves, becomes an AuthCtx, selects policies, and ends up as a predicate in
 * the compiled SQL. Nothing is stubbed except the network hop, which is looped
 * back into the same worker rather than mocked away.
 *
 * Three properties are worth more than the happy path:
 *
 *   - An unconfigured deployment refuses. It does not fall back to anonymous,
 *     because a deployment missing its secret should be visibly broken rather
 *     than quietly open to everyone.
 *   - A bad token is a 401. It is not a silent downgrade to anonymous, which
 *     would show a user whose session expired an empty page instead of a
 *     reason.
 *   - A signed-in user's rows come from the policy, not from the request. The
 *     only thing that differs between the two runs is the header.
 */

import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetCatalogue } from '../db/introspect.js';
import worker, { type Env } from '../index.js';
import { seedDatabase, seedStandardPolicies } from '../policy/__fixtures__/schema.js';
import { resetRegistry } from '../policy/registry.js';
import { resetAuth, runAuthMigrations } from './index.js';

const BASE_URL = 'https://baseclf.test';
const PASSWORD = 'a-password-of-ordinary-length';

const configured = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: BASE_URL,
  // Explicitly on. It is off by default because a password hash costs 58 ms of
  // CPU and a free-plan request gets 10 ms, so a deployment that enables it
  // without a paid plan produces sign-ups that fail only for real users.
  BETTER_AUTH_EMAIL_PASSWORD: 'true',
};

/** The same env with the secret taken away. */
const { BETTER_AUTH_SECRET: _omitted, ...unconfigured } = configured;

function call(path: string, init: RequestInit = {}, on: Env = configured): Promise<Response> {
  return worker.fetch(new Request(`${BASE_URL}${path}`, init), on);
}

const realFetch = globalThis.fetch;
let token: string;
let userId: string;

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeAll(async () => {
  // The verifier fetches the JWKS over the network. Loop that back into the
  // worker instead of mocking it: the worker really does serve the key set that
  // verifies the token it really did issue.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(BASE_URL)) return worker.fetch(new Request(url, init), configured);
    throw new Error(`unexpected outbound request in a test: ${url}`);
  }) as typeof fetch;

  await seedDatabase(env.DB);
  await seedStandardPolicies(env.DB);
  resetCatalogue();
  resetRegistry();
  resetAuth();

  // Through the same entry point the provisioning step will use, so the schema
  // is derived from the same options the worker serves with. Migrating with a
  // hand-written options object silently omits the jwks table the jwt plugin
  // owns, and the first symptom is the token endpoint answering 500 with an
  // empty body.
  const created = await runAuthMigrations(configured);
  expect(created).toContain('jwks');

  const signUp = await call('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'carla@example.test', password: PASSWORD, name: 'Carla' }),
  });
  expect(signUp.status).toBe(200);

  const tokenResponse = await call('/api/auth/token', {
    headers: { authorization: `Bearer ${signUp.headers.get('set-auth-token')}` },
  });
  expect(tokenResponse.status).toBe(200);
  token = ((await tokenResponse.json()) as { token: string }).token;

  const [, payload] = token.split('.');
  userId = JSON.parse(atob((payload as string).replace(/-/g, '+').replace(/_/g, '/'))).sub;

  // A draft that belongs to the account that just signed up. Written directly
  // rather than through the API, because what is being tested is who can read
  // it afterwards.
  await env.DB.prepare(
    'INSERT INTO posts (id, title, body, status, author_id, org_id, created_at) VALUES (?,?,?,?,?,?,?)',
  )
    .bind('p_carla', 'Carla draft', 'body', 'draft', userId, 'org_1', '2026-08-11T00:00:00Z')
    .run();
}, 120_000);

describe('a deployment that is not configured', () => {
  it('refuses rather than serving everyone anonymously', async () => {
    // Fail closed. The tempting alternative, treating a missing secret as "no
    // auth configured, so everything is anonymous", turns a deployment mistake
    // into an open database.
    const response = await call('/rest/v1/posts', {}, unconfigured);
    expect(response.status).toBe(500);
  });
});

describe('the same request, two identities', () => {
  it('shows an anonymous caller only what the anon policy allows', async () => {
    const response = await call('/rest/v1/posts?select=id,status');
    expect(response.status).toBe(200);

    const rows = (await response.json()) as { id: string; status: string }[];
    expect(rows.every((row) => row.status === 'published')).toBe(true);
    expect(rows.some((row) => row.id === 'p_carla')).toBe(false);
  });

  it('shows a signed-in caller their own draft as well', async () => {
    const response = await call('/rest/v1/posts?select=id,status', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);

    const rows = (await response.json()) as { id: string; status: string }[];

    // The row the anonymous request could not see, from the identical URL.
    expect(rows.some((row) => row.id === 'p_carla')).toBe(true);
    // And still nobody else's drafts.
    expect(rows.some((row) => row.status === 'draft' && row.id !== 'p_carla')).toBe(false);
  });

  it('differs only by the header', async () => {
    const path = '/rest/v1/posts?select=id';
    const anonymous = (await (await call(path)).json()) as { id: string }[];
    const signedIn = (await (
      await call(path, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { id: string }[];

    expect(signedIn.length).toBeGreaterThan(anonymous.length);
  });
});

describe('a token that does not check out', () => {
  it('is a 401 rather than a quiet downgrade to anonymous', async () => {
    const response = await call('/rest/v1/posts', {
      headers: { authorization: 'Bearer not.a.token' },
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('says the same thing for a well-formed token from nowhere', async () => {
    // Signed correctly, by somebody else. Indistinguishable to the caller from
    // any other refusal.
    const { SignJWT, generateKeyPair } = await import('jose');
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const forged = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(BASE_URL)
      .setAudience(BASE_URL)
      .setSubject(userId)
      .setExpirationTime('1h')
      .sign(privateKey);

    const response = await call('/rest/v1/posts', {
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(response.status).toBe(401);
  });
});

describe('the identity provider is mounted, and is not a table', () => {
  it('serves its own key set', async () => {
    const response = await call('/api/auth/jwks');
    expect(response.status).toBe(200);

    const jwks = (await response.json()) as { keys: { alg: string }[] };
    expect(jwks.keys[0]?.alg).toBe('ES256');
  });

  it('never routes an auth path into the table router', async () => {
    // `/api/auth/...` is claimed before `tableFromPath` ever sees it, so no
    // table name can shadow the identity provider.
    const response = await call('/api/auth/does-not-exist');
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain('"code":"NOT_FOUND"');
  });
});

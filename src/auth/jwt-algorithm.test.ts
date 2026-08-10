/**
 * Trap 4: is the token really ES256, or did it stay on the EdDSA default?
 *
 * BaseCLF's tokens are verified by other people's code: the customer's app,
 * their edge middleware, another service. EdDSA is fine inside workerd and
 * awkward everywhere else, so the contract pins ES256. Passing
 * `keyPairConfig: { alg: 'ES256' }` is not evidence that it took effect, so
 * this reads the header of a token the library actually issues.
 *
 * Getting a token needs a session, and a session needs Better Auth's own
 * tables. Those are created here through `getMigrations`, which is a
 * programmatic API rather than the CLI. That matters beyond this test: the
 * skill records that `better-auth migrate` cannot reach a D1 binding because
 * the CLI runs in Node. `getMigrations` runs wherever it is called, including
 * inside the Worker where the binding exists.
 */

import { env } from 'cloudflare:workers';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { bearer, jwt } from 'better-auth/plugins';
import { beforeAll, describe, expect, it } from 'vitest';

const CONSTRUCTION_ONLY_SECRET = 'test-secret-not-used-to-sign-anything-real';
const BASE_URL = 'https://example.test';

const options = {
  database: env.DB,
  secret: CONSTRUCTION_ONLY_SECRET,
  baseURL: BASE_URL,
  emailAndPassword: { enabled: true },
  plugins: [bearer(), jwt({ jwks: { keyPairConfig: { alg: 'ES256' as const } } })],
};

const auth = betterAuth(options);

/** The part of a JWT before the first dot, base64url, decoded. */
function headerOf(token: string): Record<string, unknown> {
  const [encoded] = token.split('.');
  if (encoded === undefined) throw new Error('not a JWT');

  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

let createdTables: string[] = [];

beforeAll(async () => {
  const migrations = await getMigrations(options);
  createdTables = migrations.toBeCreated.map((entry) => entry.table);
  await migrations.runMigrations();
}, 60_000);

describe('better-auth schema on D1', () => {
  it('creates its tables through the programmatic migration API', async () => {
    // The finding worth keeping: this ran against a D1 binding, from inside the
    // runtime, with no CLI involved.
    expect(createdTables.length).toBeGreaterThan(0);
    console.log(`  tables created: ${createdTables.join(', ')}`);

    const present = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = present.results.map((row) => row.name);

    for (const table of createdTables) expect(names).toContain(table);
  });
});

describe('trap 4: the algorithm the tokens actually carry', () => {
  it('publishes a P-256 key on the JWKS endpoint, not Ed25519', async () => {
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/jwks`, { method: 'GET' }),
    );
    expect(response.status).toBe(200);

    const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
    const key = jwks.keys[0];

    console.log(`  jwks key: ${JSON.stringify(key)}`);

    // EdDSA would publish kty OKP with crv Ed25519. ES256 publishes an EC key
    // on the P-256 curve, which is the whole point of pinning it.
    expect(key?.kty).toBe('EC');
    expect(key?.crv).toBe('P-256');
  });

  it('issues a token whose header says ES256', async () => {
    const signUp = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ann@example.test',
          password: 'a-password-of-ordinary-length',
          name: 'Ann',
        }),
      }),
    );
    expect(signUp.status).toBe(200);

    // The bearer plugin returns the session token in this header rather than a
    // cookie, which is the transport BaseCLF uses because the frontend sits on
    // a different origin. See trap 3.
    const sessionToken = signUp.headers.get('set-auth-token');
    expect(sessionToken).toBeTruthy();

    const tokenResponse = await auth.handler(
      new Request(`${BASE_URL}/api/auth/token`, {
        method: 'GET',
        headers: { authorization: `Bearer ${sessionToken}` },
      }),
    );
    expect(tokenResponse.status).toBe(200);

    const { token } = (await tokenResponse.json()) as { token: string };
    const header = headerOf(token);

    console.log(`  jwt header: ${JSON.stringify(header)}`);

    // Trap 4, answered by the token itself rather than by the configuration.
    expect(header.alg).toBe('ES256');
  }, 60_000);
});

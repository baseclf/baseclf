/**
 * `$auth.app.*`, end to end, with a real data source behind it for the first time.
 *
 * The V3 checklist has carried a half-open item since it shipped: "a policy
 * referencing `$auth.app.plan` runs" was only ever tested from the refusing side,
 * because `definePayload` emitted an empty object and there was no way to put
 * anything else in it (debt 13). This file is the other half: a record stored in
 * `_app_metadata` travels into the JWT the real issuer mints, through the real
 * verifier, into `AuthCtx`, and decides which rows a policy returns.
 *
 * Runs against the real `getAuth` options rather than a copy of them, because a
 * copy is how this project once proved a verifier worked while the product's own
 * wiring was broken.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { applyEngineSchema } from '../db/bootstrap.js';
import { getCatalogue, resetCatalogue } from '../db/introspect.js';
import { registerPolicies } from '../policy/__fixtures__/schema.js';
import { getRegistry, resetRegistry } from '../policy/registry.js';
import { readTable } from '../rest/router.js';
import { upsertAppMetadataStatement } from './app-metadata.js';
import { contextFromClaims } from './claims.js';
import { type AuthEnv, getAuth, runAuthMigrations } from './index.js';
import { type VerifierConfig, verifyToken } from './verify.js';

const BASE_URL = 'https://app-claims.test';

/**
 * A private env rather than a patched shared one, so nothing this suite
 * configures leaks into another file's idea of what is set.
 */
const authEnv: AuthEnv = {
  DB: env.DB,
  BETTER_AUTH_SECRET: 'app-claims-suite-secret-of-ordinary-length',
  BETTER_AUTH_URL: BASE_URL,
  BETTER_AUTH_EMAIL_PASSWORD: 'true',
};

const decodePayload = (token: string): Record<string, unknown> => {
  const [, encoded] = token.split('.');
  if (encoded === undefined) throw new Error('not a JWT');
  return JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
};

async function signUpAndGetToken(
  email: string,
): Promise<{ userId: string; token: () => Promise<string> }> {
  const auth = getAuth(authEnv);

  const signUp = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-password-of-ordinary-length', name: email }),
    }),
  );
  const session = signUp.headers.get('set-auth-token');
  expect(session).not.toBeNull();

  const who = await auth.handler(
    new Request(`${BASE_URL}/api/auth/get-session`, {
      headers: { authorization: `Bearer ${session}` },
    }),
  );
  const body = (await who.json()) as { user?: { id?: string } } | null;
  const userId = body?.user?.id;
  expect(typeof userId).toBe('string');

  return {
    userId: userId as string,
    token: async () => {
      const minted = await auth.handler(
        new Request(`${BASE_URL}/api/auth/token`, {
          headers: { authorization: `Bearer ${session}` },
        }),
      );
      return ((await minted.json()) as { token: string }).token;
    },
  };
}

let withRecord: { userId: string; token: () => Promise<string> };
let withoutRecord: { userId: string; token: () => Promise<string> };

beforeAll(async () => {
  await runAuthMigrations(authEnv);
  await applyEngineSchema(env.DB);

  withRecord = await signUpAndGetToken('claims@example.test');
  withoutRecord = await signUpAndGetToken('bare@example.test');

  const stored = upsertAppMetadataStatement(withRecord.userId, { plan: 'pro', region: 'apac' });
  await env.DB.prepare(stored.sql)
    .bind(...stored.parameters)
    .run();
}, 60_000);

describe('the claims store and the token mint', () => {
  it('a stored record travels into the token as app_metadata', async () => {
    const payload = decodePayload(await withRecord.token());
    expect(payload['app_metadata']).toEqual({ plan: 'pro', region: 'apac' });
    expect(payload['role']).toBe('authenticated');
  });

  it('a user with no record gets an empty object, not a failed mint', async () => {
    const payload = decodePayload(await withoutRecord.token());
    expect(payload['app_metadata']).toEqual({});
  });

  it('replacing the record replaces the claims, not merges them', async () => {
    const replaced = upsertAppMetadataStatement(withRecord.userId, { plan: 'pro' });
    await env.DB.prepare(replaced.sql)
      .bind(...replaced.parameters)
      .run();

    const payload = decodePayload(await withRecord.token());
    expect(payload['app_metadata']).toEqual({ plan: 'pro' });
  });
});

describe('a policy that reads $auth.app.plan', () => {
  beforeAll(async () => {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS tiers (id TEXT PRIMARY KEY NOT NULL, tier TEXT NOT NULL) STRICT',
    ).run();
    await env.DB.prepare("INSERT OR REPLACE INTO tiers (id, tier) VALUES ('t_pro', 'pro')").run();
    await env.DB.prepare("INSERT OR REPLACE INTO tiers (id, tier) VALUES ('t_free', 'free')").run();

    await registerPolicies(env.DB, {
      table: 'tiers',
      binds: {},
      policies: [
        {
          name: 'read_my_tier',
          operation: 'select',
          roles: ['authenticated'],
          using: { tier: { _eq: '$auth.app.plan' } },
          columns: ['id', 'tier'],
        },
      ],
    });
    resetCatalogue();
    resetRegistry();
  });

  async function rowsFor(token: string) {
    const config: VerifierConfig = {
      keySetUrl: `${BASE_URL}/api/auth/jwks`,
      readKeySet: () => getAuth(authEnv).api.getJwks(),
      issuer: BASE_URL,
      audience: BASE_URL,
    };
    const auth = contextFromClaims(await verifyToken(token, config));
    const [catalogue, registry] = await Promise.all([getCatalogue(env.DB), getRegistry(env.DB)]);
    return readTable<{ id: string; tier: string }>({
      executor: env.DB,
      catalogue,
      registry,
      auth,
      table: 'tiers',
      search: new URLSearchParams(),
    });
  }

  it('returns exactly the rows the stored claim matches', async () => {
    const result = await rowsFor(await withRecord.token());
    expect(result.rows).toEqual([{ id: 't_pro', tier: 'pro' }]);
  });

  it('returns nothing for a user whose claim set has no plan', async () => {
    // A missing claim resolves to null (compile.ts, `resolveClaim`), and a null
    // predicate passes no WHERE, so the answer is empty rather than an error.
    // Fail-closed by construction, and this is the pair test that proves the
    // positive case above is the claim doing the work.
    const result = await rowsFor(await withoutRecord.token());
    expect(result.rows).toEqual([]);
  });
});

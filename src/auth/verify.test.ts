/**
 * The identity boundary, tested from the refusing side.
 *
 * A verifier that accepts good tokens is easy and proves almost nothing. What
 * matters is what it turns away: a token for somebody else's deployment, one
 * signed with a key we do not know, one signed with an algorithm the attacker
 * chose, and one that has expired. Each of those is a way in if it is missed,
 * so each has a test.
 *
 * Tokens here are minted with `jose` directly rather than through Better Auth,
 * because the awkward cases (wrong issuer, wrong algorithm, already expired)
 * are not things a correct issuer will produce on request.
 */

import { env } from 'cloudflare:workers';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { bearer, jwt } from 'better-auth/plugins';
import { exportJWK, generateKeyPair, type JSONWebKeySet, type JWK, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BaseclfError } from '../utils/errors.js';
import { authenticate, bearerToken, type VerifierConfig, verifyToken } from './verify.js';

/**
 * Assert that a promise was refused *by the verifier*, for the reason the
 * verifier gives, rather than merely that something threw.
 *
 * `rejects.toThrow()` on its own is not enough here and the difference is not
 * academic: an earlier version of this file left its fetch interceptor
 * uninstalled, so every refusal test passed on an infrastructure error while
 * the verifier was never exercised at all. A test that cannot tell those apart
 * is worse than no test, because it reports confidence it has not earned.
 */
async function expectUnauthenticated(work: Promise<unknown>): Promise<BaseclfError> {
  let thrown: unknown;
  try {
    await work;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(BaseclfError);
  const error = thrown as BaseclfError;
  expect(error.status).toBe(401);
  expect(error.code).toBe('UNAUTHENTICATED');
  expect(error.message).toBe('Unauthenticated.');
  return error;
}

const SECRET = 'test-secret-not-used-to-sign-anything-real';
const BASE_URL = 'https://issuer.test';
const JWKS_PATH = '/api/auth/jwks';

const options = {
  database: env.DB,
  secret: SECRET,
  baseURL: BASE_URL,
  emailAndPassword: { enabled: true },
  plugins: [bearer(), jwt({ jwks: { keyPairConfig: { alg: 'ES256' as const } } })],
};

const auth = betterAuth(options);

/**
 * 🔴 Every outbound request fails, including the JWKS endpoint. That is the
 * point of this fixture, not a limitation of it.
 *
 * This interceptor used to make one exception: it routed the JWKS URL into the
 * Better Auth handler, so the verifier's `fetch` of its own key set succeeded.
 * It was written to avoid mocking, and it looked more honest than a mock. It was
 * worse than a mock, because it faithfully simulated the one thing that did not
 * work in production: a Worker fetching its own `*.workers.dev` URL is answered
 * 404, so every JWT failed verification on every deployment from V3 until
 * 2026-08-15, while this suite stayed green.
 *
 * Now nothing is allowed out. The verifier reads its key set in process, so a
 * `fetch` reaching this function at all means somebody put the network back on
 * the identity path, and the tests below turn red instead of a deployment doing
 * it silently months later.
 */
const realFetch = globalThis.fetch;

let outboundAttempts: string[] = [];

const interceptor = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  outboundAttempts.push(url);
  throw new Error(`unexpected outbound request in a test: ${url}`);
}) as typeof fetch;

let config: VerifierConfig;
/** A token the real issuer minted, with whatever iss and aud it chose. */
let goodToken: string;
let issuedPayload: Record<string, unknown>;

const decodePayload = (token: string): Record<string, unknown> => {
  const [, encoded] = token.split('.');
  if (encoded === undefined) throw new Error('not a JWT');
  return JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
};

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeAll(async () => {
  // Installed here rather than at module scope. Module scope runs to completion
  // before the first test does, so an interceptor installed and restored there
  // is never in effect while anything is being tested. That mistake is easy to
  // miss because the suite still passes: the refusal tests keep rejecting, just
  // for the wrong reason. See the assertions below, which check the reason.
  globalThis.fetch = interceptor;

  await (await getMigrations(options)).runMigrations();

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
  const sessionToken = signUp.headers.get('set-auth-token');

  const tokenResponse = await auth.handler(
    new Request(`${BASE_URL}/api/auth/token`, {
      method: 'GET',
      headers: { authorization: `Bearer ${sessionToken}` },
    }),
  );
  goodToken = ((await tokenResponse.json()) as { token: string }).token;
  issuedPayload = decodePayload(goodToken);

  // The contract is taken from what the issuer actually mints rather than from
  // what the documentation says it should. If those disagree, the test that
  // prints this is where it shows up.
  config = {
    keySetUrl: `${BASE_URL}${JWKS_PATH}`,
    // In process, the same way `verifierConfig` builds it for the worker. No
    // request leaves, which is why the interceptor above can refuse everything.
    readKeySet: () => auth.api.getJwks(),
    issuer: String(issuedPayload.iss),
    audience: String(issuedPayload.aud),
  };
}, 60_000);

/** A token signed by a key the verifier has never seen. */
async function foreignToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  await exportJWK(privateKey);

  return new SignJWT({ role: 'authenticated', ...overrides })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setSubject('u_impostor')
    .setExpirationTime('1h')
    .sign(privateKey);
}

/**
 * 🔴 The test this file did not have, and the reason a broken deployment looked
 * healthy from V3 until 2026-08-15.
 *
 * The verifier used to reach its key set with `fetch`, at a URL belonging to the
 * Worker doing the fetching. On Cloudflare that is answered 404, so every JWT
 * was refused on every deployment. Nothing here failed, because the fixture
 * routed exactly that URL back into the issuer: the suite proved the verifier
 * works when the network works, and the network was the broken part.
 *
 * So this asserts about the network rather than about the result. It is the same
 * discipline `policy_simulate` needed for "does not touch data", where compiling
 * and running-then-discarding produce identical output and only a count of
 * round trips can tell them apart.
 */
describe('the identity path and the network', () => {
  it('verifies a real token without making a single outbound request', async () => {
    // A key set name nothing has used, so the Cache API cannot answer from an
    // earlier test and `readKeySet` is genuinely invoked. Without this the
    // assertion would pass on a warm cache while a reintroduced fetch sat
    // unexercised behind it.
    const cold: VerifierConfig = {
      ...config,
      keySetUrl: `${BASE_URL}${JWKS_PATH}/cold-no-network-check`,
    };

    outboundAttempts = [];
    const claims = await verifyToken(goodToken, cold);

    // Both halves matter. Without the first, a verifier that refused everything
    // would also make no outbound request and would pass.
    expect(claims.sub).toBe(issuedPayload.sub);
    expect(outboundAttempts).toEqual([]);
  });

  it('refuses when the issuer produces something that is not a key set', async () => {
    // The replacement for "the JWKS endpoint answered 404". A local read has no
    // status code, so the only thing left to get wrong is the shape, and a shape
    // that is not a key set must fail closed rather than verify against nothing.
    const broken: VerifierConfig = {
      ...config,
      keySetUrl: `${BASE_URL}${JWKS_PATH}/cold-not-a-key-set`,
      readKeySet: async () => ({ nothing: 'useful' }),
    };

    const error = await expectUnauthenticated(verifyToken(goodToken, broken));
    expect(error.detail).toContain('did not produce a key set');
  });
});

describe('the token contract Better Auth actually issues', () => {
  it('carries a subject and an expiry', () => {
    console.log(`  payload keys: ${Object.keys(issuedPayload).sort().join(', ')}`);
    console.log(`  iss: ${issuedPayload.iss}`);
    console.log(`  aud: ${issuedPayload.aud}`);

    expect(issuedPayload.sub).toBeTruthy();
    expect(issuedPayload.exp).toBeTruthy();
  });

  it('does NOT carry role or app_metadata by default', () => {
    // Recorded rather than worked around. The skill documents a contract with
    // `role` and `app_metadata` in it; the default token has neither, and it
    // sets `aud` to the base URL rather than to a service name.
    expect(issuedPayload.role).toBeUndefined();
    expect(issuedPayload.app_metadata).toBeUndefined();
    expect(issuedPayload.aud).toBe(issuedPayload.iss);
  });

  it('therefore resolves a signed-in user to the anonymous role', async () => {
    // The consequence, stated out loud because it is the kind of thing that
    // looks like it works. Verification succeeds, the subject arrives, and the
    // policy engine still treats the caller as anon, so a signed-in user sees
    // exactly the public view. Closing this is what `definePayload` is for, and
    // it belongs to the step that wires auth into the router.
    const context = await authenticate(
      new Request('https://example.test/', { headers: { authorization: `Bearer ${goodToken}` } }),
      config,
    );

    expect(context.uid).toBe(issuedPayload.sub);
    expect(context.role).toBe('anon');
  });

  it('carries role and app_metadata once definePayload asks for them', async () => {
    // The fix, proven here so that the wiring step is a configuration change
    // rather than an experiment.
    const withClaims = betterAuth({
      ...options,
      plugins: [
        bearer(),
        jwt({
          jwks: { keyPairConfig: { alg: 'ES256' as const } },
          // Nested under `jwt`, not at the top level. Passing it at the top
          // level is silently ignored: the token still mints, still verifies,
          // and still has no role in it.
          jwt: {
            definePayload: ({ user }) => ({
              email: user.email,
              role: 'authenticated',
              app_metadata: { plan: 'free' },
            }),
          },
        }),
      ],
    });

    const signIn = await withClaims.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ann@example.test',
          password: 'a-password-of-ordinary-length',
        }),
      }),
    );

    const tokenResponse = await withClaims.handler(
      new Request(`${BASE_URL}/api/auth/token`, {
        method: 'GET',
        headers: { authorization: `Bearer ${signIn.headers.get('set-auth-token')}` },
      }),
    );
    const { token } = (await tokenResponse.json()) as { token: string };
    const payload = decodePayload(token);

    console.log(
      `  with definePayload: role=${payload.role} app_metadata=${JSON.stringify(payload.app_metadata)}`,
    );

    expect(payload.role).toBe('authenticated');
    expect(payload.app_metadata).toEqual({ plan: 'free' });
  }, 60_000);
});

describe('bearerToken', () => {
  const withHeader = (value: string): Request =>
    new Request('https://example.test/', { headers: { authorization: value } });

  it('reads a bearer token', () => {
    expect(bearerToken(withHeader('Bearer abc.def.ghi'))).toBe('abc.def.ghi');
  });

  it('is case insensitive about the scheme', () => {
    expect(bearerToken(withHeader('bearer abc'))).toBe('abc');
  });

  it('ignores another scheme', () => {
    expect(bearerToken(withHeader('Basic abc'))).toBeNull();
  });

  it('ignores an empty token', () => {
    expect(bearerToken(withHeader('Bearer   '))).toBeNull();
  });

  it('is null when the header is absent', () => {
    expect(bearerToken(new Request('https://example.test/'))).toBeNull();
  });
});

describe('what the verifier accepts', () => {
  it('accepts a token the issuer minted', async () => {
    const claims = await verifyToken(goodToken, config);
    expect(claims.sub).toBe(issuedPayload.sub);
  });

  it('serves the second verification from the cache', async () => {
    // Not a performance claim. The point is that the JWKS endpoint is not on
    // the hot path, which only holds if the cache-control header did its job.
    await verifyToken(goodToken, config);
    await expect(verifyToken(goodToken, config)).resolves.toBeTruthy();
  });
});

describe('what the verifier refuses', () => {
  it('refuses a token signed by an unknown key', async () => {
    // The most important one. A well-formed token with every claim correct,
    // signed by somebody who is not the issuer.
    await expectUnauthenticated(verifyToken(await foreignToken(), config));
  });

  it('refuses a token minted for a different deployment', async () => {
    await expectUnauthenticated(
      verifyToken(goodToken, { ...config, issuer: 'https://somebody-else.test' }),
    );
  });

  it('refuses a token with the wrong audience', async () => {
    await expectUnauthenticated(
      verifyToken(goodToken, { ...config, audience: 'not-this-service' }),
    );
  });

  it('refuses an expired token', async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const expired = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject('u_ann')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);

    await expectUnauthenticated(verifyToken(expired, config));
  });

  it('refuses an unsigned token, whatever its header claims', async () => {
    // alg none, the oldest trick there is. Pinning the algorithm list is what
    // stops the token from choosing how it gets checked.
    const header = btoa(JSON.stringify({ alg: 'none' })).replace(/=+$/, '');
    const payload = btoa(JSON.stringify({ sub: 'u_impostor', iss: config.issuer })).replace(
      /=+$/,
      '',
    );

    await expectUnauthenticated(verifyToken(`${header}.${payload}.`, config));
  });

  it('tells the client nothing about why, and the log everything', async () => {
    // Rule 00 invariant I5 applied to identity. "Expired" and "forged" and "not
    // for us" are all useful to somebody probing, so the client is told none of
    // them and every refusal reads identically. The reason lives in `detail`,
    // which `toResponseBody` never serialises.
    const forged = await expectUnauthenticated(verifyToken(await foreignToken(), config));
    const wrongAudience = await expectUnauthenticated(
      verifyToken(goodToken, { ...config, audience: 'wrong' }),
    );

    expect(forged.toResponseBody()).toEqual(wrongAudience.toResponseBody());
    expect(JSON.stringify(forged.toResponseBody())).not.toContain(forged.detail);

    // Different causes, different diagnostics, same thing said out loud.
    expect(forged.detail).toBeTruthy();
    expect(wrongAudience.detail).toBeTruthy();
    expect(forged.detail).not.toBe(wrongAudience.detail);
  });
});

describe('authenticate', () => {
  it('is anonymous when no credentials are presented', async () => {
    const context = await authenticate(new Request('https://example.test/'), config);

    expect(context.role).toBe('anon');
    expect(context.uid).toBeNull();
  });

  it('carries the subject through when the token is good', async () => {
    const context = await authenticate(
      new Request('https://example.test/', { headers: { authorization: `Bearer ${goodToken}` } }),
      config,
    );

    expect(context.uid).toBe(issuedPayload.sub);
  });

  it('refuses rather than quietly downgrading a bad token to anonymous', async () => {
    // The tempting shortcut, and a bad one. A caller with an expired session
    // would silently get the public view and see an empty page with no
    // explanation, which reads as data loss rather than as a sign-in prompt.
    const request = new Request('https://example.test/', {
      headers: { authorization: `Bearer ${await foreignToken()}` },
    });

    await expectUnauthenticated(authenticate(request, config));
  });

  it('never lets user metadata into the context', async () => {
    // Rule 00 invariant I4 at the last place it could go wrong. Even if a token
    // carries user_metadata, AuthCtx has nowhere to put it.
    const context = await authenticate(
      new Request('https://example.test/', { headers: { authorization: `Bearer ${goodToken}` } }),
      config,
    );

    expect(Object.keys(context).sort()).toEqual(['app', 'email', 'role', 'uid']);
    expect(JSON.stringify(context)).not.toContain('user_metadata');
  });
});

/**
 * Rotation, made to happen rather than waited for.
 *
 * The retry after ERR_JWKS_NO_MATCHING_KEY is the one branch here that only
 * production runs. It runs on the day a key rotates, and if it is wrong then
 * every request 401s at once, which is the worst imaginable moment to discover
 * it. So these tests do not wait for an issuer to rotate on its own: both key
 * sets are minted here, and the endpoint changes its mind exactly when told to.
 *
 * Better Auth is deliberately absent from this section. It mints one key set
 * and has no reason to replace it on request, and the whole subject is the
 * moment between two key sets, which only a hand-built endpoint holds still.
 */

const ROTATION_ISSUER = 'https://rotating-issuer.test';
const ROTATION_AUDIENCE = 'baseclf-rotation';

/** An issuer's signing key, with the public half shaped the way a JWKS carries it. */
interface RotationKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

/**
 * A key pair that a key set can be built from and a token signed with.
 *
 * The `kid` is not decoration. `jose` only reports ERR_JWKS_NO_MATCHING_KEY
 * when it can rule every key in the set out, and with no `kid` in the header it
 * cannot: it keeps the single key it has, checks the signature against it, and
 * fails with a different code that this path deliberately does not retry. A
 * rotation test whose two keys share a `kid`, or carry none, exercises the
 * wrong branch and passes anyway.
 */
async function rotationKey(kid: string): Promise<RotationKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });

  return {
    kid,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' },
  };
}

/** What each scenario's key store holds at this moment. */
const servedKeySets = new Map<string, JSONWebKeySet>();
/** How many times each scenario's key store was actually read. */
const timesRead = new Map<string, number>();

/**
 * A key set name of its own for every scenario.
 *
 * `loadJwks` caches by this name through the Cache API, and that cache outlives
 * the test that filled it. Two scenarios sharing a name would share a cached key
 * set, so the second one would be reading the first one's leftovers while
 * appearing to arrange its own. Every count below would then be measuring the
 * wrong thing, and nothing would look wrong. Distinct names are what keeps these
 * tests independent.
 *
 * `readKeySet` reads the map rather than answering a request. Rotation used to be
 * staged by chaining another `fetch` interceptor on top of the file's own, which
 * worked and also meant these tests could not tell a local read from a network
 * one. Now they can: nothing here can reach `fetch` at all.
 */
function scenario(name: string): VerifierConfig {
  const keySetUrl = `${ROTATION_ISSUER}/jwks/${name}`;

  return {
    keySetUrl,
    readKeySet: async () => {
      const served = servedKeySets.get(keySetUrl);
      if (served === undefined) throw new Error(`scenario "${name}" has no key set staged`);
      timesRead.set(keySetUrl, (timesRead.get(keySetUrl) ?? 0) + 1);
      return served;
    },
    issuer: ROTATION_ISSUER,
    audience: ROTATION_AUDIENCE,
  };
}

/** Point a scenario's key store at a key set, replacing whatever it held before. */
function nowServes(config: VerifierConfig, ...keys: readonly RotationKey[]): void {
  servedKeySets.set(config.keySetUrl, { keys: keys.map((key) => key.publicJwk) });
}

function readsOf(config: VerifierConfig): number {
  return timesRead.get(config.keySetUrl) ?? 0;
}

async function tokenFrom(
  key: RotationKey,
  config: VerifierConfig,
  subject: string,
  expiresAt: string | number = '1h',
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: key.kid })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setSubject(subject)
    .setExpirationTime(expiresAt)
    .sign(key.privateKey);
}

describe('what a refusal carries with it', () => {
  /**
   * The whole error graph, serialised the way a careless log line would
   * serialise it. Own properties at every level, cycles cut, so a payload
   * parked anywhere in the wreckage shows up in the string.
   */
  function drained(error: unknown): string {
    const seen = new Set<unknown>();
    const walk = (value: unknown): unknown => {
      if (typeof value !== 'object' || value === null) return value;
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const key of Object.getOwnPropertyNames(value)) {
        out[key] = walk((value as Record<string, unknown>)[key]);
      }
      return out;
    };
    return JSON.stringify(walk(error));
  }

  it('keeps the decoded payload out of the error it throws', async () => {
    // A token that passes the signature check and fails a claim check, because
    // that is the family of jose errors that carries the full decoded payload
    // on a `payload` property (debt 22). The real token's claims include the
    // account email, which is what this test hunts for in the wreckage.
    const elsewhere: VerifierConfig = { ...config, audience: 'https://somebody-else.test' };

    const refusal = await expectUnauthenticated(verifyToken(goodToken, elsewhere));

    const everything = drained(refusal);
    expect(everything).not.toContain('ann@example.test');
    expect(everything).not.toContain(String(issuedPayload.sub));

    // The debugging value survives: the name and the code, and nothing else.
    const cause = refusal.cause as { name?: string; code?: string };
    expect(cause.name).toBe('JWTClaimValidationFailed');
    expect(cause.code).toBe('ERR_JWT_CLAIM_VALIDATION_FAILED');
    expect(Object.getOwnPropertyNames(cause).sort()).toEqual(['code', 'name']);
  });
});

describe('when the issuer rotates its signing key', () => {
  // No fetch interception here any more. Rotation is staged through the
  // scenario's own `readKeySet`, so the file-level interceptor stays in force
  // throughout and any request escaping to the network fails the test.

  it('accepts a token signed by the new key after dropping the cached key set once', async () => {
    const config = scenario('heals');
    const retired = await rotationKey('key-2026-07');
    const current = await rotationKey('key-2026-08');

    // Warm the cache the way production does, with an ordinary verification.
    nowServes(config, retired);
    const settled = await tokenFrom(retired, config, 'u_before');
    await verifyToken(settled, config);
    expect(readsOf(config)).toBe(1);

    // Prove the cache is really holding the old set before rotating anything,
    // because the rest of this test means nothing otherwise. If the put had
    // stored nothing, the verification after the rotation would fetch the new
    // set on its first attempt and succeed without ever reaching the branch
    // under test, and the final count would still read two.
    await verifyToken(settled, config);
    expect(readsOf(config)).toBe(1);

    // The rotation. Tokens signed by a key our cached copy predates start
    // arriving immediately, long before any TTL would have expired.
    nowServes(config, current);
    const claims = await verifyToken(await tokenFrom(current, config, 'u_after'), config);

    // It succeeded, rather than merely failing to throw.
    expect(claims.sub).toBe('u_after');

    // And the endpoint was reached exactly once more, so the stale set did come
    // back from the cache, was dropped once, and the refetch did not repeat.
    expect(readsOf(config)).toBe(2);
  });

  it('writes the reloaded key set back, so the rotation costs one reload and not one per request', async () => {
    const config = scenario('persists');
    const retired = await rotationKey('key-2026-07');
    const current = await rotationKey('key-2026-08');

    nowServes(config, retired);
    await verifyToken(await tokenFrom(retired, config, 'u_before'), config);

    nowServes(config, current);
    const token = await tokenFrom(current, config, 'u_after');
    await verifyToken(token, config);
    expect(readsOf(config)).toBe(2);

    // The next request pays nothing. If the refresh had handed the fresh set to
    // its caller without storing it, every request for the rest of this
    // deployment's life would fetch twice and still answer correctly, so the
    // only visible symptom would be a quiet doubling of outbound requests
    // against a subrequest budget of 50.
    await expect(verifyToken(token, config)).resolves.toBeTruthy();
    expect(readsOf(config)).toBe(2);
  });

  it('still refuses with 401 when the reloaded key set has no matching key either', async () => {
    const config = scenario('still-unknown');
    const issuerKey = await rotationKey('key-2026-07');
    const impostorKey = await rotationKey('key-nobody-published');

    nowServes(config, issuerKey);
    await verifyToken(await tokenFrom(issuerKey, config, 'u_before'), config);

    // A forged token whose `kid` matches nothing, before the refresh or after
    // it. The retry is an allowance for rotation, not a second chance at a
    // signature, and the refusal has to survive the extra round trip intact.
    const refused = await expectUnauthenticated(
      verifyToken(await tokenFrom(impostorKey, config, 'u_impostor'), config),
    );

    expect(readsOf(config)).toBe(2);

    // The refusal came from the retry rather than from the first attempt. Every
    // refusal on this path carries the same status, code and message by design
    // (invariant I5), so without checking the diagnostic the assertions above
    // would hold even if the refresh had never happened at all.
    expect(refused.detail).toContain('after reloading the key set');
  });

  it('does not reload for a refusal that a fresh key set could not fix', async () => {
    const config = scenario('no-pointless-refresh');
    const key = await rotationKey('key-2026-07');

    nowServes(config, key);
    await verifyToken(await tokenFrom(key, config, 'u_before'), config);
    expect(readsOf(config)).toBe(1);

    // Signed by the very key the endpoint publishes, and expired. `jose` finds
    // the key and then rejects the claim, so there is no key set anywhere that
    // would make this token valid.
    const expired = await tokenFrom(key, config, 'u_stale', Math.floor(Date.now() / 1000) - 3600);
    const refused = await expectUnauthenticated(verifyToken(expired, config));

    // The narrow condition on the retry is load-bearing rather than tidy. A
    // reload on any refusal would mean an expired token, the most ordinary
    // refusal there is, re-reading the key store on every request.
    //
    // ⚠️ The count is the assertion that carries this. The `detail` check below
    // is deliberately written against the message the retry path emits *today*:
    // when this said `not.toContain('after refreshing')` and the message had
    // become "after reloading", it passed no matter what the code did. A
    // negative assertion on a string that no longer exists proves nothing, and
    // it goes on reporting success while it does.
    expect(readsOf(config)).toBe(1);
    expect(refused.detail).not.toContain('after reloading');
  });
});

/**
 * ⚠️ This section used to test a brake on the retry. The brake was removed on
 * 2026-08-15 by an explicit decision, and these tests were rewritten rather than
 * deleted, so read this before assuming they were weakened to go green.
 *
 * `kid` is a header field the attacker writes, so an unknown one on every token
 * is free to produce. When the retry meant `fetch`, that bought one outbound
 * request per inbound one against a subrequest budget of 50, and a cooldown
 * marker plus an in-flight map existed to bound it. The key set is now read in
 * process, so a forged token buys a local read and no subrequest at all, and
 * both brakes went with the fetch that justified them.
 *
 * What replaced them is the assertion the brake was only ever a proxy for: under
 * a flood of forged tokens, **nothing goes out**. That is a stronger statement
 * than "at most one request per window", and unlike the old one it stays true
 * without any counting. Refusal itself is unchanged and still asserted here,
 * because it is the part that was always about security rather than about cost.
 */
describe('when tokens carry key ids nobody published', () => {
  // No fetch interception, for the same reason as the rotation section: these
  // scenarios stage their key sets through `readKeySet`, so the file-level
  // interceptor stays in force and a request escaping to the network fails.

  /** A token signed by a key the issuer never published, with a `kid` of its own. */
  async function impostorToken(config: VerifierConfig, kid: string): Promise<string> {
    return tokenFrom(await rotationKey(kid), config, 'u_impostor');
  }

  it('refuses every one of them, however many arrive', async () => {
    const config = scenario('unknown-kid-sequential');
    const issuerKey = await rotationKey('key-2026-07');

    nowServes(config, issuerKey);
    await verifyToken(await tokenFrom(issuerKey, config, 'u_before'), config);

    // The security property, and the one that did not change when the brake
    // went. Each of these reloads the key set now instead of one of them doing
    // it, and not one of them verifies.
    for (let n = 0; n < 5; n += 1) {
      await expectUnauthenticated(
        verifyToken(await impostorToken(config, `nobody-published-${n}`), config),
      );
    }

    expect(readsOf(config)).toBe(6);
  });

  it('costs no outbound request, which is what the brake used to buy', async () => {
    const config = scenario('unknown-kid-no-network');
    const issuerKey = await rotationKey('key-2026-07');

    nowServes(config, issuerKey);
    await verifyToken(await tokenFrom(issuerKey, config, 'u_before'), config);

    outboundAttempts = [];
    for (let n = 0; n < 5; n += 1) {
      await expectUnauthenticated(
        verifyToken(await impostorToken(config, `no-network-${n}`), config),
      );
    }

    // The replacement for counting reloads. Five forged tokens used to mean up
    // to five requests this Worker paid for out of a budget of 50; now the
    // number that matters is zero, and it stays zero however many arrive.
    expect(outboundAttempts).toEqual([]);
  });

  it('refuses them identically to the client', async () => {
    const config = scenario('unknown-kid-reason');
    const issuerKey = await rotationKey('key-2026-07');

    nowServes(config, issuerKey);
    await verifyToken(await tokenFrom(issuerKey, config, 'u_before'), config);

    const first = await expectUnauthenticated(
      verifyToken(await impostorToken(config, 'unknown-a'), config),
    );
    const second = await expectUnauthenticated(
      verifyToken(await impostorToken(config, 'unknown-b'), config),
    );

    // Invariant I5. Both took the same path now that neither is braked, and the
    // client-visible body has to be identical either way. `detail` never reaches
    // a client and says the reload happened and did not help.
    expect(first.detail).toContain('after reloading the key set');
    expect(second.detail).toContain('after reloading the key set');
    expect(second.toResponseBody()).toEqual(first.toResponseBody());
  });

  it('lets one issuer be flooded without disturbing a rotation at another', async () => {
    const flooded = scenario('unknown-kid-isolation-flooded');
    const rotating = scenario('unknown-kid-isolation-rotating');

    const floodedKey = await rotationKey('key-2026-07');
    nowServes(flooded, floodedKey);
    await verifyToken(await tokenFrom(floodedKey, flooded, 'u_before'), flooded);
    await expectUnauthenticated(verifyToken(await impostorToken(flooded, 'unknown'), flooded));

    // A second deployment, rotating honestly, at the same moment the first is
    // being flooded. Cached per key set name, so one deployment's flood cannot
    // reach another's cache entry. Under the old brake the failure this guards
    // against was every request 401ing on the day a key rotates; the cache is
    // keyed the same way, so the guard is still worth keeping.
    const retired = await rotationKey('key-2026-07');
    const current = await rotationKey('key-2026-08');

    nowServes(rotating, retired);
    await verifyToken(await tokenFrom(retired, rotating, 'u_before'), rotating);
    nowServes(rotating, current);

    const claims = await verifyToken(await tokenFrom(current, rotating, 'u_after'), rotating);
    expect(claims.sub).toBe('u_after');
    expect(readsOf(rotating)).toBe(2);
  });
});

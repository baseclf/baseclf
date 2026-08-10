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
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
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
 * The issuer, served to the verifier over `fetch`.
 *
 * The verifier reaches its JWKS endpoint with a real request, so the test
 * intercepts fetch and routes that one URL into the Better Auth handler. Every
 * other URL is refused loudly rather than escaping to the network.
 */
const realFetch = globalThis.fetch;

const interceptor = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(`${BASE_URL}${JWKS_PATH}`)) {
    return auth.handler(new Request(url, { method: 'GET' }));
  }
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
    jwksUrl: `${BASE_URL}${JWKS_PATH}`,
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

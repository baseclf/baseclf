/**
 * Does Better Auth actually run inside workerd?
 *
 * This is a spike kept as a guard. Two things were unverified before V3 could
 * be designed, and both would have been expensive to discover halfway through:
 *
 *   1. Issue #6665 reports `createRequire` failing on Workers. If importing the
 *      package throws, the whole library is unusable here and V3 has to verify
 *      tokens with `jose` directly instead.
 *   2. The skill notes D1 has been supported natively since 1.5 through a
 *      built-in Kysely dialect, so `betterAuth({ database: env.DB })` should be
 *      enough. That is a claim from a changelog, not something we had run.
 *
 * Kept rather than deleted because a future version regressing Workers support
 * should fail here, loudly, rather than during a deployment.
 *
 * This file deliberately does NOT wire Better Auth into the request path. That
 * is V3. All it establishes is that the pieces load and construct.
 */

import { env } from 'cloudflare:workers';
// A bare import at module scope is itself the test for #6665: if the package
// cannot be loaded in this runtime, this file fails to import and says so.
import { betterAuth } from 'better-auth';
import { bearer, jwt } from 'better-auth/plugins';
import { describe, expect, it } from 'vitest';

/**
 * A secret for construction only. Not a credential: it never signs anything a
 * caller sees, because this file makes no requests. Real deployments take this
 * from `wrangler secret`, never from source.
 */
const CONSTRUCTION_ONLY_SECRET = 'test-secret-not-used-to-sign-anything-real';

describe('better-auth in workerd', () => {
  it('imports without tripping the createRequire failure of issue 6665', () => {
    expect(typeof betterAuth).toBe('function');
    expect(typeof jwt).toBe('function');
    expect(typeof bearer).toBe('function');
  });

  it('constructs against a D1 binding with no adapter package', () => {
    // The claim under test: since 1.5 the D1 binding is understood directly and
    // `kysely-d1` is not needed. Their own docs still say otherwise.
    const auth = betterAuth({
      database: env.DB,
      secret: CONSTRUCTION_ONLY_SECRET,
      baseURL: 'https://example.test',
    });

    expect(auth).toBeTruthy();
    expect(typeof auth.handler).toBe('function');
  });

  it('accepts the bearer and ES256 jwt plugins', () => {
    // Rule 00 and the auth skill both require ES256 rather than the EdDSA
    // default, because third parties verify these tokens. Construction
    // succeeding is not proof the algorithm took effect; that is checked in V3
    // by reading the header of a token this actually issues.
    const auth = betterAuth({
      database: env.DB,
      secret: CONSTRUCTION_ONLY_SECRET,
      baseURL: 'https://example.test',
      plugins: [
        bearer(),
        jwt({
          jwks: {
            keyPairConfig: { alg: 'ES256' },
          },
        }),
      ],
    });

    expect(typeof auth.handler).toBe('function');
    expect(auth.options.plugins?.length).toBe(2);
  });

  it('answers a request rather than throwing at the boundary', async () => {
    // The lightest possible end to end signal: hand the handler a request and
    // see that it produces a Response. What the response says does not matter
    // here. That it is a Response, produced inside workerd, does.
    const auth = betterAuth({
      database: env.DB,
      secret: CONSTRUCTION_ONLY_SECRET,
      baseURL: 'https://example.test',
      plugins: [bearer()],
    });

    const response = await auth.handler(
      new Request('https://example.test/api/auth/ok', { method: 'GET' }),
    );

    expect(response).toBeInstanceOf(Response);
    console.log(`  better-auth handler answered with HTTP ${response.status}`);
  });
});

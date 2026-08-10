/**
 * Turning a bearer token into an identity, or refusing to.
 *
 * This is a security boundary. Everything downstream, every policy predicate
 * and every compiled statement, trusts that whatever comes out of here was
 * signed by the issuer we expect. So the checks are explicit rather than
 * inherited from a library default:
 *
 *   - The algorithm is pinned to ES256. A token names its own algorithm in a
 *     header the attacker also controls, so accepting whatever it claims is
 *     the classic confusion attack. `jose` will not consider anything else.
 *   - Issuer and audience are checked, not merely present. A validly signed
 *     token from a different deployment is still not a token for this one.
 *   - Expiry is checked with no clock tolerance beyond a few seconds, because
 *     a long tolerance is an extension of every stolen token's life.
 *
 * Key material is fetched from the issuer's JWKS endpoint and cached through
 * the Cache API rather than in a module variable. `createRemoteJWKSet` caches
 * per isolate, and isolates are evicted aggressively, so that arrangement
 * re-fetches far more often than it looks like it does. The Cache API is
 * per-colo and survives the isolate.
 *
 * Rotation is handled rather than waited out. When a key rotates, tokens signed
 * with the new one arrive before any TTL expires, and every one of them fails
 * against a cached key set. `jose` reports that as ERR_JWKS_NO_MATCHING_KEY,
 * which is the signal to drop the cache once and try again.
 *
 * Rule 00 invariant I9: nothing here logs a token, a claim value, or a key.
 */

import { createLocalJWKSet, type JSONWebKeySet, type JWK, type JWTPayload, jwtVerify } from 'jose';

import type { AuthCtx } from '../policy/types.js';
import { BaseclfError } from '../utils/errors.js';
import { logEvent } from '../utils/log.js';
import { anonymousContext, contextFromClaims, type VerifiedClaims } from './claims.js';

/** The only signature algorithm this engine accepts. See the auth skill, trap 4. */
export const ACCEPTED_ALGORITHM = 'ES256';

/**
 * How long a fetched key set may be reused.
 *
 * Short enough that a rotation heals on its own within minutes, long enough
 * that the JWKS endpoint is not on the hot path of every request. Rotation does
 * not actually wait for this, because a miss triggers an immediate refresh.
 */
export const JWKS_CACHE_SECONDS = 300;

/** Tokens more than this far in the future are rejected outright. */
const CLOCK_TOLERANCE_SECONDS = 5;

export interface VerifierConfig {
  /** Where the JWKS lives, usually `${baseURL}/api/auth/jwks`. */
  readonly jwksUrl: string;
  /** The `iss` a token must carry. */
  readonly issuer: string;
  /** The `aud` a token must carry. */
  readonly audience: string;
}

/**
 * Narrow an unknown payload to a key set, rather than asserting it is one.
 *
 * rule 03 section D: no `as` across a security boundary. What comes back from
 * the JWKS endpoint is network input, and this is the point where it stops
 * being unknown.
 */
function asKeySet(value: unknown): JSONWebKeySet | null {
  if (typeof value !== 'object' || value === null || !('keys' in value)) return null;

  const keys: unknown = value.keys;
  if (!Array.isArray(keys)) return null;
  if (!keys.every((key) => typeof key === 'object' && key !== null && !Array.isArray(key))) {
    return null;
  }

  // The one assertion left, and it is not a claim that these are valid keys.
  // It says they are objects in a list, which is what was just checked. Whether
  // any of them is a usable key is decided by `jose` when it looks for one, and
  // a set full of nonsense ends at the same 401 as no set at all.
  return { keys: keys as JWK[] };
}

function unauthorized(detail: string, cause?: unknown): BaseclfError {
  // The message is deliberately the same for every failure. A caller learns
  // that the token was not accepted and nothing about why, because "expired"
  // and "wrong signature" and "unknown key" are all useful to an attacker.
  return new BaseclfError('UNAUTHENTICATED', 401, {
    message: 'Unauthenticated.',
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The cache key. A URL, because the Cache API is keyed by request. */
function cacheKeyFor(jwksUrl: string): Request {
  return new Request(jwksUrl, { method: 'GET' });
}

async function fetchJwks(jwksUrl: string): Promise<JSONWebKeySet> {
  const response = await fetch(jwksUrl, {
    // Never let a slow or hanging identity provider hold a request open.
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw unauthorized(`The JWKS endpoint answered ${response.status}.`);
  }

  const jwks = asKeySet(await response.json());
  if (jwks === null) {
    throw unauthorized('The JWKS endpoint did not return a key set.');
  }

  return jwks;
}

/**
 * The issuer's key set, from cache when possible.
 *
 * `refresh` skips the cache and replaces what is there, which is what a
 * rotation needs.
 */
async function loadJwks(jwksUrl: string, refresh: boolean): Promise<JSONWebKeySet> {
  const cache = await caches.open('baseclf:jwks');
  const key = cacheKeyFor(jwksUrl);

  if (!refresh) {
    const hit = await cache.match(key);
    if (hit) {
      // Cached bytes get the same narrowing as fresh ones. A cache is storage,
      // and storage is not a reason to trust a shape.
      const cached = asKeySet(await hit.json());
      if (cached !== null) return cached;
    }
  }

  const jwks = await fetchJwks(jwksUrl);

  // The cache-control header is not decoration. Without it the put succeeds and
  // stores nothing, so every request would refetch while appearing to work.
  // Measured in workerd, rules/02 section F.
  await cache.put(
    key,
    new Response(JSON.stringify(jwks), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `max-age=${JWKS_CACHE_SECONDS}`,
      },
    }),
  );

  return jwks;
}

/** The bearer token in an Authorization header, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;

  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;

  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

async function verifyAgainst(
  token: string,
  jwks: JSONWebKeySet,
  config: VerifierConfig,
): Promise<JWTPayload> {
  const keySet = createLocalJWKSet(jwks);

  const { payload } = await jwtVerify(token, keySet, {
    algorithms: [ACCEPTED_ALGORITHM],
    issuer: config.issuer,
    audience: config.audience,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
  });

  return payload;
}

/**
 * Verify a token and return the claims it carries.
 *
 * Throws `BaseclfError` with status 401 for anything that is not a valid token
 * for this deployment. Never returns a partially checked result.
 */
export async function verifyToken(token: string, config: VerifierConfig): Promise<VerifiedClaims> {
  let jwks = await loadJwks(config.jwksUrl, false);

  try {
    return await verifyAgainst(token, jwks, config);
  } catch (error) {
    const code = (error as { code?: string }).code;

    // The one failure worth retrying. A key rotated, our copy predates it, and
    // no amount of waiting for a TTL makes the next request succeed either.
    if (code !== 'ERR_JWKS_NO_MATCHING_KEY') {
      throw unauthorized(`Token rejected: ${code ?? 'signature or claim check failed'}.`, error);
    }

    logEvent({ event: 'jwks_refresh', reason: 'no_matching_key' });
    jwks = await loadJwks(config.jwksUrl, true);

    try {
      return await verifyAgainst(token, jwks, config);
    } catch (retryError) {
      const retryCode = (retryError as { code?: string }).code;
      throw unauthorized(
        `Token rejected after refreshing the key set: ${retryCode ?? 'unknown'}.`,
        retryError,
      );
    }
  }
}

/**
 * The identity a request carries.
 *
 * No token means anonymous, which is a role with policies of its own rather
 * than an absence of checks. A token that fails verification is an error, not
 * a quiet downgrade to anonymous: a caller who sent credentials deserves to
 * know they were not accepted, and silently serving them the public view would
 * hide an expired session behind an empty page.
 */
export async function authenticate(request: Request, config: VerifierConfig): Promise<AuthCtx> {
  const token = bearerToken(request);
  if (token === null) return anonymousContext();

  return contextFromClaims(await verifyToken(token, config));
}

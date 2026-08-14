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
 * 🔴 Key material is read **in process**, never over the network, and that is a
 * correction rather than an optimisation.
 *
 * This file used to `fetch` the issuer's JWKS endpoint. The issuer is this same
 * Worker, so that was a Worker asking the network for a document it was already
 * holding, and on Cloudflare it does not arrive: measured on a real deployment
 * 2026-08-15, a Worker fetching its own `*.workers.dev` JWKS URL is answered
 * **404**, while the identical URL answers 200 from outside. Every JWT therefore
 * failed with `The JWKS endpoint answered 404.`, on every deployment, since V3.
 *
 * Nothing caught it. Every test covering this path replaced `globalThis.fetch`
 * with a loopback into the Worker, which is a faithful simulation of the one
 * thing that was broken. `_diagnose`, `doctor` and the JWKS endpoint all
 * reported healthy because all three ask from the outside, and outside was never
 * the broken side. See rules/02 §G14.
 *
 * So the source is now `config.readKeySet`, which reaches the issuer's own key
 * store without leaving the isolate. The failure mode is gone by construction:
 * there is no request to lose.
 *
 * The result is still cached through the Cache API rather than a module
 * variable. Reading the key store is a database read, and doing one per verified
 * request is a cost rule 01 §D counts. The Cache API is per-colo and survives
 * the isolate, which a module variable does not.
 *
 * Rotation is handled rather than waited out. When a key rotates, tokens signed
 * with the new one arrive before any TTL expires, and every one of them fails
 * against a cached key set. `jose` reports that as ERR_JWKS_NO_MATCHING_KEY,
 * which is the signal to drop the cache once and read again.
 *
 * ⚠️ That retry used to be rate limited, by a cooldown marker and an in-flight
 * map, and both are gone with the fetch that justified them. Their whole reason
 * was amplification: a token names its own `kid`, an attacker writes the token,
 * and an unthrottled retry turned a stream of forged tokens into a stream of
 * outbound requests against a subrequest budget of 50. A local read has no
 * subrequest to amplify. Removing them is therefore not a loosening, but it is a
 * removal, recorded here so that anyone reintroducing a network source knows to
 * bring the brakes back with it. `scripts/mutate-jwks-brake.mjs` became
 * `scripts/mutate-jwks-source.mjs` at the same time, and its first mutation now
 * puts the network back on this path to check that a test says so.
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
  /**
   * Names this issuer's key set. Used as the cache key, and never fetched.
   *
   * Still spelled as the public JWKS address because that is what identifies a
   * key set to everyone else, and because a cache shared per colo needs a name
   * that cannot collide with another deployment's. Nothing here requests it.
   */
  readonly keySetUrl: string;
  /**
   * Reads the issuer's key set without leaving the isolate.
   *
   * Returns `unknown` on purpose. Whatever this produces is narrowed by
   * `asKeySet` before anything trusts its shape, exactly as network input was,
   * because "it came from in process" is a statement about provenance and not
   * about shape.
   */
  readonly readKeySet: () => Promise<unknown>;
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

/**
 * The issuer's key set, read from its own store.
 *
 * `readKeySet` does not leave the isolate, so unlike the `fetch` this replaces
 * there is no status code to interpret and no timeout to arm. What is left is
 * the part that always mattered: whatever comes back is narrowed before anything
 * trusts it.
 */
async function readJwks(config: VerifierConfig): Promise<JSONWebKeySet> {
  const jwks = asKeySet(await config.readKeySet());
  if (jwks === null) {
    throw unauthorized('The issuer did not produce a key set.');
  }

  return jwks;
}

/**
 * The issuer's key set, from cache when possible.
 *
 * `refresh` skips the cache and replaces what is there, which is what a
 * rotation needs.
 */
async function loadJwks(config: VerifierConfig, refresh: boolean): Promise<JSONWebKeySet> {
  const cache = await caches.open('baseclf:jwks');
  const key = cacheKeyFor(config.keySetUrl);

  if (!refresh) {
    const hit = await cache.match(key);
    if (hit) {
      // Cached bytes get the same narrowing as fresh ones. A cache is storage,
      // and storage is not a reason to trust a shape.
      const cached = asKeySet(await hit.json());
      if (cached !== null) return cached;
    }
  }

  const jwks = await readJwks(config);

  // The cache-control header is not decoration. Without it the put succeeds and
  // stores nothing, so every request would re-read while appearing to work.
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
  const jwks = await loadJwks(config, false);

  try {
    return await verifyAgainst(token, jwks, config);
  } catch (error) {
    const code = (error as { code?: string }).code;

    // The one failure worth retrying. A key rotated, our copy predates it, and
    // no amount of waiting for a TTL makes the next request succeed either.
    if (code !== 'ERR_JWKS_NO_MATCHING_KEY') {
      throw unauthorized(`Token rejected: ${code ?? 'signature or claim check failed'}.`, error);
    }

    // Unthrottled on purpose, and only because the reload is local. When this was
    // a fetch, one forged token bought one outbound request and the brakes above
    // existed to bound that; a read that never leaves the isolate has nothing to
    // amplify. Reintroduce a network source and this line needs a brake again.
    logEvent({ event: 'jwks_reload', reason: 'no_matching_key' });
    const reloaded = await loadJwks(config, true);

    try {
      return await verifyAgainst(token, reloaded, config);
    } catch (retryError) {
      const retryCode = (retryError as { code?: string }).code;
      throw unauthorized(
        `Token rejected after reloading the key set: ${retryCode ?? 'unknown'}.`,
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

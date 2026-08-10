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
 * That retry is rate limited, and the reason is not politeness. A token names
 * its own `kid`, the attacker writes the token, and this deployment's JWKS URL
 * points back at this same Worker. So an unthrottled retry turns a stream of
 * junk tokens into a stream of the Worker calling itself, one outbound request
 * per inbound one, against a subrequest budget of 50 and a bill that grows with
 * it. Nothing leaks, which is why this is a brake rather than a lock: the retry
 * still happens, just not once per forged token.
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

/**
 * How long after one refresh the next one is refused.
 *
 * This bounds the amplification described at the top of the file: a flood of
 * tokens carrying unknown key ids costs at most one outbound request per window
 * per colo, instead of one per token.
 *
 * What it costs is narrower than it first looks. A rotation still heals on the
 * very first token signed with the new key, because that token's refresh is the
 * one the window opens with. The wait only applies when a refresh has already
 * happened and did not help, which means either the token is forged or the
 * issuer had not finished publishing the new key yet. Thirty seconds is chosen
 * against the second case: long enough to be a real brake, short enough that a
 * rotation caught mid-publication resolves itself without anybody looking.
 */
export const JWKS_REFRESH_COOLDOWN_SECONDS = 30;

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

/**
 * Where the cooldown marker lives.
 *
 * A namespace of its own rather than a derived key in the one above. Deriving a
 * key would mean inventing a URL that is not the JWKS URL, and any scheme for
 * that (a query string, an extra path segment) is a scheme some real issuer's
 * URL could collide with. Two namespaces holding the same key cannot collide at
 * all, and there is nothing to reason about.
 */
const REFRESH_COOLDOWN_CACHE = 'baseclf:jwks-refresh-cooldown';

/**
 * Take the right to refresh, or find that it was just taken.
 *
 * Returns true at most once per window per colo. The marker is written *before*
 * the caller goes on to fetch rather than after it, so that the window a burst
 * could fit through is one cache write wide instead of one whole round trip to
 * the issuer.
 *
 * That ordering is a design choice held to by reading, not by a test. The case it
 * protects is a burst spread across isolates, and a single-isolate test cannot
 * produce one: locally the in-flight map below already collapses the burst before
 * the ordering matters. Do not read the tests as evidence for this line.
 *
 * The marker is written even though the caller's fetch may then fail, and that is
 * deliberate. An issuer that is timing out or answering 500 is the last thing
 * that should be retried once per inbound request.
 *
 * Keyed per JWKS URL, so a flood against one deployment cannot brake a genuine
 * rotation at another.
 */
async function claimRefresh(jwksUrl: string): Promise<boolean> {
  const cache = await caches.open(REFRESH_COOLDOWN_CACHE);
  const key = cacheKeyFor(jwksUrl);

  if (await cache.match(key)) return false;

  await cache.put(
    key,
    // The cache-control header is what makes this a cooldown at all: the window
    // is the entry's own freshness lifetime. Omit it and `put` stores nothing,
    // silently, so the brake would never engage while every test that only
    // checks the happy path kept passing. Measured in workerd, rules/02 §F.
    new Response('1', {
      headers: { 'cache-control': `max-age=${JWKS_REFRESH_COOLDOWN_SECONDS}` },
    }),
  );

  return true;
}

/**
 * Reloads in flight in this isolate, keyed by JWKS URL.
 *
 * A second brake, because the first one does not cover a burst. `claimRefresh`
 * has to read the cache before it can write to it, and both are awaits, so five
 * requests arriving in the same tick all read an empty cache before any of them
 * has written anything. Measured: five forged tokens sent together produced five
 * refreshes with the marker alone.
 *
 * The two are not redundant, they cover different axes. The marker bounds
 * refreshes *over time* and across isolates in a colo; this bounds them *at one
 * moment* inside one isolate. Removing this one entirely is caught by the
 * concurrent test below.
 *
 * They do overlap, though, and the overlap was measured rather than guessed:
 * once anything at all staggers the requests in a burst, the marker alone holds
 * the count down, and the tests cannot then tell this brake apart from a subtly
 * weakened version of it. See the known survivor recorded in
 * `scripts/mutate-jwks-brake.mjs`.
 *
 * Module scope is the right lifetime here, unlike the rate limiter, which was
 * deliberately kept out of it (`src/utils/ratelimit.ts`). That one counts, and a
 * per-isolate counter silently multiplies the limit by the number of isolates.
 * This one collapses duplicate work rather than counting it: being per-isolate
 * makes it weaker, never wrong.
 */
const refreshesInFlight = new Map<string, Promise<JSONWebKeySet | null>>();

/**
 * Reload the key set, or refuse to.
 *
 * Null means a brake stopped it, which the caller must treat as a refusal rather
 * than as an absence of information. Never returns a stale set dressed up as a
 * fresh one.
 */
function refreshKeySet(jwksUrl: string): Promise<JSONWebKeySet | null> {
  const joined = refreshesInFlight.get(jwksUrl);
  if (joined !== undefined) return joined;

  const started = (async () => {
    try {
      if (!(await claimRefresh(jwksUrl))) return null;

      // Logged here rather than at the call site so that one line means one
      // outbound request. Logged at the call site, everyone who joined an
      // in-flight refresh would log one too, and the only signal that says
      // whether this Worker is fetching itself in a loop would overcount.
      logEvent({ event: 'jwks_refresh', reason: 'no_matching_key' });
      return await loadJwks(jwksUrl, true);
    } finally {
      refreshesInFlight.delete(jwksUrl);
    }
  })();

  // Registered with no await between the lookup above and this line, so no other
  // caller can observe the map in between. That is why this function is not
  // `async`: an await opened here would be a gap for a burst to fit through.
  //
  // Held to deliberately rather than because a test enforces it. Opening that gap
  // was tried as a mutation and the suite stayed green, because the cooldown
  // marker catches the same burst on its own. So this is the cheaper of two
  // brakes doing a job the other would also do, kept because it costs a Map and
  // one comparison, not because it is load-bearing on its own.
  refreshesInFlight.set(jwksUrl, started);

  return started;
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

    // Fail-closed: a brake that declines to refresh answers 401. It never waves a
    // token through on the grounds that it could not check the token properly.
    const refreshed = await refreshKeySet(config.jwksUrl);
    if (refreshed === null) {
      logEvent({ event: 'jwks_refresh_declined', reason: 'cooldown' });
      throw unauthorized(
        'Token rejected: no matching key, and the key set was refreshed too recently to refresh it again.',
        error,
      );
    }

    jwks = refreshed;

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

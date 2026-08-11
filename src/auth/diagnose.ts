/**
 * The body of `GET /api/auth/_diagnose`.
 *
 * A wrong `BETTER_AUTH_URL` is the most common way an otherwise correct
 * deployment fails to sign anyone in, and it fails in the least helpful way
 * available: the provider answers `redirect_uri_mismatch` and nothing in the
 * logs mentions the hostname. This endpoint exists to make that a thing you
 * read rather than a thing you deduce. See the auth skill, trap 1.
 *
 * **This endpoint is public, on purpose.** Redirect URIs are public by nature,
 * they end up in an address bar during every sign-in, and `baseclf doctor` has
 * to be able to run before any administrative credential exists. Being public
 * is what makes the following rules non-negotiable rather than stylistic:
 *
 *   - No credential value is ever reported. Not truncated, not masked, not
 *     hashed, not its length. This is enforced by shape rather than by care:
 *     the input type is `ProviderStatus`, which has nowhere to put one.
 *   - Presence and absence are reported; validity is not. "That secret is
 *     wrong" tells an attacker they are close. "That variable is not set" tells
 *     an operator what to do and tells an attacker nothing they could not learn
 *     by clicking the sign-in button.
 *   - Nothing about the database appears here: no table, no column, no SQL, no
 *     internal error text, no stack.
 *   - Every URL in the body passes through `URL.origin` first, including the
 *     configured one. So a path, a query string, or anything that is not a
 *     well-formed origin cannot be reflected back: a token pasted into the
 *     query string by a confused caller does not end up in the body, and a
 *     `BETTER_AUTH_URL` that somehow arrived as `https://user:pass@host` is
 *     reported without the credentials, because `URL.origin` drops them.
 *     Echoing the configured value verbatim would read as more helpful and
 *     would be the one place in here that can disclose something.
 *
 * Field names are snake_case to match what the CLI and Studio read.
 *
 * A pure function over explicit arguments: no env, no request, no clock, so the
 * whole thing is testable without a worker and cannot grow a dependency on
 * anything it should not be reading.
 */

import {
  CREDENTIAL_VARIABLES,
  PROVIDER_LABELS,
  type ProviderId,
  type ProviderStatus,
} from './providers.js';

/**
 * What the CORS layer decided about this very request, handed in rather than
 * worked out again here.
 *
 * This endpoint used to form its own opinion about whether the caller's origin
 * was allowed, by comparing it against the configured list as raw strings. The
 * request path normalises both sides through `URL.origin`. So the two disagreed,
 * and a configured value written with a trailing slash was allowed by CORS while
 * being reported here as missing from the list. A diagnostic that is wrong about
 * the one thing it exists to diagnose is worse than no diagnostic, because it
 * sends somebody to change a setting that was already correct.
 *
 * The fix is structural rather than a matching rule copied more carefully: there
 * is one implementation of the decision, in `src/index.ts`, and this reports what
 * it returned. A second implementation would drift again, and the one that drifts
 * is the one nobody is testing.
 */
export interface CorsFacts {
  /**
   * The origin the CORS layer would echo back to this caller, or null.
   *
   * Null covers three different situations that the caller does not need told
   * apart: no Origin header, an Origin that is not a URL, and an Origin that is
   * not on the list.
   */
  readonly allowedOriginForCaller: string | null;
  /** `Access-Control-Allow-Headers`, split. A browser rejects anything absent. */
  readonly allowedRequestHeaders: readonly string[];
  /** `Access-Control-Expose-Headers`, split. Anything absent is invisible to JS. */
  readonly exposedResponseHeaders: readonly string[];
  readonly preflightMaxAgeSeconds: number;
}

export interface DiagnoseInput {
  /** `request.url`. Only its origin is ever used or reported. */
  readonly requestUrl: string;
  /** `request.headers.get('origin')`, or null when the caller sent none. */
  readonly requestOrigin: string | null;
  /** `BETTER_AUTH_URL`, as configured. */
  readonly baseUrlConfig: string;
  /** `BETTER_AUTH_TRUSTED_ORIGINS`, already split. */
  readonly trustedOrigins: readonly string[];
  readonly providers: readonly ProviderStatus[];
  /** Whether `BETTER_AUTH_SECRET` is set. Never anything about its value. */
  readonly secretConfigured: boolean;
  readonly cors: CorsFacts;
  /**
   * Which of the engine's bindings are actually present on this deployment.
   *
   * ⚠️ Added after this went wrong on the real deployment on 2026-08-11. The
   * config used to deploy had no `r2_buckets` entry, so the Worker shipped with no
   * `env.BUCKET`. Nothing said so: `wrangler deploy` reported success and listed
   * the bindings it did have, `/health` answered 200, this diagnostic answered
   * without mentioning bindings at all, and `/storage/v1` returned the same 404 it
   * returns when everything is fine, because the storage registry fails closed on
   * an empty bucket table long before it reaches the binding.
   *
   * The type says `BUCKET: R2Bucket` and is not optional, so nothing in the type
   * system was going to catch it either. A binding is a runtime fact, and this is
   * the only place that can report one.
   */
  readonly bindings: readonly BindingPresence[];
}

export interface BindingPresence {
  /** The name `src/` reads, for example `DB`. Never the resource it points at. */
  readonly name: string;
  readonly present: boolean;
}

export interface ProviderReport {
  readonly configured: boolean;
  /** Names of unset variables. Never a value. */
  readonly missing: readonly string[];
  /** Paste this into the provider's console, exactly as it appears. */
  readonly redirect_uri: string;
}

/**
 * What CORS would do, in the response body, so it can be read rather than
 * deduced from a browser console.
 *
 * Reported even when nothing is wrong. A refused preflight surfaces to the
 * developer as an opaque console message with no server-side trace, so the useful
 * thing is not a warning after the fact but the list itself: somebody sending a
 * custom header sees immediately that it is not on it.
 */
export interface CorsReport {
  /** The origin this caller would be granted, or null for none. */
  readonly allowed_origin_for_caller: string | null;
  readonly allowed_request_headers: readonly string[];
  readonly exposed_response_headers: readonly string[];
  readonly preflight_max_age_seconds: number;
}

export interface DiagnoseReport {
  /** True when there is nothing to warn about. Gives the CLI its exit code. */
  readonly ok: boolean;
  /**
   * Whether the signing secret is set. Presence only.
   *
   * Worth reporting even though it is not about OAuth: without it every route
   * on this deployment answers 500, including the ones somebody would reach for
   * next. A diagnostic that stays quiet about the reason everything is broken
   * sends people looking in the wrong place.
   */
  readonly secret_configured: boolean;
  /** `BETTER_AUTH_URL` reduced to its origin. Empty when it is not a URL. */
  readonly base_url_config: string;
  /** The origin that served this request. Origin only, never the path. */
  readonly base_url_actual: string;
  readonly base_url_matches: boolean;
  readonly trusted_origins: readonly string[];
  readonly cors: CorsReport;
  readonly providers: { readonly [K in ProviderId]?: ProviderReport };
  /**
   * Which of the engine's bindings the deployment actually has.
   *
   * Reported even when they are all present, because "the binding is there" is a
   * fact somebody debugging storage needs, and a field that only appears on
   * failure is one nobody knows to look for.
   */
  readonly bindings: readonly BindingPresence[];
  /** Each one names what to do about it. */
  readonly warnings: readonly string[];
}

/**
 * The origin of a URL, or null if it is not one.
 *
 * Every value that comes from the caller goes through here before it can reach
 * the response body. `URL.origin` also normalises the host case and drops a
 * default port, so an origin comparison does not fail over `:443`.
 */
function originOf(value: string): string | null {
  try {
    const { origin } = new URL(value.trim());
    // A non-http scheme parses fine and yields "null" as a string. Not an
    // origin worth reporting.
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Localhost is the one place http is not a mistake.
 *
 * `URL.hostname` keeps the brackets around an IPv6 address, so they come off
 * before comparing rather than being compared both ways.
 */
function isLocal(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');

  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1'
  );
}

/** "A", or "A and B", or "A, B and C". */
function list(names: readonly string[]): string {
  const last = names.at(-1) ?? '';
  return names.length <= 1 ? last : `${names.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * Warn when the signing secret is missing.
 *
 * First in the list because it is first in severity: without it nothing on this
 * deployment answers, so every other finding below is about a deployment that
 * could not serve a request even if they were all fixed.
 */
function checkSecret(configured: boolean, warnings: string[]): void {
  if (configured) return;

  warnings.push(
    'BETTER_AUTH_SECRET is not set, so every request to this deployment fails with a 500. ' +
      'Set it with `wrangler secret put BETTER_AUTH_SECRET` and redeploy. It is deliberately ' +
      'fatal rather than defaulted: a deployment that signs sessions with a guessable value ' +
      'looks like it is working.',
  );
}

/**
 * Warn when the configured base URL is not a URL at all.
 *
 * Every callback address in the report is built from it, so if this is wrong,
 * everything downstream is wrong in the same way and there is no point warning
 * about each one separately.
 */
function checkBaseUrlIsAbsolute(configured: string, warnings: string[]): void {
  if (originOf(configured) === null) {
    warnings.push(
      'BETTER_AUTH_URL is not an absolute URL, so every callback address below is wrong. ' +
        'Set it to the origin this deployment is served from, for example ' +
        'https://baseclf-abc123.example.workers.dev, and redeploy.',
    );
  }
}

/** The whole reason this endpoint exists. */
function checkBaseUrlMatches(
  configured: string,
  actual: string | null,
  warnings: string[],
): boolean {
  const configuredOrigin = originOf(configured);

  if (actual === null) {
    warnings.push(
      'The origin serving this request could not be determined, so it could not be ' +
        'compared with BETTER_AUTH_URL. Check the URL the request arrived on.',
    );
    return false;
  }

  if (configuredOrigin === null || configuredOrigin === actual) {
    return configuredOrigin !== null;
  }

  warnings.push(
    `BETTER_AUTH_URL is ${configuredOrigin}, but this request was served from ${actual}. ` +
      'Callback URLs are built from the configured value, so a sign-in started here is ' +
      'sent back to a different origin and the address the provider receives is not the ' +
      'one registered against it. This is the most common cause of redirect_uri_mismatch. ' +
      `Either set BETTER_AUTH_URL to ${actual} and redeploy, or reach this deployment at ` +
      `${configuredOrigin}.`,
  );
  return false;
}

/**
 * Warn when the configured value carries more than an origin.
 *
 * Only the origin is ever used, and only the origin is reported, so a path or a
 * set of credentials in there is silently doing nothing. Saying so is better
 * than dropping it quietly: a value nobody reads back is a value nobody notices
 * is wrong. A trailing slash is not worth a warning because `callbackUrl`
 * already strips it.
 */
function checkBaseUrlIsBareOrigin(configured: string, warnings: string[]): void {
  const asOrigin = originOf(configured);
  if (asOrigin === null) return; // Already covered by checkBaseUrlIsAbsolute.

  if (configured.trim().replace(/\/+$/, '') === asOrigin) return;

  warnings.push(
    'BETTER_AUTH_URL carries more than an origin. Only the scheme and host are used, and ' +
      'only those are reported here, so anything else in the value is doing nothing. Set it ' +
      'to exactly the origin this deployment is served from, with no path, query or ' +
      'credentials, and redeploy.',
  );
}

/** http on a public host breaks OAuth outright and leaks bearer tokens. */
function checkBaseUrlScheme(configured: string, warnings: string[]): void {
  let url: URL;
  try {
    url = new URL(configured.trim());
  } catch {
    return; // Already covered by checkBaseUrlIsAbsolute.
  }

  if (url.protocol === 'http:' && !isLocal(url.hostname)) {
    warnings.push(
      'BETTER_AUTH_URL uses http on a public host. Google and GitHub refuse redirect URIs ' +
        'that are not https, and a bearer token sent over http can be read in transit. ' +
        'Serve this deployment over https, or use a localhost address in development.',
    );
  }
}

/**
 * Warn about a provider that is half set up, and about there being none at all.
 *
 * Half set up is the loud case on purpose. A provider nobody configured is a
 * deployment that does not offer it; a provider with an id and no secret is
 * somebody who thinks they configured it, and the only symptom is a button that
 * is not there.
 */
function checkProviders(providers: readonly ProviderStatus[], warnings: string[]): void {
  for (const status of providers) {
    const variables = CREDENTIAL_VARIABLES[status.provider];
    const isPartial = status.missing.length > 0 && status.missing.length < variables.length;
    if (!isPartial) continue;

    const set = variables.filter((name) => !status.missing.includes(name));
    warnings.push(
      `${PROVIDER_LABELS[status.provider]} sign-in is off because ${list(status.missing)} ` +
        `${status.missing.length === 1 ? 'is' : 'are'} not set, although ${list(set)} ` +
        `${set.length === 1 ? 'is' : 'are'}. A provider needs both values. Set the missing ` +
        'one with `wrangler secret put`, then redeploy.',
    );
  }

  if (providers.length > 0 && providers.every((status) => !status.configured)) {
    warnings.push(
      'No social provider is configured, so nobody can sign in. Each provider needs an ' +
        'OAuth app of its own with the redirect_uri below registered against it, then its ' +
        `two variables set: ${providers
          .map((status) => list(CREDENTIAL_VARIABLES[status.provider]))
          .join(', or ')}.`,
    );
  }
}

/**
 * Warn about origins that will fail the CORS preflight.
 *
 * Sessions travel as bearer tokens rather than cookies, because a cookie from
 * another origin is a third-party cookie and Safari already blocks those. That
 * choice moves the failure to CORS, where an unlisted origin fails a preflight
 * with a browser console message and nothing on the server. See the auth skill,
 * trap 3.
 */
function checkTrustedOrigins(
  trustedOrigins: readonly string[],
  requestOrigin: string | null,
  servingOrigin: string | null,
  cors: CorsFacts,
  warnings: string[],
): void {
  if (trustedOrigins.length === 0) {
    warnings.push(
      'BETTER_AUTH_TRUSTED_ORIGINS is empty. Sessions travel as bearer tokens, so a ' +
        'frontend served from a different origin has to be listed there or its calls fail ' +
        'the CORS preflight. Set it to a comma separated list of your frontend origins.',
    );
  }

  const caller = requestOrigin === null ? null : originOf(requestOrigin);
  if (caller === null || caller === servingOrigin) return;

  // The decision the request path made, not a comparison repeated here. See the
  // note on `CorsFacts`: repeating it is what made this endpoint disagree with
  // the layer it was reporting on.
  if (cors.allowedOriginForCaller !== null) return;

  warnings.push(
    `This request came from ${caller}, which is not allowed by BETTER_AUTH_TRUSTED_ORIGINS. ` +
      'Calls to the auth endpoints from that origin fail the CORS preflight. Add it to ' +
      'BETTER_AUTH_TRUSTED_ORIGINS and redeploy.',
  );
}

/**
 * Warn about entries in the allowlist that can never match anything.
 *
 * The request path compares origins, so an entry that is not a URL, or one
 * carrying a path, matches nothing at all. Nothing anywhere says so: the operator
 * listed their frontend, the list is not empty, and every call from it still
 * fails a preflight. That is the quietest possible way to be wrong, and it is
 * separate from the caller check above because it is worth saying even when the
 * caller happens to be someone else.
 *
 * A trailing slash is deliberately not warned about. `URL.origin` drops it on
 * both sides, so it matches, and warning about a value that works would send
 * somebody to fix the wrong thing.
 */
function checkTrustedOriginsAreOrigins(
  trustedOrigins: readonly string[],
  warnings: string[],
): void {
  const unusable = trustedOrigins.filter((entry) => {
    const asOrigin = originOf(entry);
    if (asOrigin === null) return true;
    return entry.trim().replace(/\/+$/, '') !== asOrigin;
  });

  if (unusable.length === 0) return;

  warnings.push(
    `BETTER_AUTH_TRUSTED_ORIGINS lists ${list(unusable)}, which ${
      unusable.length === 1 ? 'is not an origin' : 'are not origins'
    } and so ${unusable.length === 1 ? 'matches' : 'match'} nothing. An entry has to be ` +
      'exactly a scheme and a host, for example https://app.example.com, with no path and ' +
      'no trailing segments. Calls from it fail the CORS preflight with nothing logged here.',
  );
}

/**
 * Report what CORS would do for this caller.
 *
 * No warning of its own. The caller check above already covers a refused origin,
 * and a second sentence about the same fact reads as two problems. What this adds
 * is the header lists, because a header missing from them fails a preflight in the
 * browser and leaves no trace on the server at all.
 */
function corsReport(cors: CorsFacts): CorsReport {
  return Object.freeze({
    allowed_origin_for_caller: cors.allowedOriginForCaller,
    allowed_request_headers: cors.allowedRequestHeaders,
    exposed_response_headers: cors.exposedResponseHeaders,
    preflight_max_age_seconds: cors.preflightMaxAgeSeconds,
  });
}

/**
 * Build the diagnostic body.
 *
 * The order of the warnings is the order in which they should be dealt with: a
 * base URL that is not a URL makes everything below it meaningless, and a
 * mismatched one makes the redirect URIs unusable however carefully they were
 * pasted.
 */
/**
 * Report a binding the deployment was built without.
 *
 * Named one per line rather than counted, because the name is what the reader has
 * to put back into their config, and because a count says nothing about which one.
 *
 * This is a warning rather than a refusal. A deployment missing `BUCKET` serves
 * every REST request correctly and only fails on storage, so refusing to answer
 * would take out the working half to complain about the broken one. `doctor` turns
 * it into a non-zero exit, which is where a script should learn about it.
 */
function checkBindings(bindings: readonly BindingPresence[], warnings: string[]): void {
  for (const binding of bindings) {
    if (binding.present) continue;

    warnings.push(
      `env.${binding.name} is not bound on this deployment. The config it was deployed ` +
        'with is missing that binding, so anything that reads it fails at runtime. ' +
        'Nothing else reports this: the deploy succeeds and the type says it is there.',
    );
  }
}

export function diagnose(input: DiagnoseInput): DiagnoseReport {
  const warnings: string[] = [];
  const actual = originOf(input.requestUrl);

  checkSecret(input.secretConfigured, warnings);
  checkBaseUrlIsAbsolute(input.baseUrlConfig, warnings);
  const matches = checkBaseUrlMatches(input.baseUrlConfig, actual, warnings);
  checkBaseUrlIsBareOrigin(input.baseUrlConfig, warnings);
  checkBaseUrlScheme(input.baseUrlConfig, warnings);
  checkProviders(input.providers, warnings);
  checkTrustedOrigins(input.trustedOrigins, input.requestOrigin, actual, input.cors, warnings);
  checkTrustedOriginsAreOrigins(input.trustedOrigins, warnings);
  checkBindings(input.bindings, warnings);

  const providers: { -readonly [K in ProviderId]?: ProviderReport } = {};
  for (const status of input.providers) {
    providers[status.provider] = Object.freeze({
      configured: status.configured,
      missing: status.missing,
      redirect_uri: status.redirectUri,
    });
  }

  return Object.freeze({
    ok: warnings.length === 0,
    secret_configured: input.secretConfigured,
    // The origin, never the raw value. See the note on disclosure above.
    base_url_config: originOf(input.baseUrlConfig) ?? '',
    base_url_actual: actual ?? '',
    base_url_matches: matches,
    trusted_origins: input.trustedOrigins,
    cors: corsReport(input.cors),
    providers: Object.freeze(providers),
    bindings: Object.freeze(input.bindings.map((binding) => Object.freeze({ ...binding }))),
    warnings: Object.freeze(warnings),
  });
}

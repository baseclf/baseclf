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
}

export interface ProviderReport {
  readonly configured: boolean;
  /** Names of unset variables. Never a value. */
  readonly missing: readonly string[];
  /** Paste this into the provider's console, exactly as it appears. */
  readonly redirect_uri: string;
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
  readonly providers: { readonly [K in ProviderId]?: ProviderReport };
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
  if (trustedOrigins.includes(caller)) return;

  warnings.push(
    `This request came from ${caller}, which is not listed in BETTER_AUTH_TRUSTED_ORIGINS. ` +
      'Calls to the auth endpoints from that origin fail the CORS preflight. Add it to ' +
      'BETTER_AUTH_TRUSTED_ORIGINS and redeploy.',
  );
}

/**
 * Build the diagnostic body.
 *
 * The order of the warnings is the order in which they should be dealt with: a
 * base URL that is not a URL makes everything below it meaningless, and a
 * mismatched one makes the redirect URIs unusable however carefully they were
 * pasted.
 */
export function diagnose(input: DiagnoseInput): DiagnoseReport {
  const warnings: string[] = [];
  const actual = originOf(input.requestUrl);

  checkSecret(input.secretConfigured, warnings);
  checkBaseUrlIsAbsolute(input.baseUrlConfig, warnings);
  const matches = checkBaseUrlMatches(input.baseUrlConfig, actual, warnings);
  checkBaseUrlIsBareOrigin(input.baseUrlConfig, warnings);
  checkBaseUrlScheme(input.baseUrlConfig, warnings);
  checkProviders(input.providers, warnings);
  checkTrustedOrigins(input.trustedOrigins, input.requestOrigin, actual, warnings);

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
    providers: Object.freeze(providers),
    warnings: Object.freeze(warnings),
  });
}

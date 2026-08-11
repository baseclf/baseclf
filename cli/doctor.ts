/**
 * `baseclf doctor`: what is wrong with this deployment, and what to do about it.
 *
 * The plan calls this mandatory rather than a nicety, and the reason is in the
 * record of what has actually gone wrong. Three failures found while building this
 * product were each invisible from every angle except one:
 *
 *   - **The auth migration not run.** Only `/api/auth/jwks` answers 500. `/health`
 *     and `/api/auth/_diagnose` both report a healthy deployment, and every token
 *     silently fails to verify. Nothing anywhere says why. This is the check that
 *     justifies the command.
 *   - **The policy tables missing.** Every REST request answers 500 from a D1 error
 *     about a table nobody reading the response has heard of.
 *   - **`BETTER_AUTH_URL` not matching the hostname serving the request.** The
 *     provider answers `redirect_uri_mismatch` and no log mentions a hostname.
 *
 * So this asks the deployment about itself and then says what to do, in the order
 * the problems have to be fixed. It is not a status page.
 *
 * ⚠️ One check is deliberately generous, and it is generous because of a measured
 * fact rather than caution. A `*.workers.dev` URL does not answer immediately after
 * `wrangler deploy` reports success: measured 2026-08-11, it answered 404 with
 * `error code: 1042`, then 500, then 200 after roughly thirty seconds (rules/02
 * §C2). Reporting a broken deployment in that window would be wrong, and would be
 * wrong at exactly the moment somebody is deciding whether this product works.
 *
 * No `node:` imports. `fetch` is a global in both runtimes, so this runs in the
 * test runner against the real worker rather than against a description of it.
 */

import type { Verdict } from './output.js';

/** How long a caller may wait for a fresh deployment to start answering. */
export const PROPAGATION_GRACE_SECONDS = 45;

/**
 * Whether a status is what a workers.dev URL does while it is still coming up.
 *
 * A new one answers 404, then 500, then 200, over about half a minute, and the 404
 * carries `error code: 1042`, which in that window does not mean what it means at
 * any other time (`rules/02` section C2).
 *
 * Exported and shared rather than written twice. `create` waits on this and
 * `doctor` reports on it, and two copies of one judgment is exactly the shape that
 * produced debt 31 and 35, where the diagnostic and the CORS layer disagreed about
 * what counted as a match and neither was obviously wrong on its own.
 */
export function isPropagating(status: number): boolean {
  return status === 404 || status >= 500;
}

export interface Check {
  /** Short, lowercase, stable. Used as the line label and in tests. */
  readonly name: string;
  readonly verdict: Verdict;
  /** What is true, in one sentence. Sentence case, no exclamation. */
  readonly detail: string;
  /** What to do about it. Absent when there is nothing to do. */
  readonly action?: string;
  /** A value the reader has to copy. Printed unindented by the renderer. */
  readonly copy?: string;
}

export interface DoctorReport {
  /** True when nothing is wrong. Gives the command its exit code. */
  readonly ok: boolean;
  readonly checks: readonly Check[];
}

interface DiagnoseBody {
  readonly ok?: boolean;
  readonly secret_configured?: boolean;
  readonly base_url_config?: string;
  readonly base_url_actual?: string;
  readonly base_url_matches?: boolean;
  readonly trusted_origins?: readonly string[];
  readonly cors?: {
    readonly allowed_origin_for_caller?: string | null;
    readonly allowed_request_headers?: readonly string[];
    readonly preflight_max_age_seconds?: number;
  };
  readonly providers?: Readonly<
    Record<string, { readonly configured?: boolean; readonly redirect_uri?: string }>
  >;
  readonly warnings?: readonly string[];
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * One request, with a timeout, and a failure that is a value rather than a throw.
 *
 * A doctor that throws on the first unreachable endpoint reports one problem and
 * stops, which is the opposite of what it is for. Every check runs.
 */
async function probe(
  fetcher: Fetcher,
  url: string,
): Promise<{ status: number; text: string } | { error: string }> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
    return { status: response.status, text: await response.text() };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function parse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The origin of a URL, or null. Everything reported goes through here. */
function originOf(value: string): string | null {
  try {
    const { origin } = new URL(value.trim());
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Is anything there.
 *
 * The one place a 404 or a 500 is not reported as a fault. See the note at the top
 * about propagation: both are the documented behaviour of a `workers.dev` URL in
 * the first half minute of its life, and `error code: 1042` in that window does not
 * mean what it means at any other time.
 */
function checkReachable(result: Awaited<ReturnType<typeof probe>>): Check {
  if ('error' in result) {
    // 🔴 Not a fault on its own, and calling it one is what this said before.
    //
    // Measured on 2026-08-12, on the first `workers.dev` subdomain ever claimed on an
    // account: the first twenty five seconds are not 404 then 500 then 200. They are
    // a TLS handshake failure, because the certificate for the hostname does not
    // exist yet, and that happens below HTTP where there is no status to read. So
    // `doctor` run straight after `create` reported four hard failures on a
    // deployment that was completely fine and twenty seconds old.
    //
    // `waitForDeployment` already treats a failed request as propagation for exactly
    // this reason. The two commands share `isPropagating` for the status case and had
    // drifted apart on this one, which is the shape of debts 31 and 35 again.
    return {
      name: 'reachable',
      verdict: 'attention',
      detail:
        `The deployment did not answer: ${result.error}. A brand new address does this ` +
        'for about half a minute, while its certificate is issued. It also looks like ' +
        'this if the address is wrong.',
      action: `Wait up to ${PROPAGATION_GRACE_SECONDS} seconds and run this again. If it ` +
        'does not change, check the URL and that the deploy finished.',
    };
  }

  if (result.status === 200) {
    return { name: 'reachable', verdict: 'allow', detail: 'The deployment answers on /health.' };
  }

  if (isPropagating(result.status)) {
    return {
      name: 'reachable',
      verdict: 'attention',
      detail:
        `/health answered ${result.status}. For a newly created workers.dev URL this is ` +
        'normal for about half a minute, and 404 with "error code: 1042" does not mean what ' +
        'it usually means.',
      action: `Wait up to ${PROPAGATION_GRACE_SECONDS} seconds and run this again.`,
    };
  }

  return {
    name: 'reachable',
    verdict: 'deny',
    detail: `/health answered ${result.status}, which is not a state this engine produces.`,
    action: 'Check whether something else is serving this hostname.',
  };
}

/**
 * Are the engine's own tables there.
 *
 * Without them every REST request answers 500 carrying a D1 error about a table the
 * reader has never heard of. Fail-closed, so nothing is exposed, but nothing works
 * either and the response says nothing useful.
 */
function checkSchema(result: Awaited<ReturnType<typeof probe>>): Check {
  if ('error' in result) {
    return {
      name: 'schema',
      verdict: 'deny',
      detail: `/_schema did not answer: ${result.error}`,
    };
  }

  if (result.status === 200) {
    return { name: 'schema', verdict: 'allow', detail: 'The engine tables are present.' };
  }

  return {
    name: 'schema',
    verdict: 'deny',
    detail:
      `/_schema answered ${result.status}. The engine's own tables are usually missing when ` +
      'it does, and then every request to /rest/v1 answers 500 with a database error in it.',
    action: 'Apply the migrations, then run this again.',
  };
}

/**
 * ⭐ Are the signing keys there.
 *
 * The check this command exists for. When the auth migration has not run, this is
 * the only endpoint that fails: `/health` is fine, `/_schema` is fine,
 * `/api/auth/_diagnose` reports a healthy deployment, and every token quietly fails
 * to verify because the key set cannot be read. Nothing else anywhere shows it.
 *
 * The algorithm is read from the key set rather than from configuration, for the
 * reason the auth skill gives in trap 4: a configuration that mentions ES256 is not
 * evidence that ES256 is what gets used. EdDSA would report `kty: OKP`.
 */
function checkKeys(result: Awaited<ReturnType<typeof probe>>): Check {
  if ('error' in result) {
    return { name: 'keys', verdict: 'deny', detail: `/api/auth/jwks did not answer: ${result.error}` };
  }

  if (result.status !== 200) {
    return {
      name: 'keys',
      verdict: 'deny',
      detail:
        `/api/auth/jwks answered ${result.status}. This is what a deployment whose auth ` +
        'migration never ran looks like, and it is the only endpoint that shows it: health, ' +
        'schema and diagnose all report a working deployment while no token can be verified.',
      action: 'Apply the auth migrations, then run this again.',
    };
  }

  const keys = parse<{ keys?: readonly { kty?: string; alg?: string; crv?: string }[] }>(result.text);
  const first = keys?.keys?.[0];

  if (first === undefined) {
    return {
      name: 'keys',
      verdict: 'deny',
      detail: '/api/auth/jwks answered 200 with no keys in it, so no token can be verified.',
      action: 'Apply the auth migrations, then run this again.',
    };
  }

  if (first.alg !== 'ES256' || first.kty !== 'EC') {
    return {
      name: 'keys',
      verdict: 'attention',
      detail:
        `The key set reports alg ${first.alg ?? 'unset'} and kty ${first.kty ?? 'unset'}, not ` +
        'ES256 on EC. Tokens signed this way verify inside Workers and fail in many clients ' +
        'outside it.',
      action: 'Pin the JWT algorithm to ES256 and redeploy.',
    };
  }

  return {
    name: 'keys',
    verdict: 'allow',
    detail: `The key set is present and reports ${first.alg} on ${first.crv ?? first.kty}.`,
  };
}

/**
 * Everything the deployment says about its own configuration.
 *
 * Its warnings are passed through rather than re-derived. `_diagnose` reads the
 * hostname that served the request and compares it with what is configured, which
 * is something no external check can do, and it already reports the CORS decision
 * the request path made.
 */
function checkConfiguration(result: Awaited<ReturnType<typeof probe>>): readonly Check[] {
  if ('error' in result) {
    return [
      {
        name: 'configuration',
        verdict: 'deny',
        detail: `/api/auth/_diagnose did not answer: ${result.error}`,
      },
    ];
  }

  const body = parse<DiagnoseBody>(result.text);
  if (body === null) {
    return [
      {
        name: 'configuration',
        verdict: 'deny',
        detail: `/api/auth/_diagnose answered ${result.status} without a readable body.`,
      },
    ];
  }

  const checks: Check[] = [];

  if (body.secret_configured === false) {
    checks.push({
      name: 'secret',
      verdict: 'deny',
      detail: 'BETTER_AUTH_SECRET is not set, so every request to this deployment answers 500.',
      action: 'wrangler secret put BETTER_AUTH_SECRET',
    });
  }

  for (const warning of body.warnings ?? []) {
    checks.push({ name: 'configuration', verdict: 'attention', detail: warning });
  }

  if ((body.warnings ?? []).length === 0 && body.secret_configured !== false) {
    checks.push({
      name: 'configuration',
      verdict: 'allow',
      detail: 'The deployment reports no configuration problems.',
    });
  }

  const allowed = body.cors?.allowed_request_headers;
  if (allowed !== undefined) {
    checks.push({
      name: 'cors',
      verdict: 'allow',
      detail: `A browser may send: ${allowed.join(', ')}. Anything else fails its preflight.`,
    });
  }

  // The redirect URI is the value people mis-paste, so it is reported whether or
  // not anything is wrong. It is the only string in this output that has to survive
  // a copy exactly, which is why the renderer puts it at column zero.
  for (const [provider, status] of Object.entries(body.providers ?? {})) {
    if (status.redirect_uri === undefined) continue;

    checks.push(
      status.configured === true
        ? {
            name: `provider ${provider}`,
            verdict: 'allow',
            detail: `${provider} sign-in is configured.`,
          }
        : {
            name: `provider ${provider}`,
            verdict: 'attention',
            detail: `${provider} sign-in is not configured, so nobody can use it.`,
            action:
              `Register this exact value as an authorized redirect URI in the ${provider} ` +
              'console, then set the two credential variables.',
            copy: status.redirect_uri,
          },
    );
  }

  return checks;
}

/**
 * Ask a deployment what is wrong with it.
 *
 * Every endpoint is asked, in parallel, and no failure stops the others. A doctor
 * that reports the first problem and stops makes somebody run it five times.
 */
export async function runDoctor(baseUrl: string, fetcher: Fetcher = fetch): Promise<DoctorReport> {
  const origin = originOf(baseUrl);
  if (origin === null) {
    return {
      ok: false,
      checks: [
        {
          name: 'url',
          verdict: 'deny',
          detail: `"${baseUrl}" is not a URL, so there is nothing to ask.`,
          action: 'Pass the origin the deployment is served from, for example https://baseclf.example.workers.dev',
        },
      ],
    };
  }

  const [health, schema, keys, diagnose] = await Promise.all([
    probe(fetcher, `${origin}/health`),
    probe(fetcher, `${origin}/_schema`),
    probe(fetcher, `${origin}/api/auth/jwks`),
    probe(fetcher, `${origin}/api/auth/_diagnose`),
  ]);

  const checks: readonly Check[] = [
    checkReachable(health),
    checkSchema(schema),
    checkKeys(keys),
    ...checkConfiguration(diagnose),
  ];

  // `attention` counts as not ok. A deployment nobody can sign in to is not a
  // working deployment, and an exit code that says otherwise makes this command
  // useless in a script.
  return { ok: checks.every((check) => check.verdict === 'allow'), checks };
}

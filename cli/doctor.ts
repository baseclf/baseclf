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
  /**
   * The check this one is a consequence of, when it is one.
   *
   * ⚠️ Still printed, and still counts against `ok`. What it does not do is add to
   * the number in the closing line. A deployment with no social provider produced
   * "3 things are not finished" for what is one thing to do: the configuration
   * warning says nobody can sign in, and the two provider lines are how to fix that,
   * not two more jobs. The summary already hedged with "the first one usually
   * explains the rest", which was the shape of this admitting itself.
   */
  readonly followsFrom?: string;
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
 *
 * `asked` says whether this is the second answer, which only happens when the first
 * one disagreed with every other probe. See `runDoctor`.
 */
function checkReachable(
  result: Awaited<ReturnType<typeof probe>>,
  asked: 'once' | 'again' = 'once',
): Check {
  // Asked a second time, and it still disagrees with every other probe. Both answers
  // are real and they are about different things: one request describes one path to
  // the deployment, and four siblings answering at the same instant describe the
  // deployment. Reported as the contradiction it is rather than resolved silently in
  // either direction, and no longer as "wait and run this again", which is advice
  // the evidence three lines below it already contradicts.
  if (asked === 'again' && !('status' in result && result.status === 200)) {
    const answer = 'error' in result ? result.error : `${result.status}`;

    return {
      name: 'reachable',
      verdict: 'attention',
      detail:
        `/health gave ${answer} on both attempts, while the endpoints below answered ` +
        'normally at the same moment. The deployment is serving, so this describes one ' +
        'path to it rather than an address that is still coming up.',
      action:
        'Nothing to do if the checks below pass. If every run says this, something other ' +
        'than the Worker is answering for this hostname.',
    };
  }

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
      action:
        `Wait up to ${PROPAGATION_GRACE_SECONDS} seconds and run this again. If it ` +
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
 * A table name no schema will have, asked for on the path that needs the engine.
 *
 * The leading segment is a plain name rather than an underscore one on purpose: a
 * reserved name is refused by `assertRoutable` before anything touches the database,
 * which would make this probe answer without proving a thing.
 */
const ENGINE_PROBE_PATH = '/rest/v1/baseclf_doctor_probe';

/**
 * Are the engine's own tables there, asked of a path that cannot answer without them.
 *
 * ⭐ Two things happen on this request, and both are wanted. The engine creates its
 * tables here if they are missing, because `/rest/v1` is one of the two paths that
 * does that, and then it refuses the unknown table with a 404. So a 404 means the
 * engine is able to serve data, and the asking is what makes it true rather than
 * merely observed.
 *
 * ⚠️ Which does mean this check has a side effect, and it is written down rather
 * than left for somebody to discover: `doctor` warms a deployment that has never
 * been asked for data. That is the same idempotent DDL the engine runs on its own
 * first data request, and doing it here is what stops the next command failing with
 * a raw SQLite error about a table its reader has never heard of.
 */
function checkEngineTables(result: Awaited<ReturnType<typeof probe>>): Check {
  if ('error' in result) {
    return {
      name: 'engine',
      verdict: 'deny',
      detail: `${ENGINE_PROBE_PATH} did not answer: ${result.error}`,
    };
  }

  if (result.status === 404) {
    return {
      name: 'engine',
      verdict: 'allow',
      detail: 'The engine tables are present, and the data path refuses an unknown table.',
    };
  }

  return {
    name: 'engine',
    verdict: 'deny',
    detail:
      `${ENGINE_PROBE_PATH} answered ${result.status} rather than 404. An unknown table is a ` +
      'refusal, so anything else means the data path is not working.',
    action: 'Deploy the engine again, then run this once more.',
  };
}

/**
 * Whether the catalogue endpoint answers.
 *
 * 🔴 This used to report "The engine tables are present" on a 200, and that was a
 * claim it had not checked. `/_schema` reads the catalogue with PRAGMA and needs no
 * engine table to answer, so it returns 200 on a deployment that has none.
 *
 * Measured on 2026-08-14 on a fresh deployment: this reported present, and the very
 * next command failed with `no such table: _exposed_tables`. The engine creates its
 * tables on the first request to `/rest/v1` or `/storage/v1` and deliberately not on
 * the cheap paths, so a deployment that has been created and looked at but never
 * asked for data genuinely has none.
 *
 * Now it says what it measured. The engine tables get their own check below, which
 * asks a path that needs them.
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
    return { name: 'schema', verdict: 'allow', detail: 'The catalogue endpoint answers.' };
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
    return {
      name: 'keys',
      verdict: 'deny',
      detail: `/api/auth/jwks did not answer: ${result.error}`,
    };
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

  const keys = parse<{ keys?: readonly { kty?: string; alg?: string; crv?: string }[] }>(
    result.text,
  );
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
      action: 'npx baseclf secret set BETTER_AUTH_SECRET --script <project>',
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
            // Configuring one provider is what makes the deployment usable, so an
            // unconfigured provider is a way to satisfy the configuration warning
            // rather than a separate thing to finish.
            followsFrom: 'configuration',
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
          action:
            'Pass the origin the deployment is served from, for example https://baseclf.example.workers.dev',
        },
      ],
    };
  }

  const [health, schema, keys, diagnose, engine] = await Promise.all([
    probe(fetcher, `${origin}/health`),
    probe(fetcher, `${origin}/_schema`),
    probe(fetcher, `${origin}/api/auth/jwks`),
    probe(fetcher, `${origin}/api/auth/_diagnose`),
    probe(fetcher, `${origin}${ENGINE_PROBE_PATH}`),
  ]);

  // 🔴 The five probes go out together, so an unreachable verdict that sits above
  // four endpoints answering is not describing the deployment. It is describing one
  // path to it, at one instant.
  //
  // Seen on a real run: `/health` answered 404 and was reported as an address still
  // propagating, with "wait up to 45 seconds and run this again", directly above
  // three checks that had just been served by the same origin at the same moment.
  // The report contradicted itself and counted the transient as a cause, so a
  // deployment with one thing to configure was reported as two.
  //
  // ⚠️ Asked again rather than inferred away. Reading the siblings and rewriting the
  // verdict would report a reachable deployment on the strength of a request nobody
  // made, and `rules/02` section C6 is the record of what that costs: a single
  // observation was read as a fact about a deployment and was a fact about one
  // isolate. If the second answer agrees with the first, the contradiction is real
  // and gets printed as one.
  const answeredNormally = (result: Awaited<ReturnType<typeof probe>>) =>
    'status' in result && !isPropagating(result.status);

  let reachable = checkReachable(health);

  // ⚠️ `attention` rather than "not allow", and the difference decides whether a second
  // request can tell anybody anything. `checkReachable` says attention for a failed
  // request and for a propagating status, which are the two answers that can come back
  // different a moment later. It says deny for a definite status this engine does not
  // produce, and asking again for one of those buys a round trip to be told the same
  // thing, while turning a state worth alarm into a state worth a glance.
  if (
    reachable.verdict === 'attention' &&
    [schema, keys, diagnose, engine].some(answeredNormally)
  ) {
    reachable = checkReachable(await probe(fetcher, `${origin}/health`), 'again');
  }

  const checks: readonly Check[] = [
    reachable,
    checkSchema(schema),
    checkEngineTables(engine),
    checkKeys(keys),
    ...checkConfiguration(diagnose),
  ];

  // `attention` counts as not ok. A deployment nobody can sign in to is not a
  // working deployment, and an exit code that says otherwise makes this command
  // useless in a script.
  return { ok: checks.every((check) => check.verdict === 'allow'), checks };
}

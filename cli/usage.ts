/**
 * The usage numbers for one deployment, read with the operator's own credential.
 *
 * The Health screen's warnings come from the deployment itself. Its numbers cannot:
 * requests, errors, CPU time, and rows read and written are recorded by Cloudflare
 * against the account, and the only way to them is the GraphQL analytics API
 * (`rules/02` section A2; `wrangler tail` does not carry them). That needs a
 * credential, the page never holds one, and this bridge does.
 *
 * ## What was measured before this was written
 *
 * - Filtering `workersInvocationsAdaptive` by `scriptName` **works**, and the
 *   dimension returns real names rather than the `__unknown__` recorded in 2026-08.
 *   The parts summed exactly to the unfiltered total across three Workers. Without
 *   that, the only honest number would have been the whole account's.
 * - `d1AnalyticsAdaptiveGroups` carries rows read and written, grouped by database id.
 * - The permission is `Account · Account Analytics · Read`, which
 *   `REQUIRED_TOKEN_PERMISSIONS` does **not** ask for. A token built from the list
 *   the CLI prints may well be refused here, which is why a refusal is a first-class
 *   answer below rather than an exception.
 *
 * ## ⚠️ These numbers are ESTIMATES, and the page has to say so
 *
 * Measured 2026-08-25 (`rules/02` section A0h): the dataset samples. Thirty-one
 * requests driven at a deployment came back as fifteen, and forty came back as
 * sixty. Error in **both** directions, so it is not a window landing badly; the
 * name says as much, and the schema carries a `confidence` field to go with it.
 *
 * Nothing qualitative is at risk here, but a screen that prints `15,041` beside
 * the word "requests" is presenting an estimate as a count. Same family as
 * `num_tables` (`rules/01` section G12) and `file_size` (section G20): the
 * platform hands back figures of very different reliability in one response,
 * and nothing on the surface distinguishes them.
 */

import { API_BASE, type D1Credentials, type Fetcher } from './d1-api.js';

/** The permission Cloudflare wants for this dataset, named so a refusal can say it. */
export const ANALYTICS_PERMISSION = 'Account · Account Analytics · Read';

const GRAPHQL_URL = `${API_BASE}/graphql`;

/** Shorter than the D1 timeout: this is one query, not a PRAGMA sweep. */
const TIMEOUT_MS = 20_000;

/** How far back to look. Cloudflare keeps this dataset for far longer. */
const WINDOW_DAYS = 7;

/**
 * One kind of ending, and how many requests ended that way.
 *
 * `errors` on its own is a count of requests that did not finish, and it puts two
 * unrelated situations under one number: code that threw, and a request the
 * platform killed. Those need different work from whoever reads them, so the
 * kinds are carried separately.
 *
 * Measured 2026-08-25 (`rules/02` section A0e and A0g): the vocabulary seen so
 * far is `success`, `scriptThrewException` and `exceededResources`. It is not a
 * closed set, so nothing here interprets the string; it is shown as Cloudflare
 * wrote it.
 */
export interface UsageOutcome {
  readonly status: string;
  readonly requests: number;
}

export interface UsageNumbers {
  readonly requests: number;
  readonly errors: number;
  /** Microseconds, as Cloudflare reports them. Null when the window has no data. */
  readonly cpuP50: number | null;
  readonly cpuP99: number | null;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  /**
   * Every ending other than `success`, largest first. Empty when nothing failed,
   * which is different from not having been read: a refusal is a `refused` answer.
   */
  readonly failures: readonly UsageOutcome[];
  readonly since: string;
  readonly until: string;
  /** Which Worker and which database these are about, so the page can say so. */
  readonly scriptName: string;
}

export type UsageAnswer =
  | { readonly kind: 'numbers'; readonly numbers: UsageNumbers }
  /**
   * Cloudflare would not answer. Carries its own words plus the permission this
   * needs, because the likeliest cause is a token that was never asked for it.
   */
  | { readonly kind: 'refused'; readonly message: string; readonly permission: string };

interface GraphqlAnswer {
  readonly data?: { readonly viewer?: { readonly accounts?: readonly Record<string, unknown>[] } };
  readonly errors?: readonly { readonly message?: string }[];
}

const asDate = (at: number): string => new Date(at).toISOString().slice(0, 10);

/**
 * One query, and a refusal reported rather than thrown.
 *
 * GraphQL answers 200 with an `errors` array, so the status code alone says nothing.
 * A probe that reported success on the status here would be the same shape of wrong
 * as the provisioning one in `rules/02` section C2b.
 */
async function ask(
  fetcher: Fetcher,
  credentials: D1Credentials,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ readonly rows: readonly Record<string, unknown>[] } | { readonly refused: string }> {
  const response = await fetcher(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credentials.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = (await response.json().catch(() => ({}))) as GraphqlAnswer;
  const errors = body.errors ?? [];

  if (errors.length > 0) {
    // Reported verbatim rather than classified. Deciding "this one is a permission
    // problem" from the wording means betting on somebody else's wording, and
    // `rules/01` section F1 is this project's note on how that bet goes.
    return { refused: errors.map((error) => error.message ?? 'no message').join('; ') };
  }

  if (!response.ok) {
    return { refused: `Cloudflare answered ${response.status}.` };
  }

  const account = body.data?.viewer?.accounts?.[0];
  if (account === undefined) {
    // Not a refusal: the query was accepted and the account filter matched nothing.
    // Separating the two matters, because "no data" and "not allowed" send a reader
    // in opposite directions.
    return { rows: [] };
  }

  const first = Object.values(account)[0];
  return { rows: Array.isArray(first) ? (first as Record<string, unknown>[]) : [] };
}

const INVOCATIONS = `
  query Invocations($accountTag: String!, $since: Date!, $until: Date!, $scriptName: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 100
          filter: { date_geq: $since, date_leq: $until, scriptName: $scriptName }
        ) {
          sum { requests errors }
          quantiles { cpuTimeP50 cpuTimeP99 }
        }
      }
    }
  }`;

/**
 * The same window, grouped by how each request ended.
 *
 * ⚠️ A separate query rather than a `dimensions` block on the one above, and the
 * reason is not tidiness: grouping makes the dataset return one row per status,
 * and the quantiles above are only meaningful while exactly one row comes back.
 * Adding the dimension there would have quietly turned a median into a median of
 * medians, which is a median of nothing.
 */
const OUTCOMES = `
  query Outcomes($accountTag: String!, $since: Date!, $until: Date!, $scriptName: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 100
          filter: { date_geq: $since, date_leq: $until, scriptName: $scriptName }
        ) {
          sum { requests }
          dimensions { status }
        }
      }
    }
  }`;

const D1_ROWS = `
  query D1Rows($accountTag: String!, $since: Date!, $until: Date!, $databaseId: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(
          limit: 100
          filter: { date_geq: $since, date_leq: $until, databaseId: $databaseId }
        ) {
          sum { rowsRead rowsWritten }
        }
      }
    }
  }`;

const sumOf = (rows: readonly Record<string, unknown>[], key: string): number =>
  rows.reduce((total, row) => {
    const sum = row.sum as Record<string, unknown> | undefined;
    const value = sum?.[key];
    return total + (typeof value === 'number' ? value : 0);
  }, 0);

/**
 * Read what this one Worker and this one database did over the last week.
 *
 * `scriptName` is the project name, which `create-baseclf` uses for both the Worker
 * and the database. Filtering matters more than it looks: an unfiltered read on an
 * account with several Workers reports all of them, and a number like that shown
 * beside one deployment's name is the kind of thing decision Q4 exists to forbid.
 */
export async function readUsage(options: {
  readonly fetcher: Fetcher;
  readonly credentials: D1Credentials;
  readonly scriptName: string;
  readonly databaseId: string;
  /** Injected so a test can pin the window instead of following the wall clock. */
  readonly now: number;
}): Promise<UsageAnswer> {
  const until = asDate(options.now);
  const since = asDate(options.now - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const base = { accountTag: options.credentials.accountId, since, until };

  // Together, not one after the other. The two ask different datasets and neither
  // needs the other's answer, so running them in sequence doubled the worst case
  // for no reason: two twenty-second ceilings became forty seconds of a button
  // that said "Reading…" and nothing else. Seen on a real deployment.
  const [invocations, outcomes, d1] = await Promise.all([
    ask(options.fetcher, options.credentials, INVOCATIONS, {
      ...base,
      scriptName: options.scriptName,
    }),
    ask(options.fetcher, options.credentials, OUTCOMES, {
      ...base,
      scriptName: options.scriptName,
    }),
    ask(options.fetcher, options.credentials, D1_ROWS, {
      ...base,
      databaseId: options.databaseId,
    }),
  ]);

  // Either refusal is the same answer to the caller: this credential cannot read
  // the account's record. Invocations first so the message is stable rather than
  // depending on which query lost the race.
  if ('refused' in invocations) {
    return { kind: 'refused', message: invocations.refused, permission: ANALYTICS_PERMISSION };
  }
  if ('refused' in outcomes) {
    return { kind: 'refused', message: outcomes.refused, permission: ANALYTICS_PERMISSION };
  }
  if ('refused' in d1) {
    return { kind: 'refused', message: d1.refused, permission: ANALYTICS_PERMISSION };
  }

  // Quantiles do not add across rows, so they are only meaningful when the filter
  // left exactly one. More than one means the answer is about several things, and a
  // median of medians is not a median of anything.
  const only = invocations.rows.length === 1 ? invocations.rows[0] : undefined;
  const quantiles = (only?.quantiles ?? {}) as Record<string, unknown>;
  const micros = (key: string): number | null =>
    typeof quantiles[key] === 'number' ? (quantiles[key] as number) : null;

  return {
    kind: 'numbers',
    numbers: {
      requests: sumOf(invocations.rows, 'requests'),
      errors: sumOf(invocations.rows, 'errors'),
      cpuP50: micros('cpuTimeP50'),
      cpuP99: micros('cpuTimeP99'),
      rowsRead: sumOf(d1.rows, 'rowsRead'),
      rowsWritten: sumOf(d1.rows, 'rowsWritten'),
      failures: failuresIn(outcomes.rows),
      since,
      until,
      scriptName: options.scriptName,
    },
  };
}

/**
 * Everything that did not end in success, largest first.
 *
 * Nothing here decides what a status means. `success` is the one string this
 * filters on, because it is the one whose meaning is not in doubt, and every
 * other value is passed through as Cloudflare wrote it. A status nobody has seen
 * before therefore reaches the screen as itself rather than being dropped for
 * not matching a list.
 */
function failuresIn(rows: readonly Record<string, unknown>[]): readonly UsageOutcome[] {
  const failures: UsageOutcome[] = [];

  for (const row of rows) {
    const dimensions = row.dimensions as Record<string, unknown> | undefined;
    const status = dimensions?.status;
    if (typeof status !== 'string' || status === 'success') continue;

    const sum = row.sum as Record<string, unknown> | undefined;
    const requests = sum?.requests;
    failures.push({ status, requests: typeof requests === 'number' ? requests : 0 });
  }

  return failures.sort((left, right) => right.requests - left.requests);
}

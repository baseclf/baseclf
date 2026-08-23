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
 */

import { API_BASE, type D1Credentials, type Fetcher } from './d1-api.js';

/** The permission Cloudflare wants for this dataset, named so a refusal can say it. */
export const ANALYTICS_PERMISSION = 'Account · Account Analytics · Read';

const GRAPHQL_URL = `${API_BASE}/graphql`;

/** Shorter than the D1 timeout: this is one query, not a PRAGMA sweep. */
const TIMEOUT_MS = 20_000;

/** How far back to look. Cloudflare keeps this dataset for far longer. */
const WINDOW_DAYS = 7;

export interface UsageNumbers {
  readonly requests: number;
  readonly errors: number;
  /** Microseconds, as Cloudflare reports them. Null when the window has no data. */
  readonly cpuP50: number | null;
  readonly cpuP99: number | null;
  readonly rowsRead: number;
  readonly rowsWritten: number;
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

  const invocations = await ask(options.fetcher, options.credentials, INVOCATIONS, {
    ...base,
    scriptName: options.scriptName,
  });
  if ('refused' in invocations) {
    return { kind: 'refused', message: invocations.refused, permission: ANALYTICS_PERMISSION };
  }

  const d1 = await ask(options.fetcher, options.credentials, D1_ROWS, {
    ...base,
    databaseId: options.databaseId,
  });
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
      since,
      until,
      scriptName: options.scriptName,
    },
  };
}

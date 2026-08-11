/**
 * Talking to D1 over the REST API, for the one thing it is the right tool for.
 *
 * 🔴 **This is not a data plane and must never become one.** `rules/01` section E
 * lists the three reasons the whole product routes through a Worker instead: the
 * Cloudflare API allows 1,200 requests per five minutes **for an entire account**,
 * D1 API tokens are account-scoped rather than per-database, and `withSession()` does
 * not exist here. Anything on a request path belongs in the Worker.
 *
 * What it is right for is exactly what this file does: an administrator, on their own
 * machine, holding their own credential, changing their own policies. That is a
 * handful of calls a day by one person.
 *
 * ## What was measured before this was written, on 2026-08-12
 *
 *   1. **`PRAGMA` works.** `table_list`, `table_info`, `index_list` all return rows
 *      in the same shape the Worker binding returns. `rules/01` only ever confirmed
 *      PRAGMA through the binding, so this was an open question and the answer is
 *      what makes `introspect()` reusable here.
 *   2. **Several statements in one request are atomic.** Sending two inserts where
 *      the second names a missing table left the first one rolled back.
 *   3. 🔴 **But that request may not carry bound parameters.** More than one
 *      statement and the endpoint answers `params with multiple statements is not
 *      supported`.
 *
 * Points 2 and 3 together are the important part, and they were measured in that
 * order, which is why the first note here originally said a policy write could be
 * all-or-nothing. It cannot. The choice is atomicity or bound parameters, and
 * `rules/00` invariant I7 does not allow a value to be concatenated into SQL to buy
 * the first one. So the write is a sequence of single statements, and
 * `policy-document.ts` orders them so that every half-finished state is a closed one
 * rather than relying on a transaction that is not available.
 */

import { assertExecutable } from '../src/db/guards.js';

export interface D1Credentials {
  readonly accountId: string;
  readonly token: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * How long one call waits.
 *
 * Longer than the provisioning calls in `cloudflare.ts`, because a PRAGMA sweep over
 * a database with many tables is many round trips and the reader is sitting watching
 * a single command.
 */
const TIMEOUT_MS = 60_000;

export class D1ApiError extends Error {
  readonly status: number;
  readonly codes: readonly number[];

  constructor(message: string, status: number, codes: readonly number[] = []) {
    super(message);
    this.name = 'D1ApiError';
    this.status = status;
    this.codes = codes;
  }
}

interface QueryEnvelope {
  readonly success?: boolean;
  readonly result?: readonly {
    readonly results?: readonly unknown[];
    readonly meta?: Record<string, unknown>;
  }[];
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[];
}

/**
 * One statement's worth of answer.
 *
 * ⭐ `meta` is carried rather than dropped, and it is real. Measured on 2026-08-12:
 * the endpoint returns `duration`, `rows_read`, `rows_written`, `changes`,
 * `last_row_id`, `changed_db` and `size_after`, which is everything `D1Meta`
 * declares. The first version of this returned an empty object and the type checker
 * refused it, which was the right answer: `rows_read` is what D1 bills on
 * (`rules/01` section D), so a transport that invented a zero would be lying about
 * somebody's bill in any code that later looked.
 */
export interface QueryResult {
  readonly rows: readonly unknown[];
  readonly meta: Record<string, unknown>;
}

export interface Database {
  readonly uuid: string;
  readonly name: string;
}

/**
 * Find the database by name.
 *
 * Needed because nothing on this machine knows the id. The credential file
 * `wrangler login` writes holds a token and no account, and the account holds no
 * database, so both have to be asked for. `create` derives the database name from the
 * project name, which is what makes looking it up by name work at all.
 */
export async function findDatabase(
  fetcher: Fetcher,
  credentials: D1Credentials,
  name: string,
): Promise<Database | null> {
  const response = await fetcher(
    `${API_BASE}/accounts/${credentials.accountId}/d1/database?name=${encodeURIComponent(name)}`,
    {
      headers: { authorization: `Bearer ${credentials.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  const envelope = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    result?: readonly Database[];
  };

  if (!response.ok || envelope.success === false) {
    throw new D1ApiError(`Could not list databases: ${response.status}`, response.status);
  }

  // Exact match, not the first row. The list endpoint filters by prefix, so asking
  // for `blog` on an account that also has `blog-staging` gets both, and taking the
  // first would write policies into whichever one Cloudflare happened to order
  // first. This is the same reasoning `rules/00` section I6 applies to identifiers.
  return (envelope.result ?? []).find((database) => database.name === name) ?? null;
}

export interface D1Endpoint {
  readonly fetcher: Fetcher;
  readonly credentials: D1Credentials;
  readonly databaseId: string;
}

/**
 * Run SQL and hand back the rows of each statement.
 *
 * One entry in the returned array per statement, which is how several statements in
 * one request report themselves.
 */
export async function runSql(
  endpoint: D1Endpoint,
  sql: string,
  params: readonly unknown[] = [],
): Promise<readonly QueryResult[]> {
  // The same guard every path to D1 inside the Worker runs. `src/db/introspect.ts`
  // calls it even where it passes trivially, and says why: "every path to D1 is
  // guarded" is a stronger claim than "every path except this one". This transport
  // was the exception, which an audit found. It passes today because every statement
  // here is a fixed literal, and it is here for the edit that changes that.
  //
  // It checks three things worth having: one statement per call, no more than a
  // hundred parameters, and a placeholder count that matches the parameters given.
  assertExecutable({ sql, parameters: [...params] });

  const { accountId, token } = endpoint.credentials;

  const response = await endpoint.fetcher(
    `${API_BASE}/accounts/${accountId}/d1/database/${endpoint.databaseId}/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(params.length > 0 ? { sql, params } : { sql }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  const envelope = (await response.json().catch(() => ({}))) as QueryEnvelope;

  if (!response.ok || envelope.success === false) {
    const errors = envelope.errors ?? [];
    throw new D1ApiError(
      // D1 puts the SQLite error in the message, and it is the only useful part.
      errors.map((error) => error.message ?? 'no message').join('; ') ||
        `The database refused the query: ${response.status}`,
      response.status,
      errors.map((error) => error.code ?? 0),
    );
  }

  return (envelope.result ?? []).map((entry) => ({
    rows: entry.results ?? [],
    meta: entry.meta ?? {},
  }));
}

/**
 * The fields `D1Meta` declares, checked rather than assumed.
 *
 * ⭐ Measured on 2026-08-12: the endpoint really does return all of them. So this
 * validates rather than fills in, and throws when one is missing.
 *
 * Filling a missing field with zero was the other option and it is the worse one.
 * `rows_read` is what D1 bills on (`rules/01` section D), so a transport that
 * invented a zero would be quietly wrong about somebody's bill in any code that
 * later looked at it. A transport that stops is a transport somebody fixes.
 */
function asD1Meta(raw: Record<string, unknown>): D1Meta & Record<string, unknown> {
  const NUMBERS = ['duration', 'size_after', 'rows_read', 'rows_written', 'last_row_id', 'changes'];

  for (const field of NUMBERS) {
    if (typeof raw[field] !== 'number') {
      throw new D1ApiError(
        `The database did not report "${field}". This transport claims to return the ` +
          'same metadata the binding does, and it cannot.',
        500,
      );
    }
  }

  if (typeof raw['changed_db'] !== 'boolean') {
    throw new D1ApiError('The database did not report "changed_db".', 500);
  }

  return raw as D1Meta & Record<string, unknown>;
}

/**
 * The shape `introspect()` needs, over the REST transport.
 *
 * ⭐ This exists so the CLI builds its catalogue with **the engine's own
 * `introspect()`** rather than a second implementation. A catalogue is what decides
 * whether a column in a policy is real, and `rules/00` section I6 turns on that
 * decision being exact: with double-quoted strings enabled on D1, a column name that
 * does not exist comes back as a string instead of an error, so a second, slightly
 * different catalogue builder would not fail loudly. It would silently disagree.
 *
 * ⚠️ Only `prepare(...).all()` is implemented, because that is all `introspect` uses.
 * The rest throw rather than returning something plausible. A transport that quietly
 * answered `first()` with the wrong thing would be worse than one that has no answer.
 */
class RestStatement {
  readonly #endpoint: D1Endpoint;
  readonly #sql: string;
  #params: readonly unknown[] = [];

  constructor(endpoint: D1Endpoint, sql: string) {
    this.#endpoint = endpoint;
    this.#sql = sql;
  }

  bind(...values: unknown[]): RestStatement {
    this.#params = values;
    return this;
  }

  async all<T = unknown>(): Promise<{
    results: T[];
    success: true;
    meta: D1Meta & Record<string, unknown>;
  }> {
    const [first] = await runSql(this.#endpoint, this.#sql, this.#params);
    return {
      results: (first?.rows ?? []) as T[],
      success: true,
      meta: asD1Meta(first?.meta ?? {}),
    };
  }

  first(): never {
    throw new D1ApiError('This transport implements all() only.', 500);
  }

  run(): never {
    throw new D1ApiError('This transport implements all() only.', 500);
  }

  raw(): never {
    throw new D1ApiError('This transport implements all() only.', 500);
  }
}

/**
 * An executor `introspect()` accepts, backed by the REST API.
 *
 * ⚠️ `batch` throws. The endpoint has no batch call, and it cannot be emulated here
 * without lying: running the statements one at a time would give a caller expecting
 * all-or-nothing a half-written policy on somebody's deployment. `introspect()` never
 * calls it, and the write path is ordered so it does not need it.
 */
export function restExecutor(endpoint: D1Endpoint): {
  prepare(sql: string): RestStatement;
  batch(): never;
} {
  return {
    prepare: (sql: string) => new RestStatement(endpoint, sql),
    batch: (): never => {
      throw new D1ApiError(
        'The D1 REST API has no batch. Send the statements in one request instead, ' +
          'which rolls back as a unit.',
        500,
      );
    },
  };
}

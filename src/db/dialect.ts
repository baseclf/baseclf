/**
 * A Kysely dialect for Cloudflare D1, vendored on purpose.
 *
 * The community `kysely-d1` package was last published in April 2025, has no
 * batch support, and is a supply-chain surface we do not need. This file is
 * about a hundred lines and gives us the two things the product depends on:
 *
 *   batch()        the only transaction primitive D1 has. Verified on
 *                  2026-07-29 that a failing statement rolls the whole
 *                  sequence back.
 *   withSession()  read replication with read-your-writes. Neither Kysely nor
 *                  Drizzle supports it, so the executor is an interface that
 *                  a D1DatabaseSession satisfies just as well as a D1Database.
 *
 * The executor being an interface is the important part. Per request we open a
 * session from the incoming bookmark and build the query builder on top of it,
 * so every read in that request is sequentially consistent with its own writes.
 *
 * ---
 *
 * What this file is NOT: it is not the policy layer, and nothing here consults
 * one. `createDb`, `execute` and `batch` will run whatever they are given.
 *
 * That is deliberate. Migrations, introspection and the registry's own reads
 * have to reach D1 without a policy, because a policy is a thing they are used
 * to build. But it means these exports are a way to query the database with no
 * policy attached, and using one of them on a path that serves a client request
 * would be a hole with no error attached to it.
 *
 * The rule, and it is not enforced by anything but review: a request-scoped
 * read goes through `rest/execute.ts`, which is reached through
 * `rest/router.ts`, which applies `policy/plugin.ts` first. Nothing else does.
 * `codegraph impact applyPolicy` is the check.
 */

import {
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  Kysely,
  type QueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';

import { D1Error, noInteractiveTransaction } from '../utils/errors.js';
import { assertExecutable } from './guards.js';

/**
 * The subset of D1 we use. Both `D1Database` and `D1DatabaseSession` satisfy
 * it, which is what lets a session be dropped in wherever a database goes.
 */
export interface D1Executor {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

function bindIfNeeded(
  statement: D1PreparedStatement,
  parameters: readonly unknown[],
): D1PreparedStatement {
  return parameters.length > 0 ? statement.bind(...parameters) : statement;
}

function toQueryResult<R>(result: D1Result<R>): QueryResult<R> {
  const meta = result.meta as { changes?: number; last_row_id?: number } | undefined;
  const changes = meta?.changes;
  const lastRowId = meta?.last_row_id;

  return {
    rows: result.results ?? [],
    ...(typeof changes === 'number' ? { numAffectedRows: BigInt(changes) } : {}),
    ...(typeof lastRowId === 'number' && lastRowId !== 0 ? { insertId: BigInt(lastRowId) } : {}),
  };
}

class D1Connection implements DatabaseConnection {
  readonly #executor: D1Executor;

  constructor(executor: D1Executor) {
    this.#executor = executor;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    assertExecutable(compiledQuery);

    try {
      const statement = bindIfNeeded(
        this.#executor.prepare(compiledQuery.sql),
        compiledQuery.parameters,
      );
      return toQueryResult(await statement.all<R>());
    } catch (cause) {
      // Log the SQL and the parameter count. Never the parameter values:
      // they are user data, and logs are the easiest place to leak it.
      throw new D1Error('D1_QUERY_FAILED', 500, {
        message: 'Database query failed.',
        detail: `sql=${compiledQuery.sql} paramCount=${compiledQuery.parameters.length}`,
        cause,
      });
    }
  }

  // D1 has no cursor API. Anything that needs bounded memory must paginate.
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new D1Error('D1_QUERY_FAILED', 500, {
      message: 'Streaming is not supported.',
      detail: 'D1 exposes no cursor API. Paginate with LIMIT and OFFSET instead.',
    });
  }
}

class D1Driver implements Driver {
  readonly #executor: D1Executor;

  constructor(executor: D1Executor) {
    this.#executor = executor;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new D1Connection(this.#executor);
  }

  async beginTransaction(): Promise<never> {
    throw noInteractiveTransaction('Driver.beginTransaction');
  }

  async commitTransaction(): Promise<never> {
    throw noInteractiveTransaction('Driver.commitTransaction');
  }

  async rollbackTransaction(): Promise<never> {
    throw noInteractiveTransaction('Driver.rollbackTransaction');
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

export class D1Dialect implements Dialect {
  readonly #executor: D1Executor;

  constructor(executor: D1Executor) {
    this.#executor = executor;
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new D1Driver(this.#executor);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

/**
 * Build a query builder over a D1 database or session.
 *
 * Pass a session, not the raw database, on any request path:
 *
 *   const session = env.DB.withSession(request.headers.get('x-d1-bookmark') ?? 'first-unconstrained');
 *   const db = createDb<Schema>(session);
 *   ...
 *   response.headers.set('x-d1-bookmark', session.getBookmark() ?? '');
 *
 * Without the bookmark a read can serve arbitrarily stale data after a write,
 * which is a bug that only shows up under load and is miserable to diagnose.
 *
 * Build this lazily inside `fetch`, never at module scope: the Workers startup
 * CPU budget is one second and global scope work counts against it.
 */
export function createDb<Schema>(executor: D1Executor): Kysely<Schema> {
  return new Kysely<Schema>({ dialect: new D1Dialect(executor) });
}

/**
 * Run compiled statements as one atomic sequence.
 *
 * This is the only transaction D1 offers. Verified on 2026-07-29: if any
 * statement fails the whole batch rolls back. Correctness must not depend on
 * reading a result partway through, because there is no way to branch mid-batch.
 */
export async function batch<R = unknown>(
  executor: D1Executor,
  statements: readonly CompiledQuery[],
): Promise<QueryResult<R>[]> {
  if (statements.length === 0) return [];

  for (const statement of statements) {
    assertExecutable(statement);
  }

  try {
    const prepared = statements.map((statement) =>
      bindIfNeeded(executor.prepare(statement.sql), statement.parameters),
    );
    const results = await executor.batch<R>(prepared);
    return results.map(toQueryResult);
  } catch (cause) {
    throw new D1Error('D1_QUERY_FAILED', 500, {
      message: 'Database batch failed.',
      detail: `statements=${statements.length}`,
      cause,
    });
  }
}

/**
 * Execute a compiled query directly, bypassing the Kysely driver.
 *
 * This is the path the policy engine uses: build with Kysely, compile, run the
 * catalogue and budget assertions over the result, then execute. Keeping
 * compilation and execution separate is what makes those checks possible.
 */
export async function execute<R>(
  executor: D1Executor,
  compiled: CompiledQuery,
): Promise<QueryResult<R>> {
  return new D1Connection(executor).executeQuery<R>(compiled);
}

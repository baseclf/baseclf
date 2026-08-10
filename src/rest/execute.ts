/**
 * The last thing that happens before SQL leaves the Worker.
 *
 * Three checks run here, in this order, and none of them is the primary
 * defence. Identifiers were already resolved through the catalogue and values
 * were already bound; this is the layer that assumes all of that went wrong
 * somewhere and looks at the finished text anyway.
 *
 * The middle one is the interesting one. Rule 00 invariant I6 asks for an
 * assertion that every identifier in the compiled SQL is one the database
 * actually has, and the reason is that D1 will not tell us otherwise. Double
 * quoted string literals are enabled, so `SELECT "titel" FROM "posts"` returns
 * the word "titel" for every row and reports success. Without this check a
 * mistake in the allowlist would ship as wrong data rather than as an error,
 * and wrong data is the failure mode nobody notices.
 *
 * Reading quoted regions is a sound way to do that here because Kysely's SQLite
 * compiler wraps every identifier it emits in double quotes and binds every
 * value. So each quoted region in the output is an identifier, and nothing else
 * is.
 */

import type { OperationNode, RootOperationNode } from 'kysely';
import { type CompiledQuery, SqliteQueryCompiler } from 'kysely';

import type { D1Executor } from '../db/dialect.js';
import { assertExecutable } from '../db/guards.js';
import type { Catalogue } from '../db/introspect.js';
import { BaseclfError } from '../utils/errors.js';
import { logEvent } from '../utils/log.js';

/**
 * Every table name mentioned anywhere in the tree, including inside the
 * correlated subqueries a policy adds.
 *
 * Walks the node graph rather than a list of known shapes so that a node type
 * this file has never heard of cannot hide a table from it.
 */
export function collectTableNames(root: OperationNode): Set<string> {
  const found = new Set<string>();
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }

    const candidate = node as { kind?: unknown; table?: unknown };
    if (candidate.kind === 'TableNode') {
      const identifier = (candidate.table as { identifier?: { name?: unknown } } | undefined)
        ?.identifier;
      if (typeof identifier?.name === 'string') found.add(identifier.name);
    }

    for (const value of Object.values(node)) stack.push(value);
  }

  return found;
}

/**
 * The quoted identifiers in a compiled statement, with `""` unescaped back to
 * a single quote character.
 */
export function extractQuotedIdentifiers(sql: string): string[] {
  const identifiers: string[] = [];
  let i = 0;

  while (i < sql.length) {
    if (sql[i] !== '"') {
      i += 1;
      continue;
    }

    i += 1;
    let current = '';
    while (i < sql.length) {
      if (sql[i] === '"') {
        if (sql[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      current += sql[i];
      i += 1;
    }
    identifiers.push(current);
  }

  return identifiers;
}

export interface IdentifierScope {
  /** Aliases the client asked for, already checked against the alias pattern. */
  readonly aliases: ReadonlySet<string>;
}

/**
 * Refuse any identifier the database does not have.
 *
 * The permitted set is built from the tables this particular statement reads,
 * not from the schema at large, so a column belonging to some other table is
 * still rejected.
 */
export function assertIdentifiersAreReal(
  sql: string,
  node: OperationNode,
  catalogue: Catalogue,
  scope: IdentifierScope,
): void {
  const permitted = new Set<string>(scope.aliases);

  for (const table of collectTableNames(node)) {
    const info = catalogue.tables.get(table);
    if (info === undefined) {
      throw new BaseclfError('UNKNOWN_IDENTIFIER', 500, {
        message: 'Query construction failed.',
        detail: `Compiled SQL reads table "${table}", which is not in the catalogue.`,
      });
    }
    if (info.isSystem) {
      throw new BaseclfError('UNKNOWN_IDENTIFIER', 500, {
        message: 'Query construction failed.',
        detail: `Compiled SQL reads engine table "${table}".`,
      });
    }
    permitted.add(table);
    for (const column of info.columns.keys()) permitted.add(column);
  }

  for (const identifier of extractQuotedIdentifiers(sql)) {
    if (!permitted.has(identifier)) {
      throw new BaseclfError('UNKNOWN_IDENTIFIER', 500, {
        message: 'Query construction failed.',
        detail:
          `Compiled SQL contains the identifier "${identifier}", which no table in this ` +
          'statement has. Double quoted string literals are enabled on D1, so this would ' +
          'have returned the identifier as text instead of failing.',
      });
    }
  }
}

export interface PrepareOptions {
  /** A select or a write. Both arrive here already carrying their policy. */
  readonly node: RootOperationNode;
  readonly catalogue: Catalogue;
  readonly scope: IdentifierScope;
}

export interface ExecuteOptions extends PrepareOptions {
  readonly executor: D1Executor;
}

/**
 * Compile a node to SQL and run every check that must pass before it may reach
 * D1. Returns the statement; sends nothing.
 *
 * Split out of `executeStatement` so that "a statement that has been checked"
 * is defined in exactly one place, and so the checks can be exercised, and
 * their cost measured, without a database in the way. Execution is the only
 * caller that matters; anything else that compiles a node without coming
 * through here would be skipping invariants I6 and I7.
 */
export function prepareStatement(options: PrepareOptions): CompiledQuery {
  const compiled: CompiledQuery = new SqliteQueryCompiler().compileQuery(
    options.node,
    // The compiler only uses the id for logging hooks we do not install.
    { queryId: 'baseclf' },
  );

  assertIdentifiersAreReal(compiled.sql, options.node, options.catalogue, options.scope);
  // Statement separators, the hundred parameter ceiling, placeholder to
  // parameter agreement, statement length.
  assertExecutable(compiled);

  return compiled;
}

export interface ExecuteResult<R> {
  readonly rows: readonly R[];
  readonly sql: string;
  readonly parameterCount: number;
  readonly rowsRead: number | null;
}

/**
 * Compile, check, run.
 *
 * Compilation and execution are separate steps because everything above
 * depends on being able to look at the finished statement before it runs.
 * A driver that compiles and sends in one call leaves nowhere to stand.
 *
 * Writes come through here too. `.all()` is used rather than `.run()` because
 * every write this engine builds carries RETURNING, and the rows it hands back
 * are how the caller finds out whether anything happened. Zero rows is a 404,
 * for a row that was not there and for a row the policy withheld alike.
 */
export async function executeStatement<R>(options: ExecuteOptions): Promise<ExecuteResult<R>> {
  const compiled = prepareStatement(options);

  const statement =
    compiled.parameters.length > 0
      ? options.executor.prepare(compiled.sql).bind(...compiled.parameters)
      : options.executor.prepare(compiled.sql);

  const result = await statement.all<R>();
  const meta = result.meta as { rows_read?: number } | undefined;

  // The statement and how many values it binds. The event type has no field a
  // parameter value could go in, which is rule 00 invariant I9 enforced by the
  // compiler rather than by remembering. See utils/log.ts.
  logEvent({
    event: 'query',
    sql: compiled.sql,
    paramCount: compiled.parameters.length,
    ...(typeof meta?.rows_read === 'number' ? { rowsRead: meta.rows_read } : {}),
  });

  return {
    rows: result.results ?? [],
    sql: compiled.sql,
    parameterCount: compiled.parameters.length,
    // D1 counts every row scanned, not every row returned, and bills for it.
    // Surfacing it is what makes a missing index visible before the invoice.
    rowsRead: typeof meta?.rows_read === 'number' ? meta.rows_read : null,
  };
}

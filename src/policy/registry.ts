/**
 * Which policies exist, and what happens when none do.
 *
 * The answer to the second question is the whole point of this file: it throws.
 * Rule 00 invariant I1 spells out why, and it is worth restating because the
 * pressure to soften it is constant and always sounds reasonable. A table with
 * no registered policy is not a table with no restrictions; returning an empty
 * array, or skipping the predicate, turns "somebody forgot to configure this"
 * into "everybody can read it". Supabase's most common incident is exactly this
 * shape.
 *
 * So: no definition, definition disabled, no policy for the role, no policy for
 * the operation, no policy covering the requested columns, all of them refuse.
 * There is no code path through this file that produces a query without a
 * policy predicate attached.
 */

import type { D1Executor } from '../db/dialect.js';
import { assertExecutable } from '../db/guards.js';
import { type Catalogue, getCatalogue, SYSTEM_TABLE_PREFIX } from '../db/introspect.js';
import { PolicyError } from '../utils/errors.js';
import { logEvent } from '../utils/log.js';
import { isolateMemo, MAX_REGISTRY_AGE_MS } from '../utils/memo.js';
import { parseTableDefinition } from './parse.js';
import type { Operation, PolicyDef, TableDefinition } from './types.js';
import { validateTableDefinition } from './validate.js';

/**
 * What a request is told when it asks for something it may not have.
 *
 * Always 404, never 403. Rule 00 invariant I5: a 403 tells an attacker the row
 * exists, which turns id enumeration into a data source.
 */
function notFound(detail: string): PolicyError {
  return new PolicyError('TABLE_NOT_EXPOSED', 404, { message: 'Not found.', detail });
}

function noPolicy(detail: string): PolicyError {
  return new PolicyError('NO_POLICY', 404, { message: 'Not found.', detail });
}

export interface Registry {
  /**
   * The policies that apply, or a throw. Never an empty result.
   *
   * `requested` is the set of columns the caller wants to read. Only policies
   * that grant every one of them are eligible, which is what stops a row
   * matched by a narrow policy from being returned with a wide policy's
   * columns. Pass `null` to mean "whatever is available", which resolves to the
   * columns every matching policy grants.
   */
  resolve(
    table: string,
    operation: Operation,
    role: string,
    requested: readonly string[] | null,
  ): PolicyMatch;

  /**
   * Every policy for this role and operation, with no column filtering.
   *
   * Fail-closed exactly as `resolve` is: no definition, disabled, or nothing
   * matching the pair still throws. What it does not do is decide eligibility
   * by column, because a write has to know which columns the server sets before
   * it can know which columns the caller is asking to write. `resolve` cannot
   * answer that without being told the answer first.
   */
  candidates(table: string, operation: Operation, role: string): readonly PolicyDef[];

  /** For diagnostics and the Studio. Never used to decide access. */
  readonly definitions: ReadonlyMap<string, TableDefinition>;
}

export interface PolicyMatch {
  readonly table: string;
  readonly operation: Operation;
  readonly role: string;
  /** Always at least one. Combined with OR, because permissive policies add up. */
  readonly policies: readonly PolicyDef[];
  /** Columns the request is allowed to read, already intersected with the grants. */
  readonly columns: readonly string[];
}

interface PolicyRow {
  table_name: string;
  name: string;
  operation: string;
  roles: string;
  using_expr: string;
  check_expr: string | null;
  columns: string;
  set_expr: string | null;
}

interface BindRow {
  table_name: string;
  name: string;
  expression: string;
}

interface ExposedRow {
  table_name: string;
  enabled: number;
  version: number;
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new PolicyError('INVALID_EXPR', 500, {
      message: 'Policy configuration is not usable.',
      detail: `${where} does not hold valid JSON.`,
      cause,
    });
  }
}

async function query<R>(executor: D1Executor, sql: string): Promise<R[]> {
  // No parameters and no interpolation: these are fixed statements over the
  // engine's own tables. The guard runs anyway, because "every path to D1 is
  // guarded" is a claim worth being able to make without exceptions.
  assertExecutable({ sql, parameters: [] });
  const result = await executor.prepare(sql).all<R>();
  return result.results ?? [];
}

/**
 * Read every policy, turn it into an AST, and check it against the live schema.
 *
 * Validation happens here as well as at write time on purpose. A migration that
 * drops a column referenced by a stored policy would otherwise leave that
 * policy compiling against a name that no longer exists, and on D1 that does
 * not raise: double quoted string literals are enabled, so the missing column
 * would come back as its own name in string form and the predicate would
 * quietly compare against the wrong thing.
 */
export async function loadRegistry(executor: D1Executor): Promise<Registry> {
  const catalogue = await getCatalogue(executor);

  const [exposed, binds, policies] = await Promise.all([
    query<ExposedRow>(executor, 'SELECT table_name, enabled, version FROM _exposed_tables'),
    query<BindRow>(executor, 'SELECT table_name, name, expression FROM _policy_binds'),
    query<PolicyRow>(
      executor,
      'SELECT table_name, name, operation, roles, using_expr, check_expr, columns, set_expr' +
        ' FROM _policies',
    ),
  ]);

  const bindsByTable = new Map<string, Record<string, unknown>>();
  for (const row of binds) {
    const bucket = bindsByTable.get(row.table_name) ?? {};
    bucket[row.name] = parseJson(row.expression, `Bind "${row.name}" on "${row.table_name}"`);
    bindsByTable.set(row.table_name, bucket);
  }

  const policiesByTable = new Map<string, unknown[]>();
  for (const row of policies) {
    const bucket = policiesByTable.get(row.table_name) ?? [];
    const where = `Policy "${row.name}" on "${row.table_name}"`;
    bucket.push({
      name: row.name,
      for: row.operation,
      to: parseJson(row.roles, `${where} roles`),
      using: parseJson(row.using_expr, `${where} using`),
      ...(row.check_expr === null ? {} : { check: parseJson(row.check_expr, `${where} check`) }),
      columns: parseJson(row.columns, `${where} columns`),
      ...(row.set_expr === null ? {} : { set: parseJson(row.set_expr, `${where} set`) }),
    });
    policiesByTable.set(row.table_name, bucket);
  }

  const definitions = new Map<string, TableDefinition>();
  for (const row of exposed) {
    // An engine table can be named in _exposed_tables, by a migration bug or by
    // someone doing it on purpose. Such a row is dropped here rather than
    // validated, for two reasons. Validating it would throw, and one bad row
    // would then take every other table in the registry down with it, turning a
    // misconfiguration into an outage. And skipping it silently would hide the
    // misconfiguration, so it is logged.
    //
    // This is the first of the two independent places rule 00 invariant I8 asks
    // for. `resolve` performs the second, and the REST router a third, so no
    // single one of them has to be right.
    if (row.table_name.startsWith(SYSTEM_TABLE_PREFIX)) {
      logEvent({
        event: 'policy_refusal',
        code: 'TABLE_NOT_EXPOSED',
        table: row.table_name,
        operation: 'load',
        role: '-',
      });
      continue;
    }

    const definition = parseTableDefinition({
      table: row.table_name,
      enabled: row.enabled === 1,
      version: row.version,
      binds: bindsByTable.get(row.table_name) ?? {},
      policies: policiesByTable.get(row.table_name) ?? [],
    });

    // A disabled row is configuration, not a mistake, and its policies may well
    // reference columns that no longer exist. Validating it would turn a
    // switched-off table into a failure for every other table in the registry.
    if (!definition.enabled) {
      definitions.set(definition.table, definition);
      continue;
    }

    definitions.set(definition.table, validateTableDefinition(catalogue, definition));
  }

  return buildRegistry(definitions, catalogue);
}

function buildRegistry(
  definitions: ReadonlyMap<string, TableDefinition>,
  catalogue: Catalogue,
): Registry {
  return {
    definitions,

    candidates(table, operation, role): readonly PolicyDef[] {
      // Same refusals as resolve, in the same order. Written out rather than
      // shared through a helper that returns "no policies" as a value, because
      // a helper like that is one careless caller away from being fail-open.
      if (table.startsWith(SYSTEM_TABLE_PREFIX) || catalogue.tables.get(table)?.isSystem === true) {
        throw notFound(`Table "${table}" belongs to the engine and is never exposed.`);
      }

      const definition = definitions.get(table);
      if (definition === undefined) {
        throw notFound(`Table "${table}" has no policy document.`);
      }
      if (!definition.enabled) {
        throw notFound(`Table "${table}" is registered but not enabled.`);
      }

      const matching = definition.policies.filter(
        (policy) => policy.operation === operation && policy.roles.includes(role),
      );
      if (matching.length === 0) {
        throw noPolicy(`No policy on "${table}" covers (${role}, ${operation}).`);
      }

      return matching;
    },

    resolve(table, operation, role, requested): PolicyMatch {
      // Invariant I8 again, on the lookup rather than the load. Checked by name
      // as well as through the catalogue, so a table the catalogue has never
      // heard of cannot slip past on the strength of being unknown.
      if (table.startsWith(SYSTEM_TABLE_PREFIX) || catalogue.tables.get(table)?.isSystem === true) {
        throw notFound(`Table "${table}" belongs to the engine and is never exposed.`);
      }

      const definition = definitions.get(table);
      if (definition === undefined) {
        throw notFound(`Table "${table}" has no policy document.`);
      }
      if (!definition.enabled) {
        throw notFound(`Table "${table}" is registered but not enabled.`);
      }

      const matching = definition.policies.filter(
        (policy) => policy.operation === operation && policy.roles.includes(role),
      );
      if (matching.length === 0) {
        throw noPolicy(`No policy on "${table}" covers (${role}, ${operation}).`);
      }

      if (requested === null) {
        // "Everything I can see." The columns every matching policy grants, so
        // that no row can come back carrying a column its own policy withheld.
        const shared = matching.reduce<readonly string[]>(
          (columns, policy) => columns.filter((column) => policy.columns.includes(column)),
          matching[0]?.columns ?? [],
        );
        if (shared.length === 0) {
          throw noPolicy(
            `The policies on "${table}" for (${role}, ${operation}) grant no column in common, ` +
              'so there is nothing that can be returned for every row they match.',
          );
        }
        return { table, operation, role, policies: matching, columns: shared };
      }

      // Only policies that grant every requested column take part. A policy
      // that does not grant `body` must not contribute rows to a request that
      // reads `body`, or that row would be returned with a column nothing
      // granted for it.
      const eligible = matching.filter((policy) =>
        requested.every((column) => policy.columns.includes(column)),
      );
      if (eligible.length === 0) {
        throw noPolicy(
          `No policy on "${table}" for (${role}, ${operation}) grants every requested column.`,
        );
      }

      return { table, operation, role, policies: eligible, columns: requested };
    },
  };
}

/**
 * Per-isolate memo, built lazily inside `fetch`.
 *
 * Not at module scope: the Workers startup CPU budget is one second and global
 * work counts against it (rules/02 section A).
 *
 * The cache is per isolate, so a change still does not land across the fleet at
 * once. What it does now is expire: `MAX_REGISTRY_AGE_MS` bounds how long an
 * isolate may go on answering from a registry it has not re-read. Call
 * `resetRegistry` on the isolate that made the change to skip the wait. A
 * fleet-wide invalidation keyed on `_exposed_tables.version` is still the better
 * answer and still a V7 concern, when policies become editable through the Studio.
 */
/**
 * The clock the memo reads.
 *
 * Behind a variable so the suite can watch the window close without waiting for it.
 * `setRegistryClock` is the only writer and only a test calls it; the default is the
 * one the deployment uses.
 */
let registryClock: () => number = () => Date.now();

/** Test seam. Pass nothing to put the real clock back. */
export function setRegistryClock(clock?: () => number): void {
  registryClock = clock ?? ((): number => Date.now());
}

/**
 * 🔴 Two debts, one line.
 *
 * F4: a failure is not kept, and it used to be. `cached ??= loadRegistry(executor)`
 * memoised a rejected promise, so one malformed row broke the isolate for as long as
 * it lived and repairing the data did not help.
 *
 * F2: a success does not last for ever either, and it used to. Nothing reads
 * `_exposed_tables.version`, so a narrowed policy took effect whenever the isolate
 * happened to recycle. Measured against a live deployment: still serving a removed
 * table after 393 seconds in one run, 57 in another. `MAX_REGISTRY_AGE_MS` is the
 * bound that was missing. It is not the fleet-wide invalidation a control plane would
 * give, and it is the difference between a window and no window.
 */
const memo = isolateMemo<Registry>({
  maxAgeMs: MAX_REGISTRY_AGE_MS,
  now: () => registryClock(),
});

export function getRegistry(executor: D1Executor): Promise<Registry> {
  return memo.get(() => loadRegistry(executor));
}

export function resetRegistry(): void {
  memo.reset();
}

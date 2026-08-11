/**
 * The engine's own tables, and getting them onto a deployment that lacks them.
 *
 * Until this existed, nothing outside the tests applied `POLICY_SCHEMA` or
 * `STORAGE_SCHEMA`. Both are declared, both are imported by fixtures, and neither
 * reached a real database unless somebody ran the statements by hand. So every
 * deployment answered `/rest/v1` with a D1 error naming a table its owner had
 * never heard of, and `/storage/v1` the same, while `/health` and `/api/auth/*`
 * looked fine. That is the failure shape this project keeps meeting: the
 * diagnostic is healthy and the product is not.
 *
 * ## Why this is here and not only in the CLI
 *
 * Provisioning should still create these up front, and this is the floor rather
 * than the plan, in exactly the sense `ensureRateLimitTableOnce` means it. A
 * deployment made before `baseclf migrate` existed, or restored from a Time
 * Travel snapshot, or pointed at a database somebody made by hand, has no
 * provisioning step to have run. The floor is what makes those work.
 *
 * ## Why one batch
 *
 * `batch()` is the only transaction primitive D1 has, and it rolls back when a
 * statement fails (`rules/01` §A, and measured again in
 * `auth/migration-idempotency.test.ts`). A half-applied schema is the state that
 * is hardest to reason about afterwards, so the choice is all of it or none of
 * it. It is also one round trip rather than nine.
 *
 * ## What this deliberately does NOT do
 *
 * ⚠️ It does not touch Better Auth's tables. Those cannot be created with
 * `IF NOT EXISTS`, so applying them means asking Better Auth what is missing and
 * running what it says, and on a schema that has drifted that path **fails partway
 * and does not roll back**: measured in `auth/migration-idempotency.test.ts`, a
 * `user` table one version behind gains a column and then throws on
 * `Cannot add a UNIQUE column`, which SQLite refuses outright. Running that
 * automatically would turn a deployment that was merely out of date into one that
 * cannot be migrated at all, on a code path nobody asked to run. It belongs behind
 * an operator who has been told what it will do.
 */

import { POLICY_SCHEMA } from '../policy/schema.js';
import { STORAGE_SCHEMA } from '../storage/schema.js';
import { BaseclfError } from '../utils/errors.js';
import type { D1Executor } from './dialect.js';
import { assertExecutable, type CompiledStatement } from './guards.js';

/**
 * Every statement, policy tables before storage tables.
 *
 * The order is not load-bearing today, since nothing here has a foreign key into
 * anything else here, and it is fixed anyway so that two deployments applying the
 * same version get the same database rather than two orderings of one.
 */
export const ENGINE_SCHEMA: readonly string[] = Object.freeze([
  ...POLICY_SCHEMA,
  ...STORAGE_SCHEMA,
]);

/**
 * Create whatever of it is missing. Safe to run on a database that has all of it.
 *
 * Every statement carries `IF NOT EXISTS`, which is what makes repeating this
 * free, and it is asserted rather than trusted: a statement that lost the clause
 * would turn the second run of a CLI into a failure, and the first run of a CLI is
 * the one that gets interrupted.
 */
export async function applyEngineSchema(executor: D1Executor): Promise<void> {
  const unrepeatable = unrepeatableStatements(ENGINE_SCHEMA);
  if (unrepeatable.length > 0) {
    throw new BaseclfError('INVALID_CONFIGURATION', 500, {
      message: 'The engine schema is not safe to apply twice.',
      detail: `${unrepeatable.length} statement(s) have no IF NOT EXISTS, starting with: ${
        unrepeatable[0]?.slice(0, 80) ?? ''
      }`,
    });
  }

  const statements = ENGINE_SCHEMA.map((sql): CompiledStatement => ({ sql, parameters: [] }));
  for (const statement of statements) {
    assertExecutable(statement);
  }

  await executor.batch(statements.map((statement) => executor.prepare(statement.sql)));
}

/**
 * The statements in a schema that would fail the second time they ran.
 *
 * A separate function taking its input rather than a check buried in the applier,
 * so it can be handed a bad statement in a test. A guard that only ever sees valid
 * input is a guard nothing proves, and this project has been caught by that shape
 * more than once.
 *
 * Losing the clause costs nothing on the run that adds it and breaks every run
 * after. The symptom lands on somebody else's second deployment as a table that
 * already exists, which reads as a corrupt database rather than as three missing
 * words.
 */
export function unrepeatableStatements(schema: readonly string[]): readonly string[] {
  return schema.filter((sql) => !/\bIF\s+NOT\s+EXISTS\b/i.test(sql));
}

/**
 * Getting Better Auth's tables onto a deployment that lacks them, and refusing to
 * touch one where they have drifted.
 *
 * Until this existed the migration was a manual step (debt 37), and forgetting it
 * failed in the quietest way this project has: `/health`, `/_schema` and
 * `/api/auth/_diagnose` all report a working deployment, `/api/auth/jwks` answers
 * 500, and every token silently fails to verify. `baseclf doctor` has a check
 * whose entire justification is catching that state.
 *
 * ## Why this refuses to repair drift, measured rather than assumed
 *
 * `src/auth/migration-idempotency.test.ts` asked what a second run does, and the
 * two halves of the answer point opposite ways:
 *
 *   **Repeating is free.** `getMigrations` inspects the live database, so a second
 *   run reports nothing to create and emits no `CREATE TABLE`. That is what makes
 *   this safe to call on every cold isolate.
 *
 *   **Repairing is not.** Against a `user` table one version behind, the emitted
 *   SQL is `ALTER TABLE`, and running it adds a column and then throws on
 *   `Cannot add a UNIQUE column`, which SQLite refuses outright. Nothing rolls the
 *   first column back. The database ends up neither on the old schema nor the new
 *   one, and every retry meets the same wall.
 *
 * So an `ALTER TABLE` in the emitted SQL is a **stop**, not a step. Running it
 * unattended would turn a deployment that was merely out of date into one that
 * cannot be migrated at all, on a code path nobody asked to run. It is reported
 * and left for an operator who has been told what it will do. `rules/01` §G11.
 *
 * ## Why the cheap check comes first
 *
 * Asking Better Auth what it would do means introspecting the database, and that
 * happens on every cold isolate. `PRAGMA table_list` is one query and answers the
 * common case, which is that everything is already there.
 *
 * ⚠️ The trade-off is real and worth naming: a deployment whose tables all exist
 * but have drifted takes the fast path and is not examined. That is a state this
 * module would refuse to repair anyway, so nothing is lost except an earlier
 * warning, and `doctor` reports the symptom from outside.
 */

import { type AuthEnv, compileAuthMigrations, runAuthMigrations } from './index.js';

/**
 * Every table Better Auth owns here: the core four plus the jwt plugin's `jwks`.
 *
 * Hardcoded so the common case costs one query rather than a full introspection,
 * which makes it a list that can go stale when a plugin is added. `bootstrap.test.ts`
 * asserts it against what a real migration reports on a blank database, so a plugin
 * that brings a table turns this into a failing test rather than into a deployment
 * that skips its own migration.
 */
export const AUTH_TABLES: readonly string[] = Object.freeze([
  'user',
  'session',
  'account',
  'verification',
  'jwks',
]);

export type AuthSchemaOutcome =
  /** Every table was already there. The common case, and the cheap one. */
  | { readonly kind: 'present' }
  /** Tables were missing and have been created. */
  | { readonly kind: 'created'; readonly tables: readonly string[] }
  /**
   * Something is missing and repairing it would mean altering an existing table.
   *
   * Not attempted. See the note at the top of this file: the attempt fails partway
   * and leaves the schema in a state no retry can get out of.
   */
  | { readonly kind: 'refused'; readonly detail: string };

/** Whether a name is one of ours, matched whole rather than by prefix (I6). */
function missingTables(present: readonly string[]): readonly string[] {
  return AUTH_TABLES.filter((table) => !present.includes(table));
}

/**
 * Create the auth tables if they are absent, and never alter one that is present.
 *
 * Returns what it decided rather than throwing, because two of the three outcomes
 * are not failures and the caller logs them differently. A genuine database error
 * still throws.
 */
export async function ensureAuthSchema(db: D1Database, env: AuthEnv): Promise<AuthSchemaOutcome> {
  const listed = await db.prepare('PRAGMA table_list').all<{ name?: unknown }>();
  const present = (listed.results ?? []).map((row) => String(row.name));

  const missing = missingTables(present);
  if (missing.length === 0) return { kind: 'present' };

  // Something is absent, so ask what it would take. This is the only path that
  // pays for introspection, and it runs once in the life of a database.
  const planned = (await compileAuthMigrations(env)).toLowerCase();

  if (planned.includes('alter table')) {
    return {
      kind: 'refused',
      detail:
        `${missing.length} auth table(s) absent and the migration would ALTER an existing ` +
        'one. Refused: that fails partway on a UNIQUE column and does not roll back. ' +
        'Apply it by hand after taking a Time Travel bookmark.',
    };
  }

  const created = await runAuthMigrations(env);
  return { kind: 'created', tables: created };
}

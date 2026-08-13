/**
 * Make the auth schema bootstrap do the dangerous thing, and check the tests stop it.
 *
 * One mutation here matters more than the rest. Taking off the drift refusal lets
 * the migration run against a table that has moved, and that attempt adds a column
 * and then throws on a UNIQUE one, with nothing to roll it back. The database is
 * left neither on the old schema nor the new one, and every retry meets the same
 * wall. A deployment that was out of date becomes one that cannot be migrated.
 *
 * Measured in `src/auth/migration-idempotency.test.ts`, written down in `rules/01`
 * §G11. That is what these mutations are guarding.
 *
 * Usage: node scripts/mutate-auth-bootstrap.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const BOOTSTRAP = 'src/auth/bootstrap.ts';
const INDEX = 'src/index.ts';
/**
 * Where `AUTH_TABLES` lives since the I8 fix on 2026-08-12.
 *
 * ⚠️ It used to be declared in `bootstrap.ts`, and this script kept pointing there
 * for two days after it moved. Nothing noticed, because the full mutation suite was
 * not run in between: the pattern matched nothing and the runner aborted the moment
 * it finally ran, which is the behaviour that made the drift visible at all.
 */
const CATALOGUE = 'src/db/introspect.ts';

const MUTATIONS = [
  {
    // 🔴 The module can be perfect and unreached. That is how 549 lines of code
    // that deleted rows reached a green suite in this project once already, so the
    // seam is mutated rather than assumed from both ends existing.
    name: 'the bootstrap never wired into the auth path',
    file: INDEX,
    expect: 'the worker-creates-them-while-answering test',
    find: / {6}await ensureAuthSchemaOnce\(env\);\n/,
    replace: '',
  },
  {
    // A memo that is never set means a PRAGMA, and on an unprovisioned deployment a
    // full introspection, on every single auth request.
    name: 'the memo never kept, so every request bootstraps again',
    file: INDEX,
    expect: 'the once-per-isolate test',
    find: / {2}authSchemaReady \?\?= ensureAuthSchema\(env\.DB, env\)/,
    replace: '  authSchemaReady = ensureAuthSchema(env.DB, env)',
  },
  {
    // 🔴 The one that turns an out-of-date deployment into an unmigratable one.
    name: 'the drift refusal removed, so an ALTER runs unattended',
    file: BOOTSTRAP,
    expect: 'the drift refusal tests',
    find: / {2}if \(planned\.includes\('alter table'\)\) \{/,
    replace: '  if (false) {',
  },
  {
    // Same failure by a different route: the plan is never asked for, so an ALTER
    // is never recognised as one.
    name: 'the plan never inspected, so nothing can be recognised as drift',
    file: BOOTSTRAP,
    expect: 'the drift refusal tests',
    find: / {2}const planned = \(await compileAuthMigrations\(env\)\)\.toLowerCase\(\);/,
    replace: "  const planned = '';",
  },
  {
    // Reports `present` for a deployment that is missing tables, which is exactly
    // the silent state this module exists to end.
    name: 'a missing table treated as present',
    file: BOOTSTRAP,
    expect: 'the creates-them test',
    find: / {2}if \(missing\.length === 0\) return \{ kind: 'present' \};/,
    replace: "  return { kind: 'present' };",
  },
  {
    // Matching by prefix rather than whole name. `user` would match `user_sessions`
    // and the real table would read as present. Invariant I6, and the same mutation
    // survived once already in the storage sweep before its test was sharpened.
    name: 'a table matched by prefix rather than by its whole name',
    file: BOOTSTRAP,
    expect: 'the creates-them test',
    find: /return AUTH_TABLES\.filter\(\(table\) => !present\.includes\(table\)\);/,
    replace:
      '  return AUTH_TABLES.filter((table) => !present.some((name) => name.startsWith(table)));',
  },
  {
    name: 'the jwks table dropped from the list, which is the one that fails silently',
    file: CATALOGUE,
    expect: 'the list-matches-a-real-migration test',
    find: / {2}'jwks',\n/,
    replace: '',
  },
  {
    // The cheap path is the whole reason the list is hardcoded. Losing it means a
    // full Better Auth introspection on every cold isolate.
    name: 'the cheap path skipped, so every cold isolate introspects',
    file: BOOTSTRAP,
    expect: 'the one-query test',
    find: / {2}const missing = missingTables\(present\);/,
    replace: '  const missing = [...AUTH_TABLES];',
  },
];

await runMutations({
  files: [BOOTSTRAP, INDEX, CATALOGUE],
  suites: ['src/auth/bootstrap.test.ts'],
  mutations: MUTATIONS,
});

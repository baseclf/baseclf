/**
 * The schema and policy documents every test in the engine shares.
 *
 * One fixture rather than a per-file setup so that the golden files, the
 * security tests and the REST tests are all talking about the same database. A
 * test that quietly builds its own schema is a test that can pass while the
 * thing it claims to prove is broken somewhere else.
 *
 * Shape worth noticing:
 *
 *   posts.body is nullable and posts.status is not. That difference is what the
 *   rule about negating a condition on a nullable column is tested against.
 *
 *   secrets has no policy document at all. It exists to be refused.
 *
 *   org_members is only ever reached through a policy's EXISTS, never directly.
 */

import type { D1Executor } from '../../db/dialect.js';
import { POLICY_SCHEMA } from '../schema.js';

export const APPLICATION_SCHEMA: readonly string[] = Object.freeze([
  'DROP TABLE IF EXISTS posts',
  'DROP TABLE IF EXISTS org_members',
  'DROP TABLE IF EXISTS secrets',
  `CREATE TABLE posts (
     id         TEXT NOT NULL PRIMARY KEY,
     title      TEXT NOT NULL,
     body       TEXT,
     status     TEXT NOT NULL,
     author_id  TEXT NOT NULL,
     org_id     TEXT NOT NULL,
     created_at TEXT NOT NULL
   ) STRICT`,
  'CREATE INDEX posts_author_id ON posts(author_id)',
  'CREATE INDEX posts_status ON posts(status)',
  `CREATE TABLE org_members (
     org_id  TEXT NOT NULL,
     user_id TEXT NOT NULL,
     role    TEXT NOT NULL,
     PRIMARY KEY (org_id, user_id)
   ) STRICT`,
  `CREATE TABLE secrets (
     id    TEXT NOT NULL PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT`,
]);

const READABLE_COLUMNS = ['id', 'title', 'body', 'status', 'author_id', 'created_at'];

/** Named predicates the policies below reuse. */
export const POST_BINDS: Readonly<Record<string, unknown>> = Object.freeze({
  isAuthor: { author_id: { _eq: '$auth.uid' } },
  isOrgAdmin: {
    _exists: {
      _table: 'org_members',
      _where: {
        _and: [
          { org_id: { _eq: '$row.org_id' } },
          { user_id: { _eq: '$auth.uid' } },
          { role: { _eq: 'admin' } },
        ],
      },
    },
  },
});

export interface SeedPolicy {
  readonly name: string;
  readonly operation: string;
  readonly roles: readonly string[];
  readonly using: unknown;
  readonly check?: unknown;
  readonly columns: readonly string[];
}

export const POST_POLICIES: readonly SeedPolicy[] = Object.freeze([
  {
    name: 'read_published',
    operation: 'select',
    roles: ['anon', 'authenticated'],
    using: { status: { _eq: 'published' } },
    columns: READABLE_COLUMNS,
  },
  {
    name: 'read_own',
    operation: 'select',
    roles: ['authenticated'],
    using: { $bind: 'isAuthor' },
    columns: [...READABLE_COLUMNS, 'org_id'],
  },
  {
    name: 'read_as_org_admin',
    operation: 'select',
    roles: ['authenticated'],
    using: { $bind: 'isOrgAdmin' },
    columns: [...READABLE_COLUMNS, 'org_id'],
  },
]);

export const SEED_ROWS: readonly (readonly [
  string,
  string,
  string | null,
  string,
  string,
  string,
  string,
])[] = Object.freeze([
  ['p1', 'Published by Ann', 'public', 'published', 'u_ann', 'org_1', '2026-07-01'],
  ['p2', 'Draft by Ann', null, 'draft', 'u_ann', 'org_1', '2026-07-02'],
  ['p3', 'Draft by Bob', 'private', 'draft', 'u_bob', 'org_1', '2026-07-03'],
  ['p4', 'Draft in other org', null, 'draft', 'u_cal', 'org_2', '2026-07-04'],
]);

const MEMBER_ROWS: readonly (readonly [string, string, string])[] = Object.freeze([
  ['org_1', 'u_ann', 'member'],
  ['org_1', 'u_mod', 'admin'],
  ['org_2', 'u_cal', 'member'],
]);

async function run(executor: D1Executor, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    await executor.prepare(statement).run();
  }
}

/** Create the application tables, the engine tables, and the sample rows. */
export async function seedDatabase(executor: D1Executor): Promise<void> {
  await run(executor, APPLICATION_SCHEMA);
  await run(executor, POLICY_SCHEMA);

  await run(executor, [
    'DELETE FROM _policies',
    'DELETE FROM _policy_binds',
    'DELETE FROM _exposed_tables',
  ]);

  for (const row of SEED_ROWS) {
    await executor
      .prepare(
        'INSERT INTO posts (id, title, body, status, author_id, org_id, created_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(...row)
      .run();
  }

  for (const row of MEMBER_ROWS) {
    await executor
      .prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)')
      .bind(...row)
      .run();
  }

  await executor.prepare('INSERT INTO secrets (id, value) VALUES (?, ?)').bind('s1', 'shh').run();
}

/** Register a table with the policies given, replacing whatever was there. */
export async function registerPolicies(
  executor: D1Executor,
  options: {
    readonly table: string;
    readonly enabled?: boolean;
    readonly binds?: Readonly<Record<string, unknown>>;
    readonly policies: readonly SeedPolicy[];
  },
): Promise<void> {
  const { table, enabled = true, binds = {}, policies } = options;

  await executor.prepare('DELETE FROM _policies WHERE table_name = ?').bind(table).run();
  await executor.prepare('DELETE FROM _policy_binds WHERE table_name = ?').bind(table).run();
  await executor.prepare('DELETE FROM _exposed_tables WHERE table_name = ?').bind(table).run();

  await executor
    .prepare('INSERT INTO _exposed_tables (table_name, enabled, version) VALUES (?, ?, ?)')
    .bind(table, enabled ? 1 : 0, 1)
    .run();

  for (const [name, expression] of Object.entries(binds)) {
    await executor
      .prepare('INSERT INTO _policy_binds (table_name, name, expression) VALUES (?, ?, ?)')
      .bind(table, name, JSON.stringify(expression))
      .run();
  }

  for (const policy of policies) {
    await executor
      .prepare(
        'INSERT INTO _policies (table_name, name, operation, roles, using_expr, check_expr, columns)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        table,
        policy.name,
        policy.operation,
        JSON.stringify(policy.roles),
        JSON.stringify(policy.using),
        policy.check === undefined ? null : JSON.stringify(policy.check),
        JSON.stringify(policy.columns),
      )
      .run();
  }
}

/**
 * Wipe every policy row, then register the standard arrangement.
 *
 * Called before each test rather than once, so that a test which fails partway
 * through cannot leave a policy behind for the next one to trip over. Cleanup
 * written at the end of a test body does not run when an assertion above it
 * fails, which is exactly when it is most needed.
 */
export async function seedStandardPolicies(executor: D1Executor): Promise<void> {
  await run(executor, [
    'DELETE FROM _policies',
    'DELETE FROM _policy_binds',
    'DELETE FROM _exposed_tables',
  ]);

  await registerPolicies(executor, {
    table: 'posts',
    binds: POST_BINDS,
    policies: POST_POLICIES,
  });
}

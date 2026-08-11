/**
 * What the registry cache does, measured rather than described.
 *
 * These three behaviours were reported by an audit of the policy write path and are
 * verified here rather than taken on the report's word. Two of them are known and the
 * registry's own comment says so; the value of writing them down is that the CLI was
 * shipping comments claiming the opposite, and a claim nobody can test is a claim that
 * stays wrong.
 *
 * None of these is a leak. All three are the difference between what an operator is
 * told happened and what actually happened.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getRegistry, loadRegistry, resetRegistry } from './registry.js';
import { POLICY_SCHEMA } from './schema.js';

const APPLICATION = [
  'CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY NOT NULL, title TEXT, author_id TEXT)',
];

/** One policy row, in the source grammar the registry reads. */
function policyRow(name: string, columns: readonly string[]): readonly unknown[] {
  return [
    'posts',
    name,
    'select',
    JSON.stringify(['authenticated']),
    JSON.stringify({ author_id: { _eq: '$auth.uid' } }),
    null,
    JSON.stringify(columns),
    null,
  ];
}

const INSERT_POLICY =
  'INSERT INTO _policies (table_name, name, operation, roles, using_expr, check_expr,' +
  ' columns, set_expr) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

async function reset(): Promise<void> {
  for (const statement of [...POLICY_SCHEMA, ...APPLICATION]) {
    await env.DB.prepare(statement).run();
  }
  for (const table of ['_policies', '_policy_binds', '_exposed_tables']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  resetRegistry();
}

beforeEach(reset);

describe('F2: what a version bump actually invalidates', () => {
  it('does not invalidate anything, so a narrowed policy keeps serving the wide one', async () => {
    // 🔴 An operator who removes a column from a grant is told the write succeeded,
    // at a new version, while every isolate that had already loaded keeps serving
    // the wider policy until it recycles. There is no bound on that window.
    //
    // The registry's own comment is honest about this and calls fleet-wide
    // invalidation a V7 concern. The CLI shipped three comments claiming the
    // version was the mechanism. It is not; nothing reads it.
    await env.DB.prepare(INSERT_POLICY)
      .bind(...policyRow('read', ['id', 'title', 'author_id']))
      .run();
    await env.DB.prepare(
      'INSERT INTO _exposed_tables (table_name, enabled, version) VALUES (?, 1, 1)',
    )
      .bind('posts')
      .run();

    const before = await getRegistry(env.DB);
    expect(before.candidates('posts', 'select', 'authenticated')[0]?.columns).toEqual([
      'id',
      'title',
      'author_id',
    ]);

    // Exactly what `baseclf policy apply` does: replace the rules, bump the version.
    await env.DB.prepare('DELETE FROM _exposed_tables WHERE table_name = ?').bind('posts').run();
    await env.DB.prepare('DELETE FROM _policies WHERE table_name = ?').bind('posts').run();
    await env.DB.prepare(INSERT_POLICY)
      .bind(...policyRow('read', ['id']))
      .run();
    await env.DB.prepare(
      'INSERT INTO _exposed_tables (table_name, enabled, version) VALUES (?, 1, 2)',
    )
      .bind('posts')
      .run();

    const after = await getRegistry(env.DB);

    // Still the wide grant, and the same object: nothing reloaded.
    expect(after).toBe(before);
    expect(after.candidates('posts', 'select', 'authenticated')[0]?.columns).toEqual([
      'id',
      'title',
      'author_id',
    ]);

    // And the reload that the CLI cannot reach does see the narrowed one, which is
    // what makes this a cache problem rather than a write problem.
    resetRegistry();
    const reloaded = await getRegistry(env.DB);
    expect(reloaded.candidates('posts', 'select', 'authenticated')[0]?.columns).toEqual(['id']);
  });
});

describe('F4: what happens to an isolate that saw a broken registry', () => {
  it('keeps failing after the data is repaired, because the rejection is memoised', async () => {
    // `cached ??= loadRegistry(...)` stores the promise. A rejected promise is not
    // null, so `??=` never replaces it. Reasoning about that is easy to get wrong,
    // which is why it is measured.
    //
    // Fail-closed, so not a leak. It matters because it turns any single malformed
    // row from "broken until fixed" into "broken until every isolate recycles".
    await env.DB.prepare(INSERT_POLICY)
      .bind(
        'posts',
        'bad',
        'select',
        JSON.stringify(['authenticated']),
        '{not json',
        null,
        '[]',
        null,
      )
      .run();
    await env.DB.prepare(
      'INSERT INTO _exposed_tables (table_name, enabled, version) VALUES (?, 1, 1)',
    )
      .bind('posts')
      .run();

    await expect(getRegistry(env.DB)).rejects.toThrow();

    // Repair it, exactly as an operator would.
    await env.DB.prepare('DELETE FROM _policies WHERE table_name = ?').bind('posts').run();
    await env.DB.prepare(INSERT_POLICY)
      .bind(...policyRow('read', ['id']))
      .run();

    // A fresh load is fine, so the data really is repaired.
    await expect(loadRegistry(env.DB)).resolves.toBeDefined();

    // The isolate is not.
    await expect(getRegistry(env.DB)).rejects.toThrow();
  });
});

describe('F3: two writers on one table', () => {
  it('can leave the union of both policy sets exposed, which is wider than either', async () => {
    // 🔴 The ordering argument in `cli/policy-document.ts` assumes one writer. With
    // two, the second run's deletes land between the first run's deletes and its
    // re-expose, and permissive policies OR together, so the effective grant is the
    // union of two documents that nobody wrote.
    //
    // Interleaved: A deletes, B deletes, B writes and exposes, A writes and exposes.
    const del = async (table: string): Promise<void> => {
      await env.DB.prepare(`DELETE FROM ${table} WHERE table_name = ?`).bind('posts').run();
    };

    // A: unexpose and clear
    await del('_exposed_tables');
    await del('_policies');

    // B: unexpose and clear, then write its own and expose
    await del('_exposed_tables');
    await del('_policies');
    await env.DB.prepare(INSERT_POLICY)
      .bind(...policyRow('b_wide', ['id', 'title']))
      .run();
    await env.DB.prepare(
      'INSERT INTO _exposed_tables (table_name, enabled, version) VALUES (?, 1, 2)',
    )
      .bind('posts')
      .run();

    // A: writes its own. Its final insert collides on the primary key and fails,
    // which is the only reason anybody finds out, and by then the row is written.
    await env.DB.prepare(INSERT_POLICY)
      .bind(...policyRow('a_narrow', ['id']))
      .run();

    let collided = false;
    try {
      await env.DB.prepare(
        'INSERT INTO _exposed_tables (table_name, enabled, version) VALUES (?, 1, 3)',
      )
        .bind('posts')
        .run();
    } catch {
      collided = true;
    }

    expect(collided).toBe(true);

    resetRegistry();
    const registry = await getRegistry(env.DB);
    const names = registry
      .candidates('posts', 'select', 'authenticated')
      .map((policy) => policy.name)
      .sort();

    // Both, from two different documents, on a table that is exposed.
    expect(names).toEqual(['a_narrow', 'b_wide']);
  });
});

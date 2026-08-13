/**
 * What the registry cache does, measured rather than described.
 *
 * These behaviours were reported by an audit of the policy write path and are verified
 * here rather than taken on the report's word. The value of writing them down is that
 * the CLI was shipping comments claiming the opposite, and a claim nobody can test is a
 * claim that stays wrong.
 *
 * None of them is a leak. They are the difference between what an operator is told
 * happened and what actually happened.
 *
 * ⚠️ **F4 is now a fix rather than a finding, and its test asserts the opposite of
 * what it used to.** That is the one edit `rules/03` section G would otherwise forbid,
 * so it is called out here: the old assertion described a bug, the bug is gone, and a
 * test still demanding it would be demanding the bug back. F2 and F3 are unchanged and
 * still describe live behaviour.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { D1Executor } from '../db/dialect.js';
import { MAX_REGISTRY_AGE_MS } from '../utils/memo.js';
import { getRegistry, resetRegistry, setRegistryClock } from './registry.js';
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
    // the wider policy. Nothing reads the version, and the CLI shipped three comments
    // claiming it was the mechanism.
    //
    // ⚠️ Still true, and no longer unbounded: the sibling test below shows the window
    // closing on its own after `MAX_REGISTRY_AGE_MS`. This one runs inside that
    // window, which is why it still sees the old registry. Both are the behaviour;
    // reading either on its own gives the wrong picture.
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

  it('picks the narrowed policy up on its own once the window closes', async () => {
    // ⭐ The bound F2 did not have. Nothing here calls `resetRegistry`, which is the
    // point: an isolate that never hears about the change still stops serving the old
    // policy, and it does so within a time somebody can be told.
    //
    // Measured against a live deployment before this existed: 393 seconds in one run
    // and 57 in another, with nothing changed between them. The spread was the reason
    // no figure could be given to an operator. Now there is one.
    let now = 5_000_000;
    setRegistryClock(() => now);

    try {
      await env.DB.prepare(INSERT_POLICY)
        .bind(...policyRow('read', ['id', 'title', 'author_id']))
        .run();
      await env.DB.prepare(
        'INSERT INTO _exposed_tables (table_name, enabled, version) VALUES (?, 1, 1)',
      )
        .bind('posts')
        .run();

      const before = await getRegistry(env.DB);
      expect(before.candidates('posts', 'select', 'authenticated')[0]?.columns).toHaveLength(3);

      await env.DB.prepare('DELETE FROM _policies WHERE table_name = ?').bind('posts').run();
      await env.DB.prepare(INSERT_POLICY)
        .bind(...policyRow('read', ['id']))
        .run();

      // One millisecond short. Still the old grant, and the same object.
      now += MAX_REGISTRY_AGE_MS - 1;
      expect(await getRegistry(env.DB)).toBe(before);

      // Over the line, with nobody having told it anything.
      now += 1;
      const after = await getRegistry(env.DB);
      expect(after).not.toBe(before);
      expect(after.candidates('posts', 'select', 'authenticated')[0]?.columns).toEqual(['id']);
    } finally {
      setRegistryClock();
    }
  });
});

/**
 * An executor whose first query never answers until the test says so.
 *
 * Needed because the race below is about what happens *while* a load is in flight,
 * and a real D1 answers too quickly to get in between.
 */
function gatedExecutor(): { executor: D1Executor; fail: (cause: Error) => void } {
  let reject: (cause: Error) => void = () => {};
  const gate = new Promise<never>((_, rejectGate) => {
    reject = rejectGate;
  });

  const statement = {
    bind: () => statement,
    all: () => gate,
    first: () => gate,
    run: () => gate,
    raw: () => gate,
  } as unknown as D1PreparedStatement;

  return {
    executor: { prepare: () => statement, batch: async () => [] } as unknown as D1Executor,
    fail: (cause) => {
      reject(cause);
    },
  };
}

describe('F4: what happens to an isolate that saw a broken registry', () => {
  it('recovers once the failure clears, rather than staying broken until it recycles', async () => {
    // 🔴 This test asserted the opposite until the bug it described was fixed.
    // `cached ??= loadRegistry(...)` stored the promise, and a rejected promise is
    // not null, so `??=` never replaced it: one failed load broke the isolate for
    // as long as it lived, and fixing the cause changed nothing.
    //
    // Fail-closed throughout, so this was never a leak. What it was is an outage with
    // no bound on it, which the operator could not end by fixing the cause.
    //
    // ⚠️ The trigger changed on 2026-08-14. It used to be a malformed policy row,
    // which was the cheapest way to make a load fail. That is no longer a way at
    // all: a document that cannot be read now drops its own table and the load
    // succeeds, which is the entire point of that change. What still fails a load
    // is the platform, so that is what this simulates, and it is the more faithful
    // trigger anyway since D1 trouble is the real-world cause.
    await env.DB.prepare(
      'INSERT INTO _exposed_tables (table_name, enabled, version) VALUES (?, 1, 1)',
    )
      .bind('posts')
      .run();
    await env.DB.prepare(INSERT_POLICY)
      .bind(...policyRow('read', ['id']))
      .run();

    const unavailable: D1Executor = {
      prepare(sql: string) {
        if (sql.includes('_policies')) throw new Error('D1 unavailable');
        return env.DB.prepare(sql);
      },
      batch: (statements) => env.DB.batch(statements),
    };

    await expect(getRegistry(unavailable)).rejects.toThrow();

    // Asked twice while still broken, because a memo that forgets a failure has to
    // keep failing for the right reason rather than because it cached one.
    await expect(getRegistry(unavailable)).rejects.toThrow();

    // The failure clears, exactly as an outage does.
    const registry = await getRegistry(env.DB);
    expect(registry.candidates('posts', 'select', 'authenticated')[0]?.columns).toEqual(['id']);

    // And it is a memo again: the recovered load is held, not repeated.
    expect(await getRegistry(env.DB)).toBe(registry);
  });

  it('does not let a failure discard the load that replaced it', async () => {
    // ⚠️ The obvious fix clears the memo from the failure handler unconditionally,
    // and that is wrong in one case nothing else in this file would have caught.
    // `resetRegistry` can run while a load is in flight. The next call then starts a
    // fresh one, which may already have succeeded by the time the abandoned load
    // fails, and an unconditional clear throws that good result away.
    //
    // A load nobody is waiting for must not be able to reach back into the memo.
    await env.DB.prepare(INSERT_POLICY)
      .bind(...policyRow('read', ['id']))
      .run();
    await env.DB.prepare(
      'INSERT INTO _exposed_tables (table_name, enabled, version) VALUES (?, 1, 1)',
    )
      .bind('posts')
      .run();

    const gated = gatedExecutor();

    // In flight, and about to be abandoned. The outcome is captured now rather than
    // awaited later, so the rejection is never unhandled.
    const abandoned = getRegistry(gated.executor).then(
      () => 'resolved',
      () => 'rejected',
    );

    resetRegistry();
    const good = await getRegistry(env.DB);

    gated.fail(new Error('the load nobody is waiting for'));
    expect(await abandoned).toBe('rejected');

    // Same object. The abandoned failure did not reach the memo.
    expect(await getRegistry(env.DB)).toBe(good);
  });
});

describe('F3: two writers on one table', () => {
  it('can leave the union of both policy sets exposed, which is wider than either', async () => {
    // 🔴 What the registry does when both sets are present, which is OR them, so the
    // effective grant is wider than either author wrote.
    //
    // ⚠️ **This is still exactly true, and `baseclf policy apply` can no longer reach
    // it.** The command takes a per-table lock before its first delete and guards the
    // statement that exposes the table on still holding it, so a second run either
    // refuses before writing anything or is told it was overtaken. See
    // `cli/policy-document.ts`.
    //
    // The test stays because the registry has not changed and neither has the reason
    // it matters: this state is still reachable by writing the rows directly, which
    // the README is explicit bypasses the engine. What the registry does with rows it
    // finds is worth pinning whatever put them there.
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

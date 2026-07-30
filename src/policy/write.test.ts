/**
 * The write path.
 *
 * V2's whole claim is one sentence: a caller cannot move a row out of their own
 * reach, and finds out about it as a 404 rather than a 403. Everything here is
 * some version of that.
 *
 * These run end to end against a real D1 binding, because the mechanism depends
 * on RETURNING and on the guarded insert actually behaving the way they were
 * probed to behave. A mock would prove nothing about either.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getCatalogue, resetCatalogue } from '../db/introspect.js';
import { readTable, writeTable } from '../rest/router.js';
import type { BaseclfError } from '../utils/errors.js';
import {
  OWNER_WRITABLE_POLICIES,
  POST_BINDS,
  registerPolicies,
  type SeedPolicy,
  seedDatabase,
  seedStandardPolicies,
} from './__fixtures__/schema.js';
import { getRegistry, resetRegistry } from './registry.js';
import type { AuthCtx } from './types.js';
import type { WriteOperation } from './write.js';

const ANON: AuthCtx = Object.freeze({ role: 'anon', uid: null, email: null, app: {} });

function asUser(uid: string): AuthCtx {
  return Object.freeze({ role: 'authenticated', uid, email: `${uid}@example.test`, app: {} });
}

interface PostRow {
  id?: string;
  title?: string;
  status?: string;
  author_id?: string;
}

async function write(
  auth: AuthCtx,
  operation: WriteOperation,
  query: string,
  body: Record<string, unknown> | null,
) {
  const [catalogue, registry] = await Promise.all([getCatalogue(env.DB), getRegistry(env.DB)]);
  return writeTable<PostRow>({
    executor: env.DB,
    catalogue,
    registry,
    auth,
    table: 'posts',
    search: new URLSearchParams(query),
    operation,
    body,
  });
}

async function read(auth: AuthCtx, query = '') {
  const [catalogue, registry] = await Promise.all([getCatalogue(env.DB), getRegistry(env.DB)]);
  return readTable<PostRow>({
    executor: env.DB,
    catalogue,
    registry,
    auth,
    table: 'posts',
    search: new URLSearchParams(query),
  });
}

/** Straight from the database, with no policy in the way. */
async function storedAuthor(id: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT author_id FROM posts WHERE id = ?')
    .bind(id)
    .first<{ author_id: string }>();
  return row?.author_id ?? null;
}

async function useOwnerWritablePolicy(extra: readonly SeedPolicy[] = []): Promise<void> {
  await registerPolicies(env.DB, {
    table: 'posts',
    binds: POST_BINDS,
    policies: [...OWNER_WRITABLE_POLICIES, ...extra],
  });
  resetRegistry();
}

function codeOf(error: unknown): string {
  return (error as BaseclfError).code;
}

beforeAll(async () => {
  await seedDatabase(env.DB);
});

beforeEach(async () => {
  await seedDatabase(env.DB);
  await seedStandardPolicies(env.DB);
  resetCatalogue();
  resetRegistry();
});

describe('an update that tries to change the owner', () => {
  it('is refused when the policy does not grant writing author_id', async () => {
    // The first line of defence, and the cheaper one: the column is simply not
    // something this policy lets a caller write.
    const error = await write(asUser('u_ann'), 'update', 'id=eq.p2', {
      title: 'renamed',
      author_id: 'u_bob',
    }).catch((caught) => caught);

    // NO_POLICY rather than "you may not write that column", and both are the
    // same 404 with the same sentence from outside. Rule 00 invariant I5.
    expect(codeOf(error)).toBe('NO_POLICY');
    expect((error as BaseclfError).status).toBe(404);
    expect(await storedAuthor('p2')).toBe('u_ann');
  });

  it('is refused by the check even when the policy does grant it', async () => {
    // The interesting one. author_id is writable here, so nothing stops the
    // statement being built. What stops the write is that the check was
    // rewritten into a statement about the row afterwards: the new author_id is
    // compared against the caller, and u_bob is not u_ann.
    await useOwnerWritablePolicy();

    const result = await write(asUser('u_ann'), 'update', 'id=eq.p2', {
      title: 'renamed',
      author_id: 'u_bob',
    });

    expect(result.rows).toEqual([]);
    expect(await storedAuthor('p2')).toBe('u_ann');

    // And the statement says why, in the shape the skill describes: two
    // author_id terms, one for the row as it is and one for the row as it would
    // be, the second comparing a bound value rather than the column.
    expect(result.sql).toContain('? = ?');
  });

  it('allows setting the owner to yourself, which is the only value that passes', async () => {
    await useOwnerWritablePolicy();

    const result = await write(asUser('u_ann'), 'update', 'id=eq.p2', {
      title: 'still mine',
      author_id: 'u_ann',
    });

    expect(result.rows).toHaveLength(1);
    expect(await storedAuthor('p2')).toBe('u_ann');
  });

  it('does not let the pre-image check alone carry the write', async () => {
    // A row Ann owns, handed to Bob. USING passes, because the row is hers
    // right now. Only the post-image check catches it, so this is the test that
    // fails if the rewrite is ever dropped.
    await useOwnerWritablePolicy();

    const before = await storedAuthor('p1');
    await write(asUser('u_ann'), 'update', 'id=eq.p1', { author_id: 'u_bob' });
    expect(await storedAuthor('p1')).toBe(before);
  });
});

describe('an update of somebody else row', () => {
  it('is a 404 and not a 403', async () => {
    // p3 belongs to Bob. Rule 00 invariant I5: Ann must not be able to tell
    // "that row is not yours" from "there is no such row", or she can walk a
    // range of ids and learn which ones exist.
    const mine = await write(asUser('u_ann'), 'update', 'id=eq.p3', { title: 'taken' });
    expect(mine.rows).toEqual([]);

    const imaginary = await write(asUser('u_ann'), 'update', 'id=eq.p_nope', { title: 'taken' });
    expect(imaginary.rows).toEqual([]);

    // Same answer, and the row is untouched.
    const row = await env.DB.prepare('SELECT title FROM posts WHERE id = ?')
      .bind('p3')
      .first<{ title: string }>();
    expect(row?.title).toBe('Draft by Bob');
  });

  it('cannot be widened by the client filter', async () => {
    // Asking for every row does not help: the policy is AND'd around whatever
    // the filter says.
    const result = await write(asUser('u_ann'), 'update', 'or=(id.eq.p2,id.eq.p3)', {
      title: 'sweep',
    });

    expect(result.rows.map((row) => row.id)).toEqual(['p2']);
    const bob = await env.DB.prepare('SELECT title FROM posts WHERE id = ?')
      .bind('p3')
      .first<{ title: string }>();
    expect(bob?.title).toBe('Draft by Bob');
  });
});

describe('insert', () => {
  it('ignores an author_id in the body and uses the token instead', async () => {
    const result = await write(asUser('u_ann'), 'insert', '', {
      id: 'p_new',
      title: 'Mine',
      body: null,
      status: 'draft',
      org_id: 'org_1',
      created_at: '2026-07-31',
      author_id: 'u_bob',
    });

    expect(result.rows).toHaveLength(1);
    // The value the caller sent never reached the statement.
    expect(await storedAuthor('p_new')).toBe('u_ann');
  });

  it('is a guarded insert, so a failing check writes nothing at all', async () => {
    // New posts must start as drafts. The condition is part of the same
    // statement, so there is no moment where the row exists and is then
    // removed.
    await registerPolicies(env.DB, {
      table: 'posts',
      binds: POST_BINDS,
      policies: [
        {
          name: 'insert_draft_only',
          operation: 'insert',
          roles: ['authenticated'],
          using: true,
          check: { status: { _eq: 'draft' } },
          columns: ['id', 'title', 'body', 'status', 'org_id', 'created_at'],
          set: { author_id: '$auth.uid' },
        },
      ],
    });
    resetRegistry();

    const refused = await write(asUser('u_ann'), 'insert', '', {
      id: 'p_pub',
      title: 'Straight to published',
      body: null,
      status: 'published',
      org_id: 'org_1',
      created_at: '2026-07-31',
    });
    expect(refused.rows).toEqual([]);

    const stored = await env.DB.prepare('SELECT count(*) AS c FROM posts WHERE id = ?')
      .bind('p_pub')
      .first<{ c: number }>();
    expect(stored?.c).toBe(0);

    const accepted = await write(asUser('u_ann'), 'insert', '', {
      id: 'p_draft',
      title: 'A draft',
      body: null,
      status: 'draft',
      org_id: 'org_1',
      created_at: '2026-07-31',
    });
    expect(accepted.rows).toHaveLength(1);
  });

  it('refuses a check on a column the insert does not set', async () => {
    // There is no row yet, so the column would hold whatever the schema
    // defaults to, and the engine does not read defaults. Guessing here would
    // mean a check that silently passes.
    await registerPolicies(env.DB, {
      table: 'posts',
      policies: [
        {
          name: 'insert_checks_unset_column',
          operation: 'insert',
          roles: ['authenticated'],
          using: true,
          check: { org_id: { _eq: 'org_1' } },
          columns: ['id', 'title'],
          set: { author_id: '$auth.uid' },
        },
      ],
    });
    resetRegistry();

    const error = await write(asUser('u_ann'), 'insert', '', {
      id: 'p_x',
      title: 'no org',
    }).catch((caught) => caught);

    expect(codeOf(error)).toBe('INVALID_EXPR');
  });

  it('refuses a filter, which has nothing to apply to', async () => {
    const error = await write(asUser('u_ann'), 'insert', 'id=eq.p1', {
      id: 'p_y',
      title: 'x',
      body: null,
      status: 'draft',
      org_id: 'org_1',
      created_at: '2026-07-31',
    }).catch((caught) => caught);

    expect(codeOf(error)).toBe('UNSUPPORTED_QUERY');
  });
});

describe('delete', () => {
  it('removes a row the caller owns', async () => {
    const result = await write(asUser('u_ann'), 'delete', 'id=eq.p2', null);
    expect(result.rows).toHaveLength(1);

    const stored = await env.DB.prepare('SELECT count(*) AS c FROM posts WHERE id = ?')
      .bind('p2')
      .first<{ c: number }>();
    expect(stored?.c).toBe(0);
  });

  it('answers 404 for somebody else row, and leaves it alone', async () => {
    const result = await write(asUser('u_ann'), 'delete', 'id=eq.p3', null);
    expect(result.rows).toEqual([]);

    const stored = await env.DB.prepare('SELECT count(*) AS c FROM posts WHERE id = ?')
      .bind('p3')
      .first<{ c: number }>();
    expect(stored?.c).toBe(1);
  });

  it('cannot be turned into a sweep by omitting the filter', async () => {
    // No filter means the policy alone decides, and the policy is still
    // "rows you wrote". It does not mean "everything".
    const result = await write(asUser('u_ann'), 'delete', '', null);
    expect(result.rows.map((row) => row.id).sort()).toEqual(['p1', 'p2']);

    const left = await env.DB.prepare('SELECT count(*) AS c FROM posts').first<{ c: number }>();
    expect(left?.c).toBe(2);
  });
});

describe('fail-closed on the write path too', () => {
  it('refuses a role no write policy names', async () => {
    const error = await write(ANON, 'update', 'id=eq.p1', { title: 'x' }).catch((caught) => caught);
    expect(codeOf(error)).toBe('NO_POLICY');
    expect((error as BaseclfError).status).toBe(404);
  });

  it('refuses a table with no policy document', async () => {
    const [catalogue, registry] = await Promise.all([getCatalogue(env.DB), getRegistry(env.DB)]);
    await expect(
      writeTable({
        executor: env.DB,
        catalogue,
        registry,
        auth: asUser('u_ann'),
        table: 'secrets',
        search: new URLSearchParams(),
        operation: 'update',
        body: { value: 'x' },
      }),
    ).rejects.toThrow();
  });

  it('refuses an engine table', async () => {
    const [catalogue, registry] = await Promise.all([getCatalogue(env.DB), getRegistry(env.DB)]);
    await expect(
      writeTable({
        executor: env.DB,
        catalogue,
        registry,
        auth: asUser('u_ann'),
        table: '_policies',
        search: new URLSearchParams(),
        operation: 'delete',
        body: null,
      }),
    ).rejects.toThrow();
  });

  it('refuses a body that sets nothing the policy grants', async () => {
    const error = await write(asUser('u_ann'), 'update', 'id=eq.p2', {}).catch((caught) => caught);
    expect(codeOf(error)).toBe('UNSUPPORTED_QUERY');
  });

  it('refuses a bulk write rather than writing part of one', async () => {
    const error = await write(asUser('u_ann'), 'insert', '', [
      { id: 'a' },
      { id: 'b' },
    ] as unknown as Record<string, unknown>).catch((caught) => caught);

    expect(codeOf(error)).toBe('UNSUPPORTED_QUERY');
  });
});

describe('what a write hands back', () => {
  it('returns the primary key and the columns it touched', async () => {
    const result = await write(asUser('u_ann'), 'update', 'id=eq.p2', { title: 'renamed' });

    expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual(['id', 'title']);
    expect(result.rows[0]?.id).toBe('p2');
  });

  it('binds every value, so no statement carries data', async () => {
    const result = await write(asUser('u_ann'), 'update', 'id=eq.p2', { title: 'renamed' });

    expect(result.sql).not.toContain("'");
    expect(result.sql).not.toContain('renamed');
    expect(result.sql).not.toContain('u_ann');
  });

  it('leaves the row visible to its owner and nobody else afterwards', async () => {
    await write(asUser('u_ann'), 'update', 'id=eq.p2', { title: 'renamed' });

    const ann = await read(asUser('u_ann'), 'select=id,title');
    expect(ann.rows.find((row) => row.id === 'p2')?.title).toBe('renamed');

    const bob = await read(asUser('u_bob'), 'select=id,title');
    expect(bob.rows.map((row) => row.id)).not.toContain('p2');
  });
});

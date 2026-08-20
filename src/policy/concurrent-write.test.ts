/**
 * Two writers, one row, and what "single threaded" is worth.
 *
 * D1 executes one statement at a time per database (rules/01 section D), and each
 * update here is a single guarded statement, so two updates issued together must
 * serialise: each sees a complete before-image and leaves a complete after-image.
 * This was believed rather than locked in (debt 11), and the difference matters
 * because the write path's whole design leans on "one statement, no read-modify-
 * write". A torn row, half of one writer and half of the other, would falsify
 * that design; this is the test that would catch it.
 *
 * Runs against a real D1 binding, because a mock would prove nothing about how
 * the platform schedules two in-flight statements.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getCatalogue, resetCatalogue } from '../db/introspect.js';
import { writeTable } from '../rest/router.js';
import {
  OWNER_WRITABLE_POLICIES,
  POST_BINDS,
  registerPolicies,
  seedDatabase,
} from './__fixtures__/schema.js';
import { getRegistry, resetRegistry } from './registry.js';
import type { AuthCtx } from './types.js';

interface PostRow {
  id?: string;
  title?: string;
  status?: string;
}

function asUser(uid: string): AuthCtx {
  return Object.freeze({ role: 'authenticated', uid, email: `${uid}@example.test`, app: {} });
}

async function update(auth: AuthCtx, id: string, body: Record<string, unknown>) {
  const [catalogue, registry] = await Promise.all([getCatalogue(env.DB), getRegistry(env.DB)]);
  return writeTable<PostRow>({
    executor: env.DB,
    catalogue,
    registry,
    auth,
    table: 'posts',
    search: new URLSearchParams(`id=eq.${id}`),
    operation: 'update',
    body,
  });
}

beforeAll(async () => {
  await seedDatabase(env.DB);
  resetCatalogue();
});

beforeEach(async () => {
  await registerPolicies(env.DB, {
    table: 'posts',
    binds: POST_BINDS,
    policies: OWNER_WRITABLE_POLICIES,
  });
  resetRegistry();
});

describe('two concurrent updates to the same row', () => {
  it('serialises them: the final row is exactly one writer, never a blend', async () => {
    // Read the target from the seeded data rather than spelling an id from
    // memory. A test in this repository once ran against a row that did not
    // exist because the fixture wrote `p1` and the test wrote `p_1`, and it
    // passed for the wrong half of its claim.
    const target = await env.DB.prepare(
      "SELECT id, author_id FROM posts WHERE author_id IS NOT NULL AND author_id != '' LIMIT 1",
    ).first<{ id: string; author_id: string }>();
    expect(target).not.toBeNull();
    const row = target as { id: string; author_id: string };
    const owner = asUser(row.author_id);

    // Two columns per writer, because a single column cannot show a tear: the
    // pair is what must stay together.
    const left = { title: 'left wrote this', status: 'published' };
    const right = { title: 'right wrote this', status: 'draft' };

    const [first, second] = await Promise.all([
      update(owner, row.id, left),
      update(owner, row.id, right),
    ]);

    // Both statements ran: RETURNING answered for each, so neither writer was
    // silently dropped while the other reported for both.
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(1);

    // Each RETURNING is its own post-image, so its title is one of the two
    // written values rather than something stitched together.
    expect([left.title, right.title]).toContain(first.rows[0]?.title);
    expect([left.title, right.title]).toContain(second.rows[0]?.title);

    // The stored row is one writer's pair in full. Which one wins is scheduling
    // and deliberately not asserted; a mixed pair is the failure this exists for.
    const final = await env.DB.prepare('SELECT title, status FROM posts WHERE id = ?')
      .bind(row.id)
      .first<{ title: string; status: string }>();
    const stored = final as { title: string; status: string };

    const wholeLeft = stored.title === left.title && stored.status === left.status;
    const wholeRight = stored.title === right.title && stored.status === right.status;
    expect(wholeLeft || wholeRight).toBe(true);
  });
});

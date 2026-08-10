/**
 * The HTTP surface, driven through the worker rather than through the router.
 *
 * What this covers that the router tests do not: status codes, the `Prefer`
 * header, and the translation of "RETURNING gave back nothing" into 404. That
 * last one is the one that matters, and it is why these run through `fetch`
 * instead of asserting on a result object.
 *
 * Every request here is anonymous, in the sense that none of them presents a
 * token. That is now a real identity rather than the only one available: the
 * worker verifies a bearer token when one arrives, and a request without one
 * is the anon role, which has policies of its own. See identity.test.ts for the
 * other half.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resetCatalogue } from '../db/introspect.js';
import worker from '../index.js';
import {
  registerPolicies,
  seedDatabase,
  seedStandardPolicies,
} from '../policy/__fixtures__/schema.js';
import { resetRegistry } from '../policy/registry.js';

/**
 * The worker refuses to serve anything when identity is unconfigured, so these
 * tests have to configure it even though none of them signs in. That refusal is
 * deliberate and is asserted on its own in identity.test.ts: a deployment
 * missing its secret should be visibly broken rather than quietly open.
 */
const testEnv = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: 'https://baseclf.test',
};

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`https://baseclf.test${path}`, init), testEnv);
}

function json(path: string, method: string, body: unknown, headers: HeadersInit = {}) {
  return call(path, {
    method,
    body: body === null ? null : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Policies that let the anonymous role write, so the HTTP layer can be tested. */
async function allowAnonymousWrites(): Promise<void> {
  await registerPolicies(env.DB, {
    table: 'posts',
    policies: [
      {
        name: 'read_all',
        operation: 'select',
        roles: ['anon'],
        using: true,
        columns: ['id', 'title', 'status'],
      },
      {
        name: 'insert_drafts',
        operation: 'insert',
        roles: ['anon'],
        using: true,
        check: { status: { _eq: 'draft' } },
        columns: ['id', 'title', 'body', 'status', 'org_id', 'created_at'],
        set: { author_id: 'anonymous' },
      },
      {
        name: 'update_drafts',
        operation: 'update',
        roles: ['anon'],
        using: { status: { _eq: 'draft' } },
        check: { status: { _eq: 'draft' } },
        columns: ['title'],
      },
      {
        name: 'delete_drafts',
        operation: 'delete',
        roles: ['anon'],
        using: { status: { _eq: 'draft' } },
        columns: ['id'],
      },
    ],
  });
  resetRegistry();
}

const NEW_POST = {
  id: 'p_http',
  title: 'From HTTP',
  body: null,
  status: 'draft',
  org_id: 'org_1',
  created_at: '2026-07-31',
};

beforeAll(async () => {
  await seedDatabase(env.DB);
  resetCatalogue();
});

beforeEach(async () => {
  await seedDatabase(env.DB);
  await seedStandardPolicies(env.DB);
  resetCatalogue();
  resetRegistry();
});

describe('reads', () => {
  it('serves a table the policy exposes', async () => {
    const response = await call('/rest/v1/posts?select=id,status');
    expect(response.status).toBe(200);

    const rows = (await response.json()) as { id: string }[];
    expect(rows.map((row) => row.id)).toEqual(['p1']);
  });

  it('answers 404 for a table with no policy', async () => {
    const response = await call('/rest/v1/secrets');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'Not found.' });
  });

  it('answers 404 for an engine table, with the same body', async () => {
    const engine = await call('/rest/v1/_policies');
    const missing = await call('/rest/v1/no_such_table');

    expect(engine.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await engine.json()).toEqual(await missing.json());
  });

  it('returns a bookmark so a later read can be consistent with this one', async () => {
    const response = await call('/rest/v1/posts?select=id');
    expect(response.headers.has('x-d1-bookmark')).toBe(true);
  });
});

describe('writes', () => {
  beforeEach(allowAnonymousWrites);

  it('answers 201 and no body by default on insert', async () => {
    const response = await json('/rest/v1/posts', 'POST', NEW_POST);

    // PostgREST defaults to Prefer: return=minimal, and so does this.
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('');
  });

  it('answers 201 with the row when asked for a representation', async () => {
    const response = await json('/rest/v1/posts', 'POST', NEW_POST, {
      prefer: 'return=representation',
    });

    expect(response.status).toBe(201);
    const rows = (await response.json()) as { id: string; author_id: string }[];
    expect(rows[0]?.id).toBe('p_http');
    // The server put this there. The request never mentioned it.
    expect(rows[0]?.author_id).toBe('anonymous');
  });

  it('answers 404 when the check refuses the insert', async () => {
    const response = await json('/rest/v1/posts', 'POST', { ...NEW_POST, status: 'published' });

    expect(response.status).toBe(404);
    const stored = await env.DB.prepare('SELECT count(*) AS c FROM posts WHERE id = ?')
      .bind('p_http')
      .first<{ c: number }>();
    expect(stored?.c).toBe(0);
  });

  it('answers 204 on a successful update with no representation asked for', async () => {
    const response = await json('/rest/v1/posts?id=eq.p2', 'PATCH', { title: 'renamed' });
    expect(response.status).toBe(204);
  });

  it('answers 404 for an update that matches nothing', async () => {
    // p1 is published, and the policy only reaches drafts. A row that exists
    // but is out of reach and a row that does not exist answer identically.
    const forbidden = await json('/rest/v1/posts?id=eq.p1', 'PATCH', { title: 'x' });
    const missing = await json('/rest/v1/posts?id=eq.p_nope', 'PATCH', { title: 'x' });

    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await forbidden.json()).toEqual(await missing.json());
  });

  it('answers 204 on delete and 404 when nothing matched', async () => {
    const deleted = await call('/rest/v1/posts?id=eq.p2', { method: 'DELETE' });
    expect(deleted.status).toBe(204);

    const again = await call('/rest/v1/posts?id=eq.p2', { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  it('refuses a body that is not JSON', async () => {
    const response = await call('/rest/v1/posts', {
      method: 'POST',
      body: 'not json at all',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
  });

  it('refuses a method it does not implement', async () => {
    const response = await call('/rest/v1/posts', { method: 'PUT' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD, POST, PATCH, DELETE');
  });

  it('never writes an engine table, whatever the method', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const response = await json('/rest/v1/_policies', method, method === 'DELETE' ? null : {});
      expect(response.status).toBe(404);
    }
  });
});

describe('writes without a policy', () => {
  it('are refused even when reading the same table is allowed', async () => {
    // The standard fixture gives anon a read policy on posts and no write
    // policy at all. Being able to see a row is not being able to change it.
    const read = await call('/rest/v1/posts?select=id');
    expect(read.status).toBe(200);

    const write = await json('/rest/v1/posts?id=eq.p1', 'PATCH', { title: 'x' });
    expect(write.status).toBe(404);

    const stored = await env.DB.prepare('SELECT title FROM posts WHERE id = ?')
      .bind('p1')
      .first<{ title: string }>();
    expect(stored?.title).toBe('Published by Ann');
  });
});

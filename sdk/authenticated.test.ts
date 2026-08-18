/**
 * The client with a real identity, writing through the real engine.
 *
 * 🔴 **The write path had only ever been proved from the refusing side.** The other
 * file drives the anonymous role, which the fixture grants nothing but reads, so every
 * write there is a 404 and a 404 is what you get whether the client is correct or
 * completely broken. This one signs up, takes the JWT the deployment issued, and
 * writes with it, so a passing write is evidence rather than the absence of one.
 *
 * ⭐ It is also the only place read-your-writes can be proved. The other file shows the
 * bookmark header going out and coming back, which is the mechanism; this shows a read
 * after a write returning the write, which is the promise.
 *
 * ⚠️ Email and password sign-in is switched on here, and it is off everywhere else for
 * a measured reason: hashing one password costs 58 ms of CPU against a free plan's
 * 10 ms per request. A test pays that once; a deployment pays it per sign-in.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { resetAuth, runAuthMigrations } from '../src/auth/index.js';
import { resetCatalogue } from '../src/db/introspect.js';
import worker, { type Env } from '../src/index.js';
import { seedDatabase, seedStandardPolicies } from '../src/policy/__fixtures__/schema.js';
import { resetRegistry } from '../src/policy/registry.js';
import { createClient } from './index.js';

const BASE_URL = 'https://baseclf.test';
const PASSWORD = 'a-password-of-ordinary-length';

const configured = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: BASE_URL,
  BETTER_AUTH_EMAIL_PASSWORD: 'true',
} as Env;

const intoWorker = (url: string, init?: RequestInit): Promise<Response> =>
  worker.fetch(new Request(url, init), configured);

let token: string;
let userId: string;

beforeAll(async () => {
  await seedDatabase(env.DB);
  await seedStandardPolicies(env.DB);
  resetCatalogue();
  resetRegistry();
  resetAuth();

  const created = await runAuthMigrations(configured);
  expect(created).toContain('jwks');

  const signUp = await intoWorker(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'dana@example.test', password: PASSWORD, name: 'Dana' }),
  });
  expect(signUp.status).toBe(200);

  const issued = await intoWorker(`${BASE_URL}/api/auth/token`, {
    headers: { authorization: `Bearer ${signUp.headers.get('set-auth-token')}` },
  });
  expect(issued.status).toBe(200);
  token = ((await issued.json()) as { token: string }).token;

  const [, payload] = token.split('.');
  userId = JSON.parse(atob((payload as string).replace(/-/g, '+').replace(/_/g, '/'))).sub;
}, 120_000);

/** A client carrying the identity that just signed up. */
const asDana = () => createClient(BASE_URL, { fetch: intoWorker, token: () => token });

describe('writing with an identity the deployment issued', () => {
  it('inserts a row the policy allows, and hands back what it wrote', async () => {
    // ⚠️ `author_id` is not sent. The policy writes it from the claim, so a client
    // that supplied one would be asking to be refused, and this is the shape a real
    // application uses.
    const { data, error } = await asDana()
      .from('posts')
      .insert({
        id: 'p_sdk_own',
        title: 'Written through the client',
        body: 'body',
        status: 'draft',
        org_id: 'org_1',
        created_at: '2026-08-16T00:00:00Z',
      })
      .single();

    expect(error).toBeNull();
    expect(data?.['id']).toBe('p_sdk_own');
    expect(data?.['author_id']).toBe(userId);
  });

  it('⭐ reads its own write back, which is what the bookmark is for', async () => {
    // The promise, rather than the mechanism. One client, a write and then a read, and
    // the read sees the write because the bookmark from the write went back out on it.
    const client = asDana();

    const written = await client
      .from('posts')
      .insert({
        id: 'p_sdk_rye',
        title: 'Read your writes',
        body: 'body',
        status: 'draft',
        org_id: 'org_1',
        created_at: '2026-08-16T00:00:00Z',
      })
      .single();
    expect(written.error).toBeNull();

    expect(client.bookmark()).not.toBeNull();

    const read = await client.from('posts').select('id,title').eq('id', 'p_sdk_rye').single();

    expect(read.error).toBeNull();
    expect(read.data?.['title']).toBe('Read your writes');
  });

  it('updates a row it owns', async () => {
    const { data, error } = await asDana()
      .from('posts')
      .eq('id', 'p_sdk_own')
      .update({ title: 'Edited by its author' })
      .single();

    expect(error).toBeNull();
    expect(data?.['title']).toBe('Edited by its author');
  });

  it('cannot edit somebody else row, and cannot tell that from a missing one', async () => {
    // 🔴 Invariant I5 from the client's side, and the pair is what makes it mean
    // anything. `p1` exists and belongs to `u_ann`; `p_nonexistent` does not exist at
    // all. Both answer the same, which is the invariant: a client cannot walk ids to
    // find out which ones are real.
    //
    // ⚠️ The first version of this test asked for `p_1`, which is not an id in the
    // fixture. It passed, and it proved the wrong half: "a row that is not there is
    // refused" rather than "a row that is not yours is refused". The two are
    // indistinguishable by design, which is exactly why the real row has to be used.
    const other = await asDana()
      .from('posts')
      .eq('id', 'p1')
      .update({ title: 'not mine' })
      .single();

    const missing = await asDana()
      .from('posts')
      .eq('id', 'p_nonexistent')
      .update({ title: 'not there' })
      .single();

    expect(other.data).toBeNull();
    expect(other.error?.status).toBe(404);
    expect(other.error?.code).toBe('NOT_FOUND');

    // The row that exists and the row that does not answer identically.
    expect(missing.error?.status).toBe(other.error?.status);
    expect(missing.error?.code).toBe(other.error?.code);
    expect(missing.error?.message).toBe(other.error?.message);
  });

  it('leaves the row it was refused exactly as it was', async () => {
    // The refusal above is only worth having if nothing changed behind it. Read `p1`
    // back as the role that can see it, and check the title the fixture wrote.
    const { data } = await createClient(BASE_URL, { fetch: intoWorker })
      .from('posts')
      .select('id,title')
      .eq('id', 'p1')
      .single();

    expect(data?.['title']).toBe('Published by Ann');
  });

  it('🔴 cannot hand its own row to somebody else', async () => {
    // The reason V2 exists, reached through the client. The policy grants an update on
    // rows this caller owns, and the check is evaluated against the row as it would be
    // after the write, so a change of owner fails on the post-image rather than on the
    // filter.
    const { data, error } = await asDana()
      .from('posts')
      .eq('id', 'p_sdk_own')
      .update({ author_id: 'u_2' })
      .single();

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
  });

  it('deletes a row it owns, and reports the row it removed', async () => {
    const { data, error } = await asDana().from('posts').eq('id', 'p_sdk_rye').delete().single();

    expect(error).toBeNull();
    expect(data?.['id']).toBe('p_sdk_rye');
  });

  it('sees the delete on the next read, without being told to look again', async () => {
    const client = asDana();
    await client.from('posts').eq('id', 'p_sdk_own').delete();

    const { data, error } = await client.from('posts').select('id').eq('id', 'p_sdk_own');

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

describe('the difference an identity makes to a read', () => {
  it('shows the caller their own draft, and anonymous nothing of it', async () => {
    // ⭐ The same URL, twice, answered differently. Nothing in the request says which
    // rows to hide; the engine decides from the token.
    const mine = await asDana()
      .from('posts')
      .insert({
        id: 'p_sdk_draft',
        title: 'Only mine',
        body: 'body',
        status: 'draft',
        org_id: 'org_1',
        created_at: '2026-08-16T00:00:00Z',
      })
      .single();
    expect(mine.error).toBeNull();

    const asOwner = await asDana().from('posts').select('id').eq('id', 'p_sdk_draft');
    const asAnyone = await createClient(BASE_URL, { fetch: intoWorker })
      .from('posts')
      .select('id')
      .eq('id', 'p_sdk_draft');

    expect(asOwner.data?.map((row) => row['id'])).toEqual(['p_sdk_draft']);
    expect(asAnyone.data).toEqual([]);
  });
});

describe('single() when the caller can see more than one row', () => {
  it('refuses rather than picking one, because the filter did not narrow', async () => {
    // 🔴 The half that cannot be tested anonymously: the fixture shows the anonymous
    // role exactly one published row, so "more than one" needs an identity that owns
    // several. Dana writes two, then asks for one.
    //
    // Returning the first would answer a question the caller did not ask, and which
    // row they got would depend on an ordering nobody wrote.
    const client = asDana();

    for (const id of ['p_sdk_many_a', 'p_sdk_many_b']) {
      const written = await client
        .from('posts')
        .insert({
          id,
          title: 'One of several',
          body: 'body',
          status: 'draft',
          org_id: 'org_1',
          created_at: '2026-08-16T00:00:00Z',
        })
        .single();
      expect(written.error).toBeNull();
    }

    const many = await client.from('posts').select('id').in('id', ['p_sdk_many_a', 'p_sdk_many_b']);
    expect(many.data).toHaveLength(2);

    const { data, error } = await client
      .from('posts')
      .select('id')
      .in('id', ['p_sdk_many_a', 'p_sdk_many_b'])
      .single();

    expect(data).toBeNull();
    expect(error?.code).toBe('NOT_SINGLE');
    expect(error?.message).toMatch(/Narrow the filter/);
  });
});

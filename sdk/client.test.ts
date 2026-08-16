/**
 * The client, driven against the real Worker rather than against a stand-in.
 *
 * 🔴 **This is the whole point of the file.** An SDK's job is to emit requests the
 * server accepts, so a test that checks the URL against a model of the grammar tests
 * the model. The grammar lives in `src/rest/parse-query.ts` and `src/rest/allowlist.ts`
 * and it refuses things: fourteen PostgREST operators by name, relationship embeds,
 * array bodies. A client built from `supabase-js` habits emits several of those, and
 * the failure would be a 400 at somebody else's runtime rather than a red test here.
 *
 * So `fetch` is wired to `worker.fetch` and the assertions are about rows.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { resetCatalogue } from '../src/db/introspect.js';
import worker, { type Env } from '../src/index.js';
import { seedDatabase, seedStandardPolicies } from '../src/policy/__fixtures__/schema.js';
import { resetRegistry } from '../src/policy/registry.js';
import { createClient } from './index.js';

const BASE_URL = 'https://baseclf.test';

const configured: Env = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: BASE_URL,
} as Env;

/** The client's `fetch`, pointed at the engine in this isolate. */
const intoWorker = (url: string, init?: RequestInit): Promise<Response> =>
  worker.fetch(new Request(url, init), configured);

const client = createClient(BASE_URL, { fetch: intoWorker });

beforeAll(async () => {
  await seedDatabase(env.DB);
  await seedStandardPolicies(env.DB);
  resetCatalogue();
  resetRegistry();
});

describe('reading through the client', () => {
  it('returns the rows the policy allows, and only those', async () => {
    // The fixture has published and draft posts. Anonymous sees the published ones,
    // and nothing in the request says so: the narrowing is the engine's.
    const { data, error } = await client.from('posts').select('*');

    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((row) => row['status'] === 'published')).toBe(true);
  });

  it('cannot widen what the policy allows, only narrow it', async () => {
    // 🔴 Invariant I3 from the client's side. A filter asking for drafts is ANDed onto
    // the policy rather than replacing it, so the answer is empty rather than the
    // drafts. If this ever returns a row, the client found a way to widen a policy.
    const { data, error } = await client.from('posts').select('*').eq('status', 'draft');

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('sends filters the engine actually parses', async () => {
    // Every operator in one request, so a grammar drift shows up as a refusal here
    // rather than in somebody's application.
    const { data, error } = await client
      .from('posts')
      .select('id,title,status')
      .neq('id', 'nope')
      .gte('created_at', 0)
      .lt('created_at', 9_999_999)
      .like('title', '%a%')
      .in('status', ['published', 'archived'])
      .order('id', { ascending: true })
      .limit(10);

    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it('reports a refusal as an error with the engine code, not as an exception', async () => {
    const { data, error } = await client.from('posts').select('id,no_such_column');

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
    // ⚠️ Every 404 collapses to NOT_FOUND on purpose (invariant I5), so a client
    // cannot tell "no such column" from "not yours". Asserted so nobody later
    // "improves" the client by inferring the difference.
    expect(error?.code).toBe('NOT_FOUND');
  });

  it('refuses a table the engine does not expose, the same way', async () => {
    const { error } = await client.from('_policies').select('*');

    expect(error?.status).toBe(404);
    expect(error?.code).toBe('NOT_FOUND');
  });
});

describe('what the client refuses before sending anything', () => {
  it('names the reason a PostgREST filter cannot work here', async () => {
    // The answer arrives while the line is being written rather than as a 400 in a
    // log. The reason is the caller's, not a name repeated back at them.
    expect(() => client.from('posts').unsupported('match')).toThrow(/REGEXP/);
    expect(() => client.from('posts').unsupported('cs')).toThrow(/array or range/);
    expect(() => client.from('posts').unsupported('fts')).toThrow(/FTS5/);
  });

  it('refuses an embed rather than sending a select the parser rejects', () => {
    expect(() => client.from('posts').select('id,author:user(name)')).toThrow(/embed/i);
  });

  it('refuses a bulk insert, and says why a partial write is worse', () => {
    const builder = client.from('posts');

    expect(() => builder.insert([{ id: 'a' }, { id: 'b' }] as unknown as Record<string, unknown>))
      .toThrow(/one at a time/);
  });
});

describe('the session bookmark, which is threaded without being asked for', () => {
  it('is empty before anything has been read', () => {
    const fresh = createClient(BASE_URL, { fetch: intoWorker });

    expect(fresh.bookmark()).toBeNull();
  });

  it('is picked up from a response and sent on the next request', async () => {
    // ⭐ This is what makes a read after a write see the write. The caller never
    // learns the header exists.
    const sent: (string | null)[] = [];
    const recording = (url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      sent.push(headers.get('x-d1-bookmark'));
      return intoWorker(url, init);
    };

    const fresh = createClient(BASE_URL, { fetch: recording });
    await fresh.from('posts').select('id');

    // ⚠️ Captured between the calls on purpose. Comparing what request two sent with
    // the bookmark held after request two fails, because response two advanced it
    // again. The first version of this test did exactly that and read as a bug in the
    // threading rather than as a bug in the assertion.
    const afterFirst = fresh.bookmark();
    await fresh.from('posts').select('id');

    expect(sent[0]).toBeNull();
    expect(afterFirst).not.toBeNull();
    expect(sent[1]).toBe(afterFirst);
  });

  it('sends nothing when session consistency is turned off', async () => {
    const sent: (string | null)[] = [];
    const recording = (url: string, init?: RequestInit): Promise<Response> => {
      sent.push(new Headers(init?.headers).get('x-d1-bookmark'));
      return intoWorker(url, init);
    };

    const fresh = createClient(BASE_URL, { fetch: recording, sessionConsistency: false });
    await fresh.from('posts').select('id');
    await fresh.from('posts').select('id');

    expect(sent).toEqual([null, null]);
    expect(fresh.bookmark()).toBeNull();
  });
});

describe('the client itself', () => {
  it('refuses a URL that is not one, rather than failing at the first request', () => {
    expect(() => createClient('baseclf.test')).toThrow(/http/);
  });

  it('does not carry a trailing slash into the path', () => {
    const trailing = createClient(`${BASE_URL}/`, { fetch: intoWorker });

    expect(trailing.from('posts').toURL()).toBe(`${BASE_URL}/rest/v1/posts`);
  });

  it('reads the token per request rather than capturing it once', async () => {
    // ⚠️ Tokens from this engine last fifteen minutes. A client that captured one at
    // construction works all through development and starts failing in production,
    // with nothing reporting why.
    let current: string | null = 'first';
    const seen: (string | null)[] = [];
    const recording = (url: string, init?: RequestInit): Promise<Response> => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return intoWorker(url, init);
    };

    const fresh = createClient(BASE_URL, { fetch: recording, token: () => current });
    await fresh.from('posts').select('id');
    current = 'second';
    await fresh.from('posts').select('id');

    expect(seen).toEqual(['Bearer first', 'Bearer second']);
  });

  it('sends no authorization header at all when there is no token', async () => {
    const seen: (string | null)[] = [];
    const recording = (url: string, init?: RequestInit): Promise<Response> => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return intoWorker(url, init);
    };

    await createClient(BASE_URL, { fetch: recording }).from('posts').select('id');

    expect(seen).toEqual([null]);
  });

  it('does not let two callers refining one builder see each other filters', async () => {
    // ⚠️ A mutating builder makes a shared base a trap, and the bug shows up as rows
    // missing rather than as an error.
    const base = client.from('posts').select('*');
    const published = base.eq('status', 'published');
    const drafts = base.eq('status', 'draft');

    expect(published.toURL()).not.toBe(drafts.toURL());
    expect(published.toURL()).toContain('status=eq.published');
    expect(published.toURL()).not.toContain('draft');
  });
});

describe('the write path', () => {
  /** Records the method, headers and body the client actually produced. */
  function recorder(): {
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
    calls: { method: string; body: string | null; prefer: string | null }[];
  } {
    const calls: { method: string; body: string | null; prefer: string | null }[] = [];
    return {
      calls,
      fetch: (url, init) => {
        calls.push({
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? init.body : null,
          prefer: new Headers(init?.headers).get('prefer'),
        });
        return intoWorker(url, init);
      },
    };
  }

  it('fails closed for a role with no write policy, and says nothing more', async () => {
    // 🔴 Invariant I1 seen from the client. The fixture grants anonymous nothing but
    // reads, so this is a refusal rather than a write, and the refusal is the same
    // NOT_FOUND every other one is: a client cannot tell "no policy" from "no row".
    const { data, error } = await client
      .from('posts')
      .insert({ id: 'p_sdk', title: 'nope', status: 'published', author_id: 'u_1' });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
    expect(error?.code).toBe('NOT_FOUND');
  });

  it('sends the method and body each verb is supposed to send', async () => {
    const seen = recorder();
    const writer = createClient(BASE_URL, { fetch: seen.fetch });

    await writer.from('posts').insert({ id: 'p_x', title: 'a' });
    await writer.from('posts').eq('id', 'p_x').update({ title: 'b' });
    await writer.from('posts').eq('id', 'p_x').delete();

    expect(seen.calls.map((each) => each.method)).toEqual(['POST', 'PATCH', 'DELETE']);
    expect(seen.calls[0]?.body).toBe('{"id":"p_x","title":"a"}');
    expect(seen.calls[1]?.body).toBe('{"title":"b"}');
    // A delete carries no body, so it must not announce a JSON one either.
    expect(seen.calls[2]?.body).toBeNull();
  });

  it('asks for the rows back, so a write does not need a second round trip', async () => {
    // Without `return=representation` a write answers 204 and the caller has to read
    // again to learn what it did, which is another round trip and another policy
    // evaluation of the same rows.
    const seen = recorder();
    const writer = createClient(BASE_URL, { fetch: seen.fetch });

    await writer.from('posts').insert({ id: 'p_y' });
    await writer.from('posts').select('id');

    expect(seen.calls[0]?.prefer).toBe('return=representation');
    // ⚠️ And a read must not send it. It means nothing there, and a header that
    // travels everywhere is one nobody can reason about.
    expect(seen.calls[1]?.prefer).toBeNull();
  });

  it('asks for the rows back on a delete too, which has no body to hang it on', async () => {
    // 🔴 This was wrong, and the authenticated test is what found it. Asking for the
    // rows back was tied to carrying a body, so a delete asked for nothing and came
    // back empty. A delete that reports what it removed is the only way a caller
    // learns whether the row was theirs, which is the whole answer on this path.
    const seen = recorder();
    const writer = createClient(BASE_URL, { fetch: seen.fetch });

    await writer.from('posts').eq('id', 'p_z').delete();

    expect(seen.calls[0]?.prefer).toBe('return=representation');
    // And still no content type, because there is still no body to describe.
    expect(seen.calls[0]?.body).toBeNull();
  });

  it('keeps the filters on an update, so it cannot become an unfiltered write', async () => {
    const builder = client.from('posts').eq('id', 'p_1').update({ title: 'b' });

    expect(builder.toURL()).toContain('id=eq.p_1');
  });
});

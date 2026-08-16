/**
 * Files, driven against the real storage path.
 *
 * The bucket, its policy and the prefix template are seeded here rather than mocked,
 * because what is being proved is that the client's requests are the ones the engine
 * accepts, and a stand-in would only prove they match my reading of it.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { resetAuth, runAuthMigrations } from '../src/auth/index.js';
import { applyEngineSchema } from '../src/db/bootstrap.js';
import { resetCatalogue } from '../src/db/introspect.js';
import worker, { type Env } from '../src/index.js';
import { resetStorageRegistry } from '../src/storage/registry.js';
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

/** Signed in, because the policy grants uploads to an identity rather than to anyone. */
let signedIn: ReturnType<typeof createClient>;

beforeAll(async () => {
  await applyEngineSchema(env.DB);
  await env.DB.prepare('DELETE FROM _storage_policies').run();
  await env.DB.prepare('DELETE FROM _storage_buckets').run();
  await env.DB.prepare('INSERT INTO _storage_buckets (bucket, enabled, version) VALUES (?, 1, 1)')
    .bind('avatars')
    .run();

  const insert = env.DB.prepare(
    'INSERT INTO _storage_policies (bucket, name, operation, roles, prefix, max_size_bytes,' +
      ' mime_types) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  await env.DB.batch([
    insert.bind('avatars', 'upload_own', 'upload', '["authenticated"]', 'avatars/$auth.uid/', 1024, '["image/png"]'),
    insert.bind('avatars', 'read_own', 'download', '["authenticated"]', 'avatars/$auth.uid/', null, null),
    insert.bind('avatars', 'delete_own', 'delete', '["authenticated"]', 'avatars/$auth.uid/', null, null),
  ]);

  resetCatalogue();
  resetStorageRegistry();
  resetAuth();
  await runAuthMigrations(configured);

  signedIn = createClient(BASE_URL, { fetch: intoWorker });
  const up = await signedIn.auth.signUp({
    email: 'pat@example.test',
    password: PASSWORD,
    name: 'Pat',
  });
  expect(up.error).toBeNull();
}, 120_000);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('storing a file', () => {
  it('⭐ hands back the key the server built, which the caller never chose', async () => {
    // The whole design in one assertion. The caller named a file; the key contains
    // their own id, resolved from the claim on their token, and it is the only way
    // they can address what they just uploaded.
    const { data, error } = await signedIn.storage
      .from('avatars')
      .upload('face.png', PNG, { contentType: 'image/png' });

    expect(error).toBeNull();
    expect(data?.key).toMatch(/^avatars\/.+\/face\.png$/);
    expect(data?.etag).not.toBe('');
  });

  it('reads it back', async () => {
    const { data, error } = await signedIn.storage.from('avatars').download('face.png');

    expect(error).toBeNull();
    expect(new Uint8Array(await (data as Response).arrayBuffer())).toEqual(PNG);
  });

  it('removes it, and removing it again is not an error', async () => {
    // ⚠️ The server's choice, not this client's. Answering differently the second
    // time would make delete a way to ask which keys exist.
    expect((await signedIn.storage.from('avatars').remove('face.png')).error).toBeNull();
    expect((await signedIn.storage.from('avatars').remove('face.png')).error).toBeNull();
  });
});

describe('what the client refuses before sending anything', () => {
  /**
   * ⚠️ Returned rather than thrown, and the rule is worth stating because the query
   * builder does the opposite. A builder method has no result object to put an error
   * in, so it throws; anything that returns a promise of `{ data, error }` puts it
   * there. Making one call site do both would mean every caller has to wrap AND
   * check. The first version of these tests expected a throw from an `async` method,
   * which is a rejected promise rather than a throw, and they failed as unhandled
   * errors instead of assertions.
   */
  it('refuses a file name with a slash, because the 404 would mislead', async () => {
    // The route takes exactly two segments, so `a/b.png` answers 404, and that reads
    // as "no such bucket" to somebody who was asking for a folder.
    const sent: string[] = [];
    const watching = createClient(BASE_URL, {
      fetch: (url, init) => {
        sent.push(url);
        return intoWorker(url, init);
      },
    });

    const { data, error } = await watching.storage.from('avatars').upload('a/b.png', PNG);

    expect(data).toBeNull();
    expect(error?.message).toMatch(/slash/);
    // The point of refusing here rather than there: nothing was sent.
    expect(sent).toEqual([]);
  });

  it('refuses an empty name', async () => {
    const { error } = await signedIn.storage.from('avatars').upload('', PNG);

    expect(error?.message).toMatch(/empty/);
  });

  it('refuses on download and remove too, not only on upload', async () => {
    // One check, three doors. A name that cannot be uploaded cannot be read or
    // deleted either, and a client that only guarded the write would send the other
    // two into the same misleading 404.
    expect((await signedIn.storage.from('avatars').download('a/b.png')).error).not.toBeNull();
    expect((await signedIn.storage.from('avatars').remove('a/b.png')).error).not.toBeNull();
  });
});

describe('what the engine refuses, reported rather than thrown', () => {
  it('says no to a file bigger than the policy allows', async () => {
    const tooBig = new Uint8Array(2048);
    const { data, error } = await signedIn.storage
      .from('avatars')
      .upload('big.png', tooBig, { contentType: 'image/png' });

    expect(data).toBeNull();
    expect(error?.status).toBe(413);
  });

  it('says no to a content type the policy does not list', async () => {
    // ⚠️ A declaration, not an inspection. These are the same bytes the accepted
    // upload used; only the label changed, and only the label is checked.
    const { data, error } = await signedIn.storage
      .from('avatars')
      .upload('note.txt', PNG, { contentType: 'text/plain' });

    expect(data).toBeNull();
    expect(error?.status).toBe(415);
  });

  it('refuses an anonymous upload the same way it refuses a missing bucket', async () => {
    // The policy grants uploads to an identity. Anonymous gets the not-found every
    // other refusal gives, so nobody can tell "no policy for you" from "no bucket".
    const anonymous = createClient(BASE_URL, { fetch: intoWorker });
    const { data, error } = await anonymous.storage
      .from('avatars')
      .upload('face.png', PNG, { contentType: 'image/png' });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
  });

  it('refuses a bucket nobody exposed, with the same answer', async () => {
    const { error } = await signedIn.storage
      .from('not-a-bucket')
      .upload('face.png', PNG, { contentType: 'image/png' });

    expect(error?.status).toBe(404);
  });
});

describe('the length, which the deployment requires', () => {
  it('declares it, so the deployment never has to answer 411', async () => {
    // 🔴 Without `content-length` the engine answers 411, because a size limit has
    // nothing to check against. A caller who never set a header would be told their
    // request was malformed, so the client sets it from the body it was handed.
    const sent: (string | null)[] = [];
    const watching = createClient(BASE_URL, {
      fetch: (url, init) => {
        sent.push(new Headers(init?.headers).get('content-length'));
        return intoWorker(url, init);
      },
    });

    await watching.auth.signUp({ email: 'quin@example.test', password: PASSWORD, name: 'Quin' });
    await watching.storage.from('avatars').upload('q.png', PNG, { contentType: 'image/png' });

    expect(sent.at(-1)).toBe(String(PNG.byteLength));
  });

  it('measures a string in bytes rather than in characters', async () => {
    // ⚠️ The one that is wrong by default. A five character string of accented text
    // is more than five bytes, and a length that disagrees with the body is refused
    // by the runtime rather than trimmed.
    const sent: (string | null)[] = [];
    const watching = createClient(BASE_URL, {
      fetch: (url, init) => {
        sent.push(new Headers(init?.headers).get('content-length'));
        return intoWorker(url, init);
      },
    });

    await watching.auth.signUp({ email: 'rosa@example.test', password: PASSWORD, name: 'Rosa' });
    await watching.storage.from('avatars').upload('r.txt', 'héllo', { contentType: 'image/png' });

    // Five characters, six bytes.
    expect(sent.at(-1)).toBe('6');
  });
});

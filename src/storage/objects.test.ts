/**
 * The D1 record of an object, and the two things about it that matter.
 *
 * One is that it exists at all: R2 is not in D1, so without these rows there is no
 * statement anybody can write that knows an object is there, and "join object
 * metadata with application data" is not a thing that can be expressed.
 *
 * The other is that it is never a permission. An object is reachable because a
 * storage policy resolved its key, not because a row here says who owns it, and the
 * tests below assert that the record can be wrong without the boundary moving.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthCtx } from '../policy/types.js';
import { BaseclfError } from '../utils/errors.js';
import { forgetObject, readObjectRecord, recordObject } from './objects.js';
import type { StorageBucketDefinition } from './policy.js';
import { deleteObject, downloadObject, type StorageContext, uploadObject } from './router.js';
import { STORAGE_SCHEMA } from './schema.js';

const ANN: AuthCtx = { role: 'authenticated', uid: 'u_ann', email: 'ann@test', app: {} };
const BOB: AuthCtx = { ...ANN, uid: 'u_bob', email: 'bob@test' };
const ANON: AuthCtx = { role: 'anon', uid: null, email: null, app: {} };

const AVATARS: StorageBucketDefinition = {
  bucket: 'avatars',
  enabled: true,
  policies: [
    {
      name: 'upload_own',
      for: 'upload',
      to: ['authenticated'],
      prefix: 'avatars/$auth.uid/',
      maxSizeBytes: 4096,
      allowedMimeTypes: ['image/png'],
    },
    { name: 'read_own', for: 'download', to: ['authenticated'], prefix: 'avatars/$auth.uid/' },
    { name: 'delete_own', for: 'delete', to: ['authenticated'], prefix: 'avatars/$auth.uid/' },
  ],
};

function context(overrides: Partial<StorageContext> = {}): StorageContext {
  return {
    bucket: env.BUCKET,
    db: env.DB,
    buckets: new Map([['avatars', AVATARS]]),
    auth: ANN,
    bucketName: 'avatars',
    fileName: 'me.png',
    ...overrides,
  };
}

function upload(bytes: number, type = 'image/png'): Request {
  return new Request('https://example.test/', {
    method: 'PUT',
    headers: { 'content-type': type, 'content-length': String(bytes) },
    body: new Uint8Array(bytes).fill(65),
  });
}

beforeEach(async () => {
  for (const statement of STORAGE_SCHEMA) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare('DELETE FROM _storage_objects').run();
  await env.BUCKET.delete('avatars/u_ann/me.png');
  await env.BUCKET.delete('avatars/u_bob/me.png');
});

describe('what SQL can see after an upload', () => {
  it('has a row it can join on, which is the whole point of the table', async () => {
    await uploadObject(context(), upload(64));

    const record = await readObjectRecord(env.DB, 'avatars/u_ann/me.png');
    expect(record).not.toBeNull();
    expect(record?.bucket).toBe('avatars');
    expect(record?.owner).toBe('u_ann');
    expect(record?.sizeBytes).toBe(64);
    expect(record?.contentType).toBe('image/png');
  });

  it('stamps its times from the database clock, as integers', async () => {
    // `unixepoch()` rather than `strftime('%s','now')`, and the reason is narrower
    // than it first looks. A mutation swapping one for the other survives, because
    // a STRICT table accepts a TEXT value that converts losslessly, so both spell
    // an integer into the column. Measured, `rules/01` §G8, which corrects §G7.
    //
    // What this test does establish is the part that matters either way: the clock
    // is the database's, so two colos cannot disagree about when an object was
    // written, and the value lands as an integer rather than as text.
    await uploadObject(context(), upload(16));
    const record = await readObjectRecord(env.DB, 'avatars/u_ann/me.png');

    expect(Number.isInteger(record?.createdAt)).toBe(true);
    expect(Number.isInteger(record?.updatedAt)).toBe(true);
    expect(record?.createdAt).toBeGreaterThan(1_700_000_000);
  });

  it('is joinable from an application table by key', async () => {
    // The requirement, written as the query an application would actually run.
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY NOT NULL, avatar_key TEXT)',
    ).run();
    await env.DB.prepare('DELETE FROM profiles').run();

    await uploadObject(context(), upload(32));
    await env.DB.prepare('INSERT INTO profiles (id, avatar_key) VALUES (?, ?)')
      .bind('u_ann', 'avatars/u_ann/me.png')
      .run();

    const joined = await env.DB.prepare(
      'SELECT p.id, o.size_bytes FROM profiles p' +
        ' JOIN _storage_objects o ON o.key = p.avatar_key WHERE p.id = ?',
    )
      .bind('u_ann')
      .first<{ id: string; size_bytes: number }>();

    expect(joined?.size_bytes).toBe(32);
  });

  it('records the identity that wrote last, not the one that created', async () => {
    // Under a prefix with a claim in it only one caller can reach a key, so this
    // is only visible with a shared prefix. Recording the first writer would be a
    // record of something no longer true: whoever wrote last owns the bytes.
    const shared: StorageBucketDefinition = {
      bucket: 'avatars',
      enabled: true,
      policies: [
        {
          name: 'shared',
          for: 'upload',
          to: ['authenticated'],
          prefix: 'avatars/',
          maxSizeBytes: 4096,
        },
      ],
    };
    const buckets = new Map([['avatars', shared]]);

    await uploadObject(context({ buckets, fileName: 'team.png' }), upload(8));
    expect((await readObjectRecord(env.DB, 'avatars/team.png'))?.owner).toBe('u_ann');

    await uploadObject(context({ buckets, auth: BOB, fileName: 'team.png' }), upload(16));
    const after = await readObjectRecord(env.DB, 'avatars/team.png');

    expect(after?.owner).toBe('u_bob');
    expect(after?.sizeBytes).toBe(16);

    await env.BUCKET.delete('avatars/team.png');
  });

  it('keeps created_at across an overwrite and moves updated_at', async () => {
    // created_at is backdated between the two writes, and a mutation is why. The
    // first version compared the two timestamps directly, which cannot detect
    // created_at being overwritten: the clock has one second of resolution and
    // both writes land inside the same second, so equal values prove nothing.
    // Setting a value no clock would produce makes the assertion mean what it says.
    await uploadObject(context(), upload(8));
    await env.DB.prepare('UPDATE _storage_objects SET created_at = ? WHERE key = ?')
      .bind(1_000_000_000, 'avatars/u_ann/me.png')
      .run();

    await uploadObject(context(), upload(64));
    const after = await readObjectRecord(env.DB, 'avatars/u_ann/me.png');

    expect(after?.createdAt).toBe(1_000_000_000);
    expect(after?.sizeBytes).toBe(64);
    expect(after?.updatedAt).toBeGreaterThan(1_000_000_000);
  });

  it('records nothing for an anonymous writer beyond a null owner', async () => {
    // A policy with a literal prefix needs no claim, so an anonymous upload has no
    // uid to record. Null rather than an empty string, so a query for "objects
    // with no owner" is expressible.
    const open: StorageBucketDefinition = {
      bucket: 'avatars',
      enabled: true,
      policies: [
        { name: 'open', for: 'upload', to: ['anon'], prefix: 'avatars/', maxSizeBytes: 4096 },
      ],
    };

    await uploadObject(
      context({ buckets: new Map([['avatars', open]]), auth: ANON, fileName: 'public.png' }),
      upload(8),
    );

    expect((await readObjectRecord(env.DB, 'avatars/public.png'))?.owner).toBeNull();
    await env.BUCKET.delete('avatars/public.png');
  });
});

describe('what SQL can see after a delete', () => {
  it('no longer has a row', async () => {
    await uploadObject(context(), upload(16));
    await deleteObject(context());

    expect(await readObjectRecord(env.DB, 'avatars/u_ann/me.png')).toBeNull();
  });

  it('forgets a key it never knew without complaining', async () => {
    // Delete must not report whether something existed, at the record level as
    // well as at the R2 level. Invariant I5 does not stop at the bucket.
    await expect(forgetObject(env.DB, 'avatars/u_ann/never.png')).resolves.toBeUndefined();
  });
});

describe('the record is not a permission', () => {
  it('does not make an object reachable when no policy resolves its key', async () => {
    // A row claiming Ann owns Bob's object changes nothing, because the boundary is
    // the policy resolving a key and not a row saying who owns one. If this ever
    // fails, the record has become a second permission system, and the weaker of
    // the two, because a row can be stale while a policy cannot.
    await env.BUCKET.put('avatars/u_bob/me.png', new Uint8Array(8));
    await recordObject(env.DB, {
      key: 'avatars/u_bob/me.png',
      bucket: 'avatars',
      auth: ANN,
      sizeBytes: 8,
      contentType: 'image/png',
    });

    // Ann asks for `me.png`, and her key resolves under her own prefix regardless
    // of what the record says.
    let thrown: unknown;
    try {
      await downloadObject(context());
    } catch (error) {
      thrown = error;
    }

    expect((thrown as BaseclfError).status).toBe(404);
    expect((await readObjectRecord(env.DB, 'avatars/u_bob/me.png'))?.owner).toBe('u_ann');
    expect((await env.BUCKET.head('avatars/u_bob/me.png'))?.size).toBe(8);
  });

  it('does not make an object unreachable when the row is missing', async () => {
    // The other direction. R2 is the truth and D1 follows it, so an object with no
    // record still downloads. Otherwise a failed record write would take away
    // access to bytes that are sitting right there.
    await env.BUCKET.put('avatars/u_ann/me.png', new Uint8Array(8), {
      httpMetadata: { contentType: 'image/png' },
    });
    expect(await readObjectRecord(env.DB, 'avatars/u_ann/me.png')).toBeNull();

    const response = await downloadObject(context());
    expect(response.status).toBe(200);
  });
});

describe('the ordering between R2 and D1', () => {
  it('writes no record when the bytes were refused', async () => {
    // Bytes first, row second. The other order would leave a record for an object
    // that does not exist, and then a join returns a row whose image is a 404.
    let thrown: unknown;
    try {
      await uploadObject(context({ fileName: 'toobig.png' }), upload(8192));
    } catch (error) {
      thrown = error;
    }

    expect((thrown as BaseclfError).status).toBe(413);
    expect(await readObjectRecord(env.DB, 'avatars/u_ann/toobig.png')).toBeNull();
  });

  it('writes no record when the caller lied about the size', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(new Uint8Array(1024).fill(65));
      },
    });

    const request = new Request('https://example.test/', {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'content-length': '5' },
      body,
      duplex: 'half',
    } as RequestInit);

    await expect(uploadObject(context({ fileName: 'lying.png' }), request)).rejects.toBeInstanceOf(
      BaseclfError,
    );
    expect(await readObjectRecord(env.DB, 'avatars/u_ann/lying.png')).toBeNull();
    expect(await env.BUCKET.head('avatars/u_ann/lying.png')).toBeNull();
  });
});

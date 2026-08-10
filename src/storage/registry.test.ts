/**
 * What the registry does with configuration it should not trust.
 *
 * A policy in the database is not a policy that was ever checked. It may have been
 * written before a rule existed, or straight in with `wrangler d1 execute`, which
 * bypasses every part of this engine. So the loader validates, and these tests are
 * about what it refuses rather than what it loads.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { BaseclfError } from '../utils/errors.js';
import { authorizeStorage } from './policy.js';
import { loadStorageRegistry } from './registry.js';
import { STORAGE_SCHEMA } from './schema.js';

const ANN = { role: 'authenticated', uid: 'u_ann', email: null, app: {} };

async function reset(): Promise<void> {
  for (const statement of STORAGE_SCHEMA) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare('DELETE FROM _storage_policies').run();
  await env.DB.prepare('DELETE FROM _storage_buckets').run();
}

async function addBucket(bucket: string, enabled: number): Promise<void> {
  await env.DB.prepare('INSERT INTO _storage_buckets (bucket, enabled, version) VALUES (?, ?, 1)')
    .bind(bucket, enabled)
    .run();
}

async function addPolicy(
  bucket: string,
  overrides: {
    name?: string;
    operation?: string;
    roles?: string;
    prefix?: string;
    maxSize?: number | null;
    mime?: string | null;
  } = {},
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO _storage_policies (bucket, name, operation, roles, prefix, max_size_bytes,' +
      ' mime_types) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      bucket,
      overrides.name ?? 'upload_own',
      overrides.operation ?? 'upload',
      overrides.roles ?? '["authenticated"]',
      overrides.prefix ?? 'avatars/$auth.uid/',
      overrides.maxSize ?? null,
      overrides.mime ?? null,
    )
    .run();
}

beforeEach(reset);

describe('an ordinary bucket', () => {
  it('loads, and its policy decides a key', async () => {
    await addBucket('avatars', 1);
    await addPolicy('avatars', { maxSize: 1024, mime: '["image/png"]' });

    const registry = await loadStorageRegistry(env.DB);
    const grant = authorizeStorage({
      buckets: registry.buckets,
      bucket: 'avatars',
      operation: 'upload',
      auth: ANN,
      fileName: 'me.png',
    });

    expect(grant.key).toBe('avatars/u_ann/me.png');
    expect(grant.maxSizeBytes).toBe(1024);
    expect(grant.allowedMimeTypes).toEqual(['image/png']);
  });

  it('reads a null limit as no limit, not as a limit of zero', async () => {
    // The reason both columns are nullable. A limit of zero would refuse every
    // upload, so the two have to be different things in the schema as well as in
    // the code.
    await addBucket('avatars', 1);
    await addPolicy('avatars');

    const registry = await loadStorageRegistry(env.DB);
    const grant = authorizeStorage({
      buckets: registry.buckets,
      bucket: 'avatars',
      operation: 'upload',
      auth: ANN,
      fileName: 'me.png',
    });

    expect(grant.maxSizeBytes).toBeUndefined();
    expect(grant.allowedMimeTypes).toBeUndefined();
  });
});

describe('configuration the loader must not trust', () => {
  it('refuses a stored policy that would be refused at save time', async () => {
    // Invariant I4 reaching the database anyway, which is the case that matters:
    // `validateStorageBucket` runs on the way in, but a row written with
    // `wrangler d1 execute` never went that way. Nothing else in the engine sits
    // between that row and a key being built from it.
    await addBucket('avatars', 1);
    await addPolicy('avatars', { prefix: 'avatars/$auth.user.folder/' });

    let thrown: unknown;
    try {
      await loadStorageRegistry(env.DB);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BaseclfError);
    expect((thrown as BaseclfError).detail).toContain('I4');
  });

  it('refuses a stored prefix with no trailing separator', async () => {
    await addBucket('avatars', 1);
    await addPolicy('avatars', { prefix: 'avatars/$auth.uid' });

    await expect(loadStorageRegistry(env.DB)).rejects.toBeInstanceOf(BaseclfError);
  });

  it('refuses an operation this engine does not have', async () => {
    // `operation` is a TEXT column, so the database will hold anything. The
    // narrowing in the loader is a cast, and this is the check that makes the cast
    // safe rather than a claim.
    await addBucket('avatars', 1);
    await addPolicy('avatars', { operation: 'list' });

    await expect(loadStorageRegistry(env.DB)).rejects.toBeInstanceOf(BaseclfError);
  });

  it('refuses roles that are not a list at all', async () => {
    await addBucket('avatars', 1);
    await addPolicy('avatars', { roles: '"authenticated"' });

    await expect(loadStorageRegistry(env.DB)).rejects.toBeInstanceOf(BaseclfError);
  });

  it('refuses a list whose entries are not roles', async () => {
    // A mutation is why this is separate from the test above. Removing the
    // element check left that one passing, because a JSON string is caught by the
    // array check on its own.
    //
    // This one is not about safety: `to.includes('authenticated')` is false for a
    // list of numbers, so such a policy grants nothing and the engine is closed
    // either way. It is about failing loudly. A policy that silently grants
    // nothing is exactly the shape this project refuses everywhere else, because
    // whoever wrote it believes it works.
    await addBucket('avatars', 1);
    await addPolicy('avatars', { roles: '[1, 2]' });

    await expect(loadStorageRegistry(env.DB)).rejects.toBeInstanceOf(BaseclfError);
  });

  it('drops a bucket whose name could never be addressed', async () => {
    // Dropped rather than thrown on, and the reasoning is the policy registry's:
    // throwing would let one bad row take every other bucket down with it, turning
    // a misconfiguration into an outage. It is logged instead.
    await addBucket('../evil', 1);
    await addBucket('avatars', 1);
    await addPolicy('avatars');

    const registry = await loadStorageRegistry(env.DB);

    expect(registry.buckets.has('../evil')).toBe(false);
    expect(registry.buckets.has('avatars')).toBe(true);
  });

  it('drops a bucket named with an uppercase letter, which a path could not match', async () => {
    await addBucket('Avatars', 1);

    expect((await loadStorageRegistry(env.DB)).buckets.has('Avatars')).toBe(false);
  });
});

describe('a disabled bucket', () => {
  it('is registered but refuses everything', async () => {
    await addBucket('avatars', 0);
    await addPolicy('avatars');

    const registry = await loadStorageRegistry(env.DB);

    // Present in the map, so the refusal says "disabled" in the log rather than
    // "unknown". The caller cannot tell the difference, which is invariant I5.
    expect(registry.buckets.has('avatars')).toBe(true);

    let thrown: unknown;
    try {
      authorizeStorage({
        buckets: registry.buckets,
        bucket: 'avatars',
        operation: 'upload',
        auth: ANN,
        fileName: 'me.png',
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as BaseclfError).status).toBe(404);
    expect((thrown as BaseclfError).detail).toContain('not enabled');
  });

  it('loads even when its policies would not validate', async () => {
    // A switched-off bucket is configuration rather than a mistake, and its
    // policies may reference a token that is no longer supported. Validating it
    // would turn one disabled bucket into a failure for every other one.
    await addBucket('avatars', 0);
    await addPolicy('avatars', { prefix: 'avatars/$auth.user.folder/' });
    await addBucket('working', 1);
    await addPolicy('working', { prefix: 'working/$auth.uid/' });

    const registry = await loadStorageRegistry(env.DB);

    expect(registry.buckets.has('avatars')).toBe(true);
    expect(registry.buckets.has('working')).toBe(true);
  });
});

describe('a bucket with no policies at all', () => {
  it('loads and refuses every operation', async () => {
    // The fail-closed case at the registry level: a bucket row with nothing
    // granting anything is not a bucket that grants everything.
    await addBucket('empty', 1);

    const registry = await loadStorageRegistry(env.DB);
    expect(registry.buckets.get('empty')?.policies).toEqual([]);

    for (const operation of ['upload', 'download', 'delete'] as const) {
      expect(() =>
        authorizeStorage({
          buckets: registry.buckets,
          bucket: 'empty',
          operation,
          auth: ANN,
          fileName: 'me.png',
        }),
      ).toThrow(BaseclfError);
    }
  });
});

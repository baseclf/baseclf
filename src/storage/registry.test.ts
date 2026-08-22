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
import { MAX_REGISTRY_AGE_MS } from '../utils/memo.js';
import { authorizeStorage } from './policy.js';
import {
  getStorageRegistry,
  loadStorageRegistry,
  resetStorageRegistry,
  setStorageRegistryClock,
} from './registry.js';
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

describe('the memo behind getStorageRegistry', () => {
  it('recovers once a bad row is repaired, rather than refusing until the isolate recycles', async () => {
    // 🔴 The same shape as debt F4 next door, and it arrived here by the file above
    // saying it copied the policy registry deliberately. It copied this too, and the
    // note it left was only about F2, so nothing pointed at it.
    //
    // Fail-closed, so storage refused rather than allowed. What it meant is that an
    // operator who fixed the row watched storage stay broken with no way to end it.
    resetStorageRegistry();

    await env.DB.prepare('INSERT INTO _storage_buckets (bucket, enabled, version) VALUES (?, 1, 1)')
      .bind('avatars')
      .run();
    await env.DB.prepare(
      'INSERT INTO _storage_policies (bucket, name, operation, roles, prefix,' +
        ' max_size_bytes, mime_types) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind('avatars', 'own', 'upload', '{not json', 'avatars/$auth.uid/', null, null)
      .run();

    await expect(getStorageRegistry(env.DB)).rejects.toThrow();

    await env.DB.prepare('DELETE FROM _storage_policies WHERE bucket = ?').bind('avatars').run();
    await env.DB.prepare(
      'INSERT INTO _storage_policies (bucket, name, operation, roles, prefix,' +
        ' max_size_bytes, mime_types) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        'avatars',
        'own',
        'upload',
        JSON.stringify(['authenticated']),
        'avatars/$auth.uid/',
        null,
        null,
      )
      .run();

    const registry = await getStorageRegistry(env.DB);
    expect(registry.buckets.has('avatars')).toBe(true);

    // And it is a memo again rather than a reload every time.
    expect(await getStorageRegistry(env.DB)).toBe(registry);
  });

  it('drops a bucket on its own once the window closes', async () => {
    // ⭐ The storage half of debt F2, which the file's own comment said it had copied
    // from the policy registry on purpose. Nothing here resets anything: an isolate
    // nobody told still stops serving a bucket that was removed.
    let now = 7_000_000;
    setStorageRegistryClock(() => now);

    try {
      resetStorageRegistry();
      await addBucket('avatars', 1);
      await addPolicy('avatars');

      expect((await getStorageRegistry(env.DB)).buckets.has('avatars')).toBe(true);

      await env.DB.prepare('DELETE FROM _storage_policies WHERE bucket = ?').bind('avatars').run();
      await env.DB.prepare('DELETE FROM _storage_buckets WHERE bucket = ?').bind('avatars').run();

      now += MAX_REGISTRY_AGE_MS - 1;
      expect((await getStorageRegistry(env.DB)).buckets.has('avatars')).toBe(true);

      now += 1;
      expect((await getStorageRegistry(env.DB)).buckets.has('avatars')).toBe(false);
    } finally {
      setStorageRegistryClock();
    }
  });
});

/**
 * The two statements the README prints, run as printed.
 *
 * There is no `baseclf storage` command yet, so the README tells an operator to
 * insert these rows directly, and a README that prints SQL nobody ran is how
 * this project shipped a quickstart whose sample table had no rows in it. The
 * literal text is pasted here rather than built from the helpers above: a
 * helper that drifted would keep this passing while the printed version broke.
 */
describe('the SQL the README tells an operator to run', () => {
  it('exposes a per-tenant directory, exactly as printed', async () => {
    await env.DB.prepare(
      "INSERT INTO _storage_buckets (bucket, enabled) VALUES ('files', 1)",
    ).run();
    await env.DB.prepare(
      'INSERT INTO _storage_policies (bucket, name, operation, roles, prefix)' +
        " VALUES ('files', 'tenant_files', 'download', '[\"authenticated\"]', 'files/$auth.app.tenant/')",
    ).run();

    const registry = await loadStorageRegistry(env.DB);
    const grant = authorizeStorage({
      buckets: registry.buckets,
      bucket: 'files',
      operation: 'download',
      auth: { ...ANN, app: { tenant: 'acme' } },
      fileName: 'report.pdf',
    });

    expect(grant.key).toBe('files/acme/report.pdf');

    // And the claim is what separates them, not the caller's own id.
    const other = authorizeStorage({
      buckets: registry.buckets,
      bucket: 'files',
      operation: 'download',
      auth: { ...ANN, app: { tenant: 'globex' } },
      fileName: 'report.pdf',
    });
    expect(other.key).toBe('files/globex/report.pdf');
  });

  it('grants nothing when only the policy row is inserted', async () => {
    // The reason the README prints both statements. A policy on a bucket that
    // is not registered is not a narrower grant, it is no grant at all.
    await env.DB.prepare(
      'INSERT INTO _storage_policies (bucket, name, operation, roles, prefix)' +
        " VALUES ('files', 'tenant_files', 'download', '[\"authenticated\"]', 'files/$auth.app.tenant/')",
    ).run();

    const registry = await loadStorageRegistry(env.DB);
    expect(registry.buckets.has('files')).toBe(false);
  });
});

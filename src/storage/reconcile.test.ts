/**
 * The reconciliation pass, tested for what it must never do first.
 *
 * This is the only job in the engine that deletes rows on the strength of what it
 * read a moment earlier, and it does so with nobody watching. So the tests are
 * ordered the way the risk is: the safety properties come first and the useful
 * behaviour second, because a pass that repairs nothing is an inconvenience and a
 * pass that deletes the wrong thing is a customer's data.
 *
 * Four properties are worth more than the rest, and each has a test that fails if
 * the brake described in `reconcile.ts` is removed:
 *
 *   1. **No object is ever deleted.** The fake bucket throws if `delete` is
 *      called at all, so this is asserted by every test in the file rather than by
 *      one of them.
 *   2. **A row is only removed after a direct read agrees.** A listing is a bulk
 *      answer and can be wrong; `head()` is a point read of the one key being
 *      decided about.
 *   3. **Nothing inside the grace period is touched**, in either direction.
 *   4. **One invocation repairs at most `maxVerifications` rows**, so even a total
 *      misreading of the bucket is bounded.
 *
 * The bucket is a fake rather than the R2 binding, deliberately. Real R2 cannot be
 * made to answer a listing that disagrees with a point read, and that disagreement
 * is the case property 2 exists for. What real R2 does is measured next door in
 * `r2-list-behaviour.test.ts`, which is where the paging and `uploaded` semantics
 * this file assumes were established.
 */

import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  describeSweep,
  reconcileStorage,
  type StorageSweepReport,
  sweepFoundDrift,
} from './reconcile.js';
import { STORAGE_SCHEMA } from './schema.js';

interface Bindings {
  readonly DB: D1Database;
}

const db = (env as unknown as Bindings).DB;

/** Its own prefix, so nothing here depends on what another suite left behind. */
const PREFIX = 'sweep/';

const key = (n: number): string => `${PREFIX}${String(n).padStart(3, '0')}.bin`;

interface FakeObject {
  readonly key: string;
  /** Seconds in the past. The sweep compares this against the grace period. */
  readonly uploadedSecondsAgo: number;
  readonly size?: number;
}

/**
 * A bucket that answers listings and point reads from two separate sets.
 *
 * Two sets rather than one, because the whole point of the direct read is that it
 * can disagree with the listing. `present` is what `head()` finds; `listed` is
 * what `list()` reports. In normal operation they are the same, and a test that
 * makes them differ is testing the brake.
 */
function fakeBucket(listed: readonly FakeObject[], present?: readonly string[]) {
  const heads = new Set(present ?? listed.map((object) => object.key));
  const sorted = [...listed].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const listCalls: R2ListOptions[] = [];
  const headCalls: string[] = [];

  const bucket = {
    list(options: R2ListOptions = {}) {
      listCalls.push(options);
      const after = options.startAfter ?? '';
      const page = sorted
        .filter((object) => object.key > after)
        .slice(0, options.limit ?? sorted.length)
        .map((object) => ({
          key: object.key,
          size: object.size ?? 1,
          uploaded: new Date(Date.now() - object.uploadedSecondsAgo * 1_000),
        }));

      return Promise.resolve({ objects: page, truncated: false, delimitedPrefixes: [] });
    },

    head(name: string) {
      headCalls.push(name);
      return Promise.resolve(heads.has(name) ? { key: name, size: 1 } : null);
    },

    delete() {
      // Asserted by every test in this file at once. Bytes are the one thing this
      // pass may never touch, and the reasoning is at the top of `reconcile.ts`:
      // it cannot tell an object the engine wrote from one an operator put in the
      // bucket by hand, and a wrong deletion is unrecoverable.
      throw new Error('the sweep deleted an object, which it must never do');
    },
  };

  return { bucket: bucket as unknown as R2Bucket, listCalls, headCalls };
}

/** Insert a record, with `updated_at` backdated so its age is controllable. */
async function record(name: string, secondsAgo = 0): Promise<void> {
  await db
    .prepare(
      'INSERT OR REPLACE INTO _storage_objects' +
        ' (key, bucket, owner, size_bytes, content_type, created_at, updated_at)' +
        ' VALUES (?1, ?2, NULL, 1, NULL, unixepoch() - ?3, unixepoch() - ?3)',
    )
    .bind(name, 'sweep', secondsAgo)
    .run();
}

async function recordedKeys(): Promise<string[]> {
  const result = await db
    .prepare('SELECT key FROM _storage_objects WHERE key LIKE ?1 ORDER BY key')
    .bind(`${PREFIX}%`)
    .all<{ key: string }>();

  return result.results.map((row) => row.key);
}

const sweep = (
  bucket: R2Bucket,
  options: Parameters<typeof reconcileStorage>[2] = {},
): Promise<StorageSweepReport> =>
  reconcileStorage(bucket, db as never, { graceSeconds: 1, ...options });

beforeAll(async () => {
  for (const statement of STORAGE_SCHEMA) await db.prepare(statement).run();
});

afterEach(async () => {
  await db.prepare('DELETE FROM _storage_objects WHERE key LIKE ?1').bind(`${PREFIX}%`).run();
  await db.prepare('DELETE FROM _storage_sweep').run();
});

describe('a deployment that has no storage tables', () => {
  it('looks at nothing and says so, rather than throwing every hour', async () => {
    // Nothing outside the tests applies STORAGE_SCHEMA yet, so this is the state
    // every deployment is actually in. Throwing here would put an exception in
    // the log hourly, on every one of them, for a condition this pass cannot fix
    // and `doctor` already reports.
    const prepared: string[] = [];
    const bare = {
      prepare(sql: string) {
        prepared.push(sql);
        return {
          bind: () => ({
            all: () => Promise.resolve({ results: [] }),
            first: () => Promise.resolve(null),
            run: () => Promise.resolve({}),
          }),
          // ⚠️ `_storage_buckets` is in the list and `_storage_objects` is not,
          // which is a partial migration and a state a deployment can really be
          // in. It is here because a mutation survived without it: a check that
          // matched the prefix `_storage` would find this and decide the table was
          // there. Invariant I6 says exact, whole-name matching, and with
          // double-quoted string literals on in D1 a table that is not there does
          // not announce itself.
          all: () =>
            Promise.resolve({
              results: [{ name: '_rate_limit' }, { name: '_storage_buckets' }, { name: 'user' }],
            }),
        };
      },
    };

    const { bucket } = fakeBucket([]);
    const report = await reconcileStorage(bucket, bare as never);

    expect(report.ran).toBe(false);
    // Only the question was asked. No state table was created, and the bucket was
    // never listed, so a deployment with no storage is left exactly as found.
    expect(prepared).toEqual(['PRAGMA table_list']);
  });

  it('is not reported as drift, because nothing was looked at', async () => {
    // Counters set on purpose, and they make this a test of the guard rather than
    // of the zeros around it. A skipped report has zeros today, so a version that
    // checked only the counters would pass this with the guard deleted; the state
    // below cannot occur, and that is what makes it able to tell the two apart.
    const report = {
      ran: false,
      orphanedObjectCount: 5,
      recordsRemoved: 2,
      recordsContradicted: 0,
      recordsDeferred: 0,
    } as StorageSweepReport;

    expect(sweepFoundDrift(report)).toBe(false);
  });

  it('describes itself as skipped rather than as a clean pass', async () => {
    // A row of zeros reads as "checked, all fine". It was not checked.
    const report = { ran: false } as StorageSweepReport;
    expect(describeSweep(report)).toContain('skipped');
  });
});

describe('the things this pass must never do', () => {
  it('keeps a row whose object a direct read finds, even when the listing missed it', async () => {
    // The brake that stops a bad listing cascading. If list() ever returned an
    // empty page for a bucket that is not empty, every candidate it produced would
    // be contradicted here and nothing at all would be removed.
    await record(key(1), 3_600);
    const { bucket, headCalls } = fakeBucket([], [key(1)]);

    const report = await sweep(bucket);

    expect(report.recordsRemoved).toBe(0);
    expect(report.recordsContradicted).toBe(1);
    expect(headCalls).toContain(key(1));
    expect(await recordedKeys()).toEqual([key(1)]);
  });

  it('leaves a row alone while it is still inside the grace period', async () => {
    // An upload writes bytes and then the row, so a row younger than the grace
    // period may belong to bytes this listing was taken before.
    await record(key(1), 0);
    const { bucket } = fakeBucket([]);

    const report = await sweep(bucket, { graceSeconds: 3_600 });

    expect(report.recordsRemoved).toBe(0);
    expect(await recordedKeys()).toEqual([key(1)]);
  });

  it('removes no more than maxVerifications rows in one invocation', async () => {
    // The blast radius, and it bounds every failure mode including ones nobody
    // has thought of. Even a total misreading of the bucket costs this many rows.
    for (let n = 1; n <= 10; n += 1) await record(key(n), 3_600);
    const { bucket } = fakeBucket([]);

    const report = await sweep(bucket, { maxVerifications: 3 });

    expect(report.recordsRemoved).toBe(3);
    expect(report.recordsDeferred).toBeGreaterThan(0);
    expect(await recordedKeys()).toHaveLength(7);
  });

  it('changes nothing at all when repair is off', async () => {
    await record(key(1), 3_600);
    const { bucket } = fakeBucket([]);

    const report = await sweep(bucket, { repair: false });

    expect(await recordedKeys()).toEqual([key(1)]);
    // And the resume point is untouched, or a diagnostic would quietly skip the
    // cron past a stretch of the bucket nobody knew had been passed over.
    const state = await db.prepare('SELECT after_key FROM _storage_sweep').first();
    expect(state).toBeNull();
    expect(report.ran).toBe(true);
  });
});

describe('a row for bytes that are gone', () => {
  it('is removed once it is older than the grace period', async () => {
    await record(key(1), 3_600);
    await record(key(2), 3_600);
    const { bucket } = fakeBucket([{ key: key(2), uploadedSecondsAgo: 3_600 }]);

    const report = await sweep(bucket);

    expect(report.recordsRemoved).toBe(1);
    expect(await recordedKeys()).toEqual([key(2)]);
  });

  it('is examined even when it sorts past every object in the bucket', async () => {
    // Without the unbounded tail read, deleting the last objects from a bucket
    // would leave their rows unreachable by any pass, forever.
    await record(key(9), 3_600);
    const { bucket } = fakeBucket([{ key: key(1), uploadedSecondsAgo: 3_600 }]);
    await record(key(1), 3_600);

    const report = await sweep(bucket);

    expect(report.recordsRemoved).toBe(1);
    expect(await recordedKeys()).toEqual([key(1)]);
  });
});

describe('bytes with no row', () => {
  it('are counted and sampled, and left exactly where they are', async () => {
    // Reported, never repaired. This pass cannot tell an object the engine wrote
    // from one an operator uploaded by hand, and the row it would have to invent
    // would have to claim the object has no owner.
    const { bucket } = fakeBucket([{ key: key(1), uploadedSecondsAgo: 3_600, size: 40 }]);

    const report = await sweep(bucket);

    expect(report.orphanedObjectCount).toBe(1);
    expect(report.orphanedObjectBytes).toBe(40);
    expect(report.orphanedObjectSample[0]?.key).toBe(key(1));
    expect(report.recordsRemoved).toBe(0);
  });

  it('is not counted while it is still inside the grace period', async () => {
    const { bucket } = fakeBucket([{ key: key(1), uploadedSecondsAgo: 0 }]);

    const report = await sweep(bucket, { graceSeconds: 3_600 });

    expect(report.orphanedObjectCount).toBe(0);
  });
});

describe('walking a bucket over several invocations', () => {
  it('carries on from where it stopped rather than starting over', async () => {
    for (let n = 1; n <= 6; n += 1) await record(key(n), 3_600);
    const objects = Array.from({ length: 6 }, (_, n) => ({
      key: key(n + 1),
      uploadedSecondsAgo: 3_600,
    }));

    const first = await fakeBucket(objects);
    const one = await sweep(first.bucket, { maxPages: 1, pageSize: 2 });

    expect(one.walkComplete).toBe(false);
    expect(one.resumeAfterKey).toBe(key(2));

    const second = await fakeBucket(objects);
    await sweep(second.bucket, { maxPages: 1, pageSize: 2 });

    // The second invocation asked R2 to start past what the first one covered.
    expect(second.listCalls[0]?.startAfter).toBe(key(2));
  });

  it('counts a pass only when it reached the end of the bucket', async () => {
    const { bucket } = fakeBucket([{ key: key(1), uploadedSecondsAgo: 3_600 }]);
    await record(key(1), 3_600);

    const report = await sweep(bucket);

    expect(report.walkComplete).toBe(true);
    expect(report.passes).toBe(1);
    // Back to the start of the key space, so the next run walks it again.
    expect(report.resumeAfterKey).toBe('');
  });
});

describe('the log line this produces', () => {
  it('names no key, because a key holds a uid and so names a person', async () => {
    // Invariant I9, and the same argument log.ts makes about uploads. The keys are
    // in the returned report, for a diagnostic with an operator in front of it.
    await record(key(1), 3_600);
    const { bucket } = fakeBucket([{ key: key(2), uploadedSecondsAgo: 3_600 }]);

    const report = await sweep(bucket);
    const line = describeSweep(report);

    expect(sweepFoundDrift(report)).toBe(true);
    expect(line).not.toContain(PREFIX);
    expect(line).not.toContain(key(1));
    expect(line).not.toContain(key(2));
  });
});

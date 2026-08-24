/**
 * What a reconciliation pass has to work with, measured before any of it is designed.
 *
 * R2 is the truth and D1 follows it, so the two can disagree: an upload that fails
 * between the two writes leaves an object with no row, and a delete that fails
 * between them leaves a row for bytes that are gone. Deciding what to do about
 * that needs answers about `list()` that `rules/01` §F does not have, and the
 * answers change the design rather than decorate it:
 *
 *   1. Does `list()` page, and can a pass resume where it stopped? A sweep that
 *      cannot resume is a sweep that has to finish inside one invocation.
 *   2. What is the real ceiling on `limit`? It decides how many R2 calls and how
 *      many D1 statements one pass costs, against a Free-plan budget of 50
 *      queries per invocation (`rules/01` §B).
 *   3. Are keys ordered? A range-bounded comparison against D1 is only possible
 *      if a page is a contiguous key range.
 *   4. Does a listed object carry `uploaded`, and is it usable as an age? This is
 *      the one that decides whether an in-flight upload can be told apart from an
 *      orphan. Without it, a sweep that deletes bytes deletes files people are
 *      uploading right now.
 *
 * Probes rather than tests of our code, and they stay in the suite for the reason
 * the D1 and R2 probes did: the platform changes, and an assumption nobody
 * re-checks is the kind that breaks quietly.
 *
 * ⚠️ Measured against R2 and D1 LOCAL, through miniflare, not against a remote
 * bucket. Same caveat as `rules/01` §F1 and §G7, and it is a real one: a paging
 * ceiling is exactly the kind of thing an emulator can be more generous about.
 */

import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STORAGE_SCHEMA } from './schema.js';

interface Bindings {
  readonly BUCKET: R2Bucket;
  readonly DB: D1Database;
}

const bucket = (env as unknown as Bindings).BUCKET;
const db = (env as unknown as Bindings).DB;

/** Its own prefix, so nothing here depends on what another suite left behind. */
const PREFIX = 'probe-list/';

const KEYS = Array.from({ length: 12 }, (_, n) => `${PREFIX}${String(n).padStart(3, '0')}.bin`);

async function listedKeys(options?: R2ListOptions): Promise<string[]> {
  const page = await bucket.list(options);
  return page.objects.map((object) => object.key);
}

describe('R2 list() in this environment', () => {
  beforeAll(async () => {
    for (const key of KEYS) await bucket.put(key, 'x');
  });

  afterAll(async () => {
    for (const key of KEYS) await bucket.delete(key);
  });

  it('returns keys in lexicographic order', async () => {
    // The property a range-bounded comparison depends on. If a page were unordered,
    // "every row between the first and last key of this page" would not describe the
    // page, and the D1 side would have to fetch the whole table instead.
    const keys = await listedKeys({ prefix: PREFIX });

    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual(KEYS);
  });

  it('narrows to a prefix, which is what scopes a pass to one logical bucket', async () => {
    const inside = await listedKeys({ prefix: PREFIX });
    const outside = await listedKeys({ prefix: 'probe-list-nothing-here/' });

    expect(inside).toHaveLength(KEYS.length);
    expect(outside).toHaveLength(0);
  });

  it('pages with a cursor, and reports truncation', async () => {
    // The answer to whether a pass can resume. Without a cursor a sweep would have
    // to finish inside one invocation or start over, and starting over is how a
    // large bucket never gets past its first page.
    const first = await bucket.list({ prefix: PREFIX, limit: 5 });

    expect(first.objects).toHaveLength(5);
    expect(first.truncated).toBe(true);

    expect(typeof (first.truncated ? first.cursor : null)).toBe('string');

    const second = await bucket.list({
      prefix: PREFIX,
      limit: 5,
      ...(first.truncated ? { cursor: first.cursor } : {}),
    });
    expect(second.objects.map((object) => object.key)).toEqual(KEYS.slice(5, 10));

    const third = await bucket.list({
      prefix: PREFIX,
      limit: 5,
      ...(second.truncated ? { cursor: second.cursor } : {}),
    });
    expect(third.objects.map((object) => object.key)).toEqual(KEYS.slice(10));
    expect(third.truncated).toBe(false);
  });

  it('⭐ keeps a cursor inside the prefix it is given, which decides whether paging can be exposed', async () => {
    // Not a reconciliation question. A sweep makes both calls itself and has no
    // reason to mix prefixes; this was asked because debt 59 wanted to expose paging
    // to a caller, and a cursor is an opaque token the caller would hand back.
    //
    // 🔴 If a cursor carried an absolute position and overrode the prefix, a caller
    // holding one from their own directory could page into somebody else's, and the
    // whole storage model rests on a caller never being able to name a directory.
    //
    // ⭐ It holds here, and the listing API still does not expose a cursor. This runs
    // against miniflare, and for a question of this shape a local pass is weak
    // evidence while a local failure would have been decisive: an emulator is free
    // to be stricter than the service. So paging resumes from `startAfter` with a
    // file name the caller already holds, re-scoped by prefixing it here, and the
    // answer below stops deciding anything. Kept because it is the assertion that
    // would notice somebody exposing the cursor later.
    const other = 'probe-list-other/';
    const otherKeys = [`${other}aaa.bin`, `${other}bbb.bin`];
    for (const key of otherKeys) await bucket.put(key, 'x');

    try {
      const first = await bucket.list({ prefix: PREFIX, limit: 5 });
      expect(first.truncated).toBe(true);

      // The cursor belongs to PREFIX. Hand it back with a different prefix.
      const crossed = await bucket.list({
        prefix: other,
        ...(first.truncated ? { cursor: first.cursor } : {}),
      });

      // Every key it returns must still be inside the prefix asked for. Asserted as
      // a property rather than an exact list, because what a mismatched cursor does
      // to the *starting point* is R2's business; what it may not do is leave the
      // prefix.
      for (const object of crossed.objects) {
        expect(object.key.startsWith(other)).toBe(true);
      }
    } finally {
      for (const key of otherKeys) await bucket.delete(key);
    }
  });

  it('treats startAfter as exclusive, so a pass can resume from a key alone', async () => {
    // A second way to resume, and the one that survives a cursor being unusable
    // across invocations. A cursor is an opaque token with no documented lifetime;
    // a key is a key.
    const keys = await listedKeys({ prefix: PREFIX, startAfter: KEYS[4] ?? '', limit: 3 });

    expect(keys).toEqual(KEYS.slice(5, 8));
  });

  it('reports what the ceiling on limit actually is', async () => {
    // The number that decides how many calls a pass costs. Recorded either way,
    // because a refusal and a silent clamp are different failures: one is caught at
    // the call site, the other quietly halves a sweep's progress per invocation.
    let overCeiling = '';
    try {
      const page = await bucket.list({ prefix: PREFIX, limit: 1001 });
      overCeiling = `accepted, returned ${page.objects.length}`;
    } catch (error) {
      overCeiling = `refused: ${(error as Error).message}`;
    }

    const atCeiling = await bucket.list({ prefix: PREFIX, limit: 1000 });

    console.log(`  list({ limit: 1000 }) -> ${atCeiling.objects.length} objects`);
    console.log(`  list({ limit: 1001 }) -> ${overCeiling}`);

    // Whatever the ceiling is, 1000 must be usable: it is the page size the design
    // below budgets against.
    expect(atCeiling.objects).toHaveLength(KEYS.length);
    expect(overCeiling).not.toBe('');
  });

  it('⭐ gives every listed object an `uploaded` Date, which is the only defence against deleting a live upload', async () => {
    // The finding the whole design turns on.
    //
    // An object that was written a moment ago and whose row has not been written yet
    // is indistinguishable from an object whose row will never be written. The only
    // thing that tells them apart is age, and this is where age comes from. Without
    // it, a sweep that removes orphaned bytes removes files people are uploading.
    const before = Date.now();
    await bucket.put(`${PREFIX}fresh.bin`, 'x');

    const page = await bucket.list({ prefix: `${PREFIX}fresh` });
    const object = page.objects[0];

    expect(object).toBeDefined();
    expect(object?.uploaded).toBeInstanceOf(Date);

    const uploaded = object?.uploaded.getTime() ?? 0;
    console.log(`  uploaded=${uploaded} now=${Date.now()} skew=${uploaded - before}ms`);

    // Within a generous window of the call that created it, in both directions. A
    // clock that runs ahead would make a fresh object look old, which is the
    // direction that loses data.
    expect(uploaded).toBeGreaterThan(before - 60_000);
    expect(uploaded).toBeLessThan(Date.now() + 60_000);

    await bucket.delete(`${PREFIX}fresh.bin`);
  });

  it('carries size and etag on a listed object, so a pass needs no second call per key', async () => {
    const page = await bucket.list({ prefix: PREFIX, limit: 1 });
    const object = page.objects[0];

    expect(object?.size).toBe(1);
    expect(typeof object?.etag).toBe('string');
  });

  it('drops a deleted key from the listing immediately', async () => {
    // A sweep reads the listing and then acts on it. If a delete were not visible
    // straight away, a pass would keep rediscovering work it had already done.
    const key = `${PREFIX}transient.bin`;
    await bucket.put(key, 'x');
    expect(await listedKeys({ prefix: `${PREFIX}transient` })).toEqual([key]);

    await bucket.delete(key);
    expect(await listedKeys({ prefix: `${PREFIX}transient` })).toEqual([]);
  });
});

/**
 * What the D1 half of a pass costs.
 *
 * D1 bills rows scanned rather than rows returned (`rules/01` §D), so the question
 * is not how many rows come back but how many the statement touches. A pass that
 * reads the whole table on every page is a full scan multiplied by the number of
 * pages, which is the difference between a job that costs nothing and one that
 * shows up on an invoice.
 */
describe('what a reconciliation statement costs in D1', () => {
  const ROWS = 200;

  beforeAll(async () => {
    for (const statement of STORAGE_SCHEMA) await db.prepare(statement).run();
    await db.prepare('DELETE FROM _storage_objects').run();

    // One batch rather than 200 round trips.
    await db.batch(
      Array.from({ length: ROWS }, (_, n) =>
        db
          .prepare(
            'INSERT INTO _storage_objects' +
              ' (key, bucket, owner, size_bytes, content_type, created_at, updated_at)' +
              ' VALUES (?1, ?2, NULL, 1, NULL, unixepoch(), unixepoch())',
          )
          .bind(`${PREFIX}${String(n).padStart(4, '0')}.bin`, 'probe'),
      ),
    );
  });

  afterAll(async () => {
    await db.prepare('DELETE FROM _storage_objects').run();
  });

  it('reports rows_read, without which none of this is measurable', async () => {
    const result = await db.prepare('SELECT key FROM _storage_objects').all();
    const rowsRead = (result.meta as { rows_read?: number } | undefined)?.rows_read;

    console.log(`  full scan of ${ROWS} rows -> rows_read=${String(rowsRead)}`);
    expect(typeof rowsRead).toBe('number');
  });

  it('⭐ scans a key range rather than the table when the range is bounded', async () => {
    // The reason a pass walks R2 in key order. A page of R2 keys is a contiguous
    // range, so the rows that could correspond to it are a range too, and the
    // primary key index turns "which rows belong to this page" into a seek instead
    // of a scan.
    const from = `${PREFIX}0000.bin`;
    const to = `${PREFIX}0009.bin`;

    const ranged = await db
      .prepare('SELECT key FROM _storage_objects WHERE key >= ?1 AND key <= ?2')
      .bind(from, to)
      .all();
    const whole = await db.prepare('SELECT key FROM _storage_objects').all();

    const rangedRead = (ranged.meta as { rows_read?: number } | undefined)?.rows_read ?? -1;
    const wholeRead = (whole.meta as { rows_read?: number } | undefined)?.rows_read ?? -1;

    console.log(
      `  10 of ${ROWS} rows: ranged rows_read=${rangedRead}, full rows_read=${wholeRead}`,
    );

    expect(ranged.results).toHaveLength(10);
    expect(rangedRead).toBeLessThan(wholeRead);
  });

  it('finds the rows in a range that no key in the page accounts for, in one statement', async () => {
    // The anti-join a pass runs per page. The page of keys goes in as one JSON
    // array through `json_each`, which costs one bound parameter regardless of how
    // many keys it holds; expanding it to `IN (?,?,?…)` would hit the 100 variable
    // ceiling at the tenth of a full page (invariant I7, `rules/01` §A).
    await db
      .prepare(
        'INSERT INTO _storage_objects' +
          ' (key, bucket, owner, size_bytes, content_type, created_at, updated_at)' +
          ' VALUES (?1, ?2, NULL, 1, NULL, unixepoch(), unixepoch())',
      )
      .bind(`${PREFIX}0003-gone.bin`, 'probe')
      .run();

    const page = ['0000', '0001', '0002', '0003', '0004'].map((n) => `${PREFIX}${n}.bin`);

    const result = await db
      .prepare(
        'SELECT key FROM _storage_objects' +
          ' WHERE key >= ?2 AND key <= ?3' +
          ' AND key NOT IN (SELECT value FROM json_each(?1))',
      )
      .bind(JSON.stringify(page), page[0], `${PREFIX}0004.bin`)
      .all<{ key: string }>();

    // `0003-gone` sorts between `0003.bin` and `0004.bin` because `-` is below `.`
    // in ASCII, so it is inside the range and absent from the page: exactly the
    // shape of a row whose bytes are gone.
    expect(result.results.map((row) => row.key)).toEqual([`${PREFIX}0003-gone.bin`]);

    const rowsRead = (result.meta as { rows_read?: number } | undefined)?.rows_read ?? -1;
    console.log(`  anti-join over a 5 key page of ${ROWS + 1} rows -> rows_read=${rowsRead}`);
    expect(rowsRead).toBeLessThan(ROWS);
  });

  it('takes a full page of keys as one bound parameter', async () => {
    // The ceiling that matters for the statement above. A thousand keys is one
    // parameter, and the JSON that holds them has to fit inside the 100 KB statement
    // limit as a value rather than as SQL, which it does because it is bound.
    const page = Array.from(
      { length: 1000 },
      (_, n) => `${PREFIX}${String(n).padStart(4, '0')}.bin`,
    );
    const json = JSON.stringify(page);

    const result = await db
      .prepare('SELECT count(*) AS n FROM json_each(?1)')
      .bind(json)
      .first<{ n: number }>();

    console.log(`  a 1000 key page is ${json.length} bytes in one bound parameter`);
    expect(result?.n).toBe(1000);
  });
});

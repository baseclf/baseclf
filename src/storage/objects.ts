/**
 * The D1 record of what is in the bucket.
 *
 * R2 is not in D1, so without these rows no statement can know an object exists,
 * and joining object metadata with application data is not something anybody can
 * write. An application keeps the key in its own column and joins on it.
 *
 * ⚠️ `_storage_objects` is never exposed through REST. The `_` prefix is what does
 * that, checked in two independent places already (rule 00 invariant I8): the
 * policy registry refuses to expose such a table, and the REST router refuses to
 * route to one. This table needed no new protection, which is the point of the
 * convention, and there is a test asserting both still hold.
 *
 * ## The ordering, which is the only real decision in this file
 *
 * There is no transaction spanning R2 and D1, so one of them is written first and
 * a failure between them leaves the two disagreeing. The rule chosen, and it is
 * the same rule in both directions:
 *
 *   **R2 is the truth. D1 follows it.**
 *
 * On upload: bytes first, row second. A failure leaves an object with no record,
 * which is recoverable and invisible to anyone but a reconciliation job. The other
 * order would leave a record for an object that does not exist, and then SQL lies:
 * a join returns a row, an application renders an image, and the image is a 404.
 *
 * On delete: bytes first, row second, and here the reasoning is stronger than
 * bookkeeping. A failure leaves a record for something already gone, which is a
 * lie SQL tells and nothing more. The other order would leave the BYTES in place
 * after the caller asked for them to be deleted, still downloadable by anybody who
 * knows the key. That is not untidiness, it is the deletion not having happened.
 *
 * ⚠️ Neither direction is atomic and this file does not pretend otherwise. What is
 * missing is a reconciliation pass, and it is written down as debt rather than
 * papered over: an orphaned object costs storage silently, and a stale row makes a
 * join wrong.
 */

import type { D1Executor } from '../db/dialect.js';
import { assertExecutable } from '../db/guards.js';
import type { AuthCtx } from '../policy/types.js';

/**
 * Record an object, or update the record of one that was overwritten.
 *
 * One statement, because D1 has no interactive transaction and a read then write
 * would be two. `created_at` survives an overwrite by not appearing in the update
 * clause at all, which is simpler than preserving it and cannot drift.
 *
 * `unixepoch()` appears three times and is consistent within one statement,
 * measured 200 times out of 200 (rules/01 §G7). The clock is the database's, so
 * two colos cannot disagree about when an object was written.
 */
export async function recordObject(
  executor: D1Executor,
  object: {
    readonly key: string;
    readonly bucket: string;
    readonly auth: AuthCtx;
    readonly sizeBytes: number;
    readonly contentType: string | null;
  },
): Promise<void> {
  const sql =
    'INSERT INTO "_storage_objects"' +
    ' ("key", "bucket", "owner", "size_bytes", "content_type", "created_at", "updated_at")' +
    ' VALUES (?1, ?2, ?3, ?4, ?5, unixepoch(), unixepoch())' +
    ' ON CONFLICT("key") DO UPDATE SET' +
    ' "bucket" = ?2, "owner" = ?3, "size_bytes" = ?4, "content_type" = ?5,' +
    ' "updated_at" = unixepoch()';

  const parameters = [
    object.key,
    object.bucket,
    object.auth.uid,
    object.sizeBytes,
    object.contentType,
  ];

  assertExecutable({ sql, parameters });
  await executor
    .prepare(sql)
    .bind(...parameters)
    .run();
}

/** Forget an object. Absent is success, because delete must not report existence. */
export async function forgetObject(executor: D1Executor, key: string): Promise<void> {
  const sql = 'DELETE FROM "_storage_objects" WHERE "key" = ?1';

  assertExecutable({ sql, parameters: [key] });
  await executor.prepare(sql).bind(key).run();
}

export interface ObjectRecord {
  readonly key: string;
  readonly bucket: string;
  readonly owner: string | null;
  readonly sizeBytes: number;
  readonly contentType: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ObjectRow {
  key: string;
  bucket: string;
  owner: string | null;
  size_bytes: number;
  content_type: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Read one record.
 *
 * ⚠️ For the engine, for `baseclf doctor`, and for the Studio. **Never** for
 * deciding access: an object is reachable because a storage policy resolved its
 * key, not because a row here says who owns it. Deciding from this row instead
 * would be a second permission system, which is exactly what the storage policy
 * exists to avoid, and it would be the weaker of the two because a row can be
 * stale while a policy cannot.
 */
export async function readObjectRecord(
  executor: D1Executor,
  key: string,
): Promise<ObjectRecord | null> {
  const sql =
    'SELECT "key", "bucket", "owner", "size_bytes", "content_type", "created_at", "updated_at"' +
    ' FROM "_storage_objects" WHERE "key" = ?1';

  assertExecutable({ sql, parameters: [key] });
  const row = await executor.prepare(sql).bind(key).first<ObjectRow>();

  if (row === null) return null;

  return Object.freeze({
    key: row.key,
    bucket: row.bucket,
    owner: row.owner,
    sizeBytes: row.size_bytes,
    contentType: row.content_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

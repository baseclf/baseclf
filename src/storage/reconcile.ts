/**
 * Making D1 agree with R2 again, in the one direction where that is safe.
 *
 * `objects.ts` writes the bytes first and the row second and says plainly that
 * neither direction is atomic. This is the pass that was owed against that note.
 * It is worth reading the asymmetry before the code, because the asymmetry is the
 * whole design and it is not obvious from the symptom:
 *
 *   **A row for bytes that are gone** is a lie SQL tells. A join returns it, an
 *   application renders an image, and the image is a 404. Removing the row loses
 *   nothing that is not already lost: the bytes went first, and `owner` and
 *   `created_at` describe an object that no longer exists. This direction is
 *   repaired.
 *
 *   **Bytes with no row** cost storage silently. The obvious repair is to delete
 *   them, and this pass will not do it, at any setting. Three reasons, and the
 *   first alone is enough:
 *
 *     1. A sweep that deletes bytes is one bug away from permanent, unrecoverable
 *        loss of a customer's files, and the bug would be invisible until somebody
 *        went looking for a file that was not there any more.
 *     2. This pass cannot tell an object BaseCLF wrote from one an operator put in
 *        the bucket with `wrangler r2 object put`. Both look identical: bytes with
 *        no row. Deleting "orphans" would delete the operator's own files.
 *     3. The other repair, writing the missing row, is refused for a quieter
 *        reason. The one thing that cannot be recovered from R2 is `owner`, so an
 *        adopted row would have to claim the object has none. That is inventing a
 *        fact, and an engine does not get to write rows nobody wrote.
 *
 *   So this direction is REPORTED and never touched. That is a smaller promise
 *   than "reconciliation" usually implies, and it is the honest one.
 *
 * ## The three things that stop this deleting a row it should not
 *
 * 1. **A grace period.** An object whose bytes landed a moment ago and whose row
 *    has not been written yet looks exactly like an orphan, and so does a row
 *    written after this pass listed R2. Nothing younger than `graceSeconds` is
 *    considered at all, in either direction. The age of a row comes from
 *    `unixepoch()` inside the statement, so it is the database's clock rather than
 *    a Worker's; the age of an object comes from R2's `uploaded`, measured to be a
 *    Date within milliseconds of the write (`r2-list-behaviour.test.ts`).
 *
 * 2. **A direct read before every deletion.** A candidate is only a candidate
 *    because it was absent from a `list()` page, and a listing is a bulk answer.
 *    Before its row is removed, `head()` is called on that exact key, which is a
 *    point read of the one thing being decided about. If the object turns up, the
 *    row stays and the contradiction is counted. This is what keeps a bad listing
 *    from cascading: if `list()` ever returned an empty page for a bucket that is
 *    not empty, every candidate it produced would be contradicted by `head()` and
 *    nothing at all would be deleted.
 *
 * 3. **A cap on how much one invocation may repair.** `maxVerifications` bounds
 *    the blast radius of every failure mode above, including ones nobody has
 *    thought of. Even a total misreading of the bucket removes at most that many
 *    rows per run, which leaves hours for somebody to notice.
 *
 * ## Why a cron sweep and not a repair on the read path
 *
 * Repairing lazily inside `downloadObject` is tempting, because a download that
 * finds no object has already discovered the drift for free. It is refused: that
 * 404 is reachable by anyone, and invariant I5 makes a forbidden object and an
 * absent one indistinguishable, so a D1 write hung off it turns key-guessing into
 * a way of making somebody else's deployment do database writes. A background pass
 * has no caller to abuse it.
 *
 * ## What one invocation costs, measured
 *
 * `r2-list-behaviour.test.ts` measured what this budget is built on: `list()` caps
 * at 1000 keys per call and refuses 1001 outright, pages are lexicographically
 * ordered, and `startAfter` resumes exactly. A bounded key range costs 11 rows
 * read where the same query unbounded costs 200, because the range rides the
 * primary key index.
 *
 * So with the defaults below, one invocation is at most 8 `list()` calls plus at
 * most 24 `head()` calls against R2, and 3 fixed statements plus one window read
 * and at most one delete per page against D1: 19 statements at the very most. The
 * Free plan allows 50 D1 queries and 50 subrequests per invocation (`rules/01` §B,
 * `rules/02` §A), and it is not established here whether an R2 binding call counts
 * against the subrequest limit, so the R2 budget is kept under it as if it does.
 *
 * ⚠️ That buys 8000 objects an hour. A bucket with a million objects takes five
 * days to walk end to end, and that is the honest number rather than a slow path
 * nobody mentions. It is a background integrity job, not a query.
 */

import type { D1Executor } from '../db/dialect.js';
import { assertExecutable, type CompiledStatement } from '../db/guards.js';
import { BaseclfError } from '../utils/errors.js';
import { STORAGE_SWEEP_DDL } from './schema.js';

/** One walk, one row. */
const SWEEP_ID = 'default';

/** The measured ceiling on `list()`. 1001 is refused with "MaxKeys ... <= 1000". */
export const MAX_LIST_PAGE = 1000;

/**
 * How many pages one invocation walks.
 *
 * Eight, against a Free-plan budget of 50 D1 queries and 50 subrequests. See the
 * cost note at the top of the file; this is the number that leaves room for the
 * verification calls rather than a round figure.
 */
const DEFAULT_MAX_PAGES = 8;

/**
 * How old drift has to be before this pass will look at it.
 *
 * An hour, which is enormously more than the gap it is protecting: the two writes
 * of an upload are one D1 statement apart inside a single request. The number is
 * this large because being wrong here means deleting the record of a file somebody
 * just uploaded, and because there is nothing to gain from noticing drift sooner
 * than the next hourly run would anyway.
 */
const DEFAULT_GRACE_SECONDS = 3_600;

/**
 * How many rows one invocation may confirm and remove.
 *
 * This is the blast radius, and it is deliberately small. It also has to fit
 * inside the R2 call budget alongside the listings.
 */
const DEFAULT_MAX_VERIFICATIONS = 24;

/** How many orphaned objects the report names. The count and the bytes are exact. */
const ORPHAN_SAMPLE_LIMIT = 20;

const ENSURE_STATE_SQL = STORAGE_SWEEP_DDL;

/** The table this pass compares against. Absent means storage is not set up here. */
const OBJECTS_TABLE = '_storage_objects';

/**
 * Every table, so one can be looked for by an exact name.
 *
 * `PRAGMA table_list` takes no argument and the match happens in JavaScript, which
 * is the point: `PRAGMA table_info(x)` would need the name inside the statement,
 * and an identifier that reaches SQL as text is the shape invariant I6 exists to
 * forbid. Double-quoted string literals are on in D1, so a name that got there
 * wrongly would come back as a string rather than as an error.
 *
 * `table_list` is one of the four PRAGMAs measured to work on D1 (`rules/01` §A).
 */
const TABLE_LIST_SQL = 'PRAGMA table_list';

const READ_STATE_SQL = 'SELECT "after_key", "passes" FROM "_storage_sweep" WHERE "id" = ?1';

const WRITE_STATE_SQL =
  'INSERT INTO "_storage_sweep" ("id", "after_key", "passes", "updated_at")' +
  ' VALUES (?1, ?2, ?3, unixepoch())' +
  ' ON CONFLICT("id") DO UPDATE SET' +
  ' "after_key" = ?2, "passes" = ?3, "updated_at" = unixepoch()';

/**
 * Every record in one key window, with its age taken from the database clock.
 *
 * The age comes back rather than being filtered here, and that is not a detail. A
 * fresh row filtered out in SQL would be missing from the comparison, and its
 * object would then look like it had no record at all. The grace period decides
 * what may be ACTED on, never what is compared.
 *
 * `ORDER BY "key"` is what makes `LIMIT` mean "the first N of this window" rather
 * than "N of this window", which is what lets a truncated read narrow the window
 * instead of corrupting the comparison.
 */
const WINDOW_SQL =
  'SELECT "key", unixepoch() - "updated_at" AS "age_seconds" FROM "_storage_objects"' +
  ' WHERE "key" > ?1 AND "key" <= ?2 ORDER BY "key" LIMIT ?3';

/**
 * The same, with no upper bound.
 *
 * Used only once R2 has said there is nothing further, which is the only way rows
 * past the last object in the bucket are ever examined. Without it, deleting the
 * last thousand objects from a bucket would leave their rows unreachable by any
 * pass. It is safe for the same reason the bounded form is: every row it produces
 * still has to survive the grace period and then be contradicted by nothing on a
 * direct `head()`.
 */
const TAIL_WINDOW_SQL =
  'SELECT "key", unixepoch() - "updated_at" AS "age_seconds" FROM "_storage_objects"' +
  ' WHERE "key" > ?1 ORDER BY "key" LIMIT ?2';

/**
 * Remove the confirmed rows.
 *
 * One statement for the whole batch through `json_each`, never `IN (?,?,?…)`:
 * invariant I7, and the 100 variable ceiling is real (`rules/01` §A).
 */
const FORGET_SQL =
  'DELETE FROM "_storage_objects" WHERE "key" IN (SELECT value FROM json_each(?1))';

export interface StorageSweepOptions {
  /** Pages of `list()` per invocation. Default 8. */
  readonly maxPages?: number;
  /** Keys per page. Default and measured maximum 1000. */
  readonly pageSize?: number;
  /** How old drift must be before it is acted on or reported. Default 3600. */
  readonly graceSeconds?: number;
  /** Rows one invocation may confirm with `head()` and remove. Default 24. */
  readonly maxVerifications?: number;
  /** False runs the whole pass and removes nothing, for a diagnostic. Default true. */
  readonly repair?: boolean;
}

/** Bytes in the bucket that no record accounts for. Reported, never touched. */
export interface OrphanedObject {
  readonly key: string;
  readonly sizeBytes: number;
  /** Seconds since the epoch, from R2's own `uploaded`. */
  readonly uploadedAt: number;
}

export interface StorageSweepReport {
  readonly pagesScanned: number;
  readonly objectsScanned: number;
  /** Rows removed because a direct read confirmed their object is gone. */
  readonly recordsRemoved: number;
  /**
   * Rows the listing said were orphaned and `head()` said were not.
   *
   * Zero in normal operation. Anything else means a listing and a point read
   * disagreed, which is worth seeing rather than smoothing over.
   */
  readonly recordsContradicted: number;
  /**
   * Candidates this invocation ran out of budget to check.
   *
   * When this is not zero the walk resumes just below the first of them rather
   * than past them, so a backlog drains at the verification cap per invocation
   * instead of waiting for the next full walk.
   */
  readonly recordsDeferred: number;
  readonly orphanedObjectCount: number;
  readonly orphanedObjectBytes: number;
  /** At most `ORPHAN_SAMPLE_LIMIT` of them, for an operator to go and look at. */
  readonly orphanedObjectSample: readonly OrphanedObject[];
  /** Whether this invocation reached the end of the bucket. */
  readonly walkComplete: boolean;
  /** Where the next invocation resumes. Empty means the start of the key space. */
  readonly resumeAfterKey: string;
  /** Walks finished since the table was created. Zero means nothing is proven yet. */
  readonly passes: number;
  /**
   * Whether anything was looked at.
   *
   * False when this deployment has no `_storage_objects`, which is a different
   * fact from a pass that found nothing and has to stay distinguishable from it.
   * `STORAGE_SCHEMA` declares that table and nothing outside the tests applies it
   * yet, so a deployment without it is not drifting; it has no storage. Throwing
   * there would put an exception in the log every hour, on every deployment, for
   * a condition `doctor` already reports and this pass cannot fix.
   */
  readonly ran: boolean;
}

interface StateRow {
  after_key: string;
  passes: number;
}

interface WindowRow {
  key: string;
  age_seconds: number;
}

function invalid(detail: string): BaseclfError {
  return new BaseclfError('INVALID_CONFIGURATION', 500, {
    message: 'Storage sweep configuration is invalid.',
    detail,
  });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw invalid(`${name} must be a positive integer, received ${String(value)}.`);
  }
}

async function run(executor: D1Executor, statement: CompiledStatement): Promise<void> {
  assertExecutable(statement);
  await executor
    .prepare(statement.sql)
    .bind(...statement.parameters)
    .run();
}

/**
 * A value that came back as the wrong type is a failure, not a zero.
 *
 * Double-quoted string literals are enabled on D1 (invariant I6), so a mistyped
 * identifier returns its own name as a string for every row instead of raising.
 * An age that is not a number is that failure, and comparing it against the grace
 * period would silently make every row look ancient, which on this path means
 * eligible for deletion.
 */
function readAge(row: WindowRow): number {
  const age = row.age_seconds;
  if (typeof age !== 'number' || !Number.isFinite(age)) {
    throw new BaseclfError('MALFORMED_SQL', 500, {
      message: 'Storage sweep query returned an unusable row.',
      detail: `Column "age_seconds" came back as ${typeof age}, expected a number.`,
    });
  }
  return age;
}

/**
 * Whether this deployment has the table the pass reads.
 *
 * Asked rather than inferred from a failure. Deciding it by catching the error and
 * matching "no such table" would put a string comparison between a deployment that
 * has no storage and a database that is broken, and those two deserve opposite
 * treatment. The upload path already carries one message match of that kind and it
 * is the most fragile thing on it; there is no reason to add a second when the
 * question can simply be asked.
 *
 * Compared with `===` against the whole name. Not a prefix, not a pattern: I6.
 */
async function storageIsProvisioned(executor: D1Executor): Promise<boolean> {
  const statement: CompiledStatement = { sql: TABLE_LIST_SQL, parameters: [] };
  assertExecutable(statement);

  const listed = await executor.prepare(statement.sql).all<{ name?: unknown }>();

  return (listed.results ?? []).some((row) => row.name === OBJECTS_TABLE);
}

/** Create the state table if it is not there. Idempotent; see the note in `schema.ts`. */
async function ensureSweepState(executor: D1Executor): Promise<void> {
  await run(executor, { sql: ENSURE_STATE_SQL, parameters: [] });
}

/** Nothing looked at, and every counter zero so no caller mistakes it for a clean pass. */
function skippedReport(): StorageSweepReport {
  return Object.freeze({
    pagesScanned: 0,
    objectsScanned: 0,
    recordsRemoved: 0,
    recordsContradicted: 0,
    recordsDeferred: 0,
    orphanedObjectCount: 0,
    orphanedObjectBytes: 0,
    orphanedObjectSample: Object.freeze([]),
    walkComplete: false,
    resumeAfterKey: '',
    passes: 0,
    ran: false,
  });
}

async function readSweepState(executor: D1Executor): Promise<{ afterKey: string; passes: number }> {
  const statement: CompiledStatement = { sql: READ_STATE_SQL, parameters: [SWEEP_ID] };
  assertExecutable(statement);

  const row = await executor
    .prepare(statement.sql)
    .bind(...statement.parameters)
    .first<StateRow>();

  if (row === null) return { afterKey: '', passes: 0 };

  // Anything that is not the shape this file wrote restarts the walk rather than
  // being coerced. A resume point that is not a string is a resume point nobody
  // can reason about, and starting over costs one pass.
  const afterKey = typeof row.after_key === 'string' ? row.after_key : '';
  const passes = typeof row.passes === 'number' && Number.isFinite(row.passes) ? row.passes : 0;

  return { afterKey, passes };
}

async function writeSweepState(
  executor: D1Executor,
  afterKey: string,
  passes: number,
): Promise<void> {
  await run(executor, { sql: WRITE_STATE_SQL, parameters: [SWEEP_ID, afterKey, passes] });
}

async function readWindow(
  executor: D1Executor,
  afterKey: string,
  upperInclusive: string | null,
  limit: number,
): Promise<WindowRow[]> {
  const statement: CompiledStatement =
    upperInclusive === null
      ? { sql: TAIL_WINDOW_SQL, parameters: [afterKey, limit] }
      : { sql: WINDOW_SQL, parameters: [afterKey, upperInclusive, limit] };

  assertExecutable(statement);
  const result = await executor
    .prepare(statement.sql)
    .bind(...statement.parameters)
    .all<WindowRow>();

  return result.results ?? [];
}

/**
 * Walk part of the bucket and make D1 agree with what R2 says is there.
 *
 * Resumable: it records where it stopped and the next invocation carries on, so a
 * bucket larger than one invocation's budget is walked over several of them rather
 * than restarted forever. It throws on a database or bucket failure, unlike the
 * rate limiter, because nothing is waiting on the answer and there is no request to
 * wrongly admit; a sweep that has quietly stopped running is drift nobody sees.
 */
export async function reconcileStorage(
  bucket: R2Bucket,
  executor: D1Executor,
  options: StorageSweepOptions = {},
): Promise<StorageSweepReport> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageSize = options.pageSize ?? MAX_LIST_PAGE;
  const graceSeconds = options.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  const maxVerifications = options.maxVerifications ?? DEFAULT_MAX_VERIFICATIONS;
  const repair = options.repair ?? true;

  assertPositiveInteger(maxPages, 'maxPages');
  assertPositiveInteger(pageSize, 'pageSize');
  assertPositiveInteger(graceSeconds, 'graceSeconds');
  assertPositiveInteger(maxVerifications, 'maxVerifications');

  if (pageSize > MAX_LIST_PAGE) {
    throw invalid(`pageSize must be at most ${MAX_LIST_PAGE}; R2 refuses anything larger.`);
  }

  // Asked before the state table is created, so a deployment with no storage is
  // left exactly as it was found rather than acquiring a table for a pass that is
  // never going to run.
  if (!(await storageIsProvisioned(executor))) return skippedReport();

  await ensureSweepState(executor);
  const state = await readSweepState(executor);

  let afterKey = state.afterKey;
  let passes = state.passes;
  let walkComplete = false;

  let pagesScanned = 0;
  let objectsScanned = 0;
  let recordsRemoved = 0;
  let recordsContradicted = 0;
  let recordsDeferred = 0;
  let orphanedObjectCount = 0;
  let orphanedObjectBytes = 0;
  const orphanedObjectSample: OrphanedObject[] = [];

  let verificationsLeft = maxVerifications;

  // R2 reports an upload time and D1 reports an age, so the two sides are compared
  // against different clocks. Both are Cloudflare's, and the consequence of them
  // disagreeing is bounded: on the object side it can only change what is
  // REPORTED, never what is deleted.
  const nowMs = Date.now();
  const graceMs = graceSeconds * 1_000;

  for (let page = 0; page < maxPages; page += 1) {
    const listing = await bucket.list({
      limit: pageSize,
      ...(afterKey === '' ? {} : { startAfter: afterKey }),
    });

    pagesScanned += 1;
    objectsScanned += listing.objects.length;

    const lastObject = listing.objects.at(-1);

    // Null means R2 has nothing past `afterKey`, so the window runs to the end of
    // the key space. That is the only way a row above the last object in the bucket
    // is ever examined.
    const pageEnd: string | null = lastObject === undefined ? null : lastObject.key;

    const rows = await readWindow(executor, afterKey, pageEnd, pageSize);

    // More rows in this window than one read returns. Narrow the window to the last
    // row seen so both sides are complete within it, and let the next page pick up
    // from there. Every row returned is strictly above `afterKey`, so this always
    // moves forward and the walk cannot stall.
    const lastRow = rows.at(-1);
    const truncated =
      rows.length >= pageSize &&
      lastRow !== undefined &&
      (pageEnd === null || lastRow.key < pageEnd);
    const windowEnd: string | null = truncated && lastRow !== undefined ? lastRow.key : pageEnd;

    const objectsInWindow =
      windowEnd === null
        ? listing.objects
        : listing.objects.filter((object) => object.key <= windowEnd);

    const recorded = new Set(rows.map((row) => row.key));
    const present = new Set(objectsInWindow.map((object) => object.key));

    // Bytes with no row. Counted, sampled, and left exactly where they are.
    for (const object of objectsInWindow) {
      if (recorded.has(object.key)) continue;
      if (nowMs - object.uploaded.getTime() < graceMs) continue;

      orphanedObjectCount += 1;
      orphanedObjectBytes += object.size;
      if (orphanedObjectSample.length < ORPHAN_SAMPLE_LIMIT) {
        orphanedObjectSample.push({
          key: object.key,
          sizeBytes: object.size,
          uploadedAt: Math.floor(object.uploaded.getTime() / 1_000),
        });
      }
    }

    // A row for bytes the listing did not mention. Every one of these is checked
    // against the bucket directly before anything is removed.
    //
    // `settled` trails the loop so that running out of budget leaves a resume point
    // just below the first candidate that was not reached, rather than past it. A
    // walk that skipped its backlog would repair at the cap per FULL WALK, which on
    // a large bucket is days.
    const confirmed: string[] = [];
    let settled = afterKey;
    let deferredFrom: string | null = null;

    for (const row of rows) {
      if (deferredFrom !== null) {
        if (!present.has(row.key) && readAge(row) >= graceSeconds) recordsDeferred += 1;
        continue;
      }

      if (!present.has(row.key) && readAge(row) >= graceSeconds) {
        if (verificationsLeft === 0) {
          deferredFrom = settled;
          recordsDeferred += 1;
          continue;
        }
        verificationsLeft -= 1;

        if ((await bucket.head(row.key)) === null) {
          confirmed.push(row.key);
        } else {
          recordsContradicted += 1;
        }
      }

      settled = row.key;
    }

    if (repair && confirmed.length > 0) {
      await run(executor, { sql: FORGET_SQL, parameters: [JSON.stringify(confirmed)] });
      recordsRemoved += confirmed.length;
    }

    if (deferredFrom !== null) {
      afterKey = deferredFrom;
      break;
    }

    if (windowEnd === null) {
      // R2 had nothing further and every remaining row was examined.
      walkComplete = true;
      passes += 1;
      afterKey = '';
      break;
    }

    afterKey = windowEnd;
  }

  // A dry run leaves the resume point where it found it. Moving it would mean a
  // diagnostic quietly skipping the cron past a stretch of the bucket, and the
  // person who ran the diagnostic would have no reason to suspect it.
  if (repair) await writeSweepState(executor, afterKey, passes);

  return Object.freeze({
    pagesScanned,
    objectsScanned,
    recordsRemoved,
    recordsContradicted,
    recordsDeferred,
    orphanedObjectCount,
    orphanedObjectBytes,
    orphanedObjectSample: Object.freeze(orphanedObjectSample),
    walkComplete,
    resumeAfterKey: afterKey,
    passes,
    ran: true,
  });
}

/**
 * Whether a report is worth an operator's attention.
 *
 * A clean pass says nothing, because an hourly line saying nothing happened is a
 * line nobody reads and a cost nobody needed to pay. A pass that did not run says
 * nothing either: every counter in a skipped report is zero, so the checks below
 * would already be false, and the explicit guard is here so that stays true if a
 * counter is ever added.
 */
export function sweepFoundDrift(report: StorageSweepReport): boolean {
  if (!report.ran) return false;

  return (
    report.orphanedObjectCount > 0 ||
    report.recordsRemoved > 0 ||
    report.recordsContradicted > 0 ||
    report.recordsDeferred > 0
  );
}

/**
 * The report as a log line, with no key in it.
 *
 * Invariant I9 and the same argument `log.ts` makes about `storage_write`: a key
 * holds a uid, so it names a person, and an hourly log line naming whose uploads
 * went wrong is personal data accumulating somewhere nobody decided to keep it.
 * The counts and the bytes are what an operator acts on. The keys are in the
 * returned report, for a diagnostic that has an operator in front of it.
 */
export function describeSweep(report: StorageSweepReport): string {
  if (!report.ran) return 'skipped: this deployment has no _storage_objects table';

  return (
    `pages=${report.pagesScanned} objects=${report.objectsScanned} ` +
    `orphanedObjects=${report.orphanedObjectCount} orphanedBytes=${report.orphanedObjectBytes} ` +
    `recordsRemoved=${report.recordsRemoved} contradicted=${report.recordsContradicted} ` +
    `deferred=${report.recordsDeferred} ` +
    `walkComplete=${report.walkComplete} passes=${report.passes}`
  );
}

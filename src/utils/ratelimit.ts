/**
 * A fixed-window rate limiter backed by a D1 table.
 *
 * This exists because the obvious alternatives are broken on this platform, and
 * each of them is broken quietly:
 *
 *   KV                 has a 60 second minimum TTL. Better Auth asks for 10.
 *                      The write does not fail loudly, it just does not stick,
 *                      so the limiter reads empty every time and the endpoint is
 *                      open to brute force while every dashboard looks healthy.
 *   Better Auth's own  defaults to `storage: "memory"`, a module-scope Map.
 *                      Measured in workerd on 2026-08-11: with no NODE_ENV set,
 *                      which is the case on Workers, it also defaults to
 *                      `enabled: false`. Even switched on, a per-isolate Map
 *                      means the real limit is the configured max multiplied by
 *                      however many isolates the request spread across.
 *   Rate Limiting API  is per-colo and eventually consistent, and Cloudflare's
 *                      own documentation says not to treat it as an accounting
 *                      system. Fine against brute force, not a budget.
 *
 * A D1 table is globally consistent and costs one statement per request.
 *
 * ---
 *
 * The seven decisions this file is built on, and why each one is not a matter
 * of taste:
 *
 * 1. ONE STATEMENT. D1 rejects BEGIN TRANSACTION and SAVEPOINT (rule 01 §C), so
 *    there is no read-modify-write that another request cannot interleave with.
 *    The check and the increment are a single UPSERT, and the decision is read
 *    out of RETURNING. Two requests racing produce two increments, never two
 *    reads of the same stale count.
 *
 * 2. STRICT TABLE, EXPLICIT NOT NULL. `TEXT PRIMARY KEY` accepts NULL in SQLite
 *    (rule 01 §G1, measured). A NULL key would collapse unrelated callers into
 *    one row, and NULL in a comparison yields NULL rather than false. STRICT
 *    plus a written-out NOT NULL removes both.
 *
 * 3. CF-Connecting-IP, NEVER X-Forwarded-For. Cloudflare sets CF-Connecting-IP
 *    itself and overwrites whatever the client sent. X-Forwarded-For it appends
 *    to, so the client controls the front of the chain. Keying on a value the
 *    caller can choose hands an attacker an unlimited supply of fresh buckets,
 *    which is the same as having no limiter. Note that Better Auth's default is
 *    `["x-forwarded-for"]`; anything wiring its limiter must override that.
 *
 * 4. FAIL CLOSED. A failed query denies the request. On the auth path this costs
 *    nothing: if D1 is down then sign-in is down anyway, so refusing loses no
 *    working functionality. Failing open does the opposite. It removes the
 *    limiter exactly when the database is unstable, which is both the moment an
 *    attacker is most likely to have caused the instability and the moment the
 *    failure is least likely to be noticed.
 *
 * 5. NO INDEX ON window_start. D1 bills every row a write touches, and a write
 *    to an indexed column costs two rows written instead of one (rule 01 §D).
 *    This table is written on every request and scanned only by the cleanup
 *    job, which runs on a cron. Paying double on the hot path to speed up the
 *    cold one is the wrong trade; the sweep is allowed to scan.
 *
 * 6. THE KEY IS NEVER LOGGED. It contains a client IP. Rule 00 invariant I9.
 *    What gets logged is the bucket, the count and the limit, and the bucket is
 *    re-derived through a pattern that no IP can match, so a hand-built key
 *    cannot smuggle an address into a log line.
 *
 * 7. EVERY VALUE IS BOUND. Rule 00 invariant I7. The statements here are
 *    module constants with no interpolation of any kind, and they still go
 *    through `assertExecutable` before execution, because a guard that only
 *    runs where it seems necessary is a guard nobody notices going missing.
 *
 * ---
 *
 * Measured in workerd on 2026-08-11, because none of it was in rule 01:
 *
 *   unixepoch()                    exists, returns INTEGER
 *   strftime('%s','now')           exists, returns TEXT, so it is the wrong one
 *                                  for an INTEGER column in a STRICT table
 *   unixepoch() within a statement  agreed with itself in 200/200 statements
 *   DO UPDATE SET right-hand side   reads the pre-update row, not the value an
 *                                  earlier SET clause in the same statement
 *                                  assigned. `SET a = 99, b = a` yields b = 1.
 *
 * The last one is what makes this correct. Both SET clauses test the same
 * window_start and see the same value, so the count and the window can never
 * disagree about whether the window rolled over.
 *
 * Taking the time from the database rather than from `Date.now()` is deliberate:
 * a Worker in one colo and a Worker in another do not share a clock, and a
 * window decided by the caller's clock is a window an unlucky clock can widen.
 */

import type { D1Executor } from '../db/dialect.js';
import { assertExecutable, type CompiledStatement } from '../db/guards.js';
import { BaseclfError } from './errors.js';
import { logError, logEvent } from './log.js';

/**
 * System table. The leading underscore is the hard denylist of rule 00
 * invariant I8: this is never reachable through REST, and that is enforced
 * independently by the registry loader and the REST router, not here.
 */
export const RATE_LIMIT_TABLE = '_rate_limit';

/**
 * STRICT keeps a text key from arriving as NULL and keeps the counters
 * integral. No index beyond the implicit one on the primary key; see decision 5.
 */
export const RATE_LIMIT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "_rate_limit" (
  "key"          TEXT    NOT NULL PRIMARY KEY,
  "window_start" INTEGER NOT NULL,
  "hits"         INTEGER NOT NULL
) STRICT`;

/**
 * Insert the first hit, or fold this hit into the row already there.
 *
 * `?1` is the key and `?2` is the window length in seconds. `?2` appears four
 * times and is bound once: numbered placeholders let an ordinal be reused, which
 * is worth knowing because Kysely cannot do it (rule 01 §G2) and the 100
 * variable ceiling is real.
 *
 * Every reference to an existing column is qualified with the table name. Bare
 * names were measured to behave identically, so this buys nothing at runtime; it
 * buys a reader not having to remember whether an unqualified name in DO UPDATE
 * SET means the target row or the excluded one.
 *
 * A denied request still increments. The window is fixed, so a rejected hit
 * cannot push the reset further away, and letting the count run on is one fewer
 * branch in a statement that has to stay atomic.
 */
const CONSUME_SQL = `INSERT INTO "_rate_limit" ("key", "window_start", "hits")
VALUES (?1, unixepoch(), 1)
ON CONFLICT("key") DO UPDATE SET
  "hits"         = CASE WHEN "_rate_limit"."window_start" <= unixepoch() - ?2 THEN 1            ELSE "_rate_limit"."hits" + 1     END,
  "window_start" = CASE WHEN "_rate_limit"."window_start" <= unixepoch() - ?2 THEN unixepoch()  ELSE "_rate_limit"."window_start" END
RETURNING "hits", "window_start", unixepoch() AS "now"`;

/** Drops rows whose window closed longer than `?1` seconds ago. Full scan by design. */
const CLEANUP_SQL = `DELETE FROM "_rate_limit" WHERE "window_start" <= unixepoch() - ?1`;

const KEY_SEPARATOR = '|';
const MAX_KEY_LENGTH = 256;

/**
 * Bucket names are written by us, never by a caller. The charset excludes `.`
 * and `:` on purpose, which is what lets `bucketOfKey` promise that nothing it
 * returns can be an IP address.
 */
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const UNKNOWN_BUCKET = 'unknown';

/**
 * Used when no client address can be resolved.
 *
 * Everything unidentifiable shares one budget. The alternative of skipping the
 * limit is a bypass, and the alternative of throwing turns a missing header into
 * a 500 for the whole endpoint. On Cloudflare this is unreachable, because the
 * platform always sets the header.
 */
const UNKNOWN_ADDRESS = 'unknown';

/**
 * Marks the rest of a key as an identity rather than an address.
 *
 * A normalised address is hex digits, dots and colons, or the literal
 * `unknown`, so nothing this produces can be mistaken for one and two callers
 * cannot land in one budget by one of them having an id shaped like an IP.
 */
const IDENTITY_MARKER = 'u:';

/**
 * What an identity may look like before it is trusted with a place in a key.
 *
 * It arrives from a verified token, so this is not the boundary that keeps a
 * caller from choosing it. It is the check that keeps a key well formed: no
 * separator, and short enough that `MAX_KEY_LENGTH` cannot be reached.
 */
const IDENTITY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** IPv6 is handed out in blocks. A /128 key would let one customer rotate forever. */
const IPV6_PREFIX_GROUPS = 4;

/**
 * The longest an address can legally be written: an IPv4-mapped IPv6 address,
 * `ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255`.
 *
 * Anything longer is not an address, so it is treated as unresolvable rather
 * than stored. Without this the header would decide the key length, and a key
 * that fails validation later would throw on a request path instead of simply
 * being limited.
 */
const MAX_ADDRESS_LENGTH = 45;

export interface RateLimitRule {
  /** Requests permitted per window. */
  readonly limit: number;
  /** Window length in seconds. */
  readonly windowSeconds: number;
}

export interface RateLimitRequest extends RateLimitRule {
  /** Build this with `deriveRateLimitKey`. Contains a client IP; never log it. */
  readonly key: string;
}

/**
 * The outcome of one request against one key.
 *
 * There is deliberately no field saying whether the limiter itself failed. A
 * caller cannot branch on a distinction it cannot see, and the branch that would
 * be written is `if (unavailable) letThemThrough()`. When the database is
 * unreachable this reports a denial like any other; the reason goes to the log,
 * where it does not change anyone's control flow.
 */
export interface RateLimitResult {
  readonly allowed: boolean;
  /** Requests counted in the current window, including this one. 0 if unknown. */
  readonly hits: number;
  /** Seconds until the window reopens. 0 when allowed. */
  readonly retryAfterSeconds: number;
}

function invalid(detail: string): BaseclfError {
  return new BaseclfError('INVALID_CONFIGURATION', 500, {
    message: 'Rate limit configuration is invalid.',
    detail,
  });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw invalid(`${name} must be a positive integer, received ${String(value)}.`);
  }
}

/**
 * Collapse an IPv6 address to its /64 network.
 *
 * A residential IPv6 allocation is a /64 or larger, so keying on the full
 * address means one subscriber owns more keys than we could ever count. Taking
 * the first four groups means every address in a block maps to one bucket.
 */
function collapseIPv6ToPrefix64(address: string): string {
  const sides = address.split('::');
  let groups: string[];

  if (sides.length === 1) {
    groups = address.split(':');
  } else {
    const head = sides[0] ? sides[0].split(':') : [];
    const tail = sides[1] ? sides[1].split(':') : [];
    const omitted = new Array(Math.max(0, 8 - head.length - tail.length)).fill('0');
    groups = [...head, ...omitted, ...tail];
  }

  const prefix: string[] = [];
  for (let i = 0; i < IPV6_PREFIX_GROUPS; i += 1) {
    const group = groups[i];
    prefix.push((group === undefined || group === '' ? '0' : group).padStart(4, '0'));
  }

  return `${prefix.join(':')}::/64`;
}

/**
 * Reduce a client address to the unit we are willing to limit.
 *
 * IPv4 is used as-is. IPv6 collapses to its /64. An IPv4-mapped IPv6 address is
 * unwrapped so that the same client cannot occupy two buckets by arriving in two
 * notations.
 */
function normalizeClientAddress(raw: string): string {
  const address = raw.trim().toLowerCase();
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return UNKNOWN_ADDRESS;
  if (!address.includes(':')) return address;
  if (address.includes('.')) {
    const mapped = address.slice(address.lastIndexOf(':') + 1);
    return mapped.length > 0 ? mapped : UNKNOWN_ADDRESS;
  }
  return collapseIPv6ToPrefix64(address);
}

/**
 * Build the key for one caller against one bucket.
 *
 * The bucket separates budgets that should not share one: exhausting the
 * sign-in allowance must not lock the same person out of a password reset. Pass
 * a constant, not anything derived from the request, or a caller gains the
 * ability to mint buckets.
 *
 * Only CF-Connecting-IP is read. X-Forwarded-For is ignored even when present,
 * because Cloudflare appends to it rather than replacing it, leaving the client
 * in control of what it contains. Decision 3 above.
 *
 * ## Counting against an identity instead of an address
 *
 * `identity` is optional and comes from a **verified** claim, never from a
 * header. When it is there the counter is per account rather than per address,
 * and both directions of that matter:
 *
 * A shared address is the common case, not the edge case. Carrier NAT puts
 * thousands of unrelated people behind one address, so an address-keyed budget
 * on a data path is a budget those people take from each other. That is the
 * cost of getting this wrong on a path real users sit on, as opposed to the
 * auth endpoints, where an address is the only thing there is.
 *
 * And the threat this is for is an authenticated one: somebody with a session
 * calling an expensive endpoint in a loop. Counting their address rather than
 * their account would let one account spread over several networks.
 *
 * ⚠️ What it does not do is stop somebody who makes more accounts. Account
 * creation has its own budget, which is where that is bounded, and neither
 * number stops a determined attacker with a proxy pool. These limits bound a
 * runaway client and casual abuse. They are not a defence against a
 * distributed one, and Cloudflare's own rate limiting is the layer for that.
 *
 * ⚠️ An identity that is unusable falls back to the address rather than
 * throwing. It is prefixed so it can never collide with an address, and it is
 * length-checked because it ends up in a key with a ceiling on it. A claim from
 * a token this deployment signed should always pass; a request path is the
 * wrong place to find out otherwise.
 */
export function deriveRateLimitKey(
  request: Request,
  bucket: string,
  identity?: string | null,
): string {
  if (!BUCKET_PATTERN.test(bucket)) {
    throw invalid(
      `Bucket "${bucket}" is not a valid name. Use lowercase letters, digits, "_" and "-".`,
    );
  }

  if (identity !== undefined && identity !== null && IDENTITY_PATTERN.test(identity)) {
    return `${bucket}${KEY_SEPARATOR}${IDENTITY_MARKER}${identity}`;
  }

  const address = request.headers.get('CF-Connecting-IP');
  return `${bucket}${KEY_SEPARATOR}${address === null ? UNKNOWN_ADDRESS : normalizeClientAddress(address)}`;
}

/**
 * The bucket half of a key, and nothing else, for logging.
 *
 * The pattern is re-applied rather than trusted. An address contains `.` or `:`
 * and a bucket name may contain neither, so no input to this function can
 * produce an IP on the way out. That is the property the logging test pins.
 */
function bucketOfKey(key: string): string {
  const separator = key.indexOf(KEY_SEPARATOR);
  if (separator <= 0) return UNKNOWN_BUCKET;
  const candidate = key.slice(0, separator);
  return BUCKET_PATTERN.test(candidate) ? candidate : UNKNOWN_BUCKET;
}

/**
 * A failure message, with the key taken back out if it turns out to be in there.
 *
 * D1 does not echo bound values in its error text today, so in practice this
 * changes nothing. It exists because invariant I9 is not a thing to be
 * probabilistic about: the alternative is a log line whose safety depends on the
 * error strings of a database we do not control, and the check costs one
 * comparison on a path that only runs when something is already broken.
 */
function withoutKey(message: string, key: string): string {
  if (message.includes(key)) return 'redacted';

  const address = key.slice(key.indexOf(KEY_SEPARATOR) + 1);
  if (address.length > 0 && address !== UNKNOWN_ADDRESS && message.includes(address)) {
    return 'redacted';
  }

  return message;
}

function readInteger(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  // Double-quoted string literals are enabled on D1 (rule 00 invariant I6), so a
  // mistyped identifier comes back as the identifier text for every row instead
  // of raising. A count that is not a number is that failure, and the only place
  // it can be caught is here, before it is compared against a limit.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BaseclfError('MALFORMED_SQL', 500, {
      message: 'Rate limit query returned an unusable row.',
      detail: `Column "${column}" came back as ${typeof value}, expected a number.`,
    });
  }
  return value;
}

/**
 * Create the table if it is not there.
 *
 * Provisioning, not request handling. Calling this per request would put a DDL
 * statement on the hot path and have every cold isolate race every other one.
 */
export async function ensureRateLimitTable(executor: D1Executor): Promise<void> {
  const statement: CompiledStatement = { sql: RATE_LIMIT_TABLE_DDL, parameters: [] };
  assertExecutable(statement);
  await executor.prepare(statement.sql).run();
}

/**
 * Count one request against `key` and say whether it may proceed.
 *
 * Never throws for an operational failure. A database error is reported as a
 * denial, because a limiter that raises on the way past is a limiter whose
 * caller decides what to do about it, and the tempting decision is the wrong
 * one. Configuration mistakes do throw: those are ours, and they should be loud.
 */
export async function checkRateLimit(
  executor: D1Executor,
  request: RateLimitRequest,
): Promise<RateLimitResult> {
  const { key, limit, windowSeconds } = request;

  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw invalid(`Rate limit key must be 1 to ${MAX_KEY_LENGTH} characters.`);
  }
  assertPositiveInteger(limit, 'limit');
  assertPositiveInteger(windowSeconds, 'windowSeconds');

  const statement: CompiledStatement = { sql: CONSUME_SQL, parameters: [key, windowSeconds] };
  assertExecutable(statement);

  let hits: number;
  let windowStart: number;
  let now: number;

  try {
    const row = await executor
      .prepare(statement.sql)
      .bind(...statement.parameters)
      .first<Record<string, unknown>>();

    if (row === null) {
      // An upsert with RETURNING always yields a row. Reaching here means the
      // statement did not do what this file believes it does.
      throw new BaseclfError('MALFORMED_SQL', 500, {
        message: 'Rate limit query returned no row.',
        detail: 'INSERT ... ON CONFLICT DO UPDATE ... RETURNING produced nothing.',
      });
    }

    hits = readInteger(row, 'hits');
    windowStart = readInteger(row, 'window_start');
    now = readInteger(row, 'now');
  } catch (cause) {
    // Decision 4. Deny, and say why in the log rather than in the return value.
    logError({
      event: 'error',
      code: 'RATE_LIMIT_UNAVAILABLE',
      detail:
        `bucket=${bucketOfKey(key)} limit=${limit} windowSeconds=${windowSeconds} ` +
        `paramCount=${statement.parameters.length} ` +
        `cause=${withoutKey(cause instanceof Error ? cause.message : 'unknown', key)}`,
    });
    return { allowed: false, hits: 0, retryAfterSeconds: windowSeconds };
  }

  const allowed = hits <= limit;
  if (allowed) return { allowed: true, hits, retryAfterSeconds: 0 };

  // Never 0: a Retry-After of zero invites an immediate retry, which is the
  // behaviour being limited in the first place.
  const remaining = windowStart + windowSeconds - now;
  const retryAfterSeconds = remaining > 0 ? remaining : 1;

  // Only refusals are logged. One line per allowed request would be a log entry
  // on every request in the system, and the count that matters for spotting a
  // brute force attempt is this one. No key, no address: invariant I9.
  logEvent({
    event: 'error',
    code: 'RATE_LIMITED',
    detail: `bucket=${bucketOfKey(key)} hits=${hits} limit=${limit} retryAfterSeconds=${retryAfterSeconds}`,
  });

  return { allowed: false, hits, retryAfterSeconds };
}

/**
 * Delete rows whose window closed more than `retentionSeconds` ago. For a cron
 * trigger, not a request.
 *
 * Pass at least the longest window in use, or a row still being counted against
 * will be removed and its caller handed a fresh allowance.
 *
 * This scans the table. That is the other half of decision 5: the sweep is
 * infrequent and the write path is not, so the cost belongs here.
 *
 * Unlike `checkRateLimit` this does throw on a database failure. Nothing is
 * waiting on the answer, so there is no request to wrongly admit, and a sweep
 * that has silently stopped running is a table that grows without bound.
 */
export async function cleanupRateLimits(
  executor: D1Executor,
  retentionSeconds: number,
): Promise<number> {
  assertPositiveInteger(retentionSeconds, 'retentionSeconds');

  const statement: CompiledStatement = { sql: CLEANUP_SQL, parameters: [retentionSeconds] };
  assertExecutable(statement);

  const result = await executor
    .prepare(statement.sql)
    .bind(...statement.parameters)
    .run();

  const changes = (result.meta as { changes?: number } | undefined)?.changes;
  return typeof changes === 'number' ? changes : 0;
}

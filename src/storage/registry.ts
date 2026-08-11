/**
 * Which buckets exist, and what happens when one does not.
 *
 * It throws, for the reason `src/policy/registry.ts` gives at length: a bucket
 * with no registered policy is not a bucket without restrictions. Returning an
 * empty definition would turn "nobody configured this" into "anybody may write
 * here", and the failure would be invisible until somebody found it.
 *
 * Validation happens at load as well as at save. A policy stored before a rule
 * existed, or written straight into the table with `wrangler d1 execute`, would
 * otherwise be trusted on the strength of being in the database. Both paths go
 * through `validateStorageBucket`, so there is no way in that skips it.
 */

import type { D1Executor } from '../db/dialect.js';
import { assertExecutable } from '../db/guards.js';
import { PolicyError } from '../utils/errors.js';
import { logEvent } from '../utils/log.js';
import { isolateMemo } from '../utils/memo.js';
import {
  type StorageBucketDefinition,
  type StorageOperation,
  type StoragePolicy,
  validateStorageBucket,
} from './policy.js';

/**
 * What a bucket may be called.
 *
 * The name arrives as a path segment, so it is caller input on the way in and
 * configuration on the way out, and the two have to agree exactly. Restricting it
 * to lowercase alphanumerics and hyphens means a registered name can never
 * contain a separator, a dot, or a case difference for a lookup to miss.
 *
 * It also matches R2's own bucket naming, which keeps a logical bucket and a real
 * one from having names that cannot both exist.
 */
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const MAX_BUCKET_NAME_LENGTH = 63;

interface BucketRow {
  bucket: string;
  enabled: number;
  version: number;
}

interface PolicyRow {
  bucket: string;
  name: string;
  operation: string;
  roles: string;
  prefix: string;
  max_size_bytes: number | null;
  mime_types: string | null;
}

export interface StorageRegistry {
  /** Every registered bucket. The map itself is the fail-closed lookup. */
  readonly buckets: ReadonlyMap<string, StorageBucketDefinition>;
}

function configurationError(detail: string, cause?: unknown): PolicyError {
  return new PolicyError('INVALID_EXPR', 500, {
    message: 'Storage configuration is not usable.',
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function parseJsonArray(text: string, where: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw configurationError(`${where} does not hold valid JSON.`, cause);
  }

  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw configurationError(`${where} is not a list of strings.`);
  }

  return parsed;
}

async function query<R>(executor: D1Executor, sql: string): Promise<R[]> {
  // Fixed statements over the engine's own tables, no parameters and no
  // interpolation. The guard runs anyway, so that "every path to D1 is guarded"
  // holds without an exception anybody has to remember.
  assertExecutable({ sql, parameters: [] });
  const result = await executor.prepare(sql).all<R>();
  return result.results ?? [];
}

/**
 * Read every storage policy and check it before anything can use it.
 *
 * A bucket whose name is unusable is dropped rather than thrown on, and the same
 * reasoning applies as in the policy registry: throwing would let one bad row
 * take every other bucket down with it, turning a misconfiguration into an
 * outage. Dropping it silently would hide the misconfiguration, so it is logged.
 *
 * A bucket whose *policies* are invalid is a different matter and does throw,
 * because that is a policy somebody wrote intending it to grant something, and
 * quietly dropping it would leave them believing a grant exists.
 */
export async function loadStorageRegistry(executor: D1Executor): Promise<StorageRegistry> {
  const [rows, policies] = await Promise.all([
    query<BucketRow>(executor, 'SELECT bucket, enabled, version FROM _storage_buckets'),
    query<PolicyRow>(
      executor,
      'SELECT bucket, name, operation, roles, prefix, max_size_bytes, mime_types' +
        ' FROM _storage_policies',
    ),
  ]);

  const byBucket = new Map<string, StoragePolicy[]>();
  for (const row of policies) {
    const where = `Storage policy "${row.name}" on "${row.bucket}"`;
    const bucket = byBucket.get(row.bucket) ?? [];

    bucket.push({
      name: row.name,
      // Narrowed rather than asserted. An operation this engine does not know is
      // rejected by `validateStorageBucket`, and until then it is just a string.
      for: row.operation as StorageOperation,
      to: parseJsonArray(row.roles, `${where} roles`),
      prefix: row.prefix,
      ...(row.max_size_bytes === null ? {} : { maxSizeBytes: row.max_size_bytes }),
      ...(row.mime_types === null
        ? {}
        : { allowedMimeTypes: parseJsonArray(row.mime_types, `${where} mime_types`) }),
    });

    byBucket.set(row.bucket, bucket);
  }

  const buckets = new Map<string, StorageBucketDefinition>();
  for (const row of rows) {
    if (row.bucket.length > MAX_BUCKET_NAME_LENGTH || !BUCKET_NAME_PATTERN.test(row.bucket)) {
      logEvent({
        event: 'policy_refusal',
        code: 'TABLE_NOT_EXPOSED',
        table: '_storage_buckets',
        operation: 'load',
        role: '-',
      });
      continue;
    }

    const definition: StorageBucketDefinition = {
      bucket: row.bucket,
      enabled: row.enabled === 1,
      policies: byBucket.get(row.bucket) ?? [],
    };

    // A disabled bucket is configuration rather than a mistake, and its policies
    // may reference a token that is no longer supported. Validating it would turn
    // a switched-off bucket into a failure for every other one. It is still
    // registered, so `authorizeStorage` refuses it for being disabled rather than
    // for being unknown, and the log says which.
    if (!definition.enabled) {
      buckets.set(definition.bucket, definition);
      continue;
    }

    validateStorageBucket(definition);
    buckets.set(definition.bucket, definition);
  }

  return { buckets };
}

/**
 * Per-isolate memo, built lazily inside `fetch`.
 *
 * Not at module scope: the startup CPU budget is one second and global work
 * counts against it (rules/02 §A).
 *
 * ⚠️ Same debt as the policy registry, deliberately and not by accident. The memo
 * is per isolate, so a policy change takes effect as isolates recycle rather than
 * at once across the fleet. `_storage_buckets.version` exists for a fleet-wide
 * invalidation and nothing reads it yet. Copying the shape means copying the debt,
 * so it is written down in both places rather than looking solved in one.
 *
 * 🔴 And it copied a second debt nobody had written down, which is the cost of the
 * paragraph above being about only one of them. `cached ??= loadStorageRegistry(...)`
 * keeps a **rejected** promise, so an isolate that saw one bad row refused every
 * storage request for as long as it lived, repaired data or not. That was reported
 * as F4 against the policy registry alone. It was here too, and in `getCatalogue`.
 * See `utils/memo.ts`.
 */
const memo = isolateMemo<StorageRegistry>();

export function getStorageRegistry(executor: D1Executor): Promise<StorageRegistry> {
  return memo.get(() => loadStorageRegistry(executor));
}

export function resetStorageRegistry(): void {
  memo.reset();
}

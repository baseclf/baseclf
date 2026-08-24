/**
 * A storage document on disk, turned into rows in the database.
 *
 * ## One validator, not two
 *
 * 🔴 This imports `validateStorageBucket` from the engine rather than checking
 * anything itself, for the reason `policy-document.ts` gives at length: a second
 * implementation of a security rule is a second thing to keep correct, and the two
 * drift in the direction nobody notices, with the writer more permissive than the
 * reader. A prefix that this accepted and the engine refused would be a policy that
 * cannot be used; a prefix this accepted and the engine also accepted for a
 * different reason would be worse.
 *
 * Everything it checks is therefore about the shape of the JSON. The moment there is
 * a `StorageBucketDefinition`, the engine decides whether it is allowed.
 *
 * ## Why the write is not a transaction, and why that is fine
 *
 * Same measurement as the policy path, 2026-08-12: the D1 REST API accepts several
 * statements in one request and rolls them back as a unit, but refuses bound
 * parameters when there is more than one statement. So the choice is atomicity or
 * bound parameters, and invariant I7 does not allow a value to be concatenated into
 * SQL under any circumstances.
 *
 * So there is no transaction, and the order makes every half-finished state a
 * **closed** one:
 *
 *   1. Remove the bucket from `_storage_buckets`. From here until the last step
 *      `authorizeStorage` refuses every request for it, because a bucket that is not
 *      in the registry is not a bucket without restrictions (invariant I1).
 *   2. Remove the old policies.
 *   3. Write the new policies.
 *   4. Put the bucket back, with the version bumped.
 *
 * A failure at any point leaves the bucket unreachable rather than reachable with
 * half a policy set.
 *
 * ⚠️ No lock, and that is a difference from the policy path rather than an oversight.
 * `_policy_lock` is keyed by table name and reusing it for a bucket would mean a
 * bucket and a table of the same name blocking each other, which is a coupling
 * nobody would guess. Two operators applying to the same bucket at the same time can
 * therefore interleave. Every intermediate state is still closed, so the failure is
 * one apply's rules being replaced by the other's rather than a mixture being served,
 * but the last writer wins without being told. Debt F3 is the policy-side version of
 * this and it took a lock; this one is named here instead.
 */

import {
  type StorageBucketDefinition,
  type StoragePolicy,
  validateStorageBucket,
} from '../src/storage/policy.js';

/** One statement and its parameters. Never assembled into a string with values in it. */
export interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface StorageDocument {
  readonly definition: StorageBucketDefinition;
}

function fail(message: string): never {
  throw new Error(message);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${where} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where} is not a string.`);
  return value;
}

/**
 * A list of strings, or a refusal naming which entry was not one.
 *
 * The index is in the message because a roles list is written by hand and the entry
 * that is wrong is usually not the first.
 */
function asStrings(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value)) fail(`${where} is not a list.`);
  return value.map((entry, at) => asString(entry, `${where}[${at}]`));
}

function readPolicy(value: unknown, at: number): StoragePolicy {
  const raw = asRecord(value, `policies[${at}]`);
  const name = asString(raw.name, `policies[${at}].name`);

  if (raw.maxSizeBytes !== undefined && typeof raw.maxSizeBytes !== 'number') {
    fail(`Policy "${name}" has a maxSizeBytes that is not a number.`);
  }

  return {
    name,
    // Not narrowed here. An operation this engine does not have is refused by
    // `validateStorageBucket`, which is the one place that knows the list.
    for: asString(raw.for, `policies[${at}].for`) as StoragePolicy['for'],
    to: asStrings(raw.to, `policies[${at}].to`),
    prefix: asString(raw.prefix, `policies[${at}].prefix`),
    ...(raw.maxSizeBytes === undefined ? {} : { maxSizeBytes: raw.maxSizeBytes as number }),
    ...(raw.allowedMimeTypes === undefined
      ? {}
      : { allowedMimeTypes: asStrings(raw.allowedMimeTypes, `policies[${at}].allowedMimeTypes`) }),
  };
}

/**
 * Read a document, and refuse it if the engine would.
 *
 * Two failures are possible and they are different things. A document that is not
 * JSON, or that has a field of the wrong type, is a typo. A document the engine
 * rejects is a policy that would have been wrong, and the message says which rule it
 * broke.
 */
export function readStorageDocument(text: string): StorageDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    fail(`That file is not JSON. ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const raw = asRecord(parsed, 'The document');
  const bucket = asString(raw.bucket, '"bucket"');

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    fail('"enabled" is not true or false.');
  }
  if (!Array.isArray(raw.policies)) fail('"policies" is not a list.');

  const definition: StorageBucketDefinition = {
    bucket,
    // Anything other than an explicit `true` leaves the bucket off, the same
    // reading `parse.ts` gives the same field on a table document. This used to
    // default the other way, on the argument that a document written to grant
    // something should not need a line saying so; that argument was fine and
    // still lost, because it left the two apply paths of one product reading
    // one field name with opposite defaults, and because absent-means-open is
    // not a default this engine has anywhere else. `apply` says which state the
    // bucket landed in, so the closed default cannot pass silently.
    enabled: raw.enabled === true,
    policies: raw.policies.map(readPolicy),
  };

  // The engine, not this file. Everything above is about JSON shape; this is about
  // whether the policy is allowed to exist.
  validateStorageBucket(definition);

  return { definition };
}

/**
 * Every statement an apply runs, in the order that keeps each state closed.
 *
 * Returned as a list rather than run here so a test can read the order without a
 * database, which is the property that matters: the first statement closes the
 * bucket and the last one opens it.
 */
export function storageWriteStatements(
  document: StorageDocument,
  version: number,
): readonly Statement[] {
  const { bucket, enabled, policies } = document.definition;

  return [
    { sql: 'DELETE FROM "_storage_buckets" WHERE "bucket" = ?1', params: [bucket] },
    { sql: 'DELETE FROM "_storage_policies" WHERE "bucket" = ?1', params: [bucket] },
    ...policies.map((policy) => ({
      sql:
        'INSERT INTO "_storage_policies"' +
        ' ("bucket", "name", "operation", "roles", "prefix", "max_size_bytes", "mime_types")' +
        ' VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      params: [
        bucket,
        policy.name,
        policy.for,
        JSON.stringify(policy.to),
        policy.prefix,
        policy.maxSizeBytes ?? null,
        policy.allowedMimeTypes === undefined ? null : JSON.stringify(policy.allowedMimeTypes),
      ],
    })),
    {
      sql: 'INSERT INTO "_storage_buckets" ("bucket", "enabled", "version") VALUES (?1, ?2, ?3)',
      params: [bucket, enabled ? 1 : 0, version],
    },
  ];
}

/** Stop serving a bucket, and forget its rules. The bucket row goes first. */
export function storageRemoveStatements(bucket: string): readonly Statement[] {
  return [
    { sql: 'DELETE FROM "_storage_buckets" WHERE "bucket" = ?1', params: [bucket] },
    { sql: 'DELETE FROM "_storage_policies" WHERE "bucket" = ?1', params: [bucket] },
  ];
}

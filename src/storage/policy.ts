/**
 * Who may put an object where, and under what name.
 *
 * This is the same idea as the row policy engine applied to a key instead of a
 * table, and it deliberately reuses that shape rather than inventing a second
 * permission system. A bucket with no policy for a (operation, role) pair is not
 * reachable, exactly as a table with no policy is not (rule 00 invariant I1), and
 * a refusal is a 404 whether the object is forbidden or absent (invariant I5).
 *
 * The one idea worth reading before the code:
 *
 *   **The caller never supplies a path.** It supplies a single file name, and the
 *   server builds the key by putting the resolved prefix in front of it. The
 *   prefix comes from a template that only the deployment's policies can write,
 *   with claims substituted from a verified token.
 *
 * That is a structural choice rather than a stricter check. A design where the
 * caller sends a whole key and the server verifies it starts with the right
 * prefix has to be right about normalisation: `avatars/u_ann/../u_bob/x.png`
 * starts with the correct prefix as a string and addresses somebody else's
 * directory once anything normalises it. R2 keys are opaque so R2 itself would
 * not normalise it, but a CDN, a browser address bar or a later prefix check
 * might, and being safe only because nothing normalises is not being safe. Here a
 * file name cannot contain a slash at all, so traversal is not something to check
 * for; it cannot be written down.
 *
 * ⚠️ Read `MIME_IS_ADVISORY` before believing anything about file types.
 */

import type { AuthCtx } from '../policy/types.js';
import { PolicyError } from '../utils/errors.js';

export type StorageOperation = 'upload' | 'download' | 'delete';

const STORAGE_OPERATIONS: readonly StorageOperation[] = ['upload', 'download', 'delete'];

/**
 * The claim tokens a prefix template may contain, as a closed set.
 *
 * Closed rather than open, and the reasoning is invariant I6 applied to paths:
 * an unrecognised token has to be an error at validate time, because the
 * alternative is that it survives into a key as literal text. A policy meaning
 * `avatars/$auth.tenant/` that silently produced the single shared directory
 * `avatars/$auth.tenant/` would put every tenant's objects in one place, and
 * nothing would fail while it happened.
 *
 * `$auth.uid` and `$auth.app.<key>`. The two omissions are on purpose:
 *
 *   - `$auth.user.*` is banned outright by invariant I4. The user writes it, so a
 *     prefix built from it is a prefix the user chooses.
 *   - `$auth.email` is refused as well, and that is a judgement rather than an
 *     invariant. Object keys travel: into URLs, into access logs, into a CDN's
 *     cache index. An email address in a key is durable personal data in places
 *     nobody thinks of as a database, and a uid says the same thing about
 *     ownership without saying who the owner is.
 */
const FIXED_PREFIX_TOKENS = {
  '$auth.uid': (auth: AuthCtx): unknown => auth.uid,
} as const;

const APP_TOKEN_PREFIX = '$auth.app.';

/**
 * The claim names `$auth.app.<key>` may address.
 *
 * The same shape `src/policy/parse.ts` accepts after `$auth.app.` and the same
 * one `src/auth/app-metadata.ts` accepts when the claim is stored, so a key
 * spelled in a storage prefix means what it means everywhere else. One level,
 * no nesting: table policies address a flat claim, and a token that meant one
 * thing here and another there teaches the wrong lesson in whichever surface
 * somebody reads first.
 */
const APP_CLAIM_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** What a policy may write, for a message that has to list the options. */
const SUPPORTED_TOKENS = `${Object.keys(FIXED_PREFIX_TOKENS).join(', ')}, ${APP_TOKEN_PREFIX}<key>`;

/**
 * The one place that decides whether a token is a token, and what it reads.
 *
 * Returns `undefined` for anything the engine does not know. Both the validator
 * and the substitution go through here, which matters more now than it did when
 * the set was a plain record: a record answers `token in PREFIX_TOKENS` and
 * `PREFIX_TOKENS[token]` from the same data, while a parameterised family is two
 * pieces of logic unless it is deliberately one. Two would let a token pass when
 * a policy is saved and fail when somebody uploads, which is the failure landing
 * on the wrong person at the wrong time.
 *
 * ⚠️ `Object.hasOwn`, not a plain lookup. `$auth.app.constructor` must not reach
 * up the prototype chain; `src/policy/compile.ts` guards the same way for the
 * same reason.
 */
function prefixTokenReader(token: string): ((auth: AuthCtx) => unknown) | undefined {
  if (token in FIXED_PREFIX_TOKENS) {
    return FIXED_PREFIX_TOKENS[token as keyof typeof FIXED_PREFIX_TOKENS];
  }
  if (token.startsWith(APP_TOKEN_PREFIX)) {
    const key = token.slice(APP_TOKEN_PREFIX.length);
    if (!APP_CLAIM_KEY_PATTERN.test(key)) return undefined;
    return (auth: AuthCtx): unknown => (Object.hasOwn(auth.app, key) ? auth.app[key] : null);
  }
  return undefined;
}

const TOKEN_PATTERN = /\$auth(?:\.[A-Za-z0-9_]+)+/g;

/**
 * A single grant.
 *
 * `maxSizeBytes` and `allowedMimeTypes` belong to the policy rather than to the
 * bucket so that two roles can be trusted differently with the same prefix.
 */
export interface StoragePolicy {
  readonly name: string;
  readonly for: StorageOperation;
  readonly to: readonly string[];
  /** A prefix template. Ends in a slash; claims are substituted from the token. */
  readonly prefix: string;
  /** Upload only. Absent means the deployment has not set a limit, not that there is none. */
  readonly maxSizeBytes?: number;
  /** Upload only, and advisory. See `MIME_IS_ADVISORY`. */
  readonly allowedMimeTypes?: readonly string[];
}

export interface StorageBucketDefinition {
  readonly bucket: string;
  /** Absent or false means the bucket is not exposed at all. */
  readonly enabled: boolean;
  readonly policies: readonly StoragePolicy[];
}

/**
 * ⚠️ A declared MIME type is what the caller said, not what the bytes are.
 *
 * `Content-Type` on an upload is a client-supplied header. Checking it stops an
 * honest client from uploading the wrong thing by accident, and stops nobody who
 * is trying. Establishing what a file actually is means reading its leading bytes,
 * which this does not do.
 *
 * This constant exists so that the limitation is a thing in the code rather than
 * a thing somebody remembers, and so the docs at V8 describe it as it is. "We
 * validate file types" is exactly the sentence rule 00 forbids: it claims an
 * enforcement that is not there.
 */
export const MIME_IS_ADVISORY = true;

/**
 * The longest file name a caller may choose.
 *
 * Ours, not R2's. `rules/01` §F records what has been measured about R2 and a key
 * length limit is not in it, so this is a conservative number chosen to leave room
 * for the prefix rather than a platform limit being restated. Do not raise it by
 * quoting a limit from documentation that has not been measured.
 */
export const MAX_FILE_NAME_LENGTH = 128;

/**
 * What a caller may name a file.
 *
 * The first character has to be alphanumeric, which rules out a leading dot and
 * with it `.`, `..` and hidden names, without needing a rule about any of them.
 * There is no slash in the set, so a name cannot describe a path, so there is no
 * traversal to defend against. Everything else is the ordinary punctuation of a
 * file name.
 */
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Every refusal in this file, and they are all the same refusal.
 *
 * Invariant I5: a caller may not learn whether a bucket exists, whether a policy
 * covers them, or whether an object is there. All three answer identically, and
 * the reason lives in `detail`, which never reaches a response body.
 */
function notFound(detail: string): PolicyError {
  return new PolicyError('NO_POLICY', 404, { message: 'Not found.', detail });
}

function invalid(detail: string): PolicyError {
  return new PolicyError('INVALID_EXPR', 400, { message: 'Invalid policy.', detail });
}

/**
 * Check a bucket's policies at the moment they are saved, not when they are used.
 *
 * The same reasoning as invariant I4 for row policies: a policy that names a
 * forbidden claim must never reach the database, because from then on every
 * deployment reading that row inherits the mistake. Validation at use time would
 * make the error appear during somebody's upload instead, which is both later and
 * somebody else's problem.
 */
export function validateStorageBucket(definition: StorageBucketDefinition): void {
  if (definition.bucket.length === 0) {
    throw invalid('A storage bucket definition has no name.');
  }

  const seen = new Set<string>();

  for (const policy of definition.policies) {
    if (policy.name.length === 0) {
      throw invalid(`A policy on bucket "${definition.bucket}" has no name.`);
    }
    if (seen.has(policy.name)) {
      throw invalid(`Bucket "${definition.bucket}" has two policies named "${policy.name}".`);
    }
    seen.add(policy.name);

    if (!STORAGE_OPERATIONS.includes(policy.for)) {
      throw invalid(`Policy "${policy.name}" is for "${policy.for}", which is not an operation.`);
    }
    if (policy.to.length === 0) {
      throw invalid(`Policy "${policy.name}" grants nothing, because "to" is empty.`);
    }

    validatePrefixTemplate(policy);
    validateUploadLimits(policy);
  }
}

/**
 * A prefix has to end in a separator, and every token in it has to be known.
 *
 * The trailing slash is not cosmetic. Without it a prefix of `avatars/u_ann`
 * also matches the key `avatars/u_annex/secret`, so one user's directory reaches
 * into a directory belonging to a user whose id merely starts the same way. That
 * is the classic prefix bug, and requiring the separator makes it unwritable
 * rather than something a reviewer has to notice.
 */
function validatePrefixTemplate(policy: StoragePolicy): void {
  if (!policy.prefix.endsWith('/')) {
    throw invalid(
      `Policy "${policy.name}" has the prefix "${policy.prefix}", which does not end in "/". ` +
        'Without the separator the prefix also matches keys belonging to any id that merely ' +
        'starts with the same characters.',
    );
  }
  if (policy.prefix.startsWith('/')) {
    throw invalid(`Policy "${policy.name}" has a prefix starting with "/", which is not a key.`);
  }
  if (policy.prefix.includes('//')) {
    throw invalid(`Policy "${policy.name}" has an empty path segment in its prefix.`);
  }
  if (policy.prefix.split('/').includes('..') || policy.prefix.split('/').includes('.')) {
    throw invalid(`Policy "${policy.name}" has a relative segment in its prefix.`);
  }

  for (const token of policy.prefix.match(TOKEN_PATTERN) ?? []) {
    if (prefixTokenReader(token) !== undefined) continue;

    // Named separately because it is the invariant rather than a limitation, and
    // whoever wrote it needs to know it can never be allowed rather than that it
    // is not supported yet.
    if (token.startsWith('$auth.user.')) {
      throw invalid(
        `Policy "${policy.name}" builds its prefix from ${token}. That is user_metadata, ` +
          'which the user writes, so the prefix would be chosen by the caller. Rule 00 ' +
          'invariant I4 forbids it.',
      );
    }

    // Also named separately, because the family is supported and only this
    // spelling of the key is not. Told apart from "no such token", which would
    // send somebody looking for a feature that is already here.
    if (token.startsWith(APP_TOKEN_PREFIX)) {
      throw invalid(
        `Policy "${policy.name}" builds its prefix from ${token}, whose claim name is not a ` +
          'plain identifier. Letters, digits and "_", starting with a letter or "_", and one ' +
          'level: a claim is a flat fact, the same as in a table policy.',
      );
    }

    throw invalid(
      `Policy "${policy.name}" builds its prefix from ${token}, which is not a supported ` +
        `token. Supported: ${SUPPORTED_TOKENS}. An unrecognised token ` +
        'is refused rather than left in the key as text, because a prefix that still ' +
        'contains it would be one shared directory for every caller.',
    );
  }
}

function validateUploadLimits(policy: StoragePolicy): void {
  if (policy.for !== 'upload') {
    if (policy.maxSizeBytes !== undefined || policy.allowedMimeTypes !== undefined) {
      throw invalid(
        `Policy "${policy.name}" is for ${policy.for} but carries upload limits. A limit that ` +
          'does not apply must not look as though it does.',
      );
    }
    return;
  }

  if (policy.maxSizeBytes !== undefined) {
    if (!Number.isSafeInteger(policy.maxSizeBytes) || policy.maxSizeBytes <= 0) {
      throw invalid(`Policy "${policy.name}" has a maxSizeBytes that is not a positive integer.`);
    }
  }
  if (policy.allowedMimeTypes !== undefined && policy.allowedMimeTypes.length === 0) {
    throw invalid(
      `Policy "${policy.name}" has an empty allowedMimeTypes, which would refuse every ` +
        'upload. Omit it to accept any declared type.',
    );
  }
}

/**
 * What a claim may look like once it stands as a path segment in a key.
 *
 * An allowlist rather than a list of dangerous strings, on the reasoning
 * invariant I6 gives about identifiers: a closed set is checked by what it
 * admits, while a denylist is only ever as good as whoever last thought about
 * it. One expression closes the separator, the relative segments, whitespace,
 * control characters, and the empty string together.
 *
 * 🔴 It closes a gap that was open. `validatePrefixTemplate` refuses `.` and
 * `..` written into a prefix, and nothing refused them once they arrived as a
 * substituted value: measured 2026-08-22, a claim of `..` against
 * `avatars/$auth.uid/` produced the key `avatars/../secret.png` and was
 * allowed. R2 stores that literally because R2 keys are opaque, which is
 * exactly the "safe only because nothing normalises" this file opens by
 * refusing to rely on.
 *
 * Not reachable through `$auth.uid` as things stand: Better Auth builds ids
 * from `a-z`, `0-9`, `A-Z` and `-_` (read from its generator on 2026-08-22, so
 * every id it makes already satisfies this), and the user does not choose
 * theirs. It stops being unreachable the moment a claim somebody types by hand
 * can land here, which is what `$auth.app.<key>` would be.
 */
const PREFIX_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Substitute claims into a prefix template.
 *
 * A token whose claim is missing is a refusal, not an empty string. An anonymous
 * caller against `avatars/$auth.uid/` would otherwise be handed `avatars//`, a
 * single directory shared by everybody who is not signed in.
 */
function resolvePrefix(policy: StoragePolicy, auth: AuthCtx): string {
  return policy.prefix.replace(TOKEN_PATTERN, (token) => {
    const read = prefixTokenReader(token);
    if (read === undefined) {
      // Unreachable through a validated policy. Kept because the alternative to a
      // throw here is the token surviving into a key, and this file should not
      // depend on validation having run to be safe.
      throw notFound(`Prefix token ${token} is not supported.`);
    }

    const value = read(auth);
    if (value === null || value === undefined || value === '') {
      throw notFound(
        `Policy "${policy.name}" needs ${token}, which this request does not carry. ` +
          'Refused rather than substituted with an empty segment, which would be a ' +
          'directory shared by every caller in the same position.',
      );
    }

    // A directory name has to be text, and only text. `$auth.app.<key>` can hold
    // anything JSON carries, and every non-string collapses into something worse
    // than a refusal if it is coerced: an object becomes "[object Object]", one
    // shared directory for every caller whose claim happens to be an object, and
    // an array becomes a comma-joined string that passes every check below.
    //
    // Deliberately stricter than `resolveScalarClaim` in the policy compiler,
    // which takes numbers and booleans. That value becomes a bound parameter and
    // is compared; this one becomes part of a key and is stored.
    //
    // ⚠️ Only knowable per request, because the claim belongs to the user rather
    // than to the policy. So the refusal has to say which claim and what it
    // holds: the policy is fine and one caller's metadata is not, and an
    // operator reading "not found" would go and check the policy first.
    if (typeof value !== 'string') {
      throw notFound(
        `Policy "${policy.name}" needs ${token} to be text, and this caller's claim is ` +
          `${Array.isArray(value) ? 'a list' : `a ${typeof value}`}. A key segment is not ` +
          'converted from another type, because every conversion collapses different ' +
          'callers onto the same directory.',
      );
    }

    if (!PREFIX_SEGMENT_PATTERN.test(value)) {
      // A claim is verified, not sanitised. Verified says who wrote it, not what
      // it is safe to build a key out of.
      throw notFound(
        `Policy "${policy.name}" resolved ${token} to a value that is not usable as one ` +
          'path segment. Letters, digits, "_" and "-" only, up to 64 characters.',
      );
    }

    return value;
  });
}

/** Reject a file name the caller may not use. Traversal is not in the set. */
function assertUsableFileName(fileName: string): void {
  if (fileName.length === 0) {
    throw notFound('An object was requested with an empty file name.');
  }
  if (fileName.length > MAX_FILE_NAME_LENGTH) {
    throw notFound(
      `A file name of ${fileName.length} characters was requested, over the limit of ` +
        `${MAX_FILE_NAME_LENGTH}.`,
    );
  }
  if (!FILE_NAME_PATTERN.test(fileName)) {
    throw notFound(
      'A file name outside the permitted character set was requested. Names start with a ' +
        'letter or digit and may then contain letters, digits, dots, underscores and hyphens.',
    );
  }
}

export interface StorageRequest {
  readonly buckets: ReadonlyMap<string, StorageBucketDefinition>;
  readonly bucket: string;
  readonly operation: StorageOperation;
  readonly auth: AuthCtx;
  /** One name, never a path. The key is built here, not by the caller. */
  readonly fileName: string;
}

export interface StorageGrant {
  /** The full object key, built from a policy prefix and a checked file name. */
  readonly key: string;
  /** Which policy allowed it. For the log, and for a refusal to be explainable. */
  readonly policyName: string;
  /** Upload only. Undefined means the deployment set no limit. */
  readonly maxSizeBytes: number | undefined;
  /** Upload only, and advisory. See `MIME_IS_ADVISORY`. */
  readonly allowedMimeTypes: readonly string[] | undefined;
}

/**
 * Decide whether this request may touch this object, and say which key.
 *
 * Throws for every refusal, and every refusal is a 404. Never returns a partial
 * answer: there is no shape in the return type that means "allowed, but check
 * something else first".
 *
 * Fail-closed at four separate points, listed because each one is a place a
 * later change could quietly turn into a default: an unknown bucket, a bucket
 * that is not enabled, no policy matching the operation and role, and more than
 * one policy resolving for the same request.
 *
 * ## Debt 62: why more than one match is a refusal rather than a choice
 *
 * This used to take the first policy whose prefix resolved. That made the order
 * of rows in `_storage_policies` decide which grant applied, and the policy
 * language has no way to say so: nothing in a document expresses precedence, and
 * nothing in the table guarantees an order.
 *
 * ⚠️ Worth being exact about what that cost, because it is not what it looks
 * like. Two download policies with different prefixes never meant "this role can
 * read both directories". It meant the first one was used and **the second was
 * dead**, with its objects unreachable and nothing saying so. So refusing here
 * takes away no working capability. It makes visible a configuration that never
 * did what its author meant.
 *
 * The refusal is here rather than in `validateStorageBucket`, and that is a
 * deliberate trade rather than an oversight. Validation runs at load as well as
 * at save, and an invalid policy throws for the whole bucket, so a new rule there
 * would turn an existing deployment's misconfiguration into an outage across
 * every bucket it has. `loadStorageRegistry` makes the same argument about bucket
 * names in its own comment. Refusing the one ambiguous request keeps the rest of
 * the deployment answering, and the refusal names both policies.
 */
export function authorizeStorage(request: StorageRequest): StorageGrant {
  const definition = request.buckets.get(request.bucket);
  if (definition === undefined) {
    throw notFound(`Bucket "${request.bucket}" is not in the storage registry.`);
  }
  if (!definition.enabled) {
    throw notFound(`Bucket "${request.bucket}" is registered but not enabled.`);
  }

  const matching = definition.policies.filter(
    (policy) => policy.for === request.operation && policy.to.includes(request.auth.role),
  );
  if (matching.length === 0) {
    throw notFound(
      `Bucket "${request.bucket}" has no ${request.operation} policy for role ` +
        `"${request.auth.role}".`,
    );
  }

  assertUsableFileName(request.fileName);

  // Every candidate is resolved, not just candidates up to the first success.
  // Stopping early is what made the row order decide the grant, so the count
  // matters as much as the value and the count is not known until the end.
  //
  // The refusal from the last candidate that failed is kept and rethrown, so a
  // deployment with one policy still gets that policy's reason rather than a
  // generic one. A policy that cannot resolve is not a candidate: a caller with
  // no `$auth.uid` is simply not covered by a policy that needs one, which is how
  // a single bucket serves anon and signed-in callers from separate rules.
  const resolved: { readonly policy: StoragePolicy; readonly prefix: string }[] = [];
  let refusal: unknown;

  for (const policy of matching) {
    try {
      resolved.push({ policy, prefix: resolvePrefix(policy, request.auth) });
    } catch (error) {
      refusal = error;
    }
  }

  if (resolved.length === 0) {
    throw refusal ?? notFound(`No ${request.operation} policy on "${request.bucket}" resolved.`);
  }

  if (resolved.length > 1) {
    // Debt 62. Named in full, because the operator has to find both of them and
    // only one of them was ever doing anything.
    throw notFound(
      `Bucket "${request.bucket}" has ${resolved.length} ${request.operation} policies that ` +
        `resolve for role "${request.auth.role}": ` +
        `${resolved.map((candidate) => `"${candidate.policy.name}"`).join(', ')}. ` +
        'Which one applied would be decided by the order of the rows, and a policy document ' +
        'has no way to express precedence, so this is refused rather than one of them being ' +
        'picked. Narrow the roles or the operations until one policy covers this request.',
    );
  }

  const only = resolved[0];
  if (only === undefined) {
    // Unreachable: the length was just checked. Kept because the alternative to a
    // throw is a non-null assertion on the line that builds a key.
    throw notFound(`No ${request.operation} policy on "${request.bucket}" resolved.`);
  }

  return Object.freeze({
    key: `${only.prefix}${request.fileName}`,
    policyName: only.policy.name,
    maxSizeBytes: only.policy.maxSizeBytes,
    allowedMimeTypes: only.policy.allowedMimeTypes,
  });
}

/**
 * Check an upload against the limits its grant carries, before anything is written.
 *
 * Separate from `authorizeStorage` because it answers a different question at a
 * different moment: that one decides whether a key may be touched at all, this
 * one decides whether these particular bytes may go there. Keeping them apart is
 * what lets the router refuse on the declared length before it opens a stream.
 *
 * ⚠️ `declaredLength` is a header. A caller may understate it or omit it, so this
 * is the cheap refusal rather than the enforcement, and the router still has to
 * cap the stream it writes. Treating this as the limit would mean a lying
 * `Content-Length` uploads whatever it likes.
 */
export function assertUploadAllowed(
  grant: StorageGrant,
  declaredLength: number | null,
  declaredMimeType: string | null,
): void {
  if (
    grant.maxSizeBytes !== undefined &&
    declaredLength !== null &&
    declaredLength > grant.maxSizeBytes
  ) {
    throw new PolicyError('INVALID_EXPR', 413, {
      message: 'Payload too large.',
      detail: `${declaredLength} bytes declared, over the ${grant.maxSizeBytes} byte limit.`,
    });
  }

  if (grant.allowedMimeTypes === undefined) return;

  // Parameters after the type are dropped: `text/plain; charset=utf-8` is the
  // same type as `text/plain`, and comparing the whole header would refuse an
  // ordinary request for a reason nobody could guess from the message.
  const declared = (declaredMimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

  if (!grant.allowedMimeTypes.some((allowed) => allowed.toLowerCase() === declared)) {
    throw new PolicyError('INVALID_EXPR', 415, {
      message: 'Unsupported media type.',
      detail:
        `The caller declared "${declared || '(none)'}", which policy "${grant.policyName}" ` +
        'does not list. Note that this checks the declared type, not the bytes.',
    });
  }
}

/**
 * Objects in and out, through this Worker rather than around it.
 *
 * Every byte passes through here on purpose. R2 egress is free, so the proxy
 * costs nothing that a presigned URL would save, and it is the only arrangement
 * where a policy decision sits on the path of the bytes rather than beside it. A
 * presigned URL is a capability handed out in advance: once issued it cannot be
 * reconsidered, and nothing about the request that redeems it reaches this code.
 *
 * The size limit is the part worth reading, because the obvious implementation
 * does not work and the reason was measured rather than reasoned about.
 * `src/storage/r2-behaviour.test.ts` records the probes; the short version:
 *
 *   - `put` REFUSES a hand-made ReadableStream: "must have a known length". So
 *     the natural cap, piping the body through a TransformStream that counts
 *     bytes and errors past the limit, cannot be built at all. It produces a
 *     stream of unknown length.
 *   - A streamed request body does not have a known length either, even with
 *     Content-Length set. So `put(key, request.body)` is not dependable; whether
 *     it works depends on how the request was constructed.
 *   - `put` does accept the readable half of a `FixedLengthStream`, and that
 *     stream refuses both more bytes than were declared ("Attempt to write too
 *     many bytes") and fewer. The runtime does the enforcing.
 *
 * So the cap is two things in sequence, and neither is a byte counter here:
 *
 *   1. The declared length is checked against the policy limit BEFORE anything
 *      opens. A caller cannot declare more than it is allowed.
 *   2. The body is written through a FixedLengthStream of exactly that declared
 *      length. A caller cannot then send more than it declared, because the
 *      runtime stops it.
 *
 * An upload with no Content-Length is refused rather than guessed at. There is no
 * length to declare, so there is no limit to enforce, and an unbounded upload is
 * not a thing this should accept because a header was missing.
 *
 * A rejected `put` leaves nothing behind, which was measured too, so a refused
 * upload needs no cleanup.
 */

import type { D1Executor } from '../db/dialect.js';
import type { AuthCtx } from '../policy/types.js';
import { BaseclfError, PolicyError } from '../utils/errors.js';
import { logEvent } from '../utils/log.js';
import { forgetObject, recordObject } from './objects.js';
import {
  assertUploadAllowed,
  authorizeStorage,
  authorizeStorageListing,
  type StorageBucketDefinition,
  type StorageGrant,
} from './policy.js';

/**
 * What a download may say about itself.
 *
 * A closed list, for the same reason the CORS layer has one: a header echoed from
 * stored metadata is a header an uploader chose, and an uploader who can set
 * `Content-Disposition` or `Content-Security-Policy` on a response this origin
 * serves can turn a file upload into a page. Only these three come back, and only
 * the ones R2 recorded from the upload's own declared type.
 */
const RETURNED_OBJECT_HEADERS = ['content-type', 'content-length', 'etag'] as const;

export interface StorageContext {
  readonly bucket: R2Bucket;
  readonly buckets: ReadonlyMap<string, StorageBucketDefinition>;
  readonly auth: AuthCtx;
  /**
   * Where the D1 record of the object goes.
   *
   * Required. It used to be optional "for tests", while every context the worker
   * or a suite actually built carried one, so the only thing the `?` bought was
   * a representable state in which records are silently skipped on a security
   * path (debt 80). Never a way to write bytes with no trace, but a state
   * nothing needs is a state better left unrepresentable.
   */
  readonly db: D1Executor;
  /** The logical bucket from the path, not the R2 binding. */
  readonly bucketName: string;
  readonly fileName: string;
}

/** Every refusal on this path, and they are all indistinguishable. See invariant I5. */
function notFound(detail: string): PolicyError {
  return new PolicyError('NO_POLICY', 404, { message: 'Not found.', detail });
}

/**
 * The declared length, or a refusal.
 *
 * Refusing an absent header is the fail-closed reading and it is also the honest
 * one: without a length there is nothing to enforce a limit against. 411 says
 * exactly that, and it is one of the few statuses whose meaning a caller can act
 * on without reading any documentation.
 */
function declaredLength(request: Request): number {
  const header = request.headers.get('content-length');
  if (header === null) {
    throw new PolicyError('INVALID_EXPR', 411, {
      message: 'Length required.',
      detail:
        'An upload arrived with no Content-Length. The size limit is enforced against the ' +
        'declared length, so an upload that declares nothing cannot be bounded and is ' +
        'refused rather than accepted unbounded.',
    });
  }

  const length = Number(header);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new PolicyError('INVALID_EXPR', 400, {
      message: 'Invalid Content-Length.',
      detail: `Content-Length was "${header}", which is not a byte count.`,
    });
  }

  return length;
}

/**
 * Stream the body into R2, bounded by the length the caller declared.
 *
 * The two promises run together, and both are awaited. Awaiting only the `put`
 * would leave the pipe's failure unobserved, which is how an upload that the
 * runtime refused becomes an unhandled rejection instead of a response.
 */
async function writeBounded(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  length: number,
  contentType: string | null,
): Promise<R2Object> {
  const bounded = new FixedLengthStream(length);

  // `pipeTo` rather than a hand-rolled pump, and that was measured rather than
  // assumed. A length mismatch produces four unobserved promise rejections per
  // request in workerd, logged as `uncaught exception ... internal error`. They are
  // harmless: the failure still surfaces as a 400 and nothing is stored, proven by
  // the tests either way.
  //
  // Replacing this line with a manual reader/writer loop that observes every promise
  // it creates was tried, and it took the count from eight to six across the two
  // suites that provoke it. So six of the eight come from inside R2's own handling of
  // a cancelled readable, which no arrangement here reaches, and the twenty lines
  // bought a quarter of the noise. Reverted.
  //
  // ⚠️ The cost is real and belongs in the record: on a deployment these appear in
  // the platform's exception log for what is an ordinary bad request.
  const piping = body.pipeTo(bounded.writable);
  const storing = bucket.put(key, bounded.readable, {
    ...(contentType === null ? {} : { httpMetadata: { contentType } }),
  });

  // `allSettled` rather than `all`, and the first version of this used `all` and
  // was wrong. When the length does not match, both halves fail, and `all` rejects
  // with whichever lost the race. That was the raw runtime TypeError from `put`,
  // so the translation attached to the pipe never ran and the caller got a 500 for
  // its own mistake. Settling both means the outcome is inspected rather than
  // raced, and neither rejection goes unobserved.
  const [piped, stored] = await Promise.allSettled([piping, storing]);

  if (piped.status === 'rejected' || stored.status === 'rejected') {
    const cause =
      piped.status === 'rejected' ? piped.reason : (stored as PromiseRejectedResult).reason;

    if (isLengthMismatch(piped, stored)) {
      throw new PolicyError('INVALID_EXPR', 400, {
        message: 'Upload did not match its declared length.',
        detail:
          `The body sent for ${key} was not exactly ${length} bytes. The runtime refuses ` +
          'both more and less, and nothing was stored.',
        cause,
      });
    }

    // Not the caller's fault as far as anything here can tell, so it is not
    // reported as theirs. Blaming a caller for a bucket that is unavailable sends
    // them to change a request that was correct.
    throw cause;
  }

  return stored.value;
}

/**
 * Whether a failed write was the caller sending a different number of bytes.
 *
 * Matched on the runtime's message, which is fragile and is the least satisfying
 * part of this file. The two messages were measured, in
 * `r2-behaviour.test.ts`: "Attempt to write too many bytes through a
 * FixedLengthStream" and "FixedLengthStream did not see all expected bytes".
 *
 * A message match is used rather than treating every failure as the caller's
 * because the alternative misattributes: a bucket that is unavailable would be
 * reported as a bad request, and whoever received it would go and change a request
 * that was already correct. If the wording changes, this stops recognising a
 * length mismatch and those become 500s, which is the safe direction to break in:
 * a confusing status on a real client error, rather than a client error invented
 * for a server problem.
 */
function isLengthMismatch(...outcomes: readonly PromiseSettledResult<unknown>[]): boolean {
  return outcomes.some(
    (outcome) =>
      outcome.status === 'rejected' &&
      typeof (outcome.reason as { message?: unknown })?.message === 'string' &&
      (outcome.reason as { message: string }).message.includes('FixedLengthStream'),
  );
}

/**
 * Accept an upload, or refuse it before a byte is stored.
 *
 * The order is the point. Authorisation, then the declared length, then the
 * policy limits, and only then is anything opened. Every refusal above happens
 * without touching R2 at all.
 */
export async function uploadObject(
  context: StorageContext,
  request: Request,
): Promise<{ key: string; etag: string }> {
  const grant = authorizeStorage({
    buckets: context.buckets,
    bucket: context.bucketName,
    operation: 'upload',
    auth: context.auth,
    fileName: context.fileName,
  });

  const length = declaredLength(request);
  const contentType = request.headers.get('content-type');
  assertUploadAllowed(grant, length, contentType);

  if (request.body === null) {
    throw new PolicyError('INVALID_EXPR', 400, {
      message: 'Upload had no body.',
      detail: `A ${length} byte upload was declared for ${grant.key} with no body at all.`,
    });
  }

  const stored = await writeBounded(context.bucket, grant.key, request.body, length, contentType);

  // Bytes first, record second. See the note at the top of `objects.ts`: R2 is the
  // truth and D1 follows it, so a failure here leaves an object with no record
  // rather than a record for an object that is not there. The second is worse,
  // because then a join returns a row and the image it points at is a 404.
  await recordObject(context.db, {
    key: grant.key,
    bucket: context.bucketName,
    auth: context.auth,
    sizeBytes: length,
    contentType,
  });

  // The key is a path built from a verified claim, so it is not caller data, but
  // it is also not interesting enough to log on every upload. The policy name and
  // the size are what an operator needs to see.
  logEvent({
    event: 'storage_write',
    operation: 'upload',
    policy: grant.policyName,
    bytes: length,
  });

  return { key: grant.key, etag: stored.etag };
}

/**
 * Serve an object, or refuse in the way that says nothing.
 *
 * An object the policy does not reach and an object that is not there answer
 * identically, which is invariant I5 at this boundary. Without that, iterating
 * names tells an attacker what exists.
 */
export async function downloadObject(context: StorageContext): Promise<Response> {
  const grant = authorizeStorage({
    buckets: context.buckets,
    bucket: context.bucketName,
    operation: 'download',
    auth: context.auth,
    fileName: context.fileName,
  });

  const object = await context.bucket.get(grant.key);
  if (object === null) {
    throw notFound(`${grant.key} is not in the bucket.`);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);

  // Rebuilt from the closed list rather than passed through. `writeHttpMetadata`
  // writes whatever the uploader declared, and an uploader who can set arbitrary
  // response headers on this origin has more than an upload.
  const safe = new Headers();
  for (const name of RETURNED_OBJECT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) safe.set(name, value);
  }
  safe.set('content-length', String(object.size));
  safe.set('etag', object.httpEtag);

  return new Response(object.body, { status: 200, headers: safe });
}

/**
 * Remove an object.
 *
 * R2 reports a delete of a key that was never there as success, which was
 * measured, and that is the behaviour invariant I5 wants: a delete cannot be used
 * to find out what exists. So this does not check first and does not report
 * whether anything was there.
 */
export async function deleteObject(context: StorageContext): Promise<void> {
  const grant = authorizeStorage({
    buckets: context.buckets,
    bucket: context.bucketName,
    operation: 'delete',
    auth: context.auth,
    fileName: context.fileName,
  });

  // Bytes first here too, and this direction is the stronger argument. A failure
  // after this line leaves a record for something already gone, which is a lie SQL
  // tells and nothing more. The other order would leave the BYTES in place after
  // the caller asked for them to be deleted, still downloadable by anyone who
  // knows the key, which is the deletion not having happened.
  await context.bucket.delete(grant.key);
  await forgetObject(context.db, grant.key);

  logEvent({
    event: 'storage_write',
    operation: 'delete',
    policy: grant.policyName,
    bytes: 0,
  });
}

/**
 * How many objects a listing returns when the caller does not say.
 *
 * Modest on purpose. A listing is the one storage call whose cost grows with what
 * is in the bucket rather than with what the caller sent, so the default is a
 * screenful and asking for more is a deliberate act.
 */
const DEFAULT_LIST_LIMIT = 100;

/**
 * The most a listing will ask R2 for in one call.
 *
 * Measured rather than quoted: `r2-list-behaviour.test.ts` asks R2 what its own
 * ceiling is, and 1000 is what came back. A caller asking for more is clamped
 * rather than refused, because the number is a preference and there is nothing
 * for them to fix.
 */
const MAX_LIST_LIMIT = 1000;

export interface StorageListingContext {
  readonly bucket: R2Bucket;
  readonly buckets: ReadonlyMap<string, StorageBucketDefinition>;
  readonly auth: AuthCtx;
  /** The logical bucket from the path, not the R2 binding. */
  readonly bucketName: string;
  /** A file name to resume after, never a key and never a cursor. */
  readonly after: string | undefined;
  readonly limit: number | undefined;
}

export interface ListedObject {
  /**
   * The file name, with the directory taken off.
   *
   * ⭐ A name rather than a key, and that is the whole shape of this endpoint. A
   * caller that holds a path is a caller that can send one back, and every other
   * operation here is built on them never having one. What comes out of a listing
   * is exactly what goes into a download.
   */
  readonly name: string;
  readonly size: number;
  readonly uploaded: string;
  readonly etag: string;
}

export interface ObjectListing {
  readonly objects: readonly ListedObject[];
  /** Hand back as `after` to continue, or absent when there is nothing to continue from. */
  readonly next: string | undefined;
  /** Whether R2 had more to give. See the note on `next` being absent while this is true. */
  readonly truncated: boolean;
  /**
   * Directories inside this one, counted rather than listed.
   *
   * They exist: `wrangler r2 object put` can write `avatars/u_ann/old/x.png`, even
   * though this API cannot, since a file name may not contain a separator. Such an
   * object has no name this endpoint can hand out and no name a download could
   * take back, so it is not an object here. Counting them keeps a screen from
   * saying a directory is empty when it is not.
   */
  readonly folders: number;
}

/**
 * List the one directory this caller may list.
 *
 * ⚠️ `delimiter` is doing real work, not tidying the output. Without it a nested
 * key comes back as an object with no addressable name, which has to be skipped,
 * and skipping breaks paging: a page whose objects were all nested would resume
 * from where it started. With it there is nothing to skip, because every object in
 * the answer is directly under the prefix. Measured in `r2-list-behaviour.test.ts`
 * before this was written.
 */
export async function listObjects(context: StorageListingContext): Promise<ObjectListing> {
  const listing = authorizeStorageListing({
    buckets: context.buckets,
    bucket: context.bucketName,
    auth: context.auth,
    after: context.after,
  });

  const limit = Math.min(Math.max(context.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  const page = await context.bucket.list({
    prefix: listing.prefix,
    delimiter: '/',
    limit,
    ...(listing.startAfter === undefined ? {} : { startAfter: listing.startAfter }),
  });

  const objects = page.objects.map((object) => ({
    name: object.key.slice(listing.prefix.length),
    size: object.size,
    uploaded: object.uploaded.toISOString(),
    etag: object.etag,
  }));

  // ⚠️ `next` is absent when there is nothing on this page to resume from, and
  // `truncated` still says there is more. The two are reported separately rather
  // than collapsed, because "no more" and "more that this cannot reach" are
  // different answers and a caller that reads the first for the second stops early
  // believing it saw everything.
  const last = objects.at(-1);

  logEvent({
    event: 'storage_read',
    operation: 'list',
    policy: listing.policyName,
    objects: objects.length,
  });

  return {
    objects,
    next: page.truncated && last !== undefined ? last.name : undefined,
    truncated: page.truncated,
    folders: page.delimitedPrefixes.length,
  };
}

/**
 * Turn any failure from this path into a response, without inventing one.
 *
 * Anything that is not a `BaseclfError` is ours rather than the caller's, so it
 * becomes a 500 with nothing in the body. A message from an unexpected throw is
 * the one place an internal detail reaches a client by accident.
 */
export function storageErrorResponse(error: unknown): Response {
  if (error instanceof BaseclfError) {
    return Response.json(error.toResponseBody(), { status: error.status });
  }

  return Response.json({ error: 'Internal error.', code: 'D1_QUERY_FAILED' }, { status: 500 });
}

/** Re-exported so a caller does not have to know which file a grant came from. */
export type { StorageGrant };

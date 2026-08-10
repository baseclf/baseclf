/**
 * The upload path, tested against a caller who lies about the size.
 *
 * `assertUploadAllowed` only reads a header, so on its own it stops nobody: a
 * caller can declare five bytes and send five megabytes. Closing that is the whole
 * reason this file exists, and the test that matters most is the one where the
 * declared length and the body disagree.
 *
 * The bound comes from the runtime rather than from a byte counter here, because
 * `put` refuses a stream of unknown length and a counter produces exactly that.
 * See `r2-behaviour.test.ts` for the probes that establish it.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthCtx } from '../policy/types.js';
import { BaseclfError } from '../utils/errors.js';
import type { StorageBucketDefinition } from './policy.js';
import { deleteObject, downloadObject, type StorageContext, uploadObject } from './router.js';

interface Bindings {
  readonly BUCKET: R2Bucket;
}

const bucket = (env as unknown as Bindings).BUCKET;

const ANN: AuthCtx = { role: 'authenticated', uid: 'u_ann', email: 'ann@test', app: {} };
const BOB: AuthCtx = { ...ANN, uid: 'u_bob', email: 'bob@test' };

const AVATARS: StorageBucketDefinition = {
  bucket: 'avatars',
  enabled: true,
  policies: [
    {
      name: 'upload_own',
      for: 'upload',
      to: ['authenticated'],
      prefix: 'avatars/$auth.uid/',
      maxSizeBytes: 1024,
      allowedMimeTypes: ['image/png'],
    },
    { name: 'read_own', for: 'download', to: ['authenticated'], prefix: 'avatars/$auth.uid/' },
    { name: 'delete_own', for: 'delete', to: ['authenticated'], prefix: 'avatars/$auth.uid/' },
  ],
};

function context(overrides: Partial<StorageContext> = {}): StorageContext {
  return {
    bucket,
    buckets: new Map([['avatars', AVATARS]]),
    auth: ANN,
    bucketName: 'avatars',
    fileName: 'me.png',
    ...overrides,
  };
}

/** A request whose declared length is whatever you say, and whose body is whatever you send. */
function upload(
  bytes: number,
  options: { declare?: number; type?: string | null; body?: boolean } = {},
): Request {
  const declared = options.declare ?? bytes;
  const type = options.type === undefined ? 'image/png' : options.type;

  const headers = new Headers({ 'content-length': String(declared) });
  if (type !== null) headers.set('content-type', type);

  if (options.body === false) {
    return new Request('https://example.test/', { method: 'PUT', headers });
  }

  // A stream rather than a buffer, on purpose. A buffered body would let the
  // runtime work out the real length and the disagreement being tested would
  // never reach the code under test.
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(new Uint8Array(bytes).fill(65));
    },
  });

  return new Request('https://example.test/', {
    method: 'PUT',
    headers,
    body,
    duplex: 'half',
  } as RequestInit);
}

async function refusal(work: Promise<unknown>): Promise<BaseclfError> {
  let thrown: unknown;
  try {
    await work;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(BaseclfError);
  return thrown as BaseclfError;
}

describe('an honest upload', () => {
  beforeEach(async () => {
    await bucket.delete('avatars/u_ann/me.png');
  });

  it('is stored under the key the policy decided', async () => {
    const result = await uploadObject(context(), upload(64));

    expect(result.key).toBe('avatars/u_ann/me.png');
    expect((await bucket.head('avatars/u_ann/me.png'))?.size).toBe(64);
  });

  it('goes to a different key for a different caller', async () => {
    await uploadObject(context({ auth: BOB }), upload(32));

    expect((await bucket.head('avatars/u_bob/me.png'))?.size).toBe(32);
    await bucket.delete('avatars/u_bob/me.png');
  });

  it('keeps the declared content type on the way back out', async () => {
    await uploadObject(context(), upload(16));
    const response = await downloadObject(context());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe('16');
  });

  it('can be deleted, and deleting again is not an error', async () => {
    await uploadObject(context(), upload(16));
    await deleteObject(context());

    expect(await bucket.head('avatars/u_ann/me.png')).toBeNull();
    // R2 reports a delete of an absent key as success, so a delete cannot be used
    // to find out what exists. Invariant I5 on this path depends on it.
    await expect(deleteObject(context())).resolves.toBeUndefined();
  });
});

describe('⭐ a caller who lies about the size', () => {
  beforeEach(async () => {
    await bucket.delete('avatars/u_ann/small.png');
  });

  it('cannot store more than it declared', async () => {
    // The hole this file was written to close. Five bytes declared, a kilobyte
    // sent. `assertUploadAllowed` sees five and is satisfied, so if nothing else
    // acted the kilobyte would land in the bucket.
    const error = await refusal(
      uploadObject(context({ fileName: 'small.png' }), upload(1024, { declare: 5 })),
    );

    expect(error.status).toBe(400);
    expect(error.detail).toContain('not exactly 5 bytes');

    // And nothing was stored. A refused upload that left a partial object would
    // still cost storage and still serve bytes on the next download.
    expect(await bucket.head('avatars/u_ann/small.png')).toBeNull();
  });

  it('cannot store less than it declared either', async () => {
    // The other direction. An upload that ends early must not be stored as a
    // truncated object that looks complete.
    const error = await refusal(
      uploadObject(context({ fileName: 'small.png' }), upload(5, { declare: 512 })),
    );

    expect(error.status).toBe(400);
    expect(await bucket.head('avatars/u_ann/small.png')).toBeNull();
  });

  it('cannot declare more than the policy allows, and never opens a stream', async () => {
    // The cheap refusal, and the reason the runtime's bound is enough: a caller
    // cannot declare a number above the limit, so the length the runtime enforces
    // is always inside it.
    const error = await refusal(
      uploadObject(context({ fileName: 'small.png' }), upload(8, { declare: 1025 })),
    );

    expect(error.status).toBe(413);
    expect(await bucket.head('avatars/u_ann/small.png')).toBeNull();
  });
});

describe('a failure that is not the caller', () => {
  it('is not reported as a bad request', async () => {
    // The mistake this guards against is subtle and common: translate every
    // failed write into a 4xx, and a bucket that is unavailable tells the caller
    // its request was wrong. They then go and change a request that was correct.
    //
    // The discriminator is a match on the runtime's message, which is the weakest
    // part of the upload path, so it gets a test of its own rather than a comment
    // saying it should be fine.
    // The fake has to DRAIN the body before it fails, and the first version of
    // this test did not. Rejecting immediately leaves nothing reading the readable
    // half, so `pipeTo` never settles and the test times out after five seconds.
    //
    // It reported as a kill for five unrelated mutations before that was noticed,
    // which is the mutation-testing trap in reverse: a test that always fails
    // makes every mutation look caught. Worth more than the fix itself, because a
    // real bucket reads the body and then fails, which is what this now models.
    const broken = {
      put: async (_key: string, body: ReadableStream<Uint8Array>) => {
        await new Response(body).arrayBuffer();
        throw new Error('R2 is having a day');
      },
    } as unknown as R2Bucket;

    let thrown: unknown;
    try {
      await uploadObject(context({ bucket: broken, fileName: 'server.png' }), upload(8));
    } catch (error) {
      thrown = error;
    }

    // Not a BaseclfError, so `storageErrorResponse` turns it into a 500 with
    // nothing in the body. The caller learns that this end is broken, which is
    // true, and nothing about why.
    expect(thrown).not.toBeInstanceOf(BaseclfError);
    expect((thrown as Error).message).toBe('R2 is having a day');
  });
});

describe('an upload that cannot be bounded', () => {
  it('is refused with 411 when it declares no length', async () => {
    const request = new Request('https://example.test/', {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);

    const error = await refusal(uploadObject(context(), request));

    expect(error.status).toBe(411);
    expect(error.detail).toContain('cannot be bounded');
  });

  it('is refused when the declared length is not a byte count', async () => {
    const request = new Request('https://example.test/', {
      method: 'PUT',
      headers: { 'content-length': 'lots', 'content-type': 'image/png' },
    });

    expect((await refusal(uploadObject(context(), request))).status).toBe(400);
  });

  it('is refused when the declared length is negative', async () => {
    // A mutation is why this exists. Removing `length < 0` survived the suite,
    // because "lots" is caught by the integer check and nothing else covered a
    // number that parses fine and cannot be a byte count. A negative length would
    // reach `new FixedLengthStream(-1)`, and what that does is not something this
    // code should be finding out at runtime.
    const request = new Request('https://example.test/', {
      method: 'PUT',
      headers: { 'content-length': '-1', 'content-type': 'image/png' },
    });

    const error = await refusal(uploadObject(context(), request));

    // The diagnostic, not just the status, and the first version of this test
    // taught the lesson the hard way. It asserted 400 and that the detail
    // mentioned "-1", and it passed with the check removed: the request had no
    // body, so a different 400 fired and its detail said "A -1 byte upload was
    // declared". Two refusals that both say 400 and both quote the number are not
    // distinguishable, so the assertion has to name the branch.
    expect(error.status).toBe(400);
    expect(error.detail).toContain('not a byte count');
  });

  it('is refused when there is no body at all', async () => {
    const error = await refusal(uploadObject(context(), upload(0, { declare: 8, body: false })));
    expect(error.status).toBe(400);
  });
});

describe('what the policy refuses before R2 is touched', () => {
  it('refuses a type the policy does not list, with 415', async () => {
    const error = await refusal(
      uploadObject(context({ fileName: 'doc.png' }), upload(8, { type: 'application/pdf' })),
    );

    expect(error.status).toBe(415);
    expect(await bucket.head('avatars/u_ann/doc.png')).toBeNull();
  });

  it('refuses an operation the bucket has no policy for', async () => {
    const readOnly = new Map([
      ['avatars', { ...AVATARS, policies: [AVATARS.policies[1]!] } as StorageBucketDefinition],
    ]);

    const error = await refusal(uploadObject(context({ buckets: readOnly }), upload(8)));
    expect(error.status).toBe(404);
  });

  it('refuses a name that tries to leave the directory', async () => {
    const error = await refusal(
      uploadObject(context({ fileName: '../u_bob/theirs.png' }), upload(8)),
    );

    expect(error.status).toBe(404);
    expect(await bucket.head('avatars/u_bob/theirs.png')).toBeNull();
  });
});

describe('a download of somebody else', () => {
  it('cannot be addressed at all, so it reads as absent', async () => {
    // Bob uploads, Ann asks for the same file name. Ann's key resolves under her
    // own prefix, so she gets her own missing object rather than his.
    await uploadObject(context({ auth: BOB, fileName: 'secret.png' }), upload(16));

    const error = await refusal(downloadObject(context({ fileName: 'secret.png' })));
    expect(error.status).toBe(404);
    expect(error.toResponseBody()).toEqual({ error: 'Not found.', code: 'NOT_FOUND' });

    // His object is still there, so the refusal was about addressing and not
    // about the object having failed to store.
    expect((await bucket.head('avatars/u_bob/secret.png'))?.size).toBe(16);
    await bucket.delete('avatars/u_bob/secret.png');
  });

  it('says the same thing as a download of nothing', async () => {
    const missing = await refusal(downloadObject(context({ fileName: 'nothing.png' })));
    const forbidden = await refusal(
      downloadObject(context({ bucketName: 'not-a-bucket', fileName: 'x.png' })),
    );

    expect(missing.toResponseBody()).toEqual(forbidden.toResponseBody());
    expect(missing.detail).not.toBe(forbidden.detail);
  });
});

describe('the headers a download is allowed to set', () => {
  it('returns only the closed list, whatever the uploader declared', async () => {
    // An uploader who can set arbitrary response headers on this origin has more
    // than an upload: Content-Disposition alone turns a file into a download
    // prompt, and a policy header turns it into a page.
    await bucket.put('avatars/u_ann/crafted.png', new Uint8Array(8), {
      httpMetadata: {
        contentType: 'image/png',
        contentDisposition: 'attachment; filename="invoice.pdf"',
      },
    });

    const response = await downloadObject(context({ fileName: 'crafted.png' }));
    const names = [...response.headers.keys()].sort();

    expect(names).toEqual(['content-length', 'content-type', 'etag']);
    expect(response.headers.get('content-disposition')).toBeNull();

    await bucket.delete('avatars/u_ann/crafted.png');
  });
});

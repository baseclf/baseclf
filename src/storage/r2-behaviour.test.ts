/**
 * What R2 does when a stream we are writing goes wrong.
 *
 * The upload path has to stop a caller who understates `Content-Length` and then
 * sends more, which means erroring a stream that `put` is already reading. Whether
 * that is safe depends on answers `rules/01` §F does not have, so they are measured
 * here rather than assumed:
 *
 *   1. Does `put` accept a `ReadableStream` at all, without being told a length?
 *   2. When the stream errors part way, does `put` reject?
 *   3. Does it leave a partial object behind?
 *
 * Answer 3 is the one that decides the design. If a failed upload leaves half an
 * object, refusing the request is not enough on its own and the key has to be
 * cleaned up, which is a second failure mode to get right.
 *
 * These are probes rather than tests of our code, and they stay in the suite for
 * the reason the D1 probes did: the platform changes, and an assumption nobody
 * re-checks is the kind that breaks quietly.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

interface Bindings {
  readonly BUCKET: R2Bucket;
}

const bucket = (env as unknown as Bindings).BUCKET;

/** A stream that yields `chunks` chunks of `size` bytes, then errors if told to. */
function stream(
  chunks: number,
  size: number,
  failAfter: number | null,
): ReadableStream<Uint8Array> {
  let sent = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== null && sent >= failAfter) {
        controller.error(new Error('the caller sent more than it declared'));
        return;
      }
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(size).fill(65));
    },
  });
}

describe('R2 in this environment', () => {
  beforeAll(() => {
    expect(bucket, 'the BUCKET binding is missing from the test environment').toBeDefined();
  });

  it('is bound and answers a round trip', async () => {
    await bucket.put('probe/round-trip', 'hello');
    const got = await bucket.get('probe/round-trip');

    expect(await got?.text()).toBe('hello');
    await bucket.delete('probe/round-trip');
  });

  it('🔴 REFUSES a hand-made ReadableStream, because it has no known length', async () => {
    // The finding that decides the upload design, and the reason it is worth
    // probing before writing any of it.
    //
    // The obvious way to cap an upload is to pipe the request body through a
    // TransformStream that counts bytes and errors past the limit. That produces
    // a plain ReadableStream, whose length is unknown, and this is R2 refusing
    // exactly that. So the counting approach cannot be built at all, and the cap
    // has to come from somewhere the runtime already knows the length.
    let message = '';
    try {
      await bucket.put('probe/streamed', stream(4, 1024, null));
    } catch (error) {
      message = (error as Error).message;
    }

    console.log(`  put(hand-made stream) -> ${message}`);
    expect(message).toContain('known length');
  });

  it('accepts the readable half of a FixedLengthStream', async () => {
    // The way out. The length is declared up front, so the runtime knows it.
    const fixed = new FixedLengthStream(4096);

    const writing = (async () => {
      const writer = fixed.writable.getWriter();
      for (let n = 0; n < 4; n += 1) await writer.write(new Uint8Array(1024).fill(65));
      await writer.close();
    })();

    await Promise.all([bucket.put('probe/fixed', fixed.readable), writing]);

    expect((await bucket.get('probe/fixed'))?.size).toBe(4096);
    await bucket.delete('probe/fixed');
  });

  it('⭐ a FixedLengthStream refuses MORE bytes than were declared', async () => {
    // This is the enforcement, and it belongs to the runtime rather than to any
    // counting we would write. Declare the length that was promised, and a caller
    // who then sends more is stopped by the platform.
    const fixed = new FixedLengthStream(1024);
    let message = '';

    const writing = (async () => {
      const writer = fixed.writable.getWriter();
      try {
        await writer.write(new Uint8Array(1024).fill(65));
        await writer.write(new Uint8Array(1).fill(66));
        await writer.close();
      } catch (error) {
        message = (error as Error).message;
      }
    })();

    const put = bucket.put('probe/fixed-over', fixed.readable).catch((error: Error) => {
      message = message || error.message;
    });
    await Promise.all([put, writing]);

    console.log(`  FixedLengthStream over its declared length -> ${message || '(no error)'}`);
    expect(message).not.toBe('');

    await bucket.delete('probe/fixed-over');
  });

  it('a FixedLengthStream also refuses FEWER bytes than were declared', async () => {
    // The other direction, and it matters for the same reason: an upload that
    // ends early must not be stored as a truncated object that looks complete.
    const fixed = new FixedLengthStream(1024);
    let failed = false;

    const writing = (async () => {
      const writer = fixed.writable.getWriter();
      try {
        await writer.write(new Uint8Array(512).fill(65));
        await writer.close();
      } catch {
        failed = true;
      }
    })();

    const put = bucket.put('probe/fixed-under', fixed.readable).catch(() => {
      failed = true;
    });
    await Promise.all([put, writing]);

    console.log(`  FixedLengthStream under its declared length -> ${failed ? 'FAILED' : 'stored'}`);
    expect(failed).toBe(true);

    await bucket.delete('probe/fixed-under');
  });

  it('rejects when the stream errors part way through', async () => {
    const key = 'probe/interrupted';
    let rejected = false;

    try {
      await bucket.put(key, stream(10, 1024, 3));
    } catch {
      rejected = true;
    }

    // Recorded either way. If R2 ever resolves on a broken stream, the upload
    // path cannot rely on a throw to know it failed.
    console.log(`  put with an erroring stream: ${rejected ? 'REJECTED' : 'RESOLVED'}`);
    expect(rejected).toBe(true);
  });

  it('leaves nothing behind when it rejects', async () => {
    // The answer that decides the design. A partial object would mean a refused
    // upload still costs storage and still serves bytes on the next download.
    const key = 'probe/interrupted-leftovers';

    try {
      await bucket.put(key, stream(10, 1024, 3));
    } catch {
      // expected
    }

    const leftover = await bucket.head(key);
    console.log(`  after a rejected put, head() is ${leftover === null ? 'null' : 'AN OBJECT'}`);

    expect(leftover).toBeNull();
  });

  it('overwrites rather than appending when the same key is put twice', async () => {
    // Worth knowing before the router relies on it: a retried upload must not
    // concatenate onto the first attempt.
    const key = 'probe/overwrite';

    await bucket.put(key, 'first-and-longer');
    await bucket.put(key, 'second');

    expect(await (await bucket.get(key))?.text()).toBe('second');
    await bucket.delete(key);
  });

  it('takes a request body directly, and a body with no length is refused', async () => {
    // The shape the upload path actually uses. A request body has a known length
    // when it carries Content-Length, which is why `put` will take it.
    const withLength = new Request('https://example.test/', {
      method: 'POST',
      body: 'twelve bytes',
      headers: { 'content-type': 'text/plain' },
    });

    await bucket.put('probe/from-request', withLength.body);
    expect((await bucket.get('probe/from-request'))?.size).toBe(12);
    await bucket.delete('probe/from-request');
  });

  it('🔴 does NOT give a streamed request body a known length, even with Content-Length set', async () => {
    // This is why the upload path does not simply hand `request.body` to `put`,
    // and it reverses the obvious reading of the error message above.
    //
    // "request/response body" sounds like any request body will do. It does for a
    // body built from a string, as the test above shows. It does not for one built
    // from a stream, even with Content-Length set explicitly. So whether
    // `put(key, request.body)` works depends on how the request was constructed,
    // which is not a property the upload path can check or rely on.
    //
    // Hence FixedLengthStream: it works whatever the body's provenance, and its
    // enforcement is measurable rather than inferred from HTTP framing that a test
    // cannot reproduce.
    const streamed = new Request('https://example.test/', {
      method: 'POST',
      body: stream(1, 1024, null),
      headers: { 'content-length': '5', 'content-type': 'application/octet-stream' },
      // Required in workerd for a streaming request body.
      duplex: 'half',
    } as RequestInit);

    let stored: number | null = null;
    let message = '';
    try {
      await bucket.put('probe/streamed-request', streamed.body);
      stored = (await bucket.head('probe/streamed-request'))?.size ?? null;
    } catch (error) {
      message = (error as Error).message;
    }

    console.log(
      `  streamed request body, content-length 5, 1024 offered -> ` +
        `stored ${stored ?? 'nothing'}${message ? `, error: ${message}` : ''}`,
    );

    // Whatever happens, the one outcome that would be unsafe is 1024 bytes stored
    // against a declared 5.
    expect(stored === null || stored <= 5).toBe(true);
    expect(message).toContain('known length');

    await bucket.delete('probe/streamed-request');
  });

  it('reports a delete of a key that was never there as success', async () => {
    // So a delete cannot be used to find out what exists, which matters for
    // invariant I5 on the delete path.
    await expect(bucket.delete('probe/never-existed')).resolves.toBeUndefined();
  });
});

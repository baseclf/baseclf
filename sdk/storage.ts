/**
 * Files, and the three things this refuses to send.
 *
 * 🔴 **The caller does not choose the key, and that is the whole design rather than a
 * limitation.** They name a bucket and a file, and the server builds the key from a
 * prefix template resolved against their own verified claim, then answers 201 with the
 * key it built. So `upload` returns a key rather than taking one, and traversal is not
 * something this has to defend against: a path is not expressible.
 *
 * Three shapes people reach for do not work here, and each is refused before the
 * request rather than after:
 *
 *   1. **A file name with a slash in it.** The route is exactly two segments, so a
 *      name containing one would answer 404, which reads as "no such bucket" to
 *      somebody who was actually asking for a folder.
 *   2. **A body of unknown length.** `Content-Length` is required: without it there is
 *      nothing for a size limit to check, so the deployment answers 411. Measured on
 *      R2 in `rules/01` section F1: a stream whose length is not known cannot be
 *      stored at all, so this takes sized bodies and says so.
 *   3. **A content type that is a guess.** It is sent, because a policy may allow only
 *      some, and it is worth saying plainly that it is a **declaration** rather than
 *      an inspection of the bytes. The engine's own constant says the same. Nothing
 *      here verifies that a file called an image is one.
 */

import { BaseclfRequestError, type FetchLike } from './errors.js';

/** Everything the server decided about a stored object. */
export interface StoredObject {
  /** Built by the server from the caller's claim. The only way to address the file. */
  readonly key: string;
  readonly etag: string;
}

export interface StorageResult<T> {
  readonly data: T | null;
  readonly error: BaseclfRequestError | null;
}

/** A body whose length is known, which is the only kind that can be stored. */
export type SizedBody = Blob | ArrayBuffer | Uint8Array | string;

/** The byte length of a body, since the size has to be declared up front. */
function byteLengthOf(body: SizedBody): number {
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof Uint8Array) return body.byteLength;
  return body.byteLength;
}

export class StorageBucket {
  readonly #url: string;
  readonly #fetch: FetchLike;
  readonly #token: () => string | null | Promise<string | null>;
  readonly #bucket: string;

  constructor(
    url: string,
    fetcher: FetchLike,
    token: () => string | null | Promise<string | null>,
    bucket: string,
  ) {
    this.#url = url;
    this.#fetch = fetcher;
    this.#token = token;
    this.#bucket = bucket;
  }

  /**
   * A file name, checked before it becomes a URL.
   *
   * ⚠️ Refused here rather than sent, because the failure the server gives is
   * misleading: the route takes exactly two segments, so `a/b.png` produces a 404
   * that reads as "no such bucket" to somebody who was asking for a folder.
   */
  #path(
    fileName: string,
  ): { url: string; error: null } | { url: null; error: BaseclfRequestError } {
    if (fileName === '') {
      return {
        url: null,
        error: new BaseclfRequestError('A file name cannot be empty.', 'UNSUPPORTED_QUERY', 0),
      };
    }
    if (fileName.includes('/')) {
      return {
        url: null,
        error: new BaseclfRequestError(
          `A file name cannot contain a slash: got "${fileName}". The server builds the ` +
            'key from your own identity, so there is no folder for a caller to choose.',
          'UNSUPPORTED_QUERY',
          0,
        ),
      };
    }
    return {
      url: `${this.#url}/storage/v1/${encodeURIComponent(this.#bucket)}/${encodeURIComponent(fileName)}`,
      error: null,
    };
  }

  async #headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...extra };
    const token = await this.#token();
    if (token !== null) headers['authorization'] = `Bearer ${token}`;
    return headers;
  }

  async #failure(response: Response): Promise<BaseclfRequestError> {
    const text = await response.text();
    let message = `The request failed with ${response.status}.`;
    let code = 'UNKNOWN';
    try {
      const body = JSON.parse(text) as { error?: string; code?: string };
      if (typeof body.error === 'string') message = body.error;
      if (typeof body.code === 'string') code = body.code;
    } catch {
      // Not JSON. The status is the diagnosis.
    }
    return new BaseclfRequestError(message, code, response.status);
  }

  /**
   * Store a file, and hand back the key the server built for it.
   *
   * ⚠️ `contentType` is a declaration, not an inspection. A policy may allow only
   * some, and nothing here or on the server reads the bytes to check that a file
   * called an image is one.
   */
  async upload(
    fileName: string,
    body: SizedBody,
    options: { contentType?: string } = {},
  ): Promise<StorageResult<StoredObject>> {
    const path = this.#path(fileName);
    if (path.url === null) return { data: null, error: path.error };

    const length = byteLengthOf(body);

    const response = await this.#fetch(path.url, {
      method: 'PUT',
      headers: await this.#headers({
        'content-type': options.contentType ?? 'application/octet-stream',
        // 🔴 Declared rather than left to the runtime. Without it the deployment
        // answers 411, because a size limit has nothing to check against, and a
        // caller who never set a header would be told their request was malformed.
        'content-length': String(length),
      }),
      body: body instanceof Uint8Array ? (body.slice().buffer as ArrayBuffer) : body,
    });

    if (!response.ok) return { data: null, error: await this.#failure(response) };

    const stored = (await response.json()) as { key?: string; etag?: string };
    return {
      data: { key: stored.key ?? '', etag: stored.etag ?? '' },
      error: null,
    };
  }

  /**
   * Read a file back.
   *
   * Returns the response rather than the bytes, so a caller streaming a large object
   * is not made to hold it in memory first, and so the `etag` and `content-type` the
   * deployment chose are still there to read.
   */
  async download(fileName: string): Promise<StorageResult<Response>> {
    const path = this.#path(fileName);
    if (path.url === null) return { data: null, error: path.error };

    const response = await this.#fetch(path.url, {
      method: 'GET',
      headers: await this.#headers(),
    });

    if (!response.ok) return { data: null, error: await this.#failure(response) };
    return { data: response, error: null };
  }

  /**
   * Remove a file.
   *
   * ⚠️ Removing one that was never there is not an error, and that is the server's
   * choice rather than this one. Answering differently would make delete a way to ask
   * which keys exist, which is the same side channel every 404 in this engine is
   * shaped to close.
   */
  async remove(fileName: string): Promise<{ error: BaseclfRequestError | null }> {
    const path = this.#path(fileName);
    if (path.url === null) return { error: path.error };

    const response = await this.#fetch(path.url, {
      method: 'DELETE',
      headers: await this.#headers(),
    });

    return { error: response.ok ? null : await this.#failure(response) };
  }
}

export class StorageClient {
  readonly #url: string;
  readonly #fetch: FetchLike;
  readonly #token: () => string | null | Promise<string | null>;

  constructor(
    url: string,
    fetcher: FetchLike,
    token: () => string | null | Promise<string | null>,
  ) {
    this.#url = url;
    this.#fetch = fetcher;
    this.#token = token;
  }

  from(bucket: string): StorageBucket {
    return new StorageBucket(this.#url, this.#fetch, this.#token, bucket);
  }
}

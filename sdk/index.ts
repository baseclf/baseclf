/**
 * A client for a BaseCLF deployment.
 *
 * 🔴 **`createClient` takes no anonymous key, and that is a difference rather than an
 * omission.** The shape people expect is `createClient(url, anonKey)`, and this
 * product has no such key: identity is a bearer JWT from the deployment's own auth,
 * and a request with no token is the `anon` role. There is nothing to put in that
 * second argument, so there is no second argument. Measured on 2026-08-16: no
 * `anonKey`, `apikey` or `ANON_KEY` appears anywhere in the engine.
 *
 * What the caller passes instead is a way to get the current token, because a token
 * expires and a client that captured one at construction would start failing after
 * fifteen minutes with nothing saying why.
 *
 * ## What this does that the client it resembles does not
 *
 * ⭐ It threads D1's session bookmark. The engine returns `x-d1-bookmark` and accepts
 * it on the next request, which is what makes a read after a write see the write. The
 * client stores the last one and sends it back, so read-your-writes is the default and
 * the caller never learns the header exists.
 *
 * ## What it deliberately does not have
 *
 * Every absence is measured against the engine rather than chosen: no `upsert` (no
 * path compiles `ON CONFLICT`), no array insert (refused, because D1 cannot roll back
 * the rows that already landed), no relationship embeds (refused), and none of the
 * fourteen PostgREST filters that cannot mean anything on SQLite. See `query.ts`.
 */

import { AuthClient } from './auth.js';
import type { FetchLike } from './errors.js';
import { QueryBuilder, type QueryContext } from './query.js';

export { AuthClient, type AuthResult, type AuthUser, type Provider } from './auth.js';
export { BaseclfRequestError, type FetchLike } from './errors.js';
export { MAX_PAGE_SIZE, QueryBuilder, type FilterOperator } from './query.js';

export interface ClientOptions {
  /**
   * The bearer token to send, or a function returning it.
   *
   * ⚠️ A function rather than a string is the shape to prefer. Tokens from this
   * engine last fifteen minutes, so a client holding one from construction works
   * during development and starts failing in production for a reason nothing reports.
   */
  readonly token?: string | (() => string | null) | undefined;
  /** Injected so this runs in a browser, in Node, in a Worker, and in a test. */
  readonly fetch?: FetchLike | undefined;
  /**
   * Send D1's session bookmark back, so a read after a write sees the write.
   *
   * On by default. Turning it off gives up read-your-writes in exchange for letting
   * any replica answer, which is worth having only if something else already
   * guarantees ordering.
   */
  readonly sessionConsistency?: boolean | undefined;
  /** The clock `auth` ages tokens against. Injected so a test need not wait 900 seconds. */
  readonly now?: (() => number) | undefined;
}

export class BaseclfClient {
  /** Signing in, and the two tokens. See `auth.ts`. */
  readonly auth: AuthClient;
  readonly #context: QueryContext;

  constructor(url: string, options: ClientOptions = {}) {
    const trimmed = url.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(trimmed)) {
      throw new TypeError(`A deployment URL has to start with http or https: got "${url}".`);
    }

    const fetcher: FetchLike =
      options.fetch ?? ((target, init) => globalThis.fetch(target, init));

    this.auth = new AuthClient(trimmed, fetcher, options.now);

    // ⚠️ An explicit token wins over the signed-in session, and the order matters.
    // A server handing this a token it already verified is being deliberate, and a
    // session picked up somewhere else quietly overriding that would be a request
    // going out as somebody other than the caller meant.
    const given = options.token;
    const token = (): string | null | Promise<string | null> => {
      if (given !== undefined) return typeof given === 'function' ? given() : given;
      return this.auth.getToken();
    };

    let bookmark: string | null = null;
    const consistent = options.sessionConsistency !== false;

    this.#context = {
      url: trimmed,
      fetch: fetcher,
      token,
      bookmark: {
        read: () => (consistent ? bookmark : null),
        write: (value) => {
          if (consistent) bookmark = value;
        },
      },
    };
  }

  /** Start a query against one table. */
  from<Row = Record<string, unknown>>(table: string): QueryBuilder<Row> {
    return new QueryBuilder<Row>(this.#context, table);
  }

  /**
   * The session bookmark this client is holding, if any.
   *
   * Exposed so an application that hands work to another process can carry the
   * consistency guarantee across with it, which is otherwise the one place threading
   * it automatically cannot reach.
   */
  bookmark(): string | null {
    return this.#context.bookmark.read();
  }
}

export function createClient(url: string, options: ClientOptions = {}): BaseclfClient {
  return new BaseclfClient(url, options);
}

/**
 * One error shape, carrying the code the engine chose.
 *
 * ⚠️ The code matters more than the message here, and for a reason particular to this
 * product: every 404 the engine emits collapses to `NOT_FOUND`, whether the row does
 * not exist or the caller may not see it. That is invariant I5, and it exists so that
 * nobody can tell the two apart by trying. A client that inferred "deleted" from one
 * and "forbidden" from the other would be reconstructing exactly what the server went
 * to the trouble of hiding, so this hands the code through and adds nothing.
 */
export class BaseclfRequestError extends Error {
  /** The engine's own code, or `NETWORK` when the request never arrived. */
  readonly code: string;
  /** The HTTP status, or 0 when there was no response. */
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'BaseclfRequestError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The `fetch` the client will use.
 *
 * Injected rather than reached for, so the client runs in a browser, in Node, in a
 * Worker, and in a test that drives the real engine without a network.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

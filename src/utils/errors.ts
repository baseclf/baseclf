/**
 * One error class carrying a stable code and an HTTP status. Never throw a bare
 * string.
 *
 * What reaches the client must never leak the name of an unexposed table, the
 * compiled SQL, an internal column name, or whether a row exists. See rule 00
 * invariant I5: a forbidden row and a missing row are both 404.
 */

export type ErrorCode =
  // policy engine
  | 'TABLE_NOT_EXPOSED'
  | 'NO_POLICY'
  | 'INVALID_EXPR'
  | 'FORBIDDEN_CLAIM'
  // query construction
  | 'UNKNOWN_IDENTIFIER'
  | 'PARAM_BUDGET_EXCEEDED'
  | 'MALFORMED_SQL'
  | 'UNSUPPORTED_OPERATOR'
  | 'UNSUPPORTED_QUERY'
  // platform
  | 'D1_NO_INTERACTIVE_TRANSACTION'
  | 'D1_QUERY_FAILED'
  | 'D1_TIMEOUT';

export interface ErrorOptions {
  /** Safe to send to the client. Defaults to the code. */
  readonly message?: string;
  /** Server-side only. Never serialised into a response. */
  readonly detail?: string;
  readonly cause?: unknown;
}

export class BaseclfError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Server-side context. Deliberately excluded from `toResponseBody`. */
  readonly detail: string | undefined;

  constructor(code: ErrorCode, status: number, options: ErrorOptions = {}) {
    super(
      options.message ?? code,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'BaseclfError';
    this.code = code;
    this.status = status;
    this.detail = options.detail;
  }

  /**
   * The only shape that may be sent to a client. `detail` is omitted on
   * purpose: it exists for logs, not for responses.
   */
  toResponseBody(): { error: string; code: ErrorCode } {
    return { error: this.message, code: this.code };
  }
}

/** Fail-closed violations and anything else decided by the policy engine. */
export class PolicyError extends BaseclfError {
  constructor(code: ErrorCode, status: number, options?: ErrorOptions) {
    super(code, status, options);
    this.name = 'PolicyError';
  }
}

/** Platform-level failures coming back from D1. */
export class D1Error extends BaseclfError {
  constructor(code: ErrorCode, status: number, options?: ErrorOptions) {
    super(code, status, options);
    this.name = 'D1Error';
  }
}

/**
 * D1 rejects BEGIN TRANSACTION and SAVEPOINT. Verified against a remote
 * database on 2026-07-29: the runtime answers with an explicit message telling
 * you to use the storage transaction APIs instead.
 *
 * Every conditional mutation must therefore be a single statement, or a
 * `batch()` whose correctness does not depend on an intermediate read.
 */
export function noInteractiveTransaction(operation: string): D1Error {
  return new D1Error('D1_NO_INTERACTIVE_TRANSACTION', 500, {
    message: 'Interactive transactions are not available.',
    detail:
      `${operation} was called, but D1 rejects BEGIN TRANSACTION and SAVEPOINT. ` +
      'Express the mutation as a single statement, or use batch(), which is ' +
      'atomic and rolls the whole sequence back if any statement fails.',
  });
}

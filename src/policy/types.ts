/**
 * The policy AST.
 *
 * Everything here is `readonly`. A compiled policy is shared across requests
 * inside an isolate; if any of it were mutable, one request could change what
 * another request is allowed to see.
 *
 * The shape is deliberately narrow. Parsing turns untrusted JSON into these
 * types and nothing else reaches the compiler, so the compiler never has to ask
 * whether a value is trustworthy. See parse.ts and validate.ts.
 */

/** The four things a client can ask a table to do. */
export type Operation = 'select' | 'insert' | 'update' | 'delete';

export const OPERATIONS: readonly Operation[] = ['select', 'insert', 'update', 'delete'];

/**
 * How deep a chain of `_exists` may go.
 *
 * Every level multiplies the rows D1 scans, and D1 bills for rows scanned
 * rather than rows returned. Two is enough for the relationships people
 * actually write (row -> membership -> organisation).
 */
export const MAX_TRAVERSAL_DEPTH = 2;

/**
 * The longest LIKE pattern D1 accepts.
 *
 * Verified on a remote database 2026-07-29: 50 bytes works, 51 raises
 * "LIKE or GLOB pattern too complex".
 */
export const MAX_LIKE_PATTERN_BYTES = 50;

/** A value written directly into a policy document. */
export type Literal = string | number | boolean | null;

/**
 * A claim taken from a verified JWT.
 *
 * `user_metadata` is absent by design. It is writable by the end user, so a
 * policy that read it would let anyone grant themselves any role. Rule 00
 * invariant I4: referencing it throws while the policy is being validated, long
 * before it could ever run.
 */
export type ClaimRef =
  | { readonly source: 'uid' }
  | { readonly source: 'email' }
  | { readonly source: 'role' }
  /** A key of `app_metadata`, which only the server can write. */
  | { readonly source: 'app'; readonly key: string };

/**
 * Anything that can stand on the right of a comparison.
 *
 * Both variants that carry data become bound parameters. `outerColumn` is the
 * one that becomes an identifier, and it is resolved through the catalogue
 * before it ever reaches SQL.
 */
export type ValueExpr =
  | { readonly kind: 'literal'; readonly value: Literal }
  | { readonly kind: 'claim'; readonly ref: ClaimRef }
  /** `$row.<column>`: a column of the table one level out, inside `_exists`. */
  | { readonly kind: 'outerColumn'; readonly column: string };

export type CompareOperator = '_eq' | '_neq' | '_gt' | '_gte' | '_lt' | '_lte';

/** A list source for `_in`: written out, or a claim that holds an array. */
export type ListExpr =
  | { readonly kind: 'literalList'; readonly values: readonly Literal[] }
  | { readonly kind: 'claim'; readonly ref: ClaimRef };

export type Predicate =
  /** Every row. Written as `"using": true`, never inferred from a missing key. */
  | { readonly kind: 'all' }
  | {
      readonly kind: 'compare';
      readonly column: string;
      readonly operator: CompareOperator;
      readonly value: ValueExpr;
    }
  /** Compiled to `IN (SELECT value FROM json_each(?))`, one parameter for any length. */
  | { readonly kind: 'in'; readonly column: string; readonly values: ListExpr }
  | { readonly kind: 'isNull'; readonly column: string; readonly expected: boolean }
  | { readonly kind: 'like'; readonly column: string; readonly pattern: ValueExpr }
  | { readonly kind: 'and'; readonly operands: readonly Predicate[] }
  | { readonly kind: 'or'; readonly operands: readonly Predicate[] }
  | { readonly kind: 'not'; readonly operand: Predicate }
  /** A correlated EXISTS. Never an id list: those hit the hundred-parameter ceiling. */
  | {
      readonly kind: 'exists';
      readonly table: string;
      readonly where: Predicate;
    };

export interface PolicyDef {
  readonly name: string;
  readonly operation: Operation;
  /** Roles this policy applies to. Matched against the verified `role` claim. */
  readonly roles: readonly string[];
  /** Which existing rows the policy is about. Required: an absent one would be "all rows". */
  readonly using: Predicate;
  /** What a row is allowed to look like afterwards. Write paths only; V2. */
  readonly check: Predicate | null;
  /** Columns this policy grants. A request may only read columns a policy grants. */
  readonly columns: readonly string[];
}

export interface TableDefinition {
  readonly table: string;
  /** Absent or false means the table is not exposed at all. */
  readonly enabled: boolean;
  /** Bumped whenever policies change, so a cached registry can be invalidated. */
  readonly version: number;
  readonly policies: readonly PolicyDef[];
}

/**
 * The identity a request runs as.
 *
 * Built from a verified token, never from anything the client can set directly.
 * In V1 there is no token verification yet, so the stub hands out the anonymous
 * context; V3 replaces where this comes from, not what it looks like.
 */
export interface AuthCtx {
  readonly role: string;
  readonly uid: string | null;
  readonly email: string | null;
  /** `app_metadata`: server-written, safe to read in a policy. */
  readonly app: Readonly<Record<string, unknown>>;
}

/** The role a request carries when it presents no credentials at all. */
export const ANONYMOUS_ROLE = 'anon';

export const ANONYMOUS: AuthCtx = Object.freeze({
  role: ANONYMOUS_ROLE,
  uid: null,
  email: null,
  app: Object.freeze({}),
});

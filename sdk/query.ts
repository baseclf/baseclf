/**
 * The query builder, and why its surface is smaller than the one it resembles.
 *
 * 🔴 **Every method here exists because the engine accepts it, and the ones that are
 * missing are missing because it does not.** The shape is `supabase-js` because that
 * is the shape people already know, and copying it wholesale would produce a client
 * whose most familiar calls generate requests the server refuses. An SDK that emits
 * rejected URLs is worse than no SDK: it moves the failure from "this product does
 * not do that" to "this product is broken".
 *
 * Measured against `src/rest/allowlist.ts` and `src/rest/parse-query.ts` on
 * 2026-08-16, and held there by tests that run against the real Worker rather than
 * against a stand-in. Four things people will reach for are deliberately absent:
 *
 *   - **`upsert`** has no path at all. Nothing in `src/rest` compiles `ON CONFLICT`.
 *   - **Array insert** is refused by the router with a reason: a bulk write is many
 *     guarded statements, D1 has no transaction to undo the ones that landed, and
 *     half a write reported as success is worse than a refusal.
 *   - **Relationship embeds** answer "not available yet".
 *   - **Fourteen PostgREST operators** are refused by name, each with its own reason
 *     (SQLite has no REGEXP, no arrays, no ranges). `unsupported()` below names them
 *     so a caller gets the reason here rather than a round trip and a 400.
 *
 * ⭐ And one thing it has that the shape it copies does not: **the session bookmark**.
 * D1 hands back `x-d1-bookmark` and takes it on the next request to guarantee
 * read-your-writes. The client threads it automatically, so a read after a write sees
 * the write without the caller knowing the header exists.
 */

import { BaseclfRequestError, type FetchLike } from './errors.js';

/** Every filter the engine will accept. Ten, and this is the whole list. */
export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'is'
  | 'like'
  | 'ilike';

/**
 * PostgREST filters the engine refuses, and the reason each one cannot work.
 *
 * Kept here as well as on the server so the answer arrives without a round trip. The
 * text is the caller's, not the server's: repeating a name back at somebody who typed
 * it is not an explanation.
 */
const UNSUPPORTED: Readonly<Record<string, string>> = Object.freeze({
  match: 'SQLite has no REGEXP operator.',
  imatch: 'SQLite has no REGEXP operator.',
  cs: 'SQLite has no array or range types.',
  cd: 'SQLite has no array or range types.',
  ov: 'SQLite has no array or range types.',
  sl: 'SQLite has no range types.',
  sr: 'SQLite has no range types.',
  nxr: 'SQLite has no range types.',
  nxl: 'SQLite has no range types.',
  adj: 'SQLite has no range types.',
  fts: 'Full text search needs an FTS5 table, which is not exposed.',
  plfts: 'Full text search needs an FTS5 table, which is not exposed.',
  phfts: 'Full text search needs an FTS5 table, which is not exposed.',
  wfts: 'Full text search needs an FTS5 table, which is not exposed.',
});

/** What a filter can be given. `in` takes the list, `is` takes null or a boolean. */
export type FilterValue = string | number | boolean | null | readonly (string | number)[];

/** One condition inside an `or(...)` group. */
export interface OrCondition {
  readonly column: string;
  readonly operator: FilterOperator;
  readonly value: FilterValue;
  /** Negate this one condition, the same as `not()` does at the top level. */
  readonly negated?: boolean;
}

/**
 * Characters the engine reads as structure rather than as text.
 *
 * 🔴 Leaving these bare does not produce an error, it produces a different question.
 * `in.(p1,p2)` is two ids however many the caller passed, and a value that opens with
 * a quote is unquoted by the parser, so `eq."x"` looks for `x`. Both answers parse,
 * and only one of them is the one that was asked.
 *
 * ⭐ Quoting only when one of these appears is what keeps the meaning identical.
 * A quoted value is always text on the server, so quoting everything would stop
 * `true` and `false` binding as 1 and 0, and would make `is` a refusal. Neither of
 * those words contains any character in this class, and neither does any number, so
 * a value that needs quoting was never one the server would have coerced.
 */
const STRUCTURAL = /["\\,()]/;

function renderValue(value: string | number | boolean): string {
  const text = String(value);
  if (!STRUCTURAL.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Refuse a PostgREST filter this backend cannot mean, with the reason. */
function refuse(operator: string): never {
  const reason = UNSUPPORTED[operator];
  throw new BaseclfRequestError(
    reason === undefined
      ? `"${operator}" is not a filter this backend has.`
      : `The "${operator}" filter is not available on this backend. ${reason}`,
    'UNSUPPORTED_QUERY',
    0,
  );
}

const FILTERS: ReadonlySet<string> = new Set<FilterOperator>([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'is',
  'like',
  'ilike',
]);

/**
 * `[not.]operator.value`, the right hand side of one filter.
 *
 * The same text works at the top level and inside an `or(...)` group, because the
 * engine parses both with the same routine. Written once for that reason: two
 * renderers would be two chances to quote differently, and the one that got it wrong
 * would return rows rather than raise.
 */
function renderOperand(operator: FilterOperator, value: FilterValue, negated: boolean): string {
  if (!FILTERS.has(operator)) refuse(operator);
  const prefix = negated ? 'not.' : '';

  if (operator === 'in') {
    if (!Array.isArray(value)) {
      throw new BaseclfRequestError(
        'An "in" filter takes an array of values.',
        'UNSUPPORTED_QUERY',
        0,
      );
    }
    return `${prefix}in.(${(value as readonly (string | number)[]).map(renderValue).join(',')})`;
  }

  if (operator === 'is') {
    // ⚠️ Unquoted on purpose. The server refuses a quoted `is`, because `is."null"`
    // would be asking whether a column equals the word rather than whether it is unset.
    if (value !== null && typeof value !== 'boolean') {
      throw new BaseclfRequestError(
        'An "is" filter takes null, true or false.',
        'UNSUPPORTED_QUERY',
        0,
      );
    }
    return `${prefix}is.${value === null ? 'null' : String(value)}`;
  }

  if (value === null || Array.isArray(value)) {
    throw new BaseclfRequestError(
      `The "${operator}" filter takes a single value.`,
      'UNSUPPORTED_QUERY',
      0,
    );
  }
  return `${prefix}${operator}.${renderValue(value as string | number | boolean)}`;
}

/**
 * The largest page the engine will return, whatever is asked for.
 *
 * Copied from `MAX_PAGE_SIZE` in the parser rather than guessed. The server clamps
 * rather than refusing, so asking for more is not an error; it is a number that
 * quietly does not mean what it says, which is worth saying out loud here.
 */
export const MAX_PAGE_SIZE = 1000;

export interface QueryResult<Row> {
  readonly data: readonly Row[] | null;
  readonly error: BaseclfRequestError | null;
  /** What the engine reported it scanned, when it said. D1 bills on rows read. */
  readonly rowsRead: number | null;
}

export interface SingleResult<Row> {
  readonly data: Row | null;
  readonly error: BaseclfRequestError | null;
  readonly rowsRead: number | null;
}

/** What the builder needs from the client that made it. */
export interface QueryContext {
  readonly url: string;
  readonly fetch: FetchLike;
  /**
   * The bearer token for this call, or null for the anonymous role.
   *
   * ⚠️ Allowed to be async, because the honest implementation is: the JWT lasts 900
   * seconds and getting a fresh one is a round trip. A synchronous accessor forces
   * either a stale token or a refresh racing the request that needed it.
   */
  readonly token: () => string | null | Promise<string | null>;
  /** Read the session bookmark, and store the one the response carried. */
  readonly bookmark: {
    readonly read: () => string | null;
    readonly write: (value: string) => void;
  };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * A request being assembled. Immutable between steps.
 *
 * ⚠️ Every method returns a new builder rather than mutating this one. A builder that
 * mutates makes `const base = client.from('posts').select('*')` a trap: two callers
 * refining it separately get each other's filters, and the bug shows up as rows
 * missing rather than as an error.
 */
export class QueryBuilder<Row = Record<string, unknown>> {
  readonly #context: QueryContext;
  readonly #table: string;
  readonly #method: Method;
  readonly #params: readonly (readonly [string, string])[];
  readonly #body: unknown;

  constructor(
    context: QueryContext,
    table: string,
    method: Method = 'GET',
    params: readonly (readonly [string, string])[] = [],
    body: unknown = undefined,
  ) {
    this.#context = context;
    this.#table = table;
    this.#method = method;
    this.#params = params;
    this.#body = body;
  }

  #with(
    method: Method,
    params: readonly (readonly [string, string])[],
    body: unknown = this.#body,
  ): QueryBuilder<Row> {
    return new QueryBuilder<Row>(this.#context, this.#table, method, params, body);
  }

  #add(key: string, value: string): QueryBuilder<Row> {
    return this.#with(this.#method, [...this.#params, [key, value]]);
  }

  /** Which columns to return. `*` is every column the policy grants, not every column. */
  select(columns = '*'): QueryBuilder<Row> {
    if (columns.includes('(')) {
      throw new BaseclfRequestError(
        'Relationship embeds are not available yet, so a select cannot name another table.',
        'UNSUPPORTED_QUERY',
        0,
      );
    }
    return this.#add('select', columns);
  }

  /**
   * A filter, in the engine's own grammar.
   *
   * ⚠️ Filters can only narrow. The engine ANDs them onto the policy predicate, so
   * there is no filter that widens what a caller may see, and one that names a column
   * they may not read is a refusal rather than a wider result.
   */
  filter(column: string, operator: FilterOperator, value: FilterValue): this {
    return this.#add(column, renderOperand(operator, value, false)) as this;
  }

  eq(column: string, value: string | number | boolean): QueryBuilder<Row> {
    return this.#add(column, renderOperand('eq', value, false));
  }
  neq(column: string, value: string | number | boolean): QueryBuilder<Row> {
    return this.#add(column, renderOperand('neq', value, false));
  }
  gt(column: string, value: string | number): QueryBuilder<Row> {
    return this.#add(column, renderOperand('gt', value, false));
  }
  gte(column: string, value: string | number): QueryBuilder<Row> {
    return this.#add(column, renderOperand('gte', value, false));
  }
  lt(column: string, value: string | number): QueryBuilder<Row> {
    return this.#add(column, renderOperand('lt', value, false));
  }
  lte(column: string, value: string | number): QueryBuilder<Row> {
    return this.#add(column, renderOperand('lte', value, false));
  }
  like(column: string, pattern: string): QueryBuilder<Row> {
    return this.#add(column, renderOperand('like', pattern, false));
  }
  ilike(column: string, pattern: string): QueryBuilder<Row> {
    return this.#add(column, renderOperand('ilike', pattern, false));
  }
  is(column: string, value: null | boolean): QueryBuilder<Row> {
    return this.#add(column, renderOperand('is', value, false));
  }
  in(column: string, values: readonly (string | number)[]): QueryBuilder<Row> {
    return this.#add(column, renderOperand('in', values, false));
  }

  /**
   * The negation of one filter: `not(column, 'eq', x)` is every row where it is not x.
   *
   * ⚠️ On a column that holds nulls this is SQL's answer rather than the intuitive
   * one. `NOT (col = 'x')` is null for a null column, and a null predicate does not
   * pass a `WHERE`, so those rows are absent from both this and its opposite. The
   * policy DSL refuses `_not` over a nullable column for exactly this reason; a filter
   * is allowed to because it can only narrow, so the surprise costs rows rather than
   * leaking them.
   */
  not(column: string, operator: FilterOperator, value: FilterValue): QueryBuilder<Row> {
    return this.#add(column, renderOperand(operator, value, true));
  }

  /**
   * A group of conditions, any one of which is enough.
   *
   * ⚠️ The group as a whole is still ANDed onto the policy, so this widens what the
   * caller asked for and never what they may see. Invariant I3 is a property of the
   * engine, not of this method.
   *
   * Flat only: the engine parses `or(a,and(b,c))` and this does not emit it. A nesting
   * this cannot express is one somebody has to write by hand, which is a smaller
   * problem than a builder that emits a shape the depth limit rejects at runtime.
   */
  or(conditions: readonly OrCondition[]): QueryBuilder<Row> {
    if (conditions.length === 0) {
      throw new BaseclfRequestError(
        'An "or" group needs at least one condition.',
        'UNSUPPORTED_QUERY',
        0,
      );
    }
    const rendered = conditions.map(
      (each) => `${each.column}.${renderOperand(each.operator, each.value, each.negated === true)}`,
    );
    return this.#add('or', `(${rendered.join(',')})`);
  }

  /**
   * Refuse a PostgREST filter this backend cannot mean, with the reason.
   *
   * ⚠️ Throws here rather than sending it. The server refuses it too, and would say
   * the same thing, but a caller who gets the answer before the round trip learns it
   * while they are still writing the line rather than while reading a log.
   */
  unsupported(operator: string): never {
    return refuse(operator);
  }

  order(
    column: string,
    options: { ascending?: boolean; nullsFirst?: boolean } = {},
  ): QueryBuilder<Row> {
    const direction = options.ascending === false ? 'desc' : 'asc';
    const nulls =
      options.nullsFirst === undefined ? '' : options.nullsFirst ? '.nullsfirst' : '.nullslast';
    return this.#add('order', `${column}.${direction}${nulls}`);
  }

  /**
   * How many rows to return.
   *
   * ⚠️ The server clamps to `MAX_PAGE_SIZE` rather than refusing a larger number, so
   * asking for more is silently answered with less. Said here because a limit that
   * does not mean what it says is the kind of thing somebody builds pagination on.
   */
  limit(count: number): QueryBuilder<Row> {
    return this.#add('limit', String(count));
  }

  offset(count: number): QueryBuilder<Row> {
    return this.#add('offset', String(count));
  }

  /**
   * Add one row.
   *
   * 🔴 One object, never an array, and the refusal is here as well as on the server.
   * A bulk insert is many separately guarded statements, D1 has no transaction to
   * undo the ones that already landed, and a half-completed write reported as success
   * is worse than a refusal. The server answers 400; this answers before the request.
   */
  insert(row: Record<string, unknown>): QueryBuilder<Row> {
    if (Array.isArray(row)) {
      throw new BaseclfRequestError(
        'Inserting many rows at once is not available. Every row carries its own policy ' +
          'check, and D1 has no transaction to undo the ones that already landed, so a ' +
          'partial write would be reported as a success. Insert them one at a time.',
        'UNSUPPORTED_QUERY',
        0,
      );
    }
    return this.#with('POST', this.#params, row);
  }

  update(changes: Record<string, unknown>): QueryBuilder<Row> {
    return this.#with('PATCH', this.#params, changes);
  }

  delete(): QueryBuilder<Row> {
    return this.#with('DELETE', this.#params);
  }

  /** The URL this will request. Exposed because a client that cannot be inspected cannot be trusted. */
  toURL(): string {
    const search = new URLSearchParams();
    for (const [key, value] of this.#params) search.append(key, value);
    const query = search.toString();
    return `${this.#context.url}/rest/v1/${encodeURIComponent(this.#table)}${query === '' ? '' : `?${query}`}`;
  }

  /** Run it. Errors come back in `error` rather than thrown, so one shape handles both. */
  async run(): Promise<QueryResult<Row>> {
    const headers: Record<string, string> = { accept: 'application/json' };

    const token = await this.#context.token();
    if (token !== null) headers['authorization'] = `Bearer ${token}`;

    // ⭐ Read-your-writes, without the caller knowing the header exists. D1 hands a
    // bookmark back and takes it on the next request; threading it is the difference
    // between a read after a write seeing the write and seeing whatever replica
    // answered.
    const bookmark = this.#context.bookmark.read();
    if (bookmark !== null) headers['x-d1-bookmark'] = bookmark;

    // ⚠️ Two conditions, not one, and tying them together was a real bug. Asking for
    // the rows back belongs to every write; declaring JSON belongs to the ones that
    // carry a body. A delete has no body, so the single condition left it asking for
    // nothing back, and a delete that reports what it removed is the only way a caller
    // learns whether the row was theirs. Found by writing the test for it.
    if (this.#method !== 'GET') {
      // Without this a write answers with nothing and the caller reads again to find
      // out what it did: another round trip, and a second policy evaluation of the
      // same rows.
      headers['prefer'] = 'return=representation';
    }

    if (this.#body !== undefined) headers['content-type'] = 'application/json';

    const init: RequestInit = { method: this.#method, headers };
    if (this.#body !== undefined) init.body = JSON.stringify(this.#body);

    let response: Response;
    try {
      response = await this.#context.fetch(this.toURL(), init);
    } catch (cause) {
      return {
        data: null,
        rowsRead: null,
        error: new BaseclfRequestError(
          cause instanceof Error ? cause.message : String(cause),
          'NETWORK',
          0,
        ),
      };
    }

    const returned = response.headers.get('x-d1-bookmark');
    if (returned !== null && returned !== '') this.#context.bookmark.write(returned);

    const rowsReadHeader = response.headers.get('x-baseclf-rows-read');
    const rowsRead = rowsReadHeader === null ? null : Number(rowsReadHeader);

    const text = await response.text();
    const parsed: unknown = text === '' ? null : safeParse(text);

    if (!response.ok) {
      const body = parsed as { error?: string; code?: string } | null;
      return {
        data: null,
        rowsRead,
        error: new BaseclfRequestError(
          body?.error ?? `The request failed with ${response.status}.`,
          body?.code ?? 'UNKNOWN',
          response.status,
        ),
      };
    }

    return {
      data: (Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed]) as readonly Row[],
      rowsRead,
      error: null,
    };
  }

  /**
   * Run it and expect one row.
   *
   * ⚠️ Zero rows is `data: null` with no error, and that is deliberate. The engine
   * answers 404 for "no such row" and for "not yours" with the same body on purpose
   * (invariant I5, so nobody can probe for which), so a client that turned an empty
   * result into an error would be inventing a distinction the server refuses to make.
   */
  async single(): Promise<SingleResult<Row>> {
    const result = await this.run();

    // 🔴 More than one row is an error, and zero is not. The asymmetry is the whole
    // decision, and both halves come from the server rather than from taste.
    //
    // Zero is not an error because the engine answers "no such row" and "not yours"
    // with the same empty result on purpose (invariant I5, so nobody can probe for
    // which). A client that raised on empty would be inventing a distinction the
    // server refuses to make.
    //
    // More than one is an error because the caller said "one" and the filter did not
    // narrow to one, which is a bug in their query. Returning the first would be a
    // plausible answer to a question they did not ask, and the row they got would
    // depend on an ordering nobody specified.
    if (result.data !== null && result.data.length > 1) {
      return {
        data: null,
        rowsRead: result.rowsRead,
        error: new BaseclfRequestError(
          `single() asked for one row and the filter matched ${result.data.length}. ` +
            'Narrow the filter, or use the plain query and read the array.',
          'NOT_SINGLE',
          result.data.length,
        ),
      };
    }

    return {
      data: result.data === null ? null : (result.data[0] ?? null),
      error: result.error,
      rowsRead: result.rowsRead,
    };
  }

  /**
   * So `await builder` works without calling `.run()`.
   *
   * ⚠️ Deliberately thenable, which is the one shape the linter asks about by name.
   * Its own message allows it for a class that intends to be awaited, and this one
   * does: the builder is the value callers await, and requiring `.run()` would make
   * the common line longer for no gain. The risk the rule guards against is a plain
   * object accidentally acting like a promise; here it is the whole interface.
   */
  // biome-ignore lint/suspicious/noThenProperty: the builder is awaited by design, see above.
  then<T1 = QueryResult<Row>, T2 = never>(
    onFulfilled?: ((value: QueryResult<Row>) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this.run().then(onFulfilled, onRejected);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

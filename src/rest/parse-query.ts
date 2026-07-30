/**
 * The PostgREST query string, turned into a tree.
 *
 * Order of operations is the whole trick here. The grammar reserves `,` `.` `:`
 * and `()`, and a value that needs one of those characters is wrapped in double
 * quotes:
 *
 *   ?name=in.("Hebdon,John","Williams,Mary")
 *
 * So quoted regions are recognised before anything is split. Splitting first
 * and repairing afterwards is the classic way to write this parser wrong, and
 * in a system where the result becomes an access decision, wrong means a filter
 * that does not mean what it appears to mean.
 *
 * Nothing in this file touches the database. It produces a tree of names and
 * text; build.ts is what resolves those names against the catalogue and refuses
 * the ones that are not real. Keeping the two apart means this parser can be
 * tested exhaustively without a schema, and means the parser is never the thing
 * deciding what is allowed.
 *
 * Every limit below exists because the grammar is recursive and a query string
 * is free to send. Without them a few hundred bytes buys an unbounded amount of
 * the CPU budget a Worker is allowed per request.
 */

import { BaseclfError } from '../utils/errors.js';

export const MAX_QUERY_STRING_BYTES = 4096;
export const MAX_FILTERS = 32;
export const MAX_FILTER_DEPTH = 4;
export const MAX_SELECT_ITEMS = 100;
export const MAX_ORDER_ITEMS = 8;
export const MAX_IN_LIST_ITEMS = 256;

/** The ceiling a caller cannot raise, whatever they ask for. */
export const MAX_PAGE_SIZE = 1000;
export const DEFAULT_PAGE_SIZE = 100;

const RESERVED_PARAMETERS = new Set(['select', 'order', 'limit', 'offset', 'and', 'or']);

export interface SelectItem {
  readonly column: string;
  readonly alias: string | null;
}

export interface OrderItem {
  readonly column: string;
  readonly direction: string;
  readonly nulls: string | null;
}

/** A single comparison, still in the client's own words. */
export interface ConditionNode {
  readonly kind: 'condition';
  readonly column: string;
  readonly negated: boolean;
  readonly operator: string;
  /** Unquoted text, or the entries of an `in` list. */
  readonly value: string | readonly string[];
  /** True when the client wrapped the value in quotes, so `null` means the word. */
  readonly quoted: boolean;
}

export type FilterNode =
  | ConditionNode
  | { readonly kind: 'and'; readonly operands: readonly FilterNode[] }
  | { readonly kind: 'or'; readonly operands: readonly FilterNode[] };

export interface ParsedQuery {
  /** null means the client wrote `select=*`, or omitted it entirely. */
  readonly select: readonly SelectItem[] | null;
  readonly filters: readonly FilterNode[];
  readonly order: readonly OrderItem[];
  readonly limit: number;
  readonly offset: number;
}

function bad(message: string): never {
  throw new BaseclfError('MALFORMED_SQL', 400, { message });
}

/**
 * Split on a separator, ignoring anything inside quotes or parentheses.
 *
 * A backslash escapes the next character inside a quoted region, which is how a
 * value carries a literal double quote.
 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i] as string;

    if (quoted) {
      if (character === '\\') {
        const next = text[i + 1];
        if (next === undefined) bad('A quoted value ends with a dangling escape.');
        current += character + next;
        i += 1;
        continue;
      }
      current += character;
      if (character === '"') quoted = false;
      continue;
    }

    if (character === '"') {
      quoted = true;
      current += character;
      continue;
    }
    if (character === '(') {
      depth += 1;
      current += character;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      if (depth < 0) bad('Unbalanced parentheses in the query string.');
      current += character;
      continue;
    }
    if (character === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }

  if (quoted) bad('A quoted value is not closed.');
  if (depth !== 0) bad('Unbalanced parentheses in the query string.');

  parts.push(current);
  return parts;
}

interface Unquoted {
  readonly value: string;
  readonly quoted: boolean;
}

function unquote(token: string): Unquoted {
  if (!token.startsWith('"')) return { value: token, quoted: false };
  if (token.length < 2 || !token.endsWith('"')) bad('A quoted value is not closed.');

  const body = token.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const character = body[i] as string;
    if (character === '\\') {
      const next = body[i + 1];
      if (next === undefined) bad('A quoted value ends with a dangling escape.');
      out += next;
      i += 1;
      continue;
    }
    out += character;
  }
  return { value: out, quoted: true };
}

/** `(a,b,c)` for an `in` list. Entries are unquoted individually. */
function parseInList(text: string): readonly string[] {
  if (!text.startsWith('(') || !text.endsWith(')')) {
    bad('An "in" filter takes a parenthesised list.');
  }
  const inner = text.slice(1, -1);
  if (inner.trim() === '') return [];

  const entries = splitTopLevel(inner, ',');
  if (entries.length > MAX_IN_LIST_ITEMS) {
    bad(`An "in" list may hold at most ${MAX_IN_LIST_ITEMS} entries.`);
  }
  return entries.map((entry) => unquote(entry).value);
}

/**
 * `[not.]operator.value` as it appears on the right of a filter.
 */
function parseCondition(column: string, text: string): ConditionNode {
  const head = splitTopLevel(text, '.');
  if (head.length < 2) bad(`Filter on "${column}" needs an operator and a value.`);

  let index = 0;
  const negated = head[0] === 'not';
  if (negated) index = 1;

  const operator = head[index];
  if (operator === undefined || operator === '') {
    bad(`Filter on "${column}" is missing an operator.`);
  }

  // Everything after the operator is the value, rejoined because a value may
  // legitimately contain the separator once it is out of a quoted region.
  const rest = head.slice(index + 1).join('.');
  if (rest === '') bad(`Filter on "${column}" is missing a value.`);

  if (operator === 'in') {
    return {
      kind: 'condition',
      column,
      negated,
      operator,
      value: parseInList(rest),
      quoted: false,
    };
  }

  const { value, quoted } = unquote(rest);
  return { kind: 'condition', column, negated, operator, value, quoted };
}

interface ParseState {
  count: number;
}

function parseBooleanGroup(
  kind: 'and' | 'or',
  text: string,
  depth: number,
  state: ParseState,
): FilterNode {
  if (depth + 1 > MAX_FILTER_DEPTH) {
    bad(`Filters may not nest more than ${MAX_FILTER_DEPTH} levels deep.`);
  }
  if (!text.startsWith('(') || !text.endsWith(')')) {
    bad(`"${kind}" takes a parenthesised list of conditions.`);
  }

  const operands = splitTopLevel(text.slice(1, -1), ',').map((entry) =>
    parseFilterEntry(entry, depth + 1, state),
  );
  if (operands.length === 0) bad(`"${kind}" needs at least one condition.`);

  return { kind, operands };
}

/**
 * One entry inside `or=(...)`: either a nested group or `column.op.value`.
 *
 * A nested group is written with the parenthesis attached, `and(a.eq.1,b.eq.2)`,
 * with no separator after the keyword. That is what distinguishes it from a
 * filter on a column that happens to be called `and`, which would arrive as
 * `and.eq.1` and is a perfectly legal thing to have in a schema.
 */
function parseFilterEntry(text: string, depth: number, state: ParseState): FilterNode {
  state.count += 1;
  if (state.count > MAX_FILTERS) {
    bad(`A request may carry at most ${MAX_FILTERS} filters.`);
  }

  for (const kind of ['and', 'or'] as const) {
    if (text.startsWith(`${kind}(`)) {
      return parseBooleanGroup(kind, text.slice(kind.length), depth, state);
    }
  }

  const parts = splitTopLevel(text, '.');
  const first = parts[0];
  if (first === undefined || first === '') bad('A filter is missing its column.');

  return parseCondition(first, parts.slice(1).join('.'));
}

function parseSelect(text: string): readonly SelectItem[] | null {
  const parts = splitTopLevel(text, ',').map((part) => part.trim());
  if (parts.length > MAX_SELECT_ITEMS) {
    bad(`A request may select at most ${MAX_SELECT_ITEMS} columns.`);
  }

  const items: SelectItem[] = [];
  for (const part of parts) {
    if (part === '') bad('The select list has an empty entry.');
    if (part === '*') {
      // A star anywhere means the whole list is a star. Mixing `*` with named
      // columns has no meaning the policy layer could honour precisely.
      if (parts.length !== 1) bad('A star cannot be combined with named columns.');
      return null;
    }
    if (part.includes('(')) {
      bad('Relationship embeds are not available yet.');
    }

    const colonIndex = part.indexOf(':');
    if (colonIndex === -1) {
      items.push({ column: part, alias: null });
      continue;
    }
    const alias = part.slice(0, colonIndex);
    const column = part.slice(colonIndex + 1);
    if (alias === '' || column === '') bad('An aliased column needs both a name and an alias.');
    items.push({ column, alias });
  }

  return items;
}

function parseOrder(text: string): readonly OrderItem[] {
  const parts = splitTopLevel(text, ',');
  if (parts.length > MAX_ORDER_ITEMS) {
    bad(`A request may order by at most ${MAX_ORDER_ITEMS} columns.`);
  }

  return parts.map((part) => {
    const pieces = splitTopLevel(part, '.');
    const column = pieces[0];
    if (column === undefined || column === '') bad('An order entry is missing its column.');
    if (pieces.length > 3) bad(`Order entry "${part}" has too many parts.`);

    return {
      column,
      // PostgREST's default. Written out rather than left implicit because it
      // ends up in SQL as a keyword, never as a bound value: ORDER BY ? parses
      // on D1 and then sorts by nothing at all. Verified 2026-07-29.
      direction: pieces[1] ?? 'asc',
      nulls: pieces[2] ?? null,
    };
  });
}

function parseCount(raw: string, field: string): number {
  if (!/^\d{1,9}$/.test(raw)) bad(`"${field}" must be a non-negative whole number.`);
  return Number(raw);
}

export function parseQueryString(search: URLSearchParams): ParsedQuery {
  const asText = search.toString();
  if (new TextEncoder().encode(asText).byteLength > MAX_QUERY_STRING_BYTES) {
    bad(`A query string may be at most ${MAX_QUERY_STRING_BYTES} bytes.`);
  }

  const state: ParseState = { count: 0 };
  const filters: FilterNode[] = [];
  let select: readonly SelectItem[] | null = null;
  let order: readonly OrderItem[] = [];
  let limit = DEFAULT_PAGE_SIZE;
  let offset = 0;

  for (const [key, value] of search) {
    if (key === 'select') {
      select = parseSelect(value);
      continue;
    }
    if (key === 'order') {
      order = parseOrder(value);
      continue;
    }
    if (key === 'limit') {
      // Clamped, not rejected. A caller asking for more than the server will
      // serve gets the server's answer rather than an error they cannot act on.
      limit = Math.min(parseCount(value, 'limit'), MAX_PAGE_SIZE);
      continue;
    }
    if (key === 'offset') {
      offset = parseCount(value, 'offset');
      continue;
    }
    if (key === 'and' || key === 'or') {
      filters.push(parseBooleanGroup(key, value, 0, state));
      continue;
    }
    if (RESERVED_PARAMETERS.has(key)) continue;

    state.count += 1;
    if (state.count > MAX_FILTERS) {
      bad(`A request may carry at most ${MAX_FILTERS} filters.`);
    }
    filters.push(parseCondition(key, value));
  }

  return { select, filters, order, limit, offset };
}

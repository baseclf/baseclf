/**
 * The closed dictionary.
 *
 * Nothing a client sends becomes SQL unless it appears in this file. Tables and
 * columns are resolved against the catalogue by exact match, operators come
 * from a fixed map, and sort keywords come from a two-entry lookup. There is no
 * fall-through case anywhere: an input that is not recognised is refused, never
 * passed along.
 *
 * The reason it is a dictionary rather than a pattern is D1's double quoted
 * string literals, which are enabled. `SELECT "titel"` does not raise; it
 * returns the text "titel" for every row. A validation bug here would therefore
 * not surface as an error, it would surface as a customer seeing the wrong data
 * and nobody finding out. Rule 00, invariant I6.
 */

import { ColumnNode, ReferenceNode, TableNode } from 'kysely';

import type { Catalogue } from '../db/introspect.js';
import { SYSTEM_TABLE_PREFIX } from '../db/introspect.js';
import { MAX_LIKE_PATTERN_BYTES } from '../policy/types.js';
import { BaseclfError } from '../utils/errors.js';

/** A filter operator the API accepts, mapped to what it means in SQLite. */
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

export const SQL_COMPARISON: Readonly<
  Record<Exclude<FilterOperator, 'in' | 'is' | 'like' | 'ilike'>, string>
> = Object.freeze({
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
});

const KNOWN_OPERATORS = new Set<string>([
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
 * PostgREST operators that exist but cannot mean anything on D1.
 *
 * Listed by name so the error can say why rather than "unknown operator". A
 * client that asks for a regular expression match deserves to be told SQLite
 * has none, not left guessing at a typo.
 */
const REFUSED_OPERATORS: Readonly<Record<string, string>> = Object.freeze({
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
  fts: 'Full text search needs an FTS5 table, which V1 does not expose.',
  plfts: 'Full text search needs an FTS5 table, which V1 does not expose.',
  phfts: 'Full text search needs an FTS5 table, which V1 does not expose.',
  wfts: 'Full text search needs an FTS5 table, which V1 does not expose.',
});

/** Two entries, looked up. Never a string pasted into the query. */
const SORT_DIRECTIONS: Readonly<Record<string, 'asc' | 'desc'>> = Object.freeze({
  asc: 'asc',
  desc: 'desc',
});

const NULL_PLACEMENTS: Readonly<Record<string, 'first' | 'last'>> = Object.freeze({
  nullsfirst: 'first',
  nullslast: 'last',
});

/** Aliases are the usual blind spot, so they get the same treatment as identifiers. */
export const ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** The character that turns a user's literal % or _ back into itself. */
export const LIKE_ESCAPE_CHARACTER = '\\';

/**
 * Refuse a name without saying anything about the schema.
 *
 * Always 404, always the same sentence. "That table is not exposed", "that
 * table does not exist" and "that column is not one your policy grants" have to
 * be indistinguishable from outside, or the difference between them becomes a
 * way to map the database one request at a time. Rule 00 invariant I5 makes the
 * point about rows; the same reasoning applies to names, and it costs nothing
 * to be consistent.
 *
 * The `detail` says exactly what was wrong and goes to the log, which the
 * person deploying this owns and the person probing it does not.
 */
function notFound(detail: string): never {
  throw new BaseclfError('UNKNOWN_IDENTIFIER', 404, { message: 'Not found.', detail });
}

/**
 * Refuse something that carries no information about the schema.
 *
 * An operator or a sort keyword is part of the request's own grammar, so saying
 * why it was rejected tells a caller about their query and nothing about the
 * data. These get a useful message and a 400.
 */
function malformed(code: 'UNKNOWN_IDENTIFIER' | 'UNSUPPORTED_OPERATOR', message: string): never {
  throw new BaseclfError(code, 400, { message });
}

/**
 * A table name the client may address at all.
 *
 * The underscore prefix check here is one of the independent places rule 00
 * invariant I8 asks for; the registry performs the others. Any one of them
 * alone is enough to keep the engine's own tables off the API, which is the
 * point of having more than one.
 */
export function resolveTable(catalogue: Catalogue, name: string): string {
  if (name.startsWith(SYSTEM_TABLE_PREFIX)) {
    notFound(`"${name}" is an engine table.`);
  }
  if (!catalogue.hasTable(name)) {
    notFound(`Table "${name}" is not in the catalogue.`);
  }
  return name;
}

/** A column of a known table, matched character for character. */
export function resolveColumn(catalogue: Catalogue, table: string, name: string): string {
  if (!catalogue.hasColumn(table, name)) {
    notFound(`Column "${name}" does not exist on "${table}".`);
  }
  return name;
}

export function columnReference(table: string, column: string): ReferenceNode {
  return ReferenceNode.create(ColumnNode.create(column), TableNode.create(table));
}

export function resolveAlias(alias: string): string {
  if (!ALIAS_PATTERN.test(alias)) {
    malformed('UNKNOWN_IDENTIFIER', `"${alias}" is not a usable alias.`);
  }
  return alias;
}

export function resolveOperator(name: string): FilterOperator {
  const reason = REFUSED_OPERATORS[name];
  if (reason !== undefined) {
    throw new BaseclfError('UNSUPPORTED_OPERATOR', 400, {
      message: `The "${name}" operator is not available on this backend. ${reason}`,
    });
  }
  if (!KNOWN_OPERATORS.has(name)) {
    malformed('UNSUPPORTED_OPERATOR', `"${name}" is not a filter operator.`);
  }
  return name as FilterOperator;
}

export function resolveSortDirection(word: string): 'asc' | 'desc' {
  const direction = SORT_DIRECTIONS[word];
  if (direction === undefined) {
    malformed('UNSUPPORTED_OPERATOR', `"${word}" is not a sort direction.`);
  }
  return direction;
}

export function resolveNullPlacement(word: string): 'first' | 'last' {
  const placement = NULL_PLACEMENTS[word];
  if (placement === undefined) {
    malformed('UNSUPPORTED_OPERATOR', `"${word}" is not a null placement.`);
  }
  return placement;
}

/**
 * Turn a client's pattern into a LIKE pattern.
 *
 * PostgREST spells the wildcard `*`, so `%` and `_` arriving from a client are
 * literal characters and are escaped to stay that way. Without this a search
 * for "50_off" would quietly match "50Xoff" as well.
 *
 * The length ceiling is D1's, verified 2026-07-29: a pattern of 51 bytes is
 * answered with "LIKE or GLOB pattern too complex". Checking it here turns a
 * runtime failure into a clear 400.
 *
 * Worth stating plainly somewhere users will read it: SQLite's LIKE is case
 * insensitive for ASCII and only ASCII, so `like` and `ilike` are the same
 * operator here, and neither folds case outside that range. 'A' LIKE 'a' is
 * true; the same comparison on an accented, Greek or Cyrillic letter is false.
 * Measured in allowlist.test.ts, recorded in rules/01 section A.
 */
export function toLikePattern(input: string): string {
  let out = '';
  for (const character of input) {
    if (character === '%' || character === '_' || character === LIKE_ESCAPE_CHARACTER) {
      out += LIKE_ESCAPE_CHARACTER + character;
    } else if (character === '*') {
      out += '%';
    } else {
      out += character;
    }
  }

  const bytes = new TextEncoder().encode(out).byteLength;
  if (bytes > MAX_LIKE_PATTERN_BYTES) {
    throw new BaseclfError('UNSUPPORTED_OPERATOR', 400, {
      message:
        `A pattern may be at most ${MAX_LIKE_PATTERN_BYTES} bytes once escaped; ` +
        `this one is ${bytes}.`,
    });
  }
  return out;
}

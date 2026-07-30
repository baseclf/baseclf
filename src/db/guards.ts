/**
 * Assertions that run on compiled SQL before it is ever sent to D1.
 *
 * These are defence in depth, not the primary defence. The primary defence is
 * that identifiers are resolved through the catalogue and values are always
 * bound. See rule 00 invariants I6 and I7.
 *
 * They exist because D1 fails in quiet ways. Double-quoted string literals are
 * enabled, so a bad identifier returns the identifier as a string for every row
 * instead of raising. A guard that throws is better than data that lies.
 */

import { BaseclfError } from '../utils/errors.js';

/** Verified against a remote database on 2026-07-29. 101 raises "too many SQL variables". */
export const D1_MAX_BOUND_PARAMETERS = 100;

/** Documented limit. Not probed. */
export const D1_MAX_SQL_BYTES = 100_000;

export interface CompiledStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * Replaces the contents of every quoted region and comment with spaces, keeping
 * offsets stable so positions still line up with the original string.
 *
 * Handles the four quoting forms SQLite accepts (`'`, `"`, `` ` ``, `[ ]`) and
 * both comment forms. Doubling the quote character escapes it.
 */
export function blankQuotedRegions(sql: string): string {
  const out = sql.split('');
  let i = 0;

  const blankUntil = (closer: string, doubleEscapes: boolean): void => {
    out[i] = ' ';
    i += 1;
    while (i < sql.length) {
      if (sql[i] === closer) {
        if (doubleEscapes && sql[i + 1] === closer) {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        out[i] = ' ';
        i += 1;
        return;
      }
      out[i] = ' ';
      i += 1;
    }
  };

  while (i < sql.length) {
    const c = sql[i];

    if (c === "'" || c === '"' || c === '`') {
      blankUntil(c, true);
      continue;
    }
    if (c === '[') {
      blankUntil(']', false);
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out[i] = ' ';
        i += 1;
      }
      if (i < sql.length) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }

    i += 1;
  }

  return out.join('');
}

/**
 * The number of variables SQLite will allocate for this statement.
 *
 * Positional `?` counts one each. Numbered `?NNN` allocates up to the highest
 * ordinal, so `?1 ?100` is a hundred variables even though only two appear.
 * Mixing the two forms is legal SQLite but we never do it on purpose, so it is
 * treated as a bug.
 */
export function countBoundVariables(sql: string): number {
  const scrubbed = blankQuotedRegions(sql);
  let positional = 0;
  let highestOrdinal = 0;

  for (let i = 0; i < scrubbed.length; i += 1) {
    if (scrubbed[i] !== '?') continue;

    let j = i + 1;
    while (j < scrubbed.length) {
      const next = scrubbed[j];
      if (next === undefined || next < '0' || next > '9') break;
      j += 1;
    }

    if (j === i + 1) {
      positional += 1;
    } else {
      const ordinal = Number(scrubbed.slice(i + 1, j));
      if (ordinal > highestOrdinal) highestOrdinal = ordinal;
      i = j - 1;
    }
  }

  if (positional > 0 && highestOrdinal > 0) {
    throw new BaseclfError('MALFORMED_SQL', 500, {
      message: 'Query construction failed.',
      detail: 'Positional and numbered placeholders are mixed in one statement. Use one form.',
    });
  }

  return positional > 0 ? positional : highestOrdinal;
}

/** Rejects a statement separator that survived outside a quoted region. */
export function assertSingleStatement(compiled: CompiledStatement): void {
  if (blankQuotedRegions(compiled.sql).includes(';')) {
    throw new BaseclfError('MALFORMED_SQL', 500, {
      message: 'Query construction failed.',
      detail: 'Compiled SQL contains a statement separator outside a literal.',
    });
  }
}

/**
 * D1 allows exactly 100 bound variables. Lists must go through
 * `IN (SELECT value FROM json_each(?1))`, which costs one variable regardless
 * of length. Never expand a list into `IN (?,?,?)`.
 */
export function assertParameterBudget(compiled: CompiledStatement): void {
  if (compiled.parameters.length > D1_MAX_BOUND_PARAMETERS) {
    throw new BaseclfError('PARAM_BUDGET_EXCEEDED', 400, {
      message: `A query may bind at most ${D1_MAX_BOUND_PARAMETERS} values.`,
      detail:
        `This statement binds ${compiled.parameters.length}. ` +
        'Pass lists as a JSON array through json_each rather than expanding them.',
    });
  }
}

/** A mismatch here means the builder and the parameter list drifted apart. */
export function assertPlaceholdersMatchParameters(compiled: CompiledStatement): void {
  const declared = countBoundVariables(compiled.sql);
  if (declared !== compiled.parameters.length) {
    throw new BaseclfError('MALFORMED_SQL', 500, {
      message: 'Query construction failed.',
      detail: `SQL declares ${declared} bound variable(s) but ${compiled.parameters.length} were supplied.`,
    });
  }
}

export function assertStatementLength(compiled: CompiledStatement): void {
  const bytes = new TextEncoder().encode(compiled.sql).byteLength;
  if (bytes > D1_MAX_SQL_BYTES) {
    throw new BaseclfError('MALFORMED_SQL', 400, {
      message: 'Query is too large.',
      detail: `Compiled SQL is ${bytes} bytes; D1 allows ${D1_MAX_SQL_BYTES}.`,
    });
  }
}

/**
 * Run every structural check. Call this on the compiled query before handing it
 * to D1, on every path without exception.
 */
export function assertExecutable(compiled: CompiledStatement): void {
  assertSingleStatement(compiled);
  assertParameterBudget(compiled);
  assertPlaceholdersMatchParameters(compiled);
  assertStatementLength(compiled);
}

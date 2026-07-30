import { describe, expect, it } from 'vitest';

import { BaseclfError } from '../utils/errors.js';
import {
  assertExecutable,
  assertParameterBudget,
  assertPlaceholdersMatchParameters,
  assertSingleStatement,
  blankQuotedRegions,
  countBoundVariables,
  D1_MAX_BOUND_PARAMETERS,
} from './guards.js';

const stmt = (sql: string, parameters: readonly unknown[] = []) => ({ sql, parameters });

/**
 * Diagnostics live on `detail`, which is server-side only and never serialised
 * into a response. `message` stays deliberately vague so an error cannot leak
 * an internal table name, the compiled SQL, or whether a row exists. Tests
 * assert on `detail` for the same reason production logs read it.
 */
function detailOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof BaseclfError) return error.detail ?? '';
    throw error;
  }
  throw new Error('expected the call to throw, but it returned');
}

describe('blankQuotedRegions', () => {
  it('keeps offsets stable so positions still line up', () => {
    const sql = `SELECT 'abc' FROM t`;
    expect(blankQuotedRegions(sql)).toHaveLength(sql.length);
  });

  it('blanks single quoted strings including doubled escapes', () => {
    expect(blankQuotedRegions(`SELECT 'it''s; here' FROM t`)).not.toContain(';');
  });

  it('blanks double quoted identifiers', () => {
    expect(blankQuotedRegions(`SELECT "we;ird" FROM t`)).not.toContain(';');
  });

  it('blanks bracket and backtick quoting', () => {
    expect(blankQuotedRegions('SELECT [a;b], `c;d` FROM t')).not.toContain(';');
  });

  it('blanks line and block comments', () => {
    expect(blankQuotedRegions('SELECT 1 -- drop; me\nFROM t')).not.toContain(';');
    expect(blankQuotedRegions('SELECT 1 /* drop; me */ FROM t')).not.toContain(';');
  });
});

describe('countBoundVariables', () => {
  it('counts positional placeholders', () => {
    expect(countBoundVariables('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(2);
  });

  it('ignores question marks inside literals', () => {
    expect(countBoundVariables(`SELECT 'why?' FROM t WHERE a = ?`)).toBe(1);
  });

  it('uses the highest ordinal for numbered placeholders', () => {
    // SQLite allocates up to the highest ordinal, so ?1 ?100 is a hundred
    // variables even though only two appear. Reuse is what makes hoisting a
    // claim free: ?1 twice is still one variable.
    expect(countBoundVariables('SELECT * FROM t WHERE a = ?1 AND b = ?1')).toBe(1);
    expect(countBoundVariables('SELECT * FROM t WHERE a = ?1 AND b = ?100')).toBe(100);
  });

  it('rejects mixing positional and numbered forms', () => {
    expect(detailOf(() => countBoundVariables('SELECT * FROM t WHERE a = ? AND b = ?2'))).toMatch(
      /Positional and numbered/,
    );
  });
});

describe('assertSingleStatement', () => {
  it('accepts a single statement', () => {
    expect(() => assertSingleStatement(stmt('SELECT 1 FROM t'))).not.toThrow();
  });

  it('accepts a semicolon that lives inside a literal', () => {
    expect(() => assertSingleStatement(stmt(`SELECT 'a;b' FROM t`))).not.toThrow();
  });

  it('rejects a statement separator outside a literal', () => {
    expect(detailOf(() => assertSingleStatement(stmt('SELECT 1; DROP TABLE t')))).toMatch(
      /separator/,
    );
  });

  it('keeps the client-facing message free of internals', () => {
    // Rule 03 section C. The response must not carry the SQL that failed.
    try {
      assertSingleStatement(stmt('SELECT secret_column FROM internal_table; DROP TABLE t'));
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as BaseclfError;
      expect(err.message).not.toContain('secret_column');
      expect(err.message).not.toContain('internal_table');
      expect(err.toResponseBody()).not.toHaveProperty('detail');
    }
  });
});

describe('assertParameterBudget', () => {
  it('accepts exactly the D1 ceiling', () => {
    const params = Array.from({ length: D1_MAX_BOUND_PARAMETERS }, (_, i) => i);
    expect(() => assertParameterBudget(stmt('SELECT 1', params))).not.toThrow();
  });

  it('rejects one over the ceiling and names the alternative', () => {
    const params = Array.from({ length: D1_MAX_BOUND_PARAMETERS + 1 }, (_, i) => i);
    expect(() => assertParameterBudget(stmt('SELECT 1', params))).toThrow(/at most 100/);
  });
});

describe('assertPlaceholdersMatchParameters', () => {
  it('accepts a matching pair', () => {
    expect(() => assertPlaceholdersMatchParameters(stmt('SELECT ?, ?', [1, 2]))).not.toThrow();
  });

  it('rejects a builder that drifted from its parameter list', () => {
    expect(detailOf(() => assertPlaceholdersMatchParameters(stmt('SELECT ?, ?', [1])))).toMatch(
      /declares 2 bound variable/,
    );
  });
});

describe('assertExecutable', () => {
  it('passes a well formed statement', () => {
    expect(() =>
      assertExecutable(stmt('SELECT id FROM posts WHERE author_id = ?', ['u_1'])),
    ).not.toThrow();
  });

  it('catches a stray statement separator', () => {
    expect(() => assertExecutable(stmt('SELECT 1; SELECT 2'))).toThrow();
  });
});

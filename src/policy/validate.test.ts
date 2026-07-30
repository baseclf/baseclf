/**
 * The rules that need to know what the database looks like.
 *
 * The one worth reading is the negation rule. It is a decision, not an
 * implementation detail, and it was left open in rules/01 section G until now.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { type Catalogue, getCatalogue, resetCatalogue } from '../db/introspect.js';
import type { PolicyError } from '../utils/errors.js';
import { seedDatabase } from './__fixtures__/schema.js';
import { parseTableDefinition } from './parse.js';
import { validateTableDefinition } from './validate.js';

let catalogue: Catalogue;

beforeAll(async () => {
  await seedDatabase(env.DB);
  resetCatalogue();
  catalogue = await getCatalogue(env.DB);
});

function validate(
  using: unknown,
  options: { table?: string; columns?: readonly string[]; binds?: Record<string, unknown> } = {},
): void {
  const definition = parseTableDefinition({
    table: options.table ?? 'posts',
    enabled: true,
    binds: options.binds ?? {},
    policies: [
      {
        name: 'p',
        for: 'select',
        to: ['anon'],
        using,
        columns: options.columns ?? ['id'],
      },
    ],
  });
  validateTableDefinition(catalogue, definition);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as PolicyError).code;
  }
  return 'NO_THROW';
}

describe('identifiers', () => {
  it('must exist, matched character for character', () => {
    expect(() => validate({ author_id: { _eq: '$auth.uid' } })).not.toThrow();

    expect(codeOf(() => validate({ autor_id: { _eq: '$auth.uid' } }))).toBe('UNKNOWN_IDENTIFIER');
    expect(codeOf(() => validate({ Author_Id: { _eq: '$auth.uid' } }))).toBe('UNKNOWN_IDENTIFIER');
    expect(codeOf(() => validate({ author: { _eq: '$auth.uid' } }))).toBe('UNKNOWN_IDENTIFIER');
  });

  it('are checked in the column grant list too', () => {
    expect(codeOf(() => validate(true, { columns: ['id', 'titel'] }))).toBe('UNKNOWN_IDENTIFIER');
  });

  it('are checked inside an _exists, against the inner table', () => {
    expect(() =>
      validate({
        _exists: { _table: 'org_members', _where: { user_id: { _eq: '$auth.uid' } } },
      }),
    ).not.toThrow();

    // `title` is a column of posts, not of org_members.
    expect(
      codeOf(() =>
        validate({ _exists: { _table: 'org_members', _where: { title: { _eq: 'x' } } } }),
      ),
    ).toBe('UNKNOWN_IDENTIFIER');
  });

  it('resolve $row against the table one level out', () => {
    expect(() =>
      validate({
        _exists: { _table: 'org_members', _where: { org_id: { _eq: '$row.org_id' } } },
      }),
    ).not.toThrow();

    expect(
      codeOf(() =>
        validate({
          _exists: { _table: 'org_members', _where: { org_id: { _eq: '$row.no_such_column' } } },
        }),
      ),
    ).toBe('UNKNOWN_IDENTIFIER');
  });

  it('refuse $row where there is no enclosing table', () => {
    expect(codeOf(() => validate({ org_id: { _eq: '$row.org_id' } }))).toBe('INVALID_EXPR');
  });
});

describe('engine tables', () => {
  it('cannot be given a policy document', () => {
    expect(codeOf(() => validate(true, { table: '_policies', columns: ['name'] }))).toBe(
      'INVALID_EXPR',
    );
  });

  it('cannot be traversed from a policy either', () => {
    // Otherwise a policy on an ordinary table would be a way to read the
    // engine's own tables one boolean at a time.
    expect(
      codeOf(() => validate({ _exists: { _table: '_policies', _where: { name: { _eq: 'x' } } } })),
    ).toBe('INVALID_EXPR');
  });
});

describe('negation over a column that can be NULL', () => {
  // The decision rules/01 section G1 left open.
  //
  // Measured 2026-07-30: a plain TEXT PRIMARY KEY accepts NULL, so nullability
  // is not something a schema can be assumed out of. NOT (NULL = 'x') is NULL,
  // and WHERE reads NULL as false, so a negated policy hides rows whose column
  // is NULL rather than matching them.
  //
  // Both automatic fixes are wrong. Wrapping the operand in "col IS NULL OR ..."
  // would widen a policy predicate on the engine's own initiative, and nothing
  // may add rows the author did not write. Leaving it silent keeps a trap that
  // reads as correct. So it is refused and the author writes it out.
  //
  // Note what this is not: it is not closing a hole. NULL is falsy in WHERE, so
  // the surprise is always in the restrictive direction. It is a rule about
  // being able to trust what a policy says.

  it('is refused', () => {
    // posts.body is nullable.
    expect(codeOf(() => validate({ _not: { body: { _eq: 'x' } } }))).toBe('INVALID_EXPR');
  });

  it('is allowed when the column cannot be NULL', () => {
    // posts.status is NOT NULL.
    expect(() => validate({ _not: { status: { _eq: 'draft' } } })).not.toThrow();
  });

  it('is refused however deeply the nullable column sits inside the negation', () => {
    expect(
      codeOf(() =>
        validate({ _not: { _and: [{ status: { _eq: 'a' } }, { body: { _eq: 'b' } }] } }),
      ),
    ).toBe('INVALID_EXPR');
    expect(codeOf(() => validate({ _not: { _not: { body: { _eq: 'x' } } } }))).toBe('INVALID_EXPR');
    expect(codeOf(() => validate({ _not: { body: { _in: ['x'] } } }))).toBe('INVALID_EXPR');
    expect(codeOf(() => validate({ _not: { body: { _like: 'x%' } } }))).toBe('INVALID_EXPR');
  });

  it('allows negating the operators that cannot produce NULL', () => {
    // IS NULL answers true or false whatever the data holds.
    expect(() => validate({ _not: { body: { _is_null: true } } })).not.toThrow();
    // So does EXISTS.
    expect(() =>
      validate({
        _not: { _exists: { _table: 'org_members', _where: { user_id: { _eq: '$auth.uid' } } } },
      }),
    ).not.toThrow();
  });

  it('leaves _neq alone, which is the way out of the rule', () => {
    // "x != y does not match NULL" is the single most widely known fact about
    // SQL nulls, so it is not a trap the way a negated subtree is. Spelling the
    // NULL case out with it is the documented fix.
    expect(() => validate({ body: { _neq: 'x' } })).not.toThrow();
    expect(() =>
      validate({ _or: [{ body: { _is_null: true } }, { body: { _neq: 'x' } }] }),
    ).not.toThrow();
  });

  it('accounts for a nullable column reached through $row', () => {
    expect(
      codeOf(() =>
        validate({
          _exists: {
            _table: 'org_members',
            _where: { _not: { org_id: { _eq: '$row.body' } } },
          },
        }),
      ),
    ).toBe('INVALID_EXPR');
  });
});

describe('traversal depth', () => {
  it('allows two levels', () => {
    expect(() =>
      validate({
        _exists: {
          _table: 'org_members',
          _where: {
            _exists: { _table: 'posts', _where: { author_id: { _eq: '$auth.uid' } } },
          },
        },
      }),
    ).not.toThrow();
  });

  it('refuses three, because each level multiplies what D1 charges for', () => {
    expect(
      codeOf(() =>
        validate({
          _exists: {
            _table: 'org_members',
            _where: {
              _exists: {
                _table: 'posts',
                _where: {
                  _exists: { _table: 'org_members', _where: { role: { _eq: 'admin' } } },
                },
              },
            },
          },
        }),
      ),
    ).toBe('INVALID_EXPR');
  });
});

describe('like patterns', () => {
  it('are refused above the length D1 accepts', () => {
    // Verified 2026-07-29: 50 bytes works, 51 raises
    // "LIKE or GLOB pattern too complex".
    expect(() => validate({ title: { _like: 'a'.repeat(50) } })).not.toThrow();
    expect(codeOf(() => validate({ title: { _like: 'a'.repeat(51) } }))).toBe('INVALID_EXPR');
  });

  it('count bytes rather than characters', () => {
    // Twenty six characters, fifty two bytes.
    expect(codeOf(() => validate({ title: { _like: '\u00E9'.repeat(26) } }))).toBe('INVALID_EXPR');
  });
});

/**
 * Parsing a policy document. No database involved, so every branch is cheap to
 * reach and there is no excuse for leaving one untested.
 */

import { describe, expect, it } from 'vitest';

import type { PolicyError } from '../utils/errors.js';
import { parseTableDefinition } from './parse.js';

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    table: 'posts',
    enabled: true,
    policies: [
      {
        name: 'p',
        for: 'select',
        to: ['anon'],
        using: { status: { _eq: 'published' } },
        columns: ['id'],
      },
    ],
    ...overrides,
  };
}

function parseUsing(using: unknown, extra: Record<string, unknown> = {}) {
  return parseTableDefinition(
    document({
      ...extra,
      policies: [{ name: 'p', for: 'select', to: ['anon'], using, columns: ['id'] }],
    }),
  );
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as PolicyError).code;
  }
  return 'NO_THROW';
}

describe('user metadata', () => {
  it('is refused, and refused as its own error code', () => {
    // Rule 00 invariant I4. This is the escalation people actually run: set
    // user_metadata.role to admin, then find a policy that trusted it.
    expect(codeOf(() => parseUsing({ author_id: { _eq: '$auth.user.id' } }))).toBe(
      'FORBIDDEN_CLAIM',
    );
    expect(codeOf(() => parseUsing({ author_id: { _eq: '$auth.user.role' } }))).toBe(
      'FORBIDDEN_CLAIM',
    );
    expect(codeOf(() => parseUsing({ author_id: { _eq: '$auth.user.anything.nested' } }))).toBe(
      'FORBIDDEN_CLAIM',
    );
  });

  it('is refused inside every structure a policy can build', () => {
    const forbidden = { author_id: { _eq: '$auth.user.id' } };

    expect(codeOf(() => parseUsing({ _not: forbidden }))).toBe('FORBIDDEN_CLAIM');
    expect(codeOf(() => parseUsing({ _and: [{ id: { _eq: '1' } }, forbidden] }))).toBe(
      'FORBIDDEN_CLAIM',
    );
    expect(codeOf(() => parseUsing({ _or: [forbidden] }))).toBe('FORBIDDEN_CLAIM');
    expect(
      codeOf(() => parseUsing({ _exists: { _table: 'org_members', _where: forbidden } })),
    ).toBe('FORBIDDEN_CLAIM');
    expect(codeOf(() => parseUsing({ $bind: 'b' }, { binds: { b: forbidden } }))).toBe(
      'FORBIDDEN_CLAIM',
    );
  });

  it('does not block app_metadata, which the server owns', () => {
    const parsed = parseUsing({ author_id: { _eq: '$auth.app.tenant' } });
    expect(parsed.policies[0]?.using).toEqual({
      kind: 'compare',
      column: 'author_id',
      operator: '_eq',
      value: { kind: 'claim', ref: { source: 'app', key: 'tenant' } },
    });
  });
});

describe('tokens', () => {
  it('accepts the ones the engine defines', () => {
    for (const token of ['$auth.uid', '$auth.email', '$auth.role', '$auth.app.plan']) {
      expect(() => parseUsing({ author_id: { _eq: token } })).not.toThrow();
    }
  });

  it('refuses a token it does not know rather than treating it as text', () => {
    // A typo has to be an error. Read as a literal, "$auth.uidd" would compile
    // to a comparison against that exact string, which matches nothing and
    // looks like a policy that works.
    expect(codeOf(() => parseUsing({ author_id: { _eq: '$auth.uidd' } }))).toBe('INVALID_EXPR');
    expect(codeOf(() => parseUsing({ author_id: { _eq: '$auth' } }))).toBe('INVALID_EXPR');
    expect(codeOf(() => parseUsing({ author_id: { _eq: '$whatever' } }))).toBe('INVALID_EXPR');
  });
});

describe('shapes that would be a hole', () => {
  it('requires using to be written out', () => {
    // Absent, it would have to default to something, and every default is
    // either "all rows" or "a policy that silently does nothing".
    expect(
      codeOf(() =>
        parseTableDefinition(
          document({ policies: [{ name: 'p', for: 'select', to: ['anon'], columns: ['id'] }] }),
        ),
      ),
    ).toBe('INVALID_EXPR');
  });

  it('accepts true as the explicit way to say every row', () => {
    expect(parseUsing(true).policies[0]?.using).toEqual({ kind: 'all' });
  });

  it('refuses an empty _and, which is true wearing a disguise', () => {
    expect(codeOf(() => parseUsing({ _and: [] }))).toBe('INVALID_EXPR');
    expect(codeOf(() => parseUsing({ _or: [] }))).toBe('INVALID_EXPR');
  });

  it('leaves a table unexposed unless enabled is exactly true', () => {
    for (const value of [undefined, false, 1, 'true', null]) {
      expect(parseTableDefinition(document({ enabled: value })).enabled).toBe(false);
    }
    expect(parseTableDefinition(document({ enabled: true })).enabled).toBe(true);
  });

  it('refuses two conditions side by side rather than guessing they mean and', () => {
    expect(
      codeOf(() => parseUsing({ status: { _eq: 'published' }, author_id: { _eq: '$auth.uid' } })),
    ).toBe('INVALID_EXPR');
    expect(codeOf(() => parseUsing({ status: { _eq: 'a', _neq: 'b' } }))).toBe('INVALID_EXPR');
  });
});

describe('binds', () => {
  it('are expanded in place', () => {
    const parsed = parseUsing(
      { $bind: 'isAuthor' },
      { binds: { isAuthor: { author_id: { _eq: '$auth.uid' } } } },
    );

    expect(parsed.policies[0]?.using).toEqual({
      kind: 'compare',
      column: 'author_id',
      operator: '_eq',
      value: { kind: 'claim', ref: { source: 'uid' } },
    });
  });

  it('may refer to one another', () => {
    expect(() =>
      parseUsing(
        { $bind: 'outer' },
        { binds: { outer: { $bind: 'inner' }, inner: { id: { _eq: '1' } } } },
      ),
    ).not.toThrow();
  });

  it('refuse to refer to themselves', () => {
    expect(codeOf(() => parseUsing({ $bind: 'a' }, { binds: { a: { $bind: 'a' } } }))).toBe(
      'INVALID_EXPR',
    );
    expect(
      codeOf(() => parseUsing({ $bind: 'a' }, { binds: { a: { $bind: 'b' }, b: { $bind: 'a' } } })),
    ).toBe('INVALID_EXPR');
  });

  it('must exist', () => {
    expect(codeOf(() => parseUsing({ $bind: 'missing' }))).toBe('INVALID_EXPR');
  });
});

describe('operators', () => {
  it('rejects an underscore key that is not one of them', () => {
    // A column really named `_hidden` would otherwise be indistinguishable from
    // a misspelled operator, and guessing either way is worse than refusing.
    expect(codeOf(() => parseUsing({ _eqq: [{ id: { _eq: '1' } }] }))).toBe('INVALID_EXPR');
    expect(codeOf(() => parseUsing({ _hidden: { _eq: '1' } }))).toBe('INVALID_EXPR');
  });

  it('requires _exists to be correlated', () => {
    // Without a _where this asks "does the other table have any row at all",
    // which answers a question about other tenants.
    expect(codeOf(() => parseUsing({ _exists: { _table: 'org_members' } }))).toBe('INVALID_EXPR');
  });

  it('takes _is_null as a boolean and nothing else', () => {
    expect(() => parseUsing({ body: { _is_null: true } })).not.toThrow();
    expect(codeOf(() => parseUsing({ body: { _is_null: 'true' } }))).toBe('INVALID_EXPR');
  });

  it('takes _in as a list of literals or a claim', () => {
    expect(() => parseUsing({ id: { _in: ['a', 'b'] } })).not.toThrow();
    expect(() => parseUsing({ id: { _in: '$auth.app.allowed' } })).not.toThrow();
    // A token inside the list would have to be resolved per entry, which is a
    // shape nothing needs and one more thing to get wrong.
    expect(codeOf(() => parseUsing({ id: { _in: ['$auth.uid'] } }))).toBe('INVALID_EXPR');
  });
});

describe('structural limits', () => {
  it('refuses a document nested deeply enough to be expensive to walk', () => {
    let nested: unknown = { id: { _eq: '1' } };
    for (let i = 0; i < 40; i += 1) nested = { _not: nested };

    expect(codeOf(() => parseUsing(nested))).toBe('INVALID_EXPR');
  });

  it('refuses two policies with the same name', () => {
    expect(
      codeOf(() =>
        parseTableDefinition(
          document({
            policies: [
              { name: 'p', for: 'select', to: ['anon'], using: true, columns: ['id'] },
              { name: 'p', for: 'select', to: ['anon'], using: true, columns: ['id'] },
            ],
          }),
        ),
      ),
    ).toBe('INVALID_EXPR');
  });

  it('refuses an operation it does not implement', () => {
    expect(
      codeOf(() =>
        parseTableDefinition(
          document({
            policies: [{ name: 'p', for: 'truncate', to: ['anon'], using: true, columns: ['id'] }],
          }),
        ),
      ),
    ).toBe('INVALID_EXPR');
  });

  it('refuses an empty column list', () => {
    expect(
      codeOf(() =>
        parseTableDefinition(
          document({
            policies: [{ name: 'p', for: 'select', to: ['anon'], using: true, columns: [] }],
          }),
        ),
      ),
    ).toBe('INVALID_EXPR');
  });
});

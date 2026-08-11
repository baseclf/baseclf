import { describe, expect, it } from 'vitest';

import type { Catalogue, TableInfo } from '../src/db/introspect.js';
import {
  checkAgainstSchema,
  nextVersion,
  readPolicyDocument,
  writeStatements,
} from './policy-document.js';

/** A document shaped the way `skills/policy-engine` section 3 writes them. */
function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    table: 'posts',
    enabled: true,
    policies: [
      {
        name: 'read_own',
        for: 'select',
        to: ['authenticated'],
        using: { author_id: { _eq: '$auth.uid' } },
        // Required, and deliberately so: an absent column list would have to default
        // to something, and every default is either every column or none.
        columns: ['id', 'title'],
      },
    ],
    ...overrides,
  });
}

function catalogue(columns: readonly string[]): Catalogue {
  const table: TableInfo = {
    name: 'posts',
    // Invariant I8: the underscore prefix is what marks a system table, and the
    // catalogue carries the answer rather than every caller re-deriving it.
    isSystem: false,
    columns: new Map(
      columns.map((name) => [
        name,
        { name, type: 'TEXT', notNull: false, primaryKey: false, hasDefault: false },
      ]),
    ),
    indexes: [],
    foreignKeys: [],
  };

  return {
    tables: new Map([['posts', table]]),
    hasTable: (name) => name === 'posts',
    hasColumn: (t, column) => t === 'posts' && columns.includes(column),
    isIndexed: () => true,
  };
}

describe('refusing a document the engine would refuse', () => {
  it('rejects a policy that reads user_metadata', async () => {
    // 🔴 Invariant I4. The check has to happen when the policy is stored, because a
    // policy that reached the database is one a later reader will trust. This test
    // is the reason the CLI imports the engine parser rather than checking anything
    // of its own.
    expect(() =>
      readPolicyDocument(
        document({
          policies: [
            {
              name: 'bad',
              for: 'select',
              to: ['authenticated'],
              using: { tenant: { _eq: '$auth.user.tenant' } },
              columns: ['id'],
            },
          ],
        }),
      ),
    ).toThrow(/user metadata/i);
  });

  it('rejects user_metadata inside a bind nothing refers to', async () => {
    // 🔴 The subtle one. Parsing the document only exercises binds some policy uses,
    // so an unreferenced bind would be written unchecked and break the whole table
    // the day somebody finally referenced it, in a deployment, pointing at a file
    // edited weeks earlier.
    expect(() =>
      readPolicyDocument(
        document({
          binds: { unused: { tenant: { _eq: '$auth.user.tenant' } } },
        }),
      ),
    ).toThrow(/user metadata/i);
  });

  it('says a file is not JSON rather than reporting it as a policy problem', () => {
    // Two different things. One is a typo, the other is a policy that would have
    // been wrong, and telling them apart is most of what makes an error useful.
    expect(() => readPolicyDocument('{ not json')).toThrow(/not valid JSON/i);
  });

  it('rejects a column that does not exist in the live schema', () => {
    // Invariant I6. With double-quoted strings enabled on D1, a wrong column name
    // comes back as a string instead of an error, so this refusal is the only thing
    // between a typo and a predicate that quietly stops filtering.
    const parsed = readPolicyDocument(document());

    expect(() => checkAgainstSchema(catalogue(['id', 'title']), parsed.definition)).toThrow();
  });

  it('accepts a document whose columns are all real', () => {
    const parsed = readPolicyDocument(document());

    expect(() =>
      checkAgainstSchema(catalogue(['id', 'title', 'author_id']), parsed.definition),
    ).not.toThrow();
  });
});

describe('the order the write happens in', () => {
  const statements = () => writeStatements(readPolicyDocument(document()), 2);

  it('removes the table from _exposed_tables before touching anything else', () => {
    // 🔴 This ordering is the safety mechanism, because there is no transaction to
    // have: the D1 REST API refuses bound parameters when a request holds more than
    // one statement, and invariant I7 does not allow the alternative.
    //
    // Unexposing first means every half-finished state is a closed one. The reader
    // loses access to their own table and is told to run it again, which is the
    // failure worth having.
    const first = statements()[0];

    expect(first?.sql).toContain('DELETE');
    expect(first?.sql).toContain('_exposed_tables');
  });

  it('puts the table back only after every policy row is written', () => {
    const all = statements();
    const last = all[all.length - 1];

    expect(last?.sql).toContain('INSERT');
    expect(last?.sql).toContain('_exposed_tables');

    const policyWrites = all.findIndex(
      (s) => s.sql.includes('INSERT') && s.sql.includes('_policies'),
    );
    expect(policyWrites).toBeLessThan(all.length - 1);
  });

  it('never puts a value in the SQL', () => {
    // Invariant I7, checked rather than trusted. Every value goes through `params`.
    for (const statement of statements()) {
      expect(statement.sql).not.toContain('posts');
      expect(statement.sql).not.toContain('read_own');
    }
  });

  it('🔴 writes every expression in the source grammar the registry reads back', () => {
    // The bug this test exists for, found by an audit and not by anything here.
    //
    // `writeStatements` used to serialise `definition.policies`, which is the parsed
    // AST: a `using` written as {"author_id":{"_eq":"$auth.uid"}} was stored as
    // {"kind":"compare","column":"author_id",...}. `loadRegistry` feeds the stored
    // column straight back into `parseTableDefinition`, which reads the source
    // grammar, so nothing written that way could ever be read back.
    //
    // It fails loudly, and it fails for the WHOLE registry: one such row and
    // /rest/v1/* answers 500 for every table on the deployment, including tables
    // configured before this command existed.
    //
    // The sibling test below covered binds, which is the one column that already
    // took its value from the source document, so it passed throughout.
    const using = { author_id: { _eq: '$auth.uid' } };
    const check = { status: { _eq: 'draft' } };

    const parsed = readPolicyDocument(
      document({
        policies: [
          {
            name: 'update_own',
            for: 'update',
            to: ['authenticated'],
            using,
            check,
            columns: ['title'],
          },
        ],
      }),
    );

    const insert = writeStatements(parsed, 1).find(
      (s) => s.sql.includes('_policies') && s.sql.includes('INSERT'),
    );

    expect(JSON.parse(String(insert?.params[4]))).toEqual(using);
    expect(JSON.parse(String(insert?.params[5]))).toEqual(check);
    expect(JSON.parse(String(insert?.params[6]))).toEqual(['title']);
  });

  it('writes binds in the form they were written, not the expanded form', () => {
    // The parser expands binds into the policies that use them. The registry stores
    // them unexpanded and expands them again on every load, so writing the expanded
    // form would store something the engine cannot read back.
    const parsed = readPolicyDocument(
      document({
        binds: { isAuthor: { author_id: { _eq: '$auth.uid' } } },
        policies: [
          {
            name: 'read_own',
            for: 'select',
            to: ['authenticated'],
            using: { $bind: 'isAuthor' },
            columns: ['id'],
          },
        ],
      }),
    );

    const bind = writeStatements(parsed, 1).find(
      (s) => s.sql.includes('_policy_binds') && s.sql.includes('INSERT'),
    );

    expect(bind).toBeDefined();
    expect(JSON.parse(String(bind?.params[2]))).toEqual({ author_id: { _eq: '$auth.uid' } });
  });
});

describe('the version', () => {
  it('always goes up, so a cached registry knows to reload', () => {
    // The registry caches compiled SQL against the version. A version that stayed
    // the same would leave a deployment serving the previous policy with nothing
    // anywhere saying so.
    expect(nextVersion(null)).toBe(1);
    expect(nextVersion(1)).toBe(2);
    expect(nextVersion(41)).toBe(42);
  });

  it('is the version that gets written', () => {
    const written = writeStatements(readPolicyDocument(document()), 7);
    const expose = written[written.length - 1];

    expect(expose?.params).toContain(7);
  });
});

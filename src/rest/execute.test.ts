/**
 * The last check before SQL leaves the Worker.
 *
 * This is the layer rule 00 invariant I6 calls for, and the only one that would
 * still catch a bug in everything above it. The first test measures the
 * behaviour it exists for, so that if D1 ever turns double quoted string
 * literals off, the reason this code is here stops being true out loud rather
 * than quietly.
 */

import { env } from 'cloudflare:workers';
import {
  ColumnNode,
  ReferenceNode,
  SelectionNode,
  SelectQueryNode,
  SqliteQueryCompiler,
  TableNode,
} from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';

import { type Catalogue, getCatalogue, resetCatalogue } from '../db/introspect.js';
import { seedDatabase } from '../policy/__fixtures__/schema.js';
import type { BaseclfError } from '../utils/errors.js';
import {
  assertIdentifiersAreReal,
  collectTableNames,
  executeStatement,
  extractQuotedIdentifiers,
} from './execute.js';

let catalogue: Catalogue;

beforeAll(async () => {
  await seedDatabase(env.DB);
  resetCatalogue();
  catalogue = await getCatalogue(env.DB);
});

/** A select of the given columns from the given table, with no policy on it. */
function selectOf(table: string, columns: readonly string[]): SelectQueryNode {
  return {
    ...SelectQueryNode.createFrom([TableNode.create(table)]),
    selections: columns.map((column) =>
      SelectionNode.create(
        ReferenceNode.create(ColumnNode.create(column), TableNode.create(table)),
      ),
    ),
  };
}

function compile(node: SelectQueryNode): string {
  return new SqliteQueryCompiler().compileQuery(node, { queryId: 'test' }).sql;
}

describe('what D1 does with an identifier that is not one', () => {
  it('returns it as text rather than raising', async () => {
    // The measurement everything else in this file is a response to. Verified
    // on remote D1 2026-07-29 and again here in workerd.
    const row = await env.DB.prepare('SELECT "no_such_column" AS value FROM posts LIMIT 1').first<{
      value: string;
    }>();

    expect(row?.value).toBe('no_such_column');
  });

  it('does the same for a whole select list', async () => {
    const result = await env.DB.prepare('SELECT "titel" AS a, "athor" AS b FROM posts').all<{
      a: string;
      b: string;
    }>();

    // Four rows of confident nonsense, and no error anywhere.
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]).toEqual({ a: 'titel', b: 'athor' });
  });
});

describe('extractQuotedIdentifiers', () => {
  it('finds each quoted region', () => {
    expect(extractQuotedIdentifiers('select "a"."b" from "a"')).toEqual(['a', 'b', 'a']);
  });

  it('unescapes a doubled quote, which is how SQLite spells one', () => {
    expect(extractQuotedIdentifiers('select "we""ird" from "t"')).toEqual(['we"ird', 't']);
  });

  it('finds nothing in a statement with no identifiers', () => {
    expect(extractQuotedIdentifiers('select 1')).toEqual([]);
  });
});

describe('collectTableNames', () => {
  it('finds the table a select reads', () => {
    expect([...collectTableNames(selectOf('posts', ['id']))]).toEqual(['posts']);
  });

  it('finds a table nested inside a subquery', () => {
    const outer = selectOf('posts', ['id']);
    const withSubquery: SelectQueryNode = {
      ...outer,
      where: { kind: 'WhereNode', where: selectOf('org_members', ['user_id']) },
    };

    expect([...collectTableNames(withSubquery)].sort()).toEqual(['org_members', 'posts']);
  });
});

describe('assertIdentifiersAreReal', () => {
  const scope = { aliases: new Set<string>() };

  it('passes a statement built from real names', () => {
    const node = selectOf('posts', ['id', 'title']);
    expect(() => assertIdentifiersAreReal(compile(node), node, catalogue, scope)).not.toThrow();
  });

  it('catches a column that does not exist', () => {
    // The scenario the whole discipline is for: something upstream let a bad
    // name through, and D1 would have answered with the name as data.
    const node = selectOf('posts', ['titel']);

    expect(() => assertIdentifiersAreReal(compile(node), node, catalogue, scope)).toThrow();
  });

  it('catches a column that exists on another table', () => {
    // `role` is real, but not on posts. A check that only asked "is this a
    // column somewhere" would let this through.
    const node = selectOf('posts', ['role']);

    expect(() => assertIdentifiersAreReal(compile(node), node, catalogue, scope)).toThrow();
  });

  it('catches an engine table', () => {
    const node = selectOf('_policies', ['name']);
    expect(() => assertIdentifiersAreReal(compile(node), node, catalogue, scope)).toThrow();
  });

  it('catches a table that is not in the catalogue at all', () => {
    const node = selectOf('imaginary', ['id']);
    expect(() => assertIdentifiersAreReal(compile(node), node, catalogue, scope)).toThrow();
  });

  it('accepts an alias the caller asked for, and only that one', () => {
    const node = selectOf('posts', ['id']);
    const sql = `${compile(node)} /* "headline" */`.replace('/*', '').replace('*/', '');

    expect(() =>
      assertIdentifiersAreReal(sql, node, catalogue, { aliases: new Set(['headline']) }),
    ).not.toThrow();
    expect(() =>
      assertIdentifiersAreReal(sql, node, catalogue, { aliases: new Set(['other']) }),
    ).toThrow();
  });

  it('reports the failure as a server fault, not a client one', () => {
    // Reaching this means the layers above did not do their job. It is a bug in
    // the engine, and a 500 says so rather than blaming the caller.
    const node = selectOf('posts', ['titel']);
    let status: number | undefined;
    try {
      assertIdentifiersAreReal(compile(node), node, catalogue, scope);
    } catch (error) {
      status = (error as BaseclfError).status;
    }
    expect(status).toBe(500);
  });
});

describe('executeSelect', () => {
  it('runs a checked statement and reports what it scanned', async () => {
    const node = selectOf('posts', ['id']);
    const result = await executeStatement<{ id: string }>({
      executor: env.DB,
      node,
      catalogue,
      scope: { aliases: new Set() },
    });

    expect(result.rows.length).toBe(4);
    expect(result.parameterCount).toBe(0);
    // D1 counts rows scanned rather than rows returned, and bills for it.
    expect(result.rowsRead).not.toBeNull();
  });

  it('refuses to run a statement that would have lied', async () => {
    const node = selectOf('posts', ['titel']);

    await expect(
      executeStatement({ executor: env.DB, node, catalogue, scope: { aliases: new Set() } }),
    ).rejects.toThrow();
  });
});

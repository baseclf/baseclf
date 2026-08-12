/**
 * What the linter says, against a real catalogue.
 *
 * The tables below are created in D1 and read back with `introspect`, so `isIndexed`
 * is SQLite answering rather than a fake agreeing with the test. An index check built
 * on a stubbed catalogue would pass while disagreeing with the database, which is the
 * one thing this file exists to prevent somebody being wrong about.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { type Catalogue, introspect, resetCatalogue } from '../db/introspect.js';
import { lintTable } from './lint.js';
import { parseTableDefinition } from './parse.js';

let catalogue: Catalogue;

beforeAll(async () => {
  resetCatalogue();

  await env.DB.prepare('DROP TABLE IF EXISTS memberships').run();
  await env.DB.prepare('DROP TABLE IF EXISTS notes').run();

  // `author_id` is indexed and NOT NULL. `body` has neither. `nickname` is indexed
  // but nullable, so the two checks cannot be satisfied by the same column and a
  // finding cannot be right by accident.
  await env.DB.prepare(
    `CREATE TABLE notes (
       id        TEXT NOT NULL PRIMARY KEY,
       author_id TEXT NOT NULL,
       org_id    TEXT NOT NULL,
       nickname  TEXT,
       body      TEXT
     )`,
  ).run();
  await env.DB.prepare('CREATE INDEX notes_author_id ON notes(author_id)').run();
  await env.DB.prepare('CREATE INDEX notes_nickname ON notes(nickname)').run();

  await env.DB.prepare(
    `CREATE TABLE memberships (
       id      TEXT NOT NULL PRIMARY KEY,
       org_id  TEXT NOT NULL,
       user_id TEXT NOT NULL
     )`,
  ).run();

  catalogue = await introspect(env.DB);
});

/** One table definition with one policy, parsed the way the engine parses it. */
function definition(using: unknown, overrides: Record<string, unknown> = {}) {
  return parseTableDefinition({
    table: 'notes',
    enabled: true,
    policies: [
      {
        name: 'read',
        for: 'select',
        to: ['authenticated'],
        using,
        columns: ['id', 'body'],
        ...overrides,
      },
    ],
  });
}

describe('the bill a policy signs up for', () => {
  it('names an unindexed column and hands back the statement that fixes it', async () => {
    // 🔴 D1 charges for rows scanned, not returned, so this is a recurring cost the
    // author has nowhere else to see.
    const findings = lintTable(catalogue, definition({ body: { _eq: 'x' } }));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('unindexed_column');
    expect(findings[0]?.policy).toBe('read');
    expect(findings[0]?.remedy).toBe('CREATE INDEX "notes_body_idx" ON "notes" ("body");');
  });

  it('says nothing about a column that is already indexed', async () => {
    expect(lintTable(catalogue, definition({ author_id: { _eq: '$auth.uid' } }))).toEqual([]);
  });

  it('treats a primary key as indexed, because the planner does', async () => {
    expect(lintTable(catalogue, definition({ id: { _eq: '$auth.uid' } }))).toEqual([]);
  });

  it('reports a column once however many times the policy names it', async () => {
    const findings = lintTable(
      catalogue,
      definition({
        _or: [{ body: { _eq: 'x' } }, { body: { _eq: 'y' } }, { body: { _like: 'z%' } }],
      }),
    );

    expect(findings).toHaveLength(1);
  });

  it('checks the column on the joined table, not only the one it started on', async () => {
    // ⚠️ The correlated column inside `_exists` is the one that decides whether the
    // subquery is a lookup or a scan of somebody's whole membership table, and it
    // belongs to the joined table rather than to the one the policy is on.
    // Attributing it outwards would warn about the wrong column and stay quiet about
    // the expensive one.
    const findings = lintTable(
      catalogue,
      definition({
        _exists: {
          _table: 'memberships',
          _where: {
            _and: [{ org_id: { _eq: '$row.org_id' } }, { user_id: { _eq: '$auth.uid' } }],
          },
        },
      }),
    );

    expect(findings.map((finding) => finding.table).sort()).toEqual(['memberships', 'memberships']);
    expect(findings.every((finding) => finding.code === 'unindexed_column')).toBe(true);
    expect(findings.map((finding) => finding.remedy).join(' ')).toContain('"memberships"');
  });

  it('says nothing about the outer column a correlated subquery reads', async () => {
    // 🔴 The first version of this reported `notes.org_id` here, and the test above
    // is what caught it. In `memberships.org_id = notes.org_id` the outer column is a
    // value read out of the row the scan already holds, not a key anything is looked
    // up by, so an index on it costs writes and changes no reads.
    //
    // `notes.org_id` has no index, so a linter that treated it as a search key would
    // report it. That is the whole point of leaving it unindexed in the fixture.
    const findings = lintTable(
      catalogue,
      definition({
        _exists: {
          _table: 'memberships',
          _where: { org_id: { _eq: '$row.org_id' } },
        },
      }),
    );

    expect(catalogue.isIndexed('notes', 'org_id')).toBe(false);
    expect(findings.map((finding) => finding.table)).toEqual(['memberships']);
  });

  it('is quiet about a column the catalogue does not have', async () => {
    // Not this check's business. `validateTableDefinition` refuses those, and a
    // second weaker opinion here would be a second thing to keep in step with
    // invariant I6.
    const findings = lintTable(catalogue, {
      table: 'notes',
      enabled: true,
      version: 1,
      policies: [
        {
          name: 'read',
          operation: 'select',
          roles: ['authenticated'],
          using: {
            kind: 'compare',
            column: 'no_such_column',
            operator: '_eq',
            value: { kind: 'literal', value: 'x' },
          },
          check: null,
          columns: ['id'],
          set: [],
        },
      ],
    });

    expect(findings).toEqual([]);
  });
});

describe('where NULL will surprise the author', () => {
  it('warns that _neq on a nullable column drops the rows that have nothing there', async () => {
    // `col <> 'x'` is NULL for a row whose col is NULL, and WHERE treats NULL as
    // false. Fails closed, so not a leak: an author seeing fewer rows than they meant.
    const findings = lintTable(catalogue, definition({ nickname: { _neq: 'anon' } }));

    expect(findings.map((finding) => finding.code)).toEqual(['nullable_neq']);
    expect(findings[0]?.detail).toContain('_is_null');
  });

  it('says nothing when the same column is compared with _eq', async () => {
    // ⚠️ Narrowed on purpose. `rules/01` section G1 says to warn whenever a policy
    // references a nullable column, and firing that widely would warn on most
    // policies, which is a warning nobody reads. `_neq` is where it bites.
    expect(lintTable(catalogue, definition({ nickname: { _eq: 'anon' } }))).toEqual([]);
  });

  it('says nothing about _neq on a column that cannot be null', async () => {
    expect(lintTable(catalogue, definition({ author_id: { _neq: 'u_1' } }))).toEqual([]);
  });
});

describe('a policy wide enough to be refused by the database', () => {
  it('warns well before the measured boundary rather than at it', async () => {
    // `rules/01` section G9: 100 deep compiles, 101 fails with "Expression tree is
    // too large". That boundary is in tree depth, and how many terms produce what
    // depth has never been verified, so the warning sits far below it.
    const terms = Array.from({ length: 40 }, (_, index) => ({ body: { _eq: `v${index}` } }));
    const findings = lintTable(catalogue, definition({ _or: terms }));

    expect(findings.some((finding) => finding.code === 'wide_expression')).toBe(true);
  });

  it('says nothing about an ordinary policy', async () => {
    const findings = lintTable(
      catalogue,
      definition({
        _or: [{ author_id: { _eq: '$auth.uid' } }, { id: { _eq: '$auth.uid' } }],
      }),
    );

    expect(findings).toEqual([]);
  });
});

describe('the write side', () => {
  it('reads the check predicate as well as using', async () => {
    // A check runs on every write and scans the same way a using does. Reading only
    // `using` would leave the write path unmeasured, which is the path that costs
    // rows written as well as rows read.
    const findings = lintTable(
      catalogue,
      definition(
        { author_id: { _eq: '$auth.uid' } },
        { for: 'update', check: { body: { _eq: 'x' } }, columns: ['body'] },
      ),
    );

    expect(findings.map((finding) => finding.code)).toEqual(['unindexed_column']);
  });
});

/**
 * The closed dictionary, checked entry by entry.
 *
 * These are boring on purpose. The value of an allowlist is entirely in there
 * being no path through it that was not written down, so the tests enumerate
 * rather than sample.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { type Catalogue, getCatalogue, resetCatalogue } from '../db/introspect.js';
import { seedDatabase } from '../policy/__fixtures__/schema.js';
import { MAX_LIKE_PATTERN_BYTES } from '../policy/types.js';
import type { BaseclfError } from '../utils/errors.js';
import {
  resolveColumn,
  resolveNullPlacement,
  resolveOperator,
  resolveSortDirection,
  resolveTable,
  toLikePattern,
} from './allowlist.js';

let catalogue: Catalogue;

beforeAll(async () => {
  await seedDatabase(env.DB);
  resetCatalogue();
  catalogue = await getCatalogue(env.DB);
});

function statusOf(fn: () => unknown): number | string {
  try {
    fn();
  } catch (error) {
    return (error as BaseclfError).status;
  }
  return 'NO_THROW';
}

describe('tables', () => {
  it('accepts a real one', () => {
    expect(resolveTable(catalogue, 'posts')).toBe('posts');
  });

  it('answers the same way for absent and for hidden', () => {
    // Rule 00 invariant I5 applied to names. If these differed, the difference
    // would be a way to map the schema one request at a time.
    expect(statusOf(() => resolveTable(catalogue, 'no_such_table'))).toBe(404);
    expect(statusOf(() => resolveTable(catalogue, '_policies'))).toBe(404);
    expect(statusOf(() => resolveTable(catalogue, 'secrets'))).toBe('NO_THROW');
  });

  it('matches character for character', () => {
    for (const name of ['Posts', 'POSTS', 'post', 'posts ', ' posts', 'postss']) {
      expect(statusOf(() => resolveTable(catalogue, name))).toBe(404);
    }
  });

  it('refuses every engine table by prefix, not by a list', () => {
    for (const name of ['_policies', '_policy_binds', '_exposed_tables', '_anything_at_all']) {
      expect(statusOf(() => resolveTable(catalogue, name))).toBe(404);
    }
  });
});

describe('columns', () => {
  it('match character for character', () => {
    expect(resolveColumn(catalogue, 'posts', 'author_id')).toBe('author_id');

    for (const name of ['Author_Id', 'author', 'author_id_extra', 'autor_id']) {
      expect(statusOf(() => resolveColumn(catalogue, 'posts', name))).toBe(404);
    }
  });

  it('belong to the table they were asked about', () => {
    // `role` is a column of org_members, not of posts.
    expect(statusOf(() => resolveColumn(catalogue, 'posts', 'role'))).toBe(404);
  });
});

describe('operators', () => {
  it('accepts the ones D1 can express', () => {
    for (const name of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike']) {
      expect(resolveOperator(name)).toBe(name);
    }
  });

  it('refuses regular expression matching, because SQLite has no REGEXP', () => {
    for (const name of ['match', 'imatch']) {
      expect(statusOf(() => resolveOperator(name))).toBe(400);
    }
  });

  it('refuses array and range operators, because SQLite has no such types', () => {
    for (const name of ['cs', 'cd', 'ov', 'sl', 'sr', 'nxr', 'nxl', 'adj']) {
      expect(statusOf(() => resolveOperator(name))).toBe(400);
    }
  });

  it('refuses full text search, which needs an FTS5 table V1 does not expose', () => {
    for (const name of ['fts', 'plfts', 'phfts', 'wfts']) {
      expect(statusOf(() => resolveOperator(name))).toBe(400);
    }
  });

  it('says why, since an operator name reveals nothing about the data', () => {
    let message = '';
    try {
      resolveOperator('match');
    } catch (error) {
      message = (error as BaseclfError).message;
    }
    expect(message).toContain('REGEXP');
  });

  it('refuses anything else outright', () => {
    for (const name of ['', 'EQ', 'eq ', 'equals', 'drop']) {
      expect(statusOf(() => resolveOperator(name))).toBe(400);
    }
  });
});

describe('sort keywords', () => {
  it('come from a two entry lookup', () => {
    expect(resolveSortDirection('asc')).toBe('asc');
    expect(resolveSortDirection('desc')).toBe('desc');
    expect(resolveNullPlacement('nullsfirst')).toBe('first');
    expect(resolveNullPlacement('nullslast')).toBe('last');
  });

  it('refuse anything else, since these end up in SQL as keywords', () => {
    // A bound parameter is not an option here: ORDER BY ? parses on D1 and then
    // sorts by nothing at all. Verified 2026-07-29.
    for (const word of ['ASC', 'ascending', 'asc desc', '', 'asc;']) {
      expect(statusOf(() => resolveSortDirection(word))).toBe(400);
    }
  });
});

describe('how far LIKE folds case, measured rather than assumed', () => {
  // rules/01 records this for one accented pair. The claim being made in the
  // README is broader, that folding is ASCII only, so it is measured here for
  // several scripts before being written down as a general statement.
  it('folds ASCII', async () => {
    const row = await env.DB.prepare("SELECT 'A' LIKE 'a' AS matched").first<{ matched: number }>();
    expect(row?.matched).toBe(1);
  });

  it('does not fold anything else', async () => {
    // Latin with a diacritic, Greek, Cyrillic. Written as escapes so the file
    // itself stays ASCII, which the commit guard requires of everything that
    // ships (rules/04 section A).
    for (const [upper, lower] of [
      ['\u00C9', '\u00E9'],
      ['\u00D6', '\u00F6'],
      ['\u03A3', '\u03C3'],
      ['\u0416', '\u0436'],
    ]) {
      const row = await env.DB.prepare('SELECT ? LIKE ? AS matched')
        .bind(upper, lower)
        .first<{ matched: number }>();
      expect(row?.matched).toBe(0);
    }
  });
});

describe('like patterns', () => {
  it('turns the PostgREST wildcard into the SQL one', () => {
    expect(toLikePattern('*draft*')).toBe('%draft%');
  });

  it('escapes the wildcards the caller typed as text', () => {
    // Without this, a search for "50_off" also matches "50Xoff", and a search
    // for "100%" matches everything starting with "100".
    expect(toLikePattern('50_off')).toBe('50\\_off');
    expect(toLikePattern('100%')).toBe('100\\%');
    expect(toLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('handles both at once', () => {
    expect(toLikePattern('*50%_off*')).toBe('%50\\%\\_off%');
  });

  it('refuses a pattern longer than D1 accepts, measured after escaping', () => {
    // 51 bytes raises "LIKE or GLOB pattern too complex" on D1.
    expect(() => toLikePattern('a'.repeat(MAX_LIKE_PATTERN_BYTES))).not.toThrow();
    expect(() => toLikePattern('a'.repeat(MAX_LIKE_PATTERN_BYTES + 1))).toThrow();

    // Escaping doubles these, so twenty six characters is over the line even
    // though the input is not.
    expect(() => toLikePattern('_'.repeat(26))).toThrow();
  });
});

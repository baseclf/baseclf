/**
 * The PostgREST query string parser.
 *
 * The tests that matter here are the quoting ones. Splitting on `,` and `.`
 * before recognising quoted regions is the classic way this parser goes wrong,
 * and in this system a filter that does not mean what it looks like is a filter
 * that does not restrict what it looks like it restricts.
 */

import { describe, expect, it } from 'vitest';

import type { BaseclfError } from '../utils/errors.js';
import {
  type ConditionNode,
  MAX_FILTER_DEPTH,
  MAX_FILTERS,
  MAX_PAGE_SIZE,
  parseQueryString,
} from './parse-query.js';

const parse = (query: string) => parseQueryString(new URLSearchParams(query));

function firstCondition(query: string): ConditionNode {
  const filter = parse(query).filters[0];
  if (filter === undefined || filter.kind !== 'condition') {
    throw new Error('expected a condition');
  }
  return filter;
}

describe('quoting', () => {
  it('keeps a separator that sits inside quotes', () => {
    // The example from the PostgREST grammar. Two names, each containing a
    // comma, not four names.
    const condition = firstCondition('name=in.("Hebdon,John","Williams,Mary")');

    expect(condition.operator).toBe('in');
    expect(condition.value).toEqual(['Hebdon,John', 'Williams,Mary']);
  });

  it('keeps a dot that sits inside quotes', () => {
    const condition = firstCondition('email=eq."ann.smith@example.test"');
    expect(condition.value).toBe('ann.smith@example.test');
    expect(condition.quoted).toBe(true);
  });

  it('keeps parentheses that sit inside quotes', () => {
    const condition = firstCondition('title=eq."a (parenthetical) title"');
    expect(condition.value).toBe('a (parenthetical) title');
  });

  it('unescapes a quote inside a quoted value', () => {
    const condition = firstCondition('title=eq."she said \\"no\\""');
    expect(condition.value).toBe('she said "no"');
  });

  it('records whether the value was quoted, because null depends on it', () => {
    expect(firstCondition('body=is.null').quoted).toBe(false);
    expect(firstCondition('body=eq."null"').quoted).toBe(true);
  });

  it('refuses an unterminated quote rather than repairing it', () => {
    expect(() => parse('title=eq."never closed')).toThrow();
    expect(() => parse('title=in.(a,b')).toThrow();
    expect(() => parse('title=in.a,b)')).toThrow();
  });
});

describe('boolean groups', () => {
  it('parses or with several conditions', () => {
    const filter = parse('or=(status.eq.draft,status.eq.published)').filters[0];

    expect(filter?.kind).toBe('or');
    expect(filter?.kind === 'or' && filter.operands).toHaveLength(2);
  });

  it('nests', () => {
    const filter = parse('or=(status.eq.draft,and(status.eq.published,id.eq.p1))').filters[0];

    expect(filter?.kind).toBe('or');
    const nested = filter?.kind === 'or' ? filter.operands[1] : undefined;
    expect(nested?.kind).toBe('and');
  });

  it('stops nesting at the depth limit', () => {
    // The grammar is recursive and the query string is free to send, so this
    // is the difference between a parser and a way to spend a Worker's CPU.
    let query = 'id.eq.p1';
    for (let i = 0; i < MAX_FILTER_DEPTH + 2; i += 1) query = `or(${query})`;

    expect(() => parse(`or=(${query})`)).toThrow();
  });
});

describe('select', () => {
  it('reads a plain list', () => {
    expect(parse('select=id,title').select).toEqual([
      { column: 'id', alias: null },
      { column: 'title', alias: null },
    ]);
  });

  it('reads an alias', () => {
    expect(parse('select=headline:title').select).toEqual([{ column: 'title', alias: 'headline' }]);
  });

  it('reports a star as absent, which the router expands against the policy', () => {
    expect(parse('select=*').select).toBeNull();
    expect(parse('').select).toBeNull();
  });

  it('refuses a star mixed with named columns', () => {
    // There is no reading of this the policy layer could honour exactly.
    expect(() => parse('select=id,*')).toThrow();
  });

  it('refuses an embed, which V1 does not serve', () => {
    expect(() => parse('select=id,author:users(name)')).toThrow();
  });
});

describe('order', () => {
  it('defaults to ascending', () => {
    expect(parse('order=created_at').order).toEqual([
      { column: 'created_at', direction: 'asc', nulls: null },
    ]);
  });

  it('reads a direction and a null placement', () => {
    expect(parse('order=created_at.desc.nullslast').order).toEqual([
      { column: 'created_at', direction: 'desc', nulls: 'nullslast' },
    ]);
  });

  it('refuses more parts than the grammar has', () => {
    expect(() => parse('order=created_at.desc.nullslast.extra')).toThrow();
  });
});

describe('paging', () => {
  it('clamps a limit rather than refusing it', () => {
    // A caller asking for more than the server will serve gets the server's
    // answer. Refusing gives them an error they cannot act on.
    expect(parse(`limit=${MAX_PAGE_SIZE + 5000}`).limit).toBe(MAX_PAGE_SIZE);
  });

  it('defaults without being asked', () => {
    expect(parse('').limit).toBeGreaterThan(0);
    expect(parse('').offset).toBe(0);
  });

  it('refuses anything that is not a whole number', () => {
    for (const query of ['limit=-1', 'limit=1.5', 'limit=abc', 'offset=-2', 'limit=']) {
      expect(() => parse(query)).toThrow();
    }
  });
});

describe('limits that keep the parser cheap', () => {
  it('caps the number of filters', () => {
    const query = Array.from({ length: MAX_FILTERS + 1 }, (_, i) => `id${i}=eq.x`).join('&');
    expect(() => parse(query)).toThrow();
  });

  it('caps the length of the query string', () => {
    expect(() => parse(`title=eq.${'a'.repeat(5000)}`)).toThrow();
  });

  it('caps the size of an in list', () => {
    const entries = Array.from({ length: 400 }, (_, i) => `p${i}`).join(',');
    expect(() => parse(`id=in.(${entries})`)).toThrow();
  });
});

describe('malformed input', () => {
  it('names what is missing', () => {
    const error = (() => {
      try {
        parse('id=eq');
      } catch (caught) {
        return caught as BaseclfError;
      }
      return null;
    })();

    expect(error?.status).toBe(400);
  });

  it('refuses a filter with no operator', () => {
    expect(() => parse('id=')).toThrow();
  });
});

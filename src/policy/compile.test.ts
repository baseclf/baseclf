/**
 * Test six of the seven rule 00 requires: a PostgREST request in, an exact
 * `{sql, parameters}` out.
 *
 * The point of pinning the whole statement rather than asserting properties of
 * it is that the interesting failures are the ones nobody thought to assert. A
 * missing pair of parentheses, a value that stopped being bound, a policy that
 * quietly dropped out of an OR: none of those would fail a test that only
 * checked the rows came back right, because on the fixture data they often
 * still would.
 */

import { env } from 'cloudflare:workers';
import { SqliteQueryCompiler } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';

import { getCatalogue, resetCatalogue } from '../db/introspect.js';
import { buildSelect } from '../rest/build.js';
import { parseQueryString } from '../rest/parse-query.js';
import { GOLDEN_CASES } from './__fixtures__/golden.js';
import { seedDatabase, seedStandardPolicies } from './__fixtures__/schema.js';
import { applyPolicy } from './plugin.js';
import { getRegistry, resetRegistry } from './registry.js';
import type { AuthCtx } from './types.js';

beforeAll(async () => {
  await seedDatabase(env.DB);
  await seedStandardPolicies(env.DB);
  resetCatalogue();
  resetRegistry();
});

async function compile(auth: AuthCtx, query: string) {
  const [catalogue, registry] = await Promise.all([getCatalogue(env.DB), getRegistry(env.DB)]);

  const parsed = parseQueryString(new URLSearchParams(query));
  const columns =
    parsed.select ??
    registry
      .resolve('posts', 'select', auth.role, null)
      .columns.map((column) => ({ column, alias: null }));

  const node = buildSelect({ catalogue, table: 'posts', parsed, columns });
  const policied = applyPolicy(node, { registry, catalogue, auth });

  return new SqliteQueryCompiler().compileQuery(policied, { queryId: 'golden' });
}

describe('golden files', () => {
  for (const testCase of GOLDEN_CASES) {
    it(testCase.name, async () => {
      const compiled = await compile(
        { role: testCase.role, uid: testCase.uid, email: null, app: {} },
        testCase.query,
      );

      expect(compiled.sql).toBe(testCase.sql);
      expect(compiled.parameters).toEqual(testCase.parameters);
    });
  }
});

describe('what every compiled statement holds true', () => {
  it('binds every value, so no statement carries data', async () => {
    for (const testCase of GOLDEN_CASES) {
      const compiled = await compile(
        { role: testCase.role, uid: testCase.uid, email: null, app: {} },
        testCase.query,
      );

      // The only single quotes SQLite emits are string literals. There are none,
      // because every value went through a parameter.
      expect(compiled.sql).not.toContain("'");
      // And no claim leaked into the text either.
      if (testCase.uid !== null) expect(compiled.sql).not.toContain(testCase.uid);
    }
  });

  it('stays inside D1 hundred parameter ceiling', async () => {
    for (const testCase of GOLDEN_CASES) {
      const compiled = await compile(
        { role: testCase.role, uid: testCase.uid, email: null, app: {} },
        testCase.query,
      );
      expect(compiled.parameters.length).toBeLessThanOrEqual(100);
    }
  });

  it('spends one parameter on a list however long the list is', async () => {
    const anon: AuthCtx = { role: 'anon', uid: null, email: null, app: {} };

    const three = await compile(anon, 'select=id&id=in.(p1,p2,p3)');
    const many = await compile(
      anon,
      `select=id&id=in.(${Array.from({ length: 200 }, (_, i) => `p${i}`).join(',')})`,
    );

    // Two hundred entries would be twice D1's ceiling if they were expanded.
    expect(many.parameters.length).toBe(three.parameters.length);
    expect(many.parameters.length).toBeLessThanOrEqual(100);
  });

  it('separates the policy from the client filter with parentheses', async () => {
    const withFilter = await compile(
      { role: 'anon', uid: null, email: null, app: {} },
      'select=id&status=eq.published',
    );

    expect(withFilter.sql).toMatch(/where \([^)]*\) and \(/);
  });
});

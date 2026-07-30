/**
 * V1 in one screen: the same request, two identities, two different queries.
 *
 * Prints the compiled SQL, the parameter count, and the rows, for an anonymous
 * caller and for a signed in author. Nothing about the request changes between
 * the two runs except who is making it.
 *
 * Run: node scripts/demo-v1.mjs
 *
 * This drives the engine over node:sqlite rather than over D1, because a script
 * outside workerd has no binding to reach. That is fine for showing what the
 * compiler produces, which is the point, and the same paths are covered against
 * a real D1 binding by the test suite. Two things this cannot demonstrate:
 * double quoted string literals behave differently here, and rows_read is not
 * reported.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const source = (path) => JSON.stringify(join(process.cwd(), path));

const ENTRY = `
  export { getCatalogue, resetCatalogue } from ${source('src/db/introspect.ts')};
  export { getRegistry, resetRegistry } from ${source('src/policy/registry.ts')};
  export { seedDatabase, seedStandardPolicies } from ${source('src/policy/__fixtures__/schema.ts')};
  export { readTable } from ${source('src/rest/router.ts')};
`;

/** The slice of D1 the engine uses, backed by node:sqlite. */
function executorFor(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const withParameters = (parameters) => ({
        bind: (...next) => withParameters(next),
        all: async () => ({ results: statement.all(...parameters), meta: {} }),
        run: async () => ({ results: [], meta: statement.run(...parameters) }),
        first: async () => statement.get(...parameters) ?? null,
      });
      return withParameters([]);
    },
    batch: async () => {
      throw new Error('The demo does not use batch.');
    },
  };
}

const IDENTITIES = [
  { label: 'anonymous visitor', auth: { role: 'anon', uid: null, email: null, app: {} } },
  {
    label: 'signed in as u_ann',
    auth: { role: 'authenticated', uid: 'u_ann', email: 'ann@example.test', app: {} },
  },
];

const REQUEST = 'select=id,title,status&order=created_at.asc';

const directory = mkdtempSync(join(tmpdir(), 'baseclf-demo-'));

try {
  const entryPath = join(directory, 'entry.ts');
  writeFileSync(entryPath, ENTRY, 'utf8');

  const built = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    outfile: join(directory, 'engine.mjs'),
    logLevel: 'silent',
  });
  if (built.errors.length > 0) throw new Error('Could not build the engine.');

  const engine = await import(pathToFileURL(join(directory, 'engine.mjs')).href);

  const database = new DatabaseSync(':memory:');
  const executor = executorFor(database);

  await engine.seedDatabase(executor);
  await engine.seedStandardPolicies(executor);
  engine.resetCatalogue();
  engine.resetRegistry();

  const catalogue = await engine.getCatalogue(executor);
  const registry = await engine.getRegistry(executor);

  console.log(`\nGET /rest/v1/posts?${REQUEST}\n`);
  console.log('Four posts exist. One is published, three are drafts by three authors.');
  console.log('The request below is byte for byte identical in both runs.\n');
  console.log('The JSON lines are the engine own query log. Note what is in them: the');
  console.log('statement and how many values it bound, never the values.\n');

  for (const { label, auth } of IDENTITIES) {
    const result = await engine.readTable({
      executor,
      catalogue,
      registry,
      auth,
      table: 'posts',
      search: new URLSearchParams(REQUEST),
    });

    console.log(`${'-'.repeat(78)}\n${label}\n`);
    console.log(`  sql         ${result.sql}`);
    console.log(`  parameters  ${result.parameterCount} bound, none written into the statement`);
    console.log(`  rows        ${result.rows.length}`);
    for (const row of result.rows) {
      console.log(`              ${row.id}  ${row.status.padEnd(10)}  ${row.title}`);
    }
    console.log('');
  }

  console.log(`${'-'.repeat(78)}\n`);
  console.log('The anonymous caller sees the published post because read_published');
  console.log('matched it. Ann also sees her own draft, because read_own matched that');
  console.log('one, and the two policies are combined with OR. Neither sees the drafts');
  console.log('belonging to somebody else, and no part of either query came from the');
  console.log('request beyond the column list, the ordering and the page size.\n');

  database.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

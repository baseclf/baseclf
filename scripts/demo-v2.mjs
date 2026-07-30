/**
 * V2 in one screen: three updates, one of which is the point.
 *
 * Ann edits her own post and it works. Ann edits Bob's post and gets nothing
 * back. Ann tries to hand her own post to Bob, using a policy that explicitly
 * lets her write the owner column, and still gets nothing back.
 *
 * The third one is the one to look at. Nothing in the column grant stops it.
 * What stops it is that the check was rewritten into a statement about the row
 * as it would be afterwards, so the comparison is against the value being
 * written rather than the value stored. There is no read, no second round trip,
 * and no window in which the row belongs to Bob.
 *
 * Run: node scripts/demo-v2.mjs
 *
 * As with demo-v1, this drives the engine over node:sqlite because a script
 * outside workerd has no D1 binding. The statements are the same ones the tests
 * run against a real binding.
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
  export {
    OWNER_WRITABLE_POLICIES, POST_BINDS, registerPolicies, seedDatabase, seedStandardPolicies,
  } from ${source('src/policy/__fixtures__/schema.ts')};
  export { writeTable } from ${source('src/rest/router.ts')};
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

const ANN = { role: 'authenticated', uid: 'u_ann', email: 'ann@example.test', app: {} };

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

  const ownerOf = (id) =>
    database.prepare('SELECT author_id FROM posts WHERE id = ?').get(id)?.author_id ?? 'gone';

  const attempt = async (label, query, body, note) => {
    const catalogue = await engine.getCatalogue(executor);
    const registry = await engine.getRegistry(executor);

    let result;
    try {
      result = await engine.writeTable({
        executor,
        catalogue,
        registry,
        auth: ANN,
        table: 'posts',
        search: new URLSearchParams(query),
        operation: 'update',
        body,
      });
    } catch (error) {
      console.log(`${'-'.repeat(78)}\n${label}\n`);
      console.log(`  refused before any SQL ran: ${error.message}`);
      console.log(`  ${note}\n`);
      return;
    }

    console.log(`${'-'.repeat(78)}\n${label}\n`);
    console.log(`  sql         ${result.sql}`);
    console.log(`  parameters  ${result.parameterCount} bound`);
    console.log(`  rows        ${result.rows.length}`);
    console.log(`  http        ${result.rows.length === 0 ? '404 Not found' : '204 No content'}`);
    console.log(`  ${note}\n`);
  };

  console.log('\nPATCH /rest/v1/posts, three times, all as u_ann\n');
  console.log('p1 and p2 belong to Ann. p3 belongs to Bob.\n');

  await attempt(
    '1. Ann renames her own post',
    'id=eq.p2',
    { title: 'renamed by Ann' },
    'Two author_id terms: the row as it is, and the row as it will be. The update' +
      '\n  does not touch author_id, so its post image is the column itself.',
  );

  await attempt(
    "2. Ann tries to rename Bob's post",
    'id=eq.p3',
    { title: 'taken' },
    'Nothing comes back. Not 403: a caller who can tell "not yours" from "not' +
      '\n  there" can walk a range of ids and learn which ones exist.',
  );

  console.log(`${'-'.repeat(78)}`);
  console.log('\nNow switching to a policy that lets the caller write author_id.\n');

  await engine.registerPolicies(executor, {
    table: 'posts',
    binds: engine.POST_BINDS,
    policies: engine.OWNER_WRITABLE_POLICIES,
  });
  engine.resetRegistry();

  console.log(`p1 owner before: ${ownerOf('p1')}\n`);

  await attempt(
    '3. Ann tries to hand her own post to Bob',
    'id=eq.p1',
    { title: 'yours now', author_id: 'u_bob' },
    'The check is no longer a column comparison. It is ? = ?, the new owner' +
      '\n  against the caller, and they do not match.',
  );

  console.log(`p1 owner after:  ${ownerOf('p1')}\n`);
  console.log(`${'-'.repeat(78)}\n`);
  console.log('Nothing in the column grant stopped the third one. The policy said Ann');
  console.log('may write author_id, and she may. What she may not do is write a value');
  console.log('that would leave the row failing the same condition that let her reach');
  console.log('it, and that is checked inside the one statement that does the writing.');
  console.log('There is no read, no second round trip, and no moment in between.\n');

  database.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

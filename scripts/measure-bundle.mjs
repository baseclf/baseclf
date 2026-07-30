/**
 * What does Kysely actually cost inside a Worker bundle?
 *
 * Third-party comparisons quote npm tarball sizes, which are meaningless after
 * tree shaking. This builds three entry points with esbuild using the same
 * settings wrangler uses, and reports the gzipped delta.
 *
 * The number that matters is the delta against the Workers script limit:
 * 3 MB gzipped on Free, 10 MB on Paid.
 *
 * Run: node scripts/measure-bundle.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'baseclf-bundle-'));

const entries = {
  'baseline (no db layer)': `
    export default { fetch: () => Response.json({ ok: true }) };
  `,
  'catalogue only': `
    import { getCatalogue } from ${JSON.stringify(join(process.cwd(), 'src/db/introspect.ts'))};
    export default { fetch: async (r, env) => Response.json([...(await getCatalogue(env.DB)).tables.keys()]) };
  `,
  'catalogue + Kysely query builder': `
    import { getCatalogue } from ${JSON.stringify(join(process.cwd(), 'src/db/introspect.ts'))};
    import { createDb, batch } from ${JSON.stringify(join(process.cwd(), 'src/db/dialect.ts'))};
    export default { fetch: async (r, env) => {
      const db = createDb(env.DB);
      const q = db.selectFrom('posts').select(['id','title'])
        .where('status','=','published').orderBy('id').limit(20);
      await batch(env.DB, [q.compile()]);
      const cat = await getCatalogue(env.DB);
      return Response.json({ sql: q.compile().sql, tables: cat.tables.size });
    }};
  `,
};

const results = [];

for (const [label, source] of Object.entries(entries)) {
  const entry = join(dir, `${label.replace(/\\W+/g, '_')}.ts`);
  writeFileSync(entry, source, 'utf8');

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    minify: true,
    write: false,
    logLevel: 'silent',
  });

  const code = result.outputFiles[0].contents;
  results.push({
    label,
    raw: code.byteLength,
    gzip: gzipSync(code).byteLength,
  });
}

const kb = (n) => `${(n / 1024).toFixed(2)} KiB`;

console.log('\nBundle cost, minified, workerd conditions\n');
for (const r of results) {
  console.log(
    `  ${r.label.padEnd(34)} ${kb(r.raw).padStart(10)} raw   ${kb(r.gzip).padStart(10)} gzip`,
  );
}

const base = results[0].gzip;
const withKysely = results[results.length - 1].gzip;
console.log(`\n  Kysely + our db layer costs ${kb(withKysely - base)} gzipped.`);
console.log('  Workers script limit: 3 MB gzip on Free, 10 MB on Paid.\n');

rmSync(dir, { recursive: true, force: true });

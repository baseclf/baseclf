/**
 * What do our dependencies actually cost inside a Worker bundle?
 *
 * Third-party comparisons quote npm tarball sizes, which are meaningless after
 * tree shaking. This builds several entry points with esbuild using the same
 * settings wrangler uses, and reports the gzipped delta.
 *
 * The number that matters is the delta against the Workers script limit:
 * 3 MB gzipped on Free, 10 MB on Paid.
 *
 * Sources are fed through esbuild's stdin with `resolveDir` set to the project
 * root, so that both absolute paths into src/ and bare package specifiers
 * resolve the way they would in a real build. Writing them to a temp directory
 * instead breaks bare specifiers, because node_modules lookup walks up from the
 * file rather than from the working directory.
 *
 * Run: node scripts/measure-bundle.mjs
 */

import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

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
  '+ better-auth core': `
    import { betterAuth } from 'better-auth';
    export default { fetch: async (r, env) => {
      const auth = betterAuth({ database: env.DB, secret: env.SECRET, baseURL: env.URL });
      return auth.handler(r);
    }};
  `,
  '+ better-auth, bearer + ES256 jwt': `
    import { betterAuth } from 'better-auth';
    import { bearer, jwt } from 'better-auth/plugins';
    export default { fetch: async (r, env) => {
      const auth = betterAuth({
        database: env.DB, secret: env.SECRET, baseURL: env.URL,
        plugins: [bearer(), jwt({ jwks: { keyPairConfig: { alg: 'ES256' } } })],
      });
      return auth.handler(r);
    }};
  `,
  // Both together, because better-auth depends on Kysely itself. Adding the two
  // deltas would double count it, so the combined figure has to be measured.
  'everything V3 will ship': `
    import { getCatalogue } from ${JSON.stringify(join(process.cwd(), 'src/db/introspect.ts'))};
    import { createDb, batch } from ${JSON.stringify(join(process.cwd(), 'src/db/dialect.ts'))};
    import { betterAuth } from 'better-auth';
    import { bearer, jwt } from 'better-auth/plugins';
    export default { fetch: async (r, env) => {
      const auth = betterAuth({
        database: env.DB, secret: env.SECRET, baseURL: env.URL,
        plugins: [bearer(), jwt({ jwks: { keyPairConfig: { alg: 'ES256' } } })],
      });
      if (r.url.includes('/api/auth')) return auth.handler(r);
      const db = createDb(env.DB);
      const q = db.selectFrom('posts').select(['id','title']).where('status','=','published');
      await batch(env.DB, [q.compile()]);
      const cat = await getCatalogue(env.DB);
      return Response.json({ sql: q.compile().sql, tables: cat.tables.size });
    }};
  `,
};

const results = [];

for (const [label, source] of Object.entries(entries)) {
  let result;
  try {
    result = await build({
      stdin: {
        contents: source,
        resolveDir: process.cwd(),
        sourcefile: `${label.replace(/\W+/g, '_')}.ts`,
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      // Node built-ins are available to the Worker through nodejs_compat, so
      // they are external here rather than something esbuild should resolve.
      external: ['node:*', 'cloudflare:*'],
      minify: true,
      write: false,
      logLevel: 'silent',
    });
  } catch (error) {
    // A failure is itself a finding, and the useful part is which import could
    // not be resolved, so keep every message rather than the first line.
    const details = (error.errors ?? []).map((e) => {
      const where = e.location ? ` (${e.location.file}:${e.location.line})` : '';
      return `${e.text}${where}`;
    });
    results.push({ label, failed: details.length > 0 ? details : [error.message] });
    continue;
  }

  const code = result.outputFiles[0].contents;
  results.push({
    label,
    raw: code.byteLength,
    gzip: gzipSync(code).byteLength,
  });
}

const kb = (n) => `${(n / 1024).toFixed(2)} KiB`;
const FREE_LIMIT_BYTES = 3 * 1024 * 1024;

console.log('\nBundle cost, minified, workerd conditions\n');
for (const r of results) {
  if (r.failed) {
    console.log(`  ${r.label.padEnd(34)} DID NOT BUILD`);
    for (const line of r.failed) console.log(`  ${' '.repeat(34)} ${line}`);
    continue;
  }
  const share = ((r.gzip / FREE_LIMIT_BYTES) * 100).toFixed(1);
  console.log(
    `  ${r.label.padEnd(34)} ${kb(r.raw).padStart(11)} raw   ${kb(r.gzip).padStart(10)} gzip   ` +
      `${share.padStart(5)}% of Free`,
  );
}

const byLabel = new Map(results.map((r) => [r.label, r]));
const gzipOf = (label) => byLabel.get(label)?.gzip ?? null;

const base = gzipOf('baseline (no db layer)');
const kysely = gzipOf('catalogue + Kysely query builder');
const auth = gzipOf('+ better-auth, bearer + ES256 jwt');
const both = gzipOf('everything V3 will ship');

console.log('');
if (base !== null && kysely !== null) {
  console.log(`  Kysely + our db layer costs   ${kb(kysely - base)} gzipped.`);
}
if (base !== null && auth !== null) {
  console.log(`  better-auth with plugins adds ${kb(auth - base)} gzipped.`);
}
if (both !== null && kysely !== null && auth !== null) {
  const naive = kysely - base + (auth - base);
  console.log(
    `  Both together measure         ${kb(both)} gzipped, ` +
      `${((both / FREE_LIMIT_BYTES) * 100).toFixed(1)}% of the Free limit.`,
  );
  console.log(
    `  Adding the deltas would say   ${kb(naive)}, so sharing Kysely saves ` +
      `${kb(naive - both)}. Measure, do not add.`,
  );
}
console.log('\n  Workers script limit: 3 MB gzip on Free, 10 MB on Paid.\n');

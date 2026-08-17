/**
 * Stage the client library as its own package, and prove it runs from where it lands.
 *
 * `baseclf-js` is the third published name and the first that is not the CLI. The
 * other two are the same bytes twice, so `stage-alias-package.mjs` copies a manifest
 * and changes one field. This one cannot: the client is different bytes, a different
 * licence, and a different dependency list.
 *
 * 🔴 **The dependency list is the reason this is not the alias script with a new
 * name.** The root manifest declares `better-auth`, `kysely`, `jose`, `zod` and two
 * more, which are the Worker's. The client imports none of them: every one of its
 * imports is a sibling file in `sdk/`, measured rather than assumed, which is why the
 * manifest written below has no `dependencies` key at all. Copying the root manifest
 * would have made every front end installing a query builder also install a server
 * side auth framework, and nothing would have reported it as wrong.
 *
 * ⚠️ Built by `tsc` rather than by esbuild, unlike the CLI. A library ships
 * declarations, and a bundled `index.js` beside per-file declarations that still name
 * `./query.js` is a package whose types point at files it does not carry. See
 * `tsconfig.sdk.json`.
 *
 * The version is read from the root manifest rather than kept here. Two numbers
 * maintained by hand drift, and the way they drift is one package claiming a release
 * it does not contain.
 *
 *   node scripts/stage-sdk-package.mjs
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'baseclf-js';
const OUT = join(ROOT, 'dist-publish', NAME);

const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

// `tsc` writes straight into the staged directory, so what is checked below is what
// would be published rather than a copy of it.
execFileSync(
  'node',
  [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.sdk.json'],
  {
    cwd: ROOT,
    stdio: 'inherit',
  },
);

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const manifest = {
  name: NAME,
  version: root.version,
  description: 'Client for a BaseCLF deployment: queries, writes, sign-in and files.',
  // MIT, not the engine's Apache-2.0. `LICENSING.md` gives the reason: this is
  // compiled into somebody's application, and anything less permissive is a licence
  // compatibility problem for their users at no benefit to this project.
  license: 'MIT',
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': {
      types: './dist/index.d.ts',
      default: './dist/index.js',
    },
  },
  // An allowlist, for the reason `check-package.mjs` gives: a state that forgets to
  // exclude something should not be expressible.
  files: ['dist'],
  // Nothing here reaches for a global at import time, so a bundler is free to drop
  // whatever the application does not use.
  sideEffects: false,
  keywords: ['cloudflare', 'd1', 'workers', 'row-level-security', 'baseclf'],
  repository: root.repository,
  homepage: root.homepage,
  bugs: root.bugs,
  engines: root.engines,
};

writeFileSync(join(OUT, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

copyFileSync(join(ROOT, 'sdk', 'LICENSE'), join(OUT, 'LICENSE'));
copyFileSync(join(ROOT, 'sdk', 'README.md'), join(OUT, 'README.md'));

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------

/**
 * Import the built package and use it, rather than trusting that it compiled.
 *
 * ⚠️ Run from the staged directory, so a specifier that resolved in the repository and
 * not in the package fails here instead of after publishing. That is the same reason
 * the alias script runs both binaries, and it caught a real break there.
 *
 * The assertions are chosen to touch the parts a broken emit would take out: the
 * export exists, the constructor rejects what it is supposed to reject, and a builder
 * produces a URL. The last one matters most, because a package that imports and then
 * cannot build a request is the failure that looks like success.
 */
const PROBE = `
import { createClient, BaseclfRequestError } from './dist/index.js';

if (typeof createClient !== 'function') throw new Error('createClient is not exported');
if (typeof BaseclfRequestError !== 'function') throw new Error('the error type is not exported');

let refusedBadUrl = false;
try { createClient('not-a-url'); } catch { refusedBadUrl = true; }
if (!refusedBadUrl) throw new Error('a URL without a scheme was accepted');

const client = createClient('https://example.test');
const url = client.from('posts').select('id').eq('status', 'published').toURL();
if (!url.includes('/rest/v1/posts')) throw new Error('the builder did not produce a rest path: ' + url);
if (!url.includes('status=eq.published')) throw new Error('the builder dropped the filter: ' + url);

// The quoting rule, through the published artifact rather than through the source.
const quoted = client.from('posts').select('id').in('id', ['p1,p2']).toURL();
if (!quoted.includes('%22p1%2Cp2%22')) throw new Error('a value carrying a separator was not quoted: ' + quoted);

let refusedFilter = false;
try { client.from('posts').not('title', 'match', 'x'); } catch { refusedFilter = true; }
if (!refusedFilter) throw new Error('an operator this backend does not have was accepted');

console.log('probe: imports, refuses, and builds a request.');
`;

writeFileSync(join(OUT, 'probe.mjs'), PROBE);
try {
  const printed = execFileSync('node', ['probe.mjs'], { cwd: OUT, encoding: 'utf8' });
  process.stdout.write(printed);
} finally {
  // Never part of the package. Written, run, removed, and removed in a `finally` so a
  // failed probe does not leave a file the allowlist would have to know about.
  rmSync(join(OUT, 'probe.mjs'), { force: true });
}

// ---------------------------------------------------------------------------
// The same guard the other two packages go through
// ---------------------------------------------------------------------------

execFileSync('node', [join(ROOT, 'scripts', 'check-package.mjs'), OUT], {
  cwd: ROOT,
  stdio: 'inherit',
});

const bytes = statSync(join(OUT, 'dist', 'index.js')).size;
console.log(`staged ${NAME}@${manifest.version} in dist-publish/${NAME}, entry ${bytes} bytes.`);
console.log('');
console.log('Publish it:');
console.log('');
console.log(`  npm publish ./dist-publish/${NAME}`);

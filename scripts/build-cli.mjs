/**
 * Build everything the published package ships, and prove each piece works.
 *
 * Two artifacts, and the second one was missing for as long as this file existed.
 * `npm pack --dry-run` on 2026-08-12 showed the CLI in the tarball and no Worker
 * anywhere in it: `dist/index.js` is gitignored, `package.json` had no `files` field,
 * so npm fell back to `.gitignore` and dropped it. The CLI survived only because npm
 * force-includes whatever `bin` points at. So the package would have installed, run,
 * asked its two questions, and then had nothing to deploy.
 *
 * ⚠️ The Worker bundle is built by wrangler rather than by esbuild here, and the
 * difference is not cosmetic: `rules/01` section G0 measured wrangler's output at 67%
 * larger than an esbuild build of the same thing. Wrangler's is the one that runs, so
 * wrangler's is the one that ships. `npm run build` produces it and this copies it.
 *
 * ## Building the CLI
 *
 * This exists because of a measurement rather than a preference. Node 24 strips
 * types from a `.ts` file without a flag, so pointing `bin` straight at
 * `cli/bin.ts` looks like it should work. It does not: type stripping does not
 * rewrite import specifiers, and this project writes them with a `.js` extension
 * because that is what the Worker build needs. So `./main.js` resolves to a file
 * that is not on disk and the CLI fails with ERR_MODULE_NOT_FOUND before printing
 * anything.
 *
 * Changing the specifiers to match would diverge from `src/`, where the extension
 * is required. Bundling is the smaller change and it also means the published
 * package has no runtime dependencies to install.
 *
 *   node scripts/build-cli.mjs
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist-cli');
const OUT_FILE = join(OUT_DIR, 'baseclf.mjs');

/** Where wrangler leaves the Worker, and where the package carries it. */
const WORKER_SOURCE = join(ROOT, 'dist', 'index.js');
const WORKER_FILE = join(OUT_DIR, 'worker.js');

mkdirSync(OUT_DIR, { recursive: true });

await build({
  entryPoints: [join(ROOT, 'cli/bin.ts')],
  outfile: OUT_FILE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Not minified. This is a developer tool, it is read when it misbehaves, and the
  // whole thing is a few kilobytes either way.
  minify: false,
  // No banner. The first version of this added `#!/usr/bin/env node` as one, on the
  // assumption that esbuild would not carry the entry's own shebang through. It
  // does: the build produced two, and a `#!` on line 2 is a syntax error rather
  // than a comment, so the CLI would not start at all. The check below is what
  // caught it, which is the reason it is a check and not a comment saying this
  // should be fine.
});

// One `#!` on line 1 is a shebang. A second anywhere is a syntax error, and it is
// the kind that only shows up when somebody runs the published package.
const built = readFileSync(OUT_FILE, 'utf8');
const shebangs = built.split('\n').filter((line) => line.startsWith('#!')).length;
if (shebangs !== 1) {
  console.error(`build-cli: the output has ${shebangs} shebang lines, expected exactly 1.`);
  process.exit(1);
}

// Executable, because `npx` runs it directly on a POSIX system. A no-op on Windows,
// where the shim decides.
chmodSync(OUT_FILE, 0o755);

// Proof it runs, not just that it built. A CLI that compiles and then crashes on
// import is the failure this whole file exists to prevent.
const printed = execFileSync('node', [OUT_FILE, '--help'], { encoding: 'utf8' });
if (!printed.includes('doctor <url>')) {
  console.error('build-cli: the built CLI ran but did not print its usage.');
  process.exit(1);
}

const { size } = statSync(OUT_FILE);
console.log(`cli: ${(size / 1024).toFixed(1)} KiB at dist-cli/baseclf.mjs, and it runs.`);

// ---------------------------------------------------------------------------
// The Worker the CLI deploys
// ---------------------------------------------------------------------------

if (!existsSync(WORKER_SOURCE)) {
  console.error(
    'build-cli: no Worker bundle at dist/index.js. Run `npm run build` first, or use ' +
      '`npm run build:cli`, which does both in order.',
  );
  process.exit(1);
}

const worker = readFileSync(WORKER_SOURCE, 'utf8');

// A module Worker exports a default with a fetch handler. Checking the shape rather
// than the size catches the case that actually happens: a build that half succeeded
// and left something no runtime will accept, which would be discovered by the reader
// at the end of provisioning rather than here.
if (!/export\s*\{[^}]*as default|export default/.test(worker)) {
  console.error('build-cli: dist/index.js has no default export, so it is not a module Worker.');
  process.exit(1);
}

copyFileSync(WORKER_SOURCE, WORKER_FILE);

const workerSize = statSync(WORKER_FILE).size;
console.log(
  `worker: ${(workerSize / 1024 / 1024).toFixed(2)} MiB at dist-cli/worker.js, ready to upload.`,
);

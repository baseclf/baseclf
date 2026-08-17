/**
 * Stage the second package, so both names carry the same bytes.
 *
 * Two names are published: `create-baseclf`, which is what `npx` resolves for the
 * `create-*` convention, and `baseclf`, which is what every hint this project prints
 * asks somebody to run.
 *
 * 🔴 The second one is not a nicety. `npx <name>` resolves a **package**, not a
 * command, so `npx baseclf doctor <url>` goes looking for a package called `baseclf`.
 * That line is the last thing `create-baseclf` prints and it is in the README twice.
 * Without this, the final instruction of onboarding is a 404, delivered at the moment
 * somebody is checking whether what they just did worked.
 *
 * ## Generated rather than maintained
 *
 * The alias is built from the real package here rather than kept as a second
 * directory with its own `package.json`. Two hand-maintained manifests drift, and the
 * way they drift is one of them shipping an older Worker than the other while both
 * report the same version. Everything except the name is copied.
 *
 *   node scripts/stage-alias-package.mjs
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-publish', 'baseclf');

/** The name the alias is published under. */
const ALIAS_NAME = 'baseclf';

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

if (manifest.name === ALIAS_NAME) {
  console.error(`stage-alias: package.json is already named ${ALIAS_NAME}. Nothing to alias.`);
  process.exit(1);
}

// Files npm always includes, plus whatever `files` lists. Copied explicitly rather
// than by packing and unpacking, so what lands here is readable before it is sent.
const CARRIED = ['README.md', 'LICENSE', 'LICENSING.md', ...(manifest.files ?? [])];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const file of CARRIED) {
  const target = join(OUT, file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(ROOT, file), target);
}

// Everything except the name. `scripts` goes, because the alias is a published
// artifact rather than a checkout: a `prepack` here would try to run a build against
// files that are not present, and fail at the worst moment.
const { scripts, devDependencies, ...rest } = manifest;

writeFileSync(
  join(OUT, 'package.json'),
  `${JSON.stringify({ ...rest, name: ALIAS_NAME }, null, 2)}\n`,
);

// Proof rather than assumption: both binaries have to run from where they now are.
// A path that resolved in the repository and not in the staged copy is exactly the
// kind of break that only shows up after publishing.
for (const [binary, expected] of [
  ['baseclf.mjs', 'doctor <url>'],
  ['create-baseclf.mjs', 'npx create-baseclf'],
]) {
  const printed = execFileSync('node', [join(OUT, 'dist-cli', binary), '--help'], {
    encoding: 'utf8',
  });

  if (!printed.includes(expected)) {
    console.error(`stage-alias: ${binary} in the staged package did not print "${expected}".`);
    process.exit(1);
  }
}

const staged = JSON.parse(readFileSync(join(OUT, 'package.json'), 'utf8'));

console.log(`staged ${staged.name}@${staged.version} in dist-publish/baseclf, both binaries run.`);
console.log('');
// ⚠️ The session check comes first because npm answers an expired one with E404 and a
// sentence about the package rather than about the login. Measured twice, on 2026-08-14
// and 2026-08-18.
console.log('Publish both, session first, one command at a time:');
console.log('');
console.log('  npm whoami');
console.log('  npm publish');
console.log('  npm publish ./dist-publish/baseclf');
console.log('');
console.log('An E401 from whoami means log in again. An E404 from publish means the same');
console.log('thing, said less helpfully.');

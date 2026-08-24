#!/usr/bin/env node
/**
 * Everything this repository publishes is staged, at this version, from this build.
 *
 * Three names go to npm: `create-baseclf` from the root, `baseclf` from
 * `dist-publish/baseclf`, and `baseclf-js` from `dist-publish/baseclf-js`. On
 * 2026-08-22 the gate exited 0 while `dist-publish/baseclf` still held the previous
 * release, because `npm run check` ran `stage:sdk` and not `stage:alias`. Reading the
 * exit code and then handing somebody a publish command would have published old
 * bytes under a new label. It was caught by grepping the staged bundle by hand.
 *
 * `AGENTS.md` section 8 answers that with an instruction to a person: run
 * `stage:alias`, then check all three manifests and the bundle. This is that
 * instruction, made mechanical.
 *
 * ## Why it asserts the result and not the step
 *
 * The obvious fix is to add `stage:alias` to the chain, and that is done. But a check
 * that a step ran is defeated by moving the step, and moving the step is what
 * happened the first time. This asserts the state instead: whatever the chain looks
 * like next month, either the staged packages carry the current version and the bytes
 * that were just built, or this refuses. It survives a reorder, a rename, and a step
 * being dropped again.
 *
 * ## Byte identity, not just version agreement
 *
 * The version in a staged manifest is written by the staging script from the root
 * manifest, so on its own it says nothing about the code beside it: a stale directory
 * from a release where the numbers happened to line up would still agree. The alias
 * is supposed to be the same bytes as the root package under a second name, so its
 * `dist-cli` is hashed against the one on disk. That is the part a version cannot
 * fake.
 *
 * `baseclf-js` is different bytes on purpose, built by `tsc` from `sdk/`, so there is
 * nothing to compare it against here and only its version is checked. Stated because
 * a reader should not have to wonder whether it was forgotten.
 *
 *   node scripts/check-staged.mjs
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The two comparisons that decide this live next door, with nothing from `node:` in
// them, so the suite in workerd can exercise them. What is left here is the reading.
import { mirrorProblems, versionProblems } from './lib/staged.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every published name that is staged into a directory, and what it must carry. */
const STAGED = [
  { name: 'baseclf', dir: join(ROOT, 'dist-publish', 'baseclf'), mirrors: 'dist-cli' },
  { name: 'baseclf-js', dir: join(ROOT, 'dist-publish', 'baseclf-js'), mirrors: null },
];

const problems = [];

const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function hashesOf(dir) {
  const hashes = new Map();

  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    hashes.set(
      path.slice(dir.length + 1).replaceAll('\\', '/'),
      createHash('sha256').update(readFileSync(path)).digest('hex'),
    );
  }

  return hashes;
}

for (const target of STAGED) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(target.dir, 'package.json'), 'utf8'));
  } catch {
    problems.push(
      `${target.name} is not staged in dist-publish/${target.name}, so publishing it would ` +
        'send whatever is there, or nothing',
    );
    continue;
  }

  problems.push(...versionProblems(target.name, manifest.version, root.version));

  if (target.mirrors === null) continue;

  let built;
  let staged;
  try {
    built = hashesOf(join(ROOT, target.mirrors));
    staged = hashesOf(join(target.dir, target.mirrors));
  } catch (error) {
    problems.push(
      `${target.name} carries ${target.mirrors}, and it could not be compared with the build ` +
        `(${error.message.split('\n')[0]})`,
    );
    continue;
  }

  problems.push(...mirrorProblems(target.name, target.mirrors, built, staged));
}

if (problems.length === 0) {
  const names = [root.name, ...STAGED.map((target) => target.name)].join(', ');
  console.log(`staged: ${names} all at ${root.version}, and the alias carries this build.`);
  process.exit(0);
}

console.error('staged: what would be published is not what this repository holds.\n');
for (const problem of problems) console.error(`  ${problem}`);
console.error(
  '\nStage them and run this again:\n' +
    '\n' +
    '  npm run build:cli\n' +
    '  npm run stage:sdk\n' +
    '  npm run stage:alias\n' +
    '\n' +
    'An exit code of 0 from the gate is not evidence about dist-publish unless this\n' +
    'ran. That is how the previous release once sat there under a new version number.',
);

process.exit(1);

#!/usr/bin/env node
/**
 * No version numbers written by hand in what ships.
 *
 * Three surfaces stated a version on 2026-08-14 and all three were wrong, found one
 * at a time by running the thing rather than by any test:
 *
 *   /health              answered a literal 0.0.0 for every build ever made
 *   MCP handshake        named 0.1.0, a release from before the CLI could write a policy
 *   both CLI binaries    had no --version at all, so there was nothing to be wrong
 *
 * Each one now reads `version` out of `package.json`, and each has a test asserting
 * it equals the manifest. That closes the three. It does not close the fourth, which
 * is somebody adding a surface next month and typing the number that is correct that
 * afternoon. A test cannot see a surface nobody told it about, so the rule is checked
 * against the source instead: a bare version string in shipped code is refused
 * whatever it says.
 *
 * ⚠️ Correct-today is exactly the case this exists for. A literal reading 0.4.1 the
 * day it is written passes every test in the suite and is wrong from the next release
 * onward, silently, which is the shape all three of the originals had.
 *
 * ## Scope, and why it stops where it does
 *
 * `src/` and `cli/` only, tests excluded. Those two are what a user runs. `scripts/`
 * is tooling that nobody deploys, and tests quote versions on purpose: the one that
 * killed the MCP bug asserts the value is not `0.1.0`, which this would have to
 * forbid to be consistent, and forbidding it would delete the test.
 *
 *   node scripts/check-versions.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const ROOTS = ['src', 'cli'];

/**
 * A quoted string whose whole content is a version and nothing else.
 *
 * Anchored inside the quotes on purpose. `'127.0.0.1'` is four parts and stays out,
 * which matters because it is real and in `src/auth/diagnose.ts`, and a check with a
 * false positive on day one gets an exception added and then ignored.
 */
const HAND_WRITTEN_VERSION = /(['"`])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\1/g;

function sourceFiles(dir) {
  const found = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (extname(entry.name) !== '.ts') continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;

    found.push(path);
  }

  return found;
}

const offences = [];

for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    const lines = readFileSync(file, 'utf8').split('\n');

    lines.forEach((line, index) => {
      for (const match of line.matchAll(HAND_WRITTEN_VERSION)) {
        offences.push({ file, line: index + 1, value: match[2], text: line.trim() });
      }
    });
  }
}

if (offences.length === 0) {
  console.log(`versions: clean. No hand-written version in ${ROOTS.join(' or ')}.`);
  process.exit(0);
}

console.error('versions: a version number is written by hand in code that ships.\n');
for (const offence of offences) {
  console.error(`  ${offence.file}:${offence.line}  ${offence.value}`);
  console.error(`    ${offence.text}`);
}

console.error(
  '\nRead it from the manifest instead, the way the other surfaces do:\n' +
    '\n' +
    "  import { version as BASECLF_VERSION } from '../package.json';\n" +
    '\n' +
    'No import attribute. With one this is a standard JSON module, which has only a\n' +
    'default export, so the named form fails to bundle while a typecheck still passes.\n' +
    '\n' +
    'This is refused even when the number is the current one. A literal that is right\n' +
    'the day it is typed is wrong from the next release onward and nothing fails,\n' +
    'which is how /health came to answer 0.0.0 for the whole life of the project.',
);

process.exit(1);

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

/**
 * The one version that has to be written down, checked instead of trusted.
 *
 * `server.json` is read by `mcp-publisher`, which is a downloaded binary rather than
 * anything this project runs, so the file has to exist on disk with a literal in it.
 * That makes it the fourth hand-written version, arriving on the same day as a check
 * forbidding the other three, and the honest answer is to check it rather than to
 * pretend the rule has no exception.
 *
 * ⚠️ Registry versions are immutable once published. A `server.json` that lags the
 * package does not fail loudly: it claims a release that ships something else, and
 * the claim cannot be corrected in place afterwards.
 *
 * The schema constraints are asserted here too, for the same reason. `mcp-publisher`
 * is not installable with npx and the registry is still preview, so nothing in this
 * project's own gate would otherwise read this file before somebody tries to publish
 * it, by hand, from a machine that has the binary.
 */
function checkServerManifest() {
  const server = JSON.parse(readFileSync('server.json', 'utf8'));
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const problems = [];

  if (server.version !== version) {
    problems.push(`server.json says ${server.version}, package.json says ${version}`);
  }
  // Both measured off the published schema rather than remembered: description is 100
  // and name is a namespace and a name around a slash.
  if (server.description.length > 100) {
    problems.push(`description is ${server.description.length} characters, the schema allows 100`);
  }
  if (!/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(server.name)) {
    problems.push(`name "${server.name}" is not <namespace>/<name>`);
  }
  for (const field of ['name', 'description', 'version']) {
    if (!(field in server)) problems.push(`"${field}" is required and absent`);
  }

  return problems;
}

const manifestProblems = checkServerManifest();

if (offences.length === 0 && manifestProblems.length === 0) {
  console.log(
    `versions: clean. No hand-written version in ${ROOTS.join(' or ')}, server.json agrees.`,
  );
  process.exit(0);
}

if (manifestProblems.length > 0) {
  console.error('versions: server.json does not agree with the package.\n');
  for (const problem of manifestProblems) console.error(`  ${problem}`);
  console.error(
    '\nRegistry versions are immutable once published, so a server.json that lags the\n' +
      'package claims a release that ships something else and cannot be corrected later.',
  );
  if (offences.length === 0) process.exit(1);
  console.error('');
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

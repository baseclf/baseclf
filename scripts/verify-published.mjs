/**
 * Check what the registry actually serves, by fetching it and using it.
 *
 * Not by version number. A version number is what the publisher claimed, and this
 * project has twice found the interesting failure somewhere a number cannot reach:
 * a package that installed and had no Worker to deploy, and a deployment reporting a
 * version it was not running. Both were found by looking at contents.
 *
 * Three things it answers, in the order they matter:
 *
 *   1. **Does it work.** The downloaded copy is imported and exercised. A package that
 *      resolves and then cannot build a request is the failure that looks like success.
 *   2. **Is it the build that was staged.** Every file hashed against a local
 *      directory, so a publish from the wrong tree shows up as a differing file rather
 *      than as a subtle bug months later.
 *   3. **Do two names carry the same bytes.** `create-baseclf` and `baseclf` are
 *      published as one artifact under two names, and the dangerous drift is one of
 *      them shipping an older Worker while both report the same version.
 *
 *   node scripts/verify-published.mjs baseclf-js@0.4.6 --against dist-publish/baseclf-js
 *   node scripts/verify-published.mjs create-baseclf@0.4.6 baseclf@0.4.6
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* -------------------------------------------------------------- arguments --- */

const args = process.argv.slice(2);
const againstAt = args.indexOf('--against');
const against = againstAt === -1 ? undefined : args[againstAt + 1];

// ⚠️ The guard on `againstAt !== -1` is load bearing. Without it the missing flag
// gives -1, its value index gives 0, and the filter drops the first spec: the script
// then verifies one package out of two and reports success. It did exactly that on
// its first run, and the only reason it was caught is that the output named one
// package where two were asked for.
const specs = args.filter(
  (arg, index) => arg !== '--against' && !(againstAt !== -1 && index === againstAt + 1),
);

if (specs.length === 0) {
  console.error('usage: node scripts/verify-published.mjs <name@version>... [--against <dir>]');
  process.exit(2);
}

/**
 * ⚠️ Shape-checked before it reaches a shell.
 *
 * The npm commands below go through `execSync` as one string, which is the documented
 * path rather than the array-with-a-shell form Node deprecated in DEP0190, where
 * arguments are concatenated rather than escaped. Nothing here comes from a network,
 * but a spec is still an argument, so it is checked rather than trusted.
 */
const SPEC = /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?@[0-9][0-9a-z.+-]*$/;
for (const spec of specs) {
  if (!SPEC.test(spec)) {
    console.error(`not a package spec: ${spec}`);
    process.exit(2);
  }
}

/* ----------------------------------------------------------------- probes --- */

/**
 * What each package has to be able to do, keyed by name.
 *
 * Keyed rather than shared for the reason `check-package.mjs` gives: the packages
 * carry different things, and a probe that passed for all of them would be testing
 * none of them. A name with no probe is a failure, so a fourth package cannot arrive
 * and be verified by silence.
 */
const PROBES = {
  'baseclf-js': `
import { createClient, BaseclfRequestError } from './package/dist/index.js';

if (typeof BaseclfRequestError !== 'function') throw new Error('the error type is missing');

const client = createClient('https://example.test');

const url = client.from('posts').select('id').eq('status', 'published').toURL();
if (!url.includes('/rest/v1/posts')) throw new Error('no rest path: ' + url);
if (!url.includes('status=eq.published')) throw new Error('filter dropped: ' + url);

// The quoting rule, from the published artifact rather than from the source. Bare,
// this asks for two ids instead of one and answers with a row nobody asked for.
const quoted = client.from('posts').select('id').in('id', ['p1,p2']).toURL();
if (!quoted.includes('%22p1%2Cp2%22')) throw new Error('values are not quoted: ' + quoted);

const negated = client.from('posts').select('id').not('id', 'eq', 'p1').toURL();
if (!negated.includes('id=not.eq.p1')) throw new Error('not() missing: ' + negated);

const grouped = client
  .from('posts')
  .select('id')
  .or([
    { column: 'id', operator: 'eq', value: 'p1' },
    { column: 'id', operator: 'eq', value: 'p2' },
  ])
  .toURL();
if (!grouped.includes('or=')) throw new Error('or() missing: ' + grouped);

let refusedOperator = false;
try { client.from('posts').not('title', 'match', 'x'); } catch { refusedOperator = true; }
if (!refusedOperator) throw new Error('an operator this backend lacks was accepted');

let refusedUrl = false;
try { createClient('not-a-url'); } catch { refusedUrl = true; }
if (!refusedUrl) throw new Error('a URL without a scheme was accepted');

console.log('    query, quoting, not, or and the refusals all work');
`,
  'create-baseclf': `
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

for (const [binary, expected] of [
  ['package/dist-cli/create-baseclf.mjs', 'npx create-baseclf'],
  ['package/dist-cli/baseclf.mjs', 'doctor <url>'],
]) {
  const printed = execFileSync(process.execPath, [binary, '--help'], { encoding: 'utf8' });
  if (!printed.includes(expected)) throw new Error(binary + ' did not print ' + expected);
}

// The Worker the CLI deploys. Nothing in the manifest points at it, the CLI only
// reads it at run time, and it was absent from the package for its whole life before
// anybody checked. So it is checked here rather than assumed.
const manifest = JSON.parse(readFileSync('package/package.json', 'utf8'));
const worker = readFileSync('package/dist-cli/worker.js', 'utf8');

if (!/export\\s*\\{[^}]*as default|export default/.test(worker)) {
  throw new Error('the worker has no default export, so it is not a module Worker');
}

// ⭐ The version is compiled into the bundle, because /health reads it from the
// manifest at build time rather than from a literal. So its presence is evidence the
// Worker was built from this release rather than carried over from an older one,
// which is the drift a version number cannot show: both packages would still report
// the number they claim.
//
// ⚠️ What it proves and no more: the tree that built this bundle had this version in
// its manifest. It says nothing about the rest of the code matching.
if (!worker.includes(JSON.stringify(manifest.version))) {
  throw new Error(
    'the worker bundle does not carry ' + manifest.version + ', so it was built from a ' +
      'tree claiming some other version',
  );
}

console.log('    both binaries run, and the worker is a module carrying this version');
`,
};
PROBES.baseclf = PROBES['create-baseclf'];

/* -------------------------------------------------------------- machinery --- */

const WORK = join(tmpdir(), 'baseclf-verify');
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

function hashTree(dir, prefix = '') {
  const out = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of hashTree(join(dir, entry.name), rel)) out.set(k, v);
    } else {
      out.set(
        rel,
        createHash('sha256')
          .update(readFileSync(join(dir, entry.name)))
          .digest('hex'),
      );
    }
  }
  return out;
}

function compare(label, a, b) {
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  const differing = names.filter((n) => a.get(n) !== b.get(n));
  if (differing.length === 0) {
    console.log(`  ${label}: all ${names.length} files match byte for byte`);
    return true;
  }
  for (const name of differing) {
    console.log(
      `  ${label}: DIFFERS ${name} (${(a.get(name) ?? 'absent').slice(0, 12)} vs ` +
        `${(b.get(name) ?? 'absent').slice(0, 12)})`,
    );
  }
  return false;
}

const problems = [];
const fetched = [];

for (const spec of specs) {
  const dir = join(WORK, spec.replace(/[^a-z0-9.-]/gi, '_'));
  mkdirSync(dir, { recursive: true });

  console.log(`\n${spec}`);

  // `--silent` so the only thing on stdout is the tarball name npm wrote.
  const tarball = execSync(`npm pack ${spec} --silent`, { cwd: dir, encoding: 'utf8' })
    .trim()
    .split('\n')
    .pop();
  execSync(`tar -xzf ${tarball}`, { cwd: dir });

  const root = join(dir, 'package');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  console.log(
    `  served: ${manifest.name}@${manifest.version}, licence ${manifest.license}, ` +
      `dependencies ${Object.keys(manifest.dependencies ?? {}).length}`,
  );

  const probe = PROBES[manifest.name];
  if (probe === undefined) {
    problems.push(`${manifest.name} has no probe. Add one rather than verifying by silence.`);
  } else {
    writeFileSync(join(dir, 'probe.mjs'), probe);
    try {
      // ⚠️ Run from the extracted directory with a relative specifier. An absolute
      // Windows path in an ESM import is read as the URL scheme `c:` and refused.
      process.stdout.write(execSync('node probe.mjs', { cwd: dir, encoding: 'utf8' }));
    } catch (error) {
      problems.push(`${manifest.name} did not survive its probe: ${error.stderr ?? error.message}`);
    }
  }

  fetched.push({ spec, name: manifest.name, tree: hashTree(root) });
}

if (against !== undefined) {
  console.log('');
  const staged = hashTree(against);
  for (const one of fetched) {
    if (!compare(`${one.spec} against ${against}`, one.tree, staged)) {
      problems.push(`${one.spec} is not the build in ${against}`);
    }
  }
}

if (fetched.length > 1) {
  console.log('');
  const [first, ...rest] = fetched;
  for (const other of rest) {
    // package.json differs by name on purpose, so it is excluded from this one.
    const strip = (tree) => new Map([...tree].filter(([k]) => k !== 'package.json'));
    if (!compare(`${first.spec} against ${other.spec}`, strip(first.tree), strip(other.tree))) {
      problems.push(`${first.spec} and ${other.spec} do not carry the same bytes`);
    }
  }
}

console.log('');
if (problems.length > 0) {
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('');
  process.exit(1);
}
console.log('verified: what the registry serves is what was built, and it works.');

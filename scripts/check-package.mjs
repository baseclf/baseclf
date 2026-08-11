/**
 * What the published package contains, checked before anybody can install it.
 *
 * `scripts/guard-commit.mjs` guards git. It reads `git ls-files` and
 * `git diff --cached`, and that is the whole of what it sees. **npm is a second
 * distribution channel and it had no guard at all**: there was no `prepack`, no
 * `prepublishOnly`, and no `files` field, so what shipped was whatever `.gitignore`
 * happened not to exclude. Nothing checked it, and one `npm publish` is as permanent
 * as a push.
 *
 * Two things were wrong when this was written, both measured with
 * `npm pack --dry-run` on 2026-08-12:
 *
 *   1. 🔴 **The Worker was not in the tarball.** `dist/index.js` is gitignored, so npm
 *      dropped it. The CLI was there only because npm force-includes whatever `bin`
 *      points at. The package would have installed, run, asked its questions, and had
 *      nothing to deploy.
 *   2. **137 files shipped**, including every `.test.ts`. Test fixtures in this repo
 *      deliberately contain token-shaped strings, which is not something to publish
 *      to a registry that scans for them.
 *
 * The fix is an allowlist (`files` in `package.json`) rather than another denylist,
 * for the same reason `rules/00` section I1 gives for the policy registry: a state
 * that forgets to exclude something should not be expressible. This script is the
 * proof that the allowlist says what it means.
 *
 *   node scripts/check-package.mjs
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Artifacts without which the package does not work. Paths as npm reports them. */
const REQUIRED = [
  // The entry point `npx create-baseclf` resolves to. npm force-includes whatever
  // `bin` points at, so this one is hard to lose, and listing it is what makes the
  // check fail loudly if `bin` itself is ever renamed.
  'dist-cli/create-baseclf.mjs',
  'dist-cli/baseclf.mjs',
  // The Worker itself. Absent for the entire life of the package before this check.
  'dist-cli/worker.js',
  'package.json',
  // npm adds this on its own, so losing it takes deleting the file. Listed anyway:
  // `package.json` claims Apache-2.0, and a package that says so while shipping no
  // licence text is the kind of thing nobody notices until somebody's legal team does.
  'LICENSE',
];

/**
 * Paths that must never leave this machine, from `rules/05` sections B and D.
 *
 * The allowlist should already make these impossible. This is the second, independent
 * check that `rules/00` section I8 asks for whenever the cost of being wrong is
 * permanent, and publishing is permanent.
 */
const FORBIDDEN_EXACT = [
  '.env',
  '.dev.vars',
  'FOUNDATION.md',
  'BUILD-PROGRESS.md',
  'HANDOFF-STATUS.md',
  'AGENTS.md',
  'Baas With CLF.md',
  'baas-cloudflare-mvp-plan.md',
  'wrangler.local.jsonc',
];

const FORBIDDEN_PREFIX = ['.claude/', 'probe/', '.wrangler/'];

/**
 * Patterns that are not secrets but do not belong in a published tarball.
 *
 * Tests are the largest group and the one with a real edge: fixtures here contain
 * strings shaped like Cloudflare tokens on purpose, and a registry that scans
 * uploads has no way to know they are canaries.
 */
const FORBIDDEN_PATTERN = [
  { re: /\.test\.ts$/, why: 'a test file. Fixtures here hold token-shaped canaries.' },
  {
    re: /^scripts\/mutate-/,
    why: 'a mutation script. It rewrites source and is for this repo only.',
  },
  { re: /\.map$/, why: 'a source map. It carries the whole source in a file nobody reads.' },
];

function tarballFiles() {
  // `--ignore-scripts` so this does not trigger the build that may have just run.
  // The artifacts have to exist already, and the check below says so if they do not.
  //
  // ⚠️ One command string through `execSync` rather than an argument array through
  // `execFileSync(..., { shell: true })`. The second form is what Node deprecated in
  // DEP0190: with a shell, an argument array is concatenated rather than escaped, so
  // it reads as safe and is not. Nothing here comes from outside, and a fixed string
  // through the documented path leaves nothing to reason about.
  const raw = execSync('npm pack --dry-run --json --ignore-scripts', { encoding: 'utf8' });

  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return {
    files: (entry?.files ?? []).map((file) => file.path.replace(/\\/g, '/')),
    size: entry?.size ?? 0,
    unpacked: entry?.unpackedSize ?? 0,
  };
}

const { files, size, unpacked } = tarballFiles();
const problems = [];

/**
 * The commands the package claims to install, checked against what it ships.
 *
 * 🔴 Both of these came out of the same failed publish on 2026-08-12.
 *
 * The paths were written `./dist-cli/x.mjs`, and npm answered every publish with
 * `"bin[create-baseclf]" script name dist-cli/create-baseclf.mjs was invalid and
 * removed`. It turns out to normalise rather than remove, so the package would have
 * worked, but nobody reading that line could tell, and a warning nobody can act on
 * during an irreversible operation is worth removing rather than living with.
 *
 * The second half matters more: a `bin` pointing at a file the tarball does not carry
 * installs a command that is not there. npm does not check this, and the reader finds
 * out when the command they were told to run does nothing.
 */
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

for (const [command, target] of Object.entries(manifest.bin ?? {})) {
  if (target.startsWith('./')) {
    problems.push(
      `bin ${command} is written "${target}". npm rewrites a leading "./" and warns ` +
        'about it on every publish. Drop the prefix.',
    );
  }

  const normalised = target.replace(/^\.\//, '');
  if (!files.includes(normalised)) {
    problems.push(
      `bin ${command} points at ${normalised}, which is not in the tarball. That ` +
        'installs a command that does nothing.',
    );
  }
}

for (const required of REQUIRED) {
  if (!files.includes(required)) {
    problems.push(`missing: ${required}. The package does not work without it.`);
  }
}

for (const file of files) {
  if (FORBIDDEN_EXACT.includes(file)) {
    problems.push(`must not ship: ${file}. See rules/05 sections B and D.`);
    continue;
  }
  const prefix = FORBIDDEN_PREFIX.find((p) => file.startsWith(p));
  if (prefix !== undefined) {
    problems.push(`must not ship: ${file}. Everything under ${prefix} is private.`);
    continue;
  }
  const pattern = FORBIDDEN_PATTERN.find((p) => p.re.test(file));
  if (pattern !== undefined) {
    problems.push(`should not ship: ${file}. That is ${pattern.why}`);
  }
}

if (problems.length > 0) {
  console.error('');
  console.error('  PUBLISH BLOCKED by scripts/check-package.mjs');
  console.error('');
  for (const problem of problems) console.error(`    ${problem}`);
  console.error('');
  console.error('  Fix the `files` field in package.json. Do not publish around this.');
  console.error('');
  process.exit(1);
}

console.log(
  `package: ${files.length} files, ${(size / 1024 / 1024).toFixed(2)} MiB packed, ` +
    `${(unpacked / 1024 / 1024).toFixed(2)} MiB unpacked. Both artifacts present, nothing private.`,
);

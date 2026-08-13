#!/usr/bin/env node
/**
 * Refuse to publish or deploy from a working tree that does not match HEAD.
 *
 * Two reasons, and they arrived from opposite directions.
 *
 * ## 1. The mutation runner leaves real files rewritten (debt 55)
 *
 * `scripts/mutation-runner.mjs` writes a mutation into the actual source file,
 * runs the suite, and restores it in a `finally` that a killed process never
 * reaches. `scripts/mutate-deploy.mjs` has carried a note saying exactly this for
 * some time, which did not stop it happening four times.
 *
 * Twice in one session a killed run left a security check disabled on disk:
 *
 *   src/auth/verify.ts    if (true) return false;   the JWKS refresh brake, never released
 *   cli/cloudflare.ts     if (false)                the compatibility_date guard, defeated
 *
 * The first was found with a deploy already asked for. Nothing runs the suite
 * between the working tree and `wrangler deploy`: the bundler reads the files as
 * they are. Three of the four things that read the tree this way cannot be undone.
 *
 * ## 2. A deployment now states which release it is
 *
 * `/health` reports the version out of `package.json`, so a deployment makes a
 * claim about which build it is running. Uploading an uncommitted tree makes that
 * claim false, and the field exists precisely so somebody can ask. A version that
 * names a commit the artifact was not built from is worse than no version at all,
 * because it answers confidently.
 *
 * ## What it does not do
 *
 * It does not look for mutation markers. Recognising `if (true)` would be a list
 * of the shapes already seen, and the next one will be a shape nobody listed. Any
 * difference from HEAD is refused, whatever produced it.
 *
 *   node scripts/guard-release.mjs deploy
 *   node scripts/guard-release.mjs publish
 */

import { execFileSync } from 'node:child_process';

const ACTION = process.argv[2] ?? 'release';

/**
 * Every path git considers different from HEAD, including untracked ones.
 *
 * Untracked files count. A source file that was never added is missing from the
 * commit and present in the bundle, which is the same divergence as a modified
 * one and reads as a smaller problem. Ignored paths are already excluded by git,
 * so `dist-cli` and the private configs do not show up here.
 */
function divergentPaths() {
  const output = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return output.split('\n').filter((line) => line.trim() !== '');
}

const dirty = divergentPaths();

if (dirty.length === 0) {
  console.log(`guard: working tree matches HEAD, safe to ${ACTION}.`);
  process.exit(0);
}

console.error(`guard: refusing to ${ACTION}, the working tree does not match HEAD.\n`);
for (const line of dirty) console.error(`  ${line}`);

console.error(
  '\nRead the diff before doing anything else, and read it rather than the status:\n' +
    '\n' +
    '  git diff\n' +
    '\n' +
    'A status line says a file changed. It does not say what changed, and every time\n' +
    'a killed mutation run has been caught here, the diff is what caught it.\n' +
    '\n' +
    'If a mutation run was interrupted, this is what it left behind. Restore those\n' +
    'files and run it again from a clean tree:\n' +
    '\n' +
    '  git restore <path>\n' +
    '\n' +
    `If the changes are yours, commit them first. What gets ${ACTION}ed should be a\n` +
    'commit somebody can name, because the deployment reports a version as though it\n' +
    'were one.',
);

process.exit(1);

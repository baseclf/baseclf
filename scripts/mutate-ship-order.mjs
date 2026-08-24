/**
 * Break the two release checks, and see the tests notice.
 *
 * These two exist because a rule stated in prose was broken four times: publish the
 * CLI first, deploy the site second. So a suite that only proves they read a route
 * correctly is beside the point. What has to hold is that they **refuse**, and every
 * mutation below makes them quieter rather than louder, because quiet is the direction
 * they fail in and quiet is also what a correct run looks like.
 *
 * ⚠️ The most valuable one is `the calibration disabled`. Without that count, a call
 * written in a shape the parser does not recognise is skipped, the remaining counts
 * still agree with each other, and the run prints `clean` for a route nobody checked.
 * That is the original failure reproduced one level up, inside the thing built to stop
 * it, and it was a real hole in the first version of this check rather than a
 * hypothetical: `fetch(BRIDGE_URL + '/usage')` moved neither counter.
 *
 * Usage: node scripts/mutate-ship-order.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const SHIP = 'scripts/lib/ship-order.mjs';
const STAGED = 'scripts/lib/staged.mjs';

const MUTATIONS = [
  {
    // 🔴 The count that turns an unreadable call into a refusal. Without it the run is
    // silent about exactly the thing it was written to catch.
    name: 'the template calibration disabled',
    file: SHIP,
    expect: 'the refuses-when-a-call-is-written-in-a-shape-it-cannot-read test',
    find: / {2}if \(mentions !== calls\.length\) \{/,
    replace: '  if (false) {',
  },
  {
    // The same count inverted, which refuses on every healthy run instead. A check
    // that cries wolf is uninstalled within a week, so this direction matters too.
    name: 'the template calibration inverted',
    file: SHIP,
    expect: 'the is-quiet-when-every-mention-came-back-out test',
    find: / {2}if \(mentions !== calls\.length\) \{/,
    replace: '  if (mentions === calls.length) {',
  },
  {
    // 🔴 The second half of the calibration, and the hole it closes was real: counting
    // the template head alone missed a call written by concatenation.
    name: 'the identifier calibration always clean',
    file: SHIP,
    expect: 'the refuses-when-the-constant-is-used-more-often-than-parsed test',
    find: / {2}if \(references === parsedCount\) return \[\];/,
    replace: '  if (true) return [];',
  },
  {
    // The declaration counted as a use, so a healthy client is off by one forever and
    // the check refuses every run until somebody deletes it.
    name: 'the declaration counted as a use of the constant',
    file: SHIP,
    expect: 'the does-not-count-the-declaration test',
    find: / {2}const references = mentions - declarations;/,
    replace: '  const references = mentions;',
  },
  {
    // A word boundary is what keeps `BRIDGE_URL_FALLBACK` from reading as a use. Drop
    // it and a healthy file refuses, for a reason nobody would find by reading.
    name: 'the identifier matched without word boundaries',
    file: SHIP,
    expect: 'the does-not-mistake-a-longer-name test',
    find: /new RegExp\(`\\\\b\$\{name\}\\\\b`, 'g'\)/,
    replace: "new RegExp(`${name}`, 'g')",
  },
  {
    // 🔴 The page's scripts, half read. The chunk carrying the calls is behind a
    // modulepreload, so a reader that takes only `<script src>` finds a page that
    // calls nothing, and calling nothing compares clean against anything.
    name: 'modulepreload not counted as a script',
    file: SHIP,
    expect: 'the counts-modulepreload test',
    find: / {2}const preloads = \[\.\.\.html\.matchAll\(\/<link\\b\[\^>\]\*>\/g\)\]/,
    replace: '  const preloads = [...[]]',
  },
  {
    // Back to matching by attribute order, which is what it did before. Correct
    // against today's bundler and silent against tomorrow's.
    name: 'preloads matched only when rel comes before href',
    file: SHIP,
    expect: 'the finds-a-preload-whatever-order test',
    find: / {2}const preloads = \[\.\.\.html\.matchAll\(\/<link\\b\[\^>\]\*>\/g\)\]\n {4}\.map\(\(\[tag\]\) => tag\)\n {4}\.filter\(\(tag\) => \/\\brel="modulepreload"\/\.test\(tag\)\)/,
    replace:
      '  const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)]\n' +
      '    .map(([, href]) => href)\n' +
      '    .filter(() => true)',
  },
  {
    // 🔴 An empty route table read as a bridge that serves nothing. Every call then
    // looks unserved, which is loud, or the comparison is skipped, which is worse.
    name: 'an unreadable route table treated as no routes',
    file: SHIP,
    expect: 'the refuses-when-the-published-bundle-has-no-route-table test',
    find: / {2}if \(routes\.length === 0\) \{/,
    replace: '  if (false) {',
  },
  {
    // The dots in an address are wildcards until they are escaped. Unescaped, this
    // binds to a host nobody deployed and reports that chunk's calls as the site's.
    name: 'the bridge address left unescaped in the identifier search',
    file: SHIP,
    expect: 'the does-not-mistake-a-different-address test',
    find: /\$\{literally\(bridgeOrigin\)\}/,
    replace: '${bridgeOrigin}',
  },
  {
    // The method window running to the end of the file, so a later `DELETE` is handed
    // to an earlier path. The wrong answer here is a clean one.
    name: 'the method read from anywhere after the call',
    file: SHIP,
    expect: 'the does-not-read-the-method-of-the-next-call test',
    find: / {4}const to = index \+ 1 < matches\.length \? matches\[index \+ 1\]\.index : body\.length;/,
    replace: '    const to = body.length;',
  },
  {
    // A route named by path alone. `PATCH /rows` then compares equal to `GET /rows`,
    // and a verb the bridge does not answer reads as served.
    name: 'a route identified without its method',
    file: SHIP,
    expect: 'the counts-a-method-the-bridge-does-not-serve test',
    find: /export const key = \(route\) => `\$\{route\.method\} \$\{route\.path\}`;/,
    replace: 'export const key = (route) => `${route.path}`;',
  },
  {
    // The version comparison neutered. This is the check that would have caught a
    // staged directory holding the previous release under a new number.
    name: 'a staged version never disagreeing with the repository',
    file: STAGED,
    expect: 'the names-a-package-staged-at-an-older-version test',
    find: / {2}if \(stagedVersion === rootVersion\) return \[\];/,
    replace: '  if (true) return [];',
  },
  {
    // 🔴 The direction that catches a leftover. A one-way comparison reads a staged
    // copy carrying a file this build does not produce as agreement.
    name: 'a leftover file in the staged copy ignored',
    file: STAGED,
    expect: 'the names-a-file-the-build-does-not-produce test',
    find: / {2}for \(const file of staged\.keys\(\)\) \{\n {4}if \(!built\.has\(file\)\) \{/,
    replace: '  for (const file of staged.keys()) {\n    if (false) {',
  },
  {
    // The digest comparison dropped, so a staged copy with the right file names and
    // the wrong bytes passes. That is precisely the state found on disk on 2026-08-24.
    name: 'the bytes of a staged file never compared',
    file: STAGED,
    expect: 'the names-a-file-whose-bytes-differ test',
    find: / {4}\} else if \(staged\.get\(file\) !== digest\) \{/,
    replace: '    } else if (false) {',
  },
];

await runMutations({
  files: [SHIP, STAGED],
  suites: ['scripts/lib/ship-order.test.mjs', 'scripts/lib/staged.test.mjs'],
  mutations: MUTATIONS,
});

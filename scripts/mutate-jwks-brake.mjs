/**
 * Break the JWKS refresh brake on purpose, and check the tests notice.
 *
 * A green suite says nothing on its own. It says something once every way of
 * getting the code wrong has been shown to turn it red, and this project has
 * already been caught twice by tests that passed for the wrong reason. So each
 * mutation below is a plausible mistake somebody could make, or a "simplification"
 * somebody could apply, and the run records which tests died for it.
 *
 * A mutation that applies to nothing is the trap this guards against hardest: it
 * reads as "the tests survived" when in fact the code was never changed. Every
 * pattern therefore has to match exactly once or the run aborts.
 *
 * Usage: node scripts/mutate-jwks-brake.mjs
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const TARGET = 'src/auth/verify.ts';
const SUITE = 'src/auth/verify.test.ts';

/**
 * Each mutation names the mistake it models and which test is expected to catch
 * it. The expectation is written down so that a mutation caught by nothing at all
 * stands out, rather than being read as a pass.
 */
const MUTATIONS = [
  {
    name: 'no cooldown marker: every unknown kid reloads',
    expect: 'the sequential burst test',
    find: /if \(await cache\.match\(key\)\) return false;/,
    replace: 'await cache.match(key);',
  },
  {
    name: 'marker written without cache-control (rules/02 §F)',
    expect: 'the sequential burst test',
    find: /'cache-control': `max-age=\$\{JWKS_REFRESH_COOLDOWN_SECONDS\}`/,
    replace: "'x-marker': 'stored-nowhere'",
  },
  {
    name: 'no in-isolate join: a burst all reloads at once',
    expect: 'the concurrent burst test',
    find: /if \(joined !== undefined\) return joined;/,
    replace: 'if (joined !== undefined && false) return joined;',
  },
  {
    // Two earlier attempts at this mutation survived, and both times the mutation
    // was the weak thing rather than the test. Deferring the registration by one
    // microtask changed nothing because the other requests had not reached their
    // own lookup yet. Adding an await *before* the lookup changed nothing either,
    // because the lookup and the registration stayed adjacent, which is the
    // property that actually matters. The hazard is an await *between* them, so
    // that is what this opens up.
    name: 'an await between consulting the map and registering in it',
    expect: 'the concurrent burst test',
    // Measured 2026-08-11: this one SURVIVES, and the reason is worth keeping
    // rather than filing as a gap to close. With the gap open, the concurrent
    // test still reports exactly one reload, because the cooldown marker catches
    // the burst by itself as soon as anything staggers the requests. The two
    // brakes overlap here, so no test can separate them.
    //
    // Two conclusions, both recorded in `src/auth/verify.ts`:
    //   - the synchronous registration is defence in depth, not the thing that
    //     makes the burst safe. Do not describe it as load-bearing.
    //   - removing the join *entirely* is a different mutation, and that one is
    //     killed, so the Map is not dead weight either.
    knownSurvivor:
      'the cooldown marker covers the same burst, so the two brakes cannot be told apart',
    edits: [
      {
        find: /function refreshKeySet\(jwksUrl: string\)/,
        replace: 'async function refreshKeySet(jwksUrl: string)',
      },
      {
        find: /^ {2}refreshesInFlight\.set\(jwksUrl, started\);$/m,
        replace:
          '  await caches.open(REFRESH_COOLDOWN_CACHE);\n  refreshesInFlight.set(jwksUrl, started);',
      },
    ],
  },
  {
    name: 'fail-open: a braked refresh falls back to the stale key set',
    expect: 'the stated-reason test',
    find: /const refreshed = await refreshKeySet\(config\.jwksUrl\);/,
    replace: 'const refreshed = (await refreshKeySet(config.jwksUrl)) ?? jwks;',
  },
  {
    name: 'brake stuck on: nothing ever refreshes',
    expect: 'the rotation tests, which must still heal',
    find: /if \(await cache\.match\(key\)\) return false;/,
    replace: 'if (true) return false;',
  },
  {
    name: 'one shared marker instead of one per issuer',
    expect: 'the per-issuer isolation test',
    find: /(const cache = await caches\.open\(REFRESH_COOLDOWN_CACHE\);\n {2}const key = cacheKeyFor\()jwksUrl(\);)/,
    replace: "$1'https://one-global-marker.invalid/'$2",
  },
];

const original = readFileSync(TARGET, 'utf8');
const originalHash = createHash('sha256').update(original).digest('hex');

/** Run the suite. Returns the names of the tests that failed. */
function runSuite() {
  try {
    execFileSync(
      'npx',
      ['vitest', 'run', SUITE, '--reporter=json', '--outputFile=.mutation.json'],
      {
        stdio: 'pipe',
        shell: true,
      },
    );
  } catch {
    // A failing suite exits non-zero, which is the normal outcome here.
  }

  const report = JSON.parse(readFileSync('.mutation.json', 'utf8'));
  return report.testResults
    .flatMap((file) => file.assertionResults ?? [])
    .filter((test) => test.status === 'failed')
    .map((test) => test.title);
}

console.log(`Baseline: ${TARGET} @ ${originalHash.slice(0, 12)}\n`);

const results = [];

try {
  for (const mutation of MUTATIONS) {
    // Some mistakes are not one edit. Opening a gap between two adjacent lines
    // needs both the gap and the `async` that permits it, and a mutation that
    // applied only half of that would be a third weak model of the same bug.
    const edits = mutation.edits ?? [{ find: mutation.find, replace: mutation.replace }];
    let mutated = original;

    for (const edit of edits) {
      const matches = mutated.match(new RegExp(edit.find.source, `${edit.find.flags}g`));
      if (matches === null || matches.length !== 1) {
        throw new Error(
          `Mutation "${mutation.name}" matched ${matches?.length ?? 0} times, expected exactly 1. ` +
            'A mutation that does not apply reads as a surviving mutant. Fix the pattern.',
        );
      }
      mutated = mutated.replace(edit.find, edit.replace);
    }

    writeFileSync(TARGET, mutated);
    const failed = runSuite();
    writeFileSync(TARGET, original);

    results.push({ ...mutation, failed });

    const verdict = failed.length > 0 ? `KILLED by ${failed.length}` : 'SURVIVED';
    console.log(`${verdict.padEnd(14)} ${mutation.name}`);
    for (const title of failed) console.log(`               - ${title}`);
    console.log('');
  }
} finally {
  writeFileSync(TARGET, original);
  rmSync('.mutation.json', { force: true });
}

const restoredHash = createHash('sha256').update(readFileSync(TARGET, 'utf8')).digest('hex');
if (restoredHash !== originalHash) {
  console.error(`RESTORE FAILED: ${TARGET} does not match the original. Check git diff.`);
  process.exit(1);
}

const survived = results.filter((result) => result.failed.length === 0);
const unexpected = survived.filter((result) => result.knownSurvivor === undefined);
/**
 * A mutation recorded as a known survivor that suddenly dies is also news. It
 * means the overlap it documents has gone, so the note explaining it is now
 * wrong and somebody should read it again.
 */
const nowKilled = results.filter(
  (result) => result.knownSurvivor !== undefined && result.failed.length > 0,
);

console.log(
  `Restored, hash matches. ${results.length - survived.length}/${results.length} killed.`,
);

for (const result of survived) {
  const note =
    result.knownSurvivor === undefined
      ? `expected to be caught by: ${result.expect}`
      : `KNOWN, and why: ${result.knownSurvivor}`;
  console.log(`\nSURVIVED: ${result.name}\n  ${note}`);
}

for (const result of nowKilled) {
  console.log(
    `\nNO LONGER SURVIVES: ${result.name}\n` +
      `  it was recorded as surviving because ${result.knownSurvivor}.\n` +
      '  Something changed. Re-read that note before trusting it.',
  );
}

process.exit(unexpected.length === 0 && nowKilled.length === 0 ? 0 : 1);

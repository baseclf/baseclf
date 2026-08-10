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

import { runMutations } from './mutation-runner.mjs';

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
    file: TARGET,
    expect: 'the sequential burst test',
    find: /if \(await cache\.match\(key\)\) return false;/,
    replace: 'await cache.match(key);',
  },
  {
    name: 'marker written without cache-control (rules/02 §F)',
    file: TARGET,
    expect: 'the sequential burst test',
    find: /'cache-control': `max-age=\$\{JWKS_REFRESH_COOLDOWN_SECONDS\}`/,
    replace: "'x-marker': 'stored-nowhere'",
  },
  {
    name: 'no in-isolate join: a burst all reloads at once',
    file: TARGET,
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
    file: TARGET,
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
        file: TARGET,
        find: /function refreshKeySet\(jwksUrl: string\)/,
        replace: 'async function refreshKeySet(jwksUrl: string)',
      },
      {
        file: TARGET,
        find: /^ {2}refreshesInFlight\.set\(jwksUrl, started\);$/m,
        replace:
          '  await caches.open(REFRESH_COOLDOWN_CACHE);\n  refreshesInFlight.set(jwksUrl, started);',
      },
    ],
  },
  {
    name: 'fail-open: a braked refresh falls back to the stale key set',
    file: TARGET,
    expect: 'the stated-reason test',
    find: /const refreshed = await refreshKeySet\(config\.jwksUrl\);/,
    replace: 'const refreshed = (await refreshKeySet(config.jwksUrl)) ?? jwks;',
  },
  {
    name: 'brake stuck on: nothing ever refreshes',
    file: TARGET,
    expect: 'the rotation tests, which must still heal',
    find: /if \(await cache\.match\(key\)\) return false;/,
    replace: 'if (true) return false;',
  },
  {
    name: 'one shared marker instead of one per issuer',
    file: TARGET,
    expect: 'the per-issuer isolation test',
    find: /(const cache = await caches\.open\(REFRESH_COOLDOWN_CACHE\);\n {2}const key = cacheKeyFor\()jwksUrl(\);)/,
    replace: "$1'https://one-global-marker.invalid/'$2",
  },
];

await runMutations({ files: [TARGET], suites: [SUITE], mutations: MUTATIONS });

/**
 * Break the JWKS source on purpose, and check the tests notice.
 *
 * ⚠️ This replaced `mutate-jwks-brake.mjs` on 2026-08-15, and the reason is the
 * point of the file rather than a footnote.
 *
 * The old script mutated a cooldown marker and an in-flight map that throttled a
 * `fetch` of the issuer's JWKS endpoint. It killed 6 of 7 mutations, which read
 * as a well guarded brake. It was guarding a code path that did not work: the
 * issuer is this same Worker, and a Worker fetching its own `*.workers.dev` URL
 * is answered 404, so every JWT was refused on every deployment from V3 until
 * 2026-08-15. The suite stayed green because the fixture routed that one URL
 * back into the issuer, and the mutation script inherited the same blind spot.
 *
 * So the mutations here are aimed at the assumptions that actually hold the
 * identity path up now, and the first of them is the one that would have caught
 * the original bug: put the network back and see whether anything turns red.
 *
 * A green suite says nothing on its own. It says something once every way of
 * getting the code wrong has been shown to turn it red. A mutation that applies
 * to nothing is the trap this guards against hardest: it reads as "the tests
 * survived" when the code was never changed. Every pattern therefore has to
 * match exactly once or the run aborts.
 *
 * Usage: node scripts/mutate-jwks-source.mjs
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
    // The regression that matters. This is the original bug, reintroduced
    // deliberately, and the whole point of the rewritten fixture is that it dies.
    name: 'the network is back on the identity path',
    file: TARGET,
    expect: 'the no-outbound-request test',
    find: /const jwks = asKeySet\(await config\.readKeySet\(\)\);/,
    replace: 'const jwks = asKeySet(await (await fetch(config.keySetUrl)).json());',
  },
  {
    name: 'fail-open: a source that returns nonsense is treated as a key set',
    file: TARGET,
    expect: 'the not-a-key-set test',
    find: /if \(jwks === null\) \{\n {4}throw unauthorized\('The issuer did not produce a key set\.'\);\n {2}\}/,
    replace: 'if (jwks === null) {\n    return { keys: [] };\n  }',
  },
  {
    name: 'reload ignored: a rotation never heals',
    file: TARGET,
    expect: 'the rotation tests',
    find: /if \(!refresh\) \{/,
    replace: 'if (true) {',
  },
  {
    name: 'key set stored without cache-control (rules/02 §F)',
    file: TARGET,
    expect: 'the read-count assertions in the rotation tests',
    find: /'cache-control': `max-age=\$\{JWKS_CACHE_SECONDS\}`/,
    replace: "'x-stored': 'nowhere'",
  },
  {
    name: 'retry on any refusal, not only on an unknown key id',
    file: TARGET,
    expect: 'the no-pointless-reload test',
    find: /if \(code !== 'ERR_JWKS_NO_MATCHING_KEY'\) \{/,
    replace: "if (code === '\\u0000never') {",
  },
  {
    name: 'one shared cache entry instead of one per issuer',
    file: TARGET,
    expect: 'the per-issuer isolation test',
    find: /const key = cacheKeyFor\(config\.keySetUrl\);/,
    replace: "const key = cacheKeyFor('https://one-global-key-set.invalid/');",
  },
  {
    // Verification must not be reachable without the algorithm pin. A token
    // names its own algorithm in a header the attacker also writes.
    name: 'algorithm no longer pinned to ES256',
    file: TARGET,
    expect: 'the wrong-algorithm refusal test',
    // Measured 2026-08-15: this one SURVIVES, and the finding is about where the
    // protection really lives rather than about a missing test.
    //
    // Widening the accepted list does not open the classic confusion attack here,
    // because `createLocalJWKSet` still has to hand `jose` a key for whatever the
    // token claims, and this issuer publishes EC keys only. An `HS256` token has
    // no key to resolve to, so it dies at key lookup rather than at the pin, and
    // no test can tell the pin from the key set doing the work.
    //
    // ⚠️ Which means the pin is defence in depth, not the thing standing between
    // an attacker and a forged token today. Do not describe it as load-bearing,
    // and do not remove it either: it is what keeps this true if the key set ever
    // carries more than one kind of key.
    //
    // ⚠️ And the reasoning above is reasoning. What was measured is only that no
    // current test separates the two. Killing this would need a fixture whose key
    // set contains a key usable by the second algorithm, which is contrived
    // enough that it would be testing `jose` rather than this file.
    knownSurvivor:
      'the published key set is EC-only, so a widened list still resolves no key for another algorithm',
    find: /algorithms: \[ACCEPTED_ALGORITHM\],/,
    replace: 'algorithms: [ACCEPTED_ALGORITHM, "HS256", "none"],',
  },
];

await runMutations({ files: [TARGET], suites: [SUITE], mutations: MUTATIONS });
